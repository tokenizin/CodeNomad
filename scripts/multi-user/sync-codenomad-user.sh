#!/usr/bin/env bash
# Sync a freshly built CodeNomad from the admin's checkout into a per-user instance, restart it, and check that
# the instance now reports the build that was just made (GET /api/build-stamp).
#
# Per-user instances (setup-codenomad-user.sh) run their own copy in ~<user>/CodeNomad, so a build in the
# admin's checkout does not reach them by itself (Prestix runs straight from the admin's tree instead).
# Copied: the source, the vendored resources/*/node_modules, and the built artifacts the server serves (UI bundle
# in packages/server/public, OpenCode plugin tarball in packages/server/dist/opencode-plugin, build-stamp.json).
# npm ci runs as the user only when package-lock.json changed.
#
# Modes (--mode, default auto):
#   root    run with sudo: copies straight into ~<user>/CodeNomad, chowns it, kickstarts the job.
#   helper  run as yourself, no password: copies into /Users/Shared/codenomad-sync/<user>, runs the root-owned
#           peer-sync-apply AS <user>, then kickstarts the job. Needs `sudo install-sync-helper.sh` once.
#   auto    root if already root; helper if it is installed; otherwise sudo (password) when on a terminal.
#
# Exit status: 0 synced and running the new build; 3 restarted but still reporting another build (stale);
#              1 failed (the instance may not be running the new build).
#
# Usage: scripts/multi-user/sync-codenomad-user.sh --user stas [--source <CodeNomad checkout>]
#          [--mode auto|root|helper] [--no-install] [--no-restart] [--no-wait]
set -euo pipefail

ORIG_ARGS=("$@")
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_USER=""
SOURCE="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="auto"
INSTALL=1
RESTART=1
WAIT=1
HELPER_APPLY="/usr/local/libexec/codenomad/peer-sync-apply"
DROP_ROOT="/Users/Shared/codenomad-sync"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) TARGET_USER="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    --no-restart) RESTART=0; shift ;;
    --no-wait) WAIT=0; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$TARGET_USER" ]] || { echo "--user is required" >&2; exit 1; }
case "$MODE" in auto|root|helper) ;; *) echo "--mode must be auto, root or helper" >&2; exit 1 ;; esac
SOURCE="$(cd "$SOURCE" && pwd)"
id "$TARGET_USER" >/dev/null 2>&1 || { echo "macOS user '$TARGET_USER' does not exist." >&2; exit 1; }
[[ -f "$SOURCE/packages/server/src/index.ts" ]] || { echo "Not a CodeNomad checkout: $SOURCE" >&2; exit 1; }
LABEL="com.tokenizin.codenomad.${TARGET_USER}"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
DROP="$DROP_ROOT/$TARGET_USER"

if [[ "$MODE" == "auto" ]]; then
  if [[ "$EUID" -eq 0 ]]; then
    MODE="root"
  elif [[ -x "$HELPER_APPLY" && -d "$DROP" && -w "$DROP" ]]; then
    MODE="helper"
  elif [[ -t 0 && -t 1 ]]; then
    echo "Passwordless sync is not installed (once: sudo $SELF_DIR/install-sync-helper.sh --admin $(id -un) --user $TARGET_USER); using sudo." >&2
    exec sudo bash "$0" "${ORIG_ARGS[@]}" --mode root
  else
    echo "No terminal for a sudo password, and the passwordless helper is not installed. Run once:" >&2
    echo "  sudo $SELF_DIR/install-sync-helper.sh --admin $(id -un) --user $TARGET_USER" >&2
    exit 1
  fi
fi
[[ "$MODE" != "root" || "$EUID" -eq 0 ]] || { echo "--mode root needs sudo." >&2; exit 1; }
[[ "$MODE" != "helper" || "$EUID" -ne 0 ]] || { echo "--mode helper runs as your own user, not root." >&2; exit 1; }

TARGET_HOME="$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory | awk '{print $2}')"
INSTALL_DIR="$TARGET_HOME/CodeNomad"

lock_hash() { [[ -f "$1" ]] && shasum "$1" | awk '{print $1}' || echo "none"; }

# Copy the source tree and the built artifacts from $SOURCE into $1.
stage_to() {
  local dest="$1" vendored built
  mkdir -p "$dest"
  # Source only: no node_modules (the user's own install), build output, .git, local .env files or the admin's tasks/evidence.
  rsync -a --delete \
    --exclude node_modules --exclude dist --exclude .git --exclude .env --exclude '.env.*' \
    --exclude tasks --exclude evidences --exclude temp --exclude .nomadworks \
    "$SOURCE"/ "$dest"/
  # The exclude above also drops vendored, git-tracked node_modules that npm ci does not recreate, e.g.
  # packages/server/resources/git-graph/node_modules/vscode (the shim Git Graph's require("vscode") needs).
  while IFS= read -r vendored; do
    mkdir -p "$dest/$vendored"
    rsync -a --delete "$SOURCE/$vendored/" "$dest/$vendored/"
  done < <(cd "$SOURCE" && find packages/*/resources -type d -name node_modules -prune 2>/dev/null)
  # Built artifacts the server serves: the UI bundle and the OpenCode plugin tarball (under the excluded dist/).
  for built in packages/server/public packages/server/dist/opencode-plugin; do
    if [[ -d "$SOURCE/$built" ]]; then
      mkdir -p "$dest/$built"
      rsync -a --delete "$SOURCE/$built/" "$dest/$built/"
    else
      echo "    (no $built in the source yet; build CodeNomad first to ship it)"
    fi
  done
}

if [[ "$MODE" == "root" ]]; then
  TARGET_GROUP="$(id -gn "$TARGET_USER")"
  LOCK_BEFORE="$(lock_hash "$INSTALL_DIR/package-lock.json")"
  echo "==> Syncing CodeNomad $SOURCE -> $INSTALL_DIR (root)"
  stage_to "$INSTALL_DIR"
  chown -R "$TARGET_USER:$TARGET_GROUP" "$INSTALL_DIR"

  if [[ "$INSTALL" -eq 1 ]]; then
    LOCK_AFTER="$(lock_hash "$INSTALL_DIR/package-lock.json")"
    if [[ "$LOCK_BEFORE" != "$LOCK_AFTER" || ! -d "$INSTALL_DIR/node_modules" ]]; then
      NODE_BIN="/opt/homebrew/bin/node"
      [[ -f "$PLIST" ]] && NODE_BIN="$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$PLIST" 2>/dev/null || echo "$NODE_BIN")"
      echo "==> Dependencies changed or not installed yet; running npm ci as $TARGET_USER"
      sudo -u "$TARGET_USER" -H env HOME="$TARGET_HOME" PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
        bash -c "cd '$INSTALL_DIR' && npm ci"
    else
      echo "==> Dependencies unchanged; skipping npm ci"
    fi
  fi
else
  # Helper mode. Nothing here runs as root, and root never writes into the user's home: this account only copies
  # into the drop folder it owns, and the root-owned peer-sync-apply (fixed path, no arguments, allowed by the
  # sudoers file install-sync-helper.sh wrote) then runs AS the target user and pulls from it.
  [[ -d "$DROP" && -w "$DROP" ]] || { echo "Drop folder $DROP is missing or not writable; run install-sync-helper.sh first." >&2; exit 1; }
  [[ "$INSTALL" -eq 1 ]] || echo "    (--no-install is ignored in helper mode: npm ci runs only when package-lock.json changed)"
  echo "==> Staging CodeNomad $SOURCE -> $DROP"
  stage_to "$DROP"
  chmod -R a+rX "$DROP"
  echo "==> Applying as $TARGET_USER (no password)"
  if ! sudo -n -u "$TARGET_USER" "$HELPER_APPLY"; then
    echo "    ERROR: the passwordless apply step failed or was refused. If it asked for a password, re-run:" >&2
    echo "      sudo $SELF_DIR/install-sync-helper.sh --admin $(id -un) --user $TARGET_USER" >&2
    exit 1
  fi
fi

[[ "$RESTART" -eq 1 ]] || exit 0
if [[ ! -f "$PLIST" ]]; then
  echo "No LaunchDaemon $PLIST; run setup-codenomad-user.sh --user $TARGET_USER first." >&2
  exit 1
fi
echo "==> Restarting system/$LABEL"
if [[ "$EUID" -eq 0 ]]; then
  launchctl kickstart -k "system/$LABEL" || { echo "    ERROR: kickstart failed; the new build is in place but not running." >&2; exit 1; }
else
  # Fixed command and arguments, the same kind of sudoers rule as the Prestix restart.
  sudo -n /bin/launchctl kickstart -k "system/$LABEL" || { echo "    ERROR: restart refused or failed; the new build is in place but not running." >&2; exit 1; }
fi

[[ "$WAIT" -eq 1 ]] || exit 0
PORT="$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments" "$PLIST" 2>/dev/null | awk 'found { gsub(/ /, ""); print; exit } /--http-port/ { found = 1 }')"
[[ -n "$PORT" ]] || { echo "    (could not read --http-port from $PLIST; skipping health check)"; exit 0; }

NODE_BIN="$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$PLIST" 2>/dev/null || true)"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
# Reads JSON on stdin and prints the value at a dotted path ("" when absent).
json_get() {
  "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];process.stdout.write(v==null?"":String(v))}catch(e){}})' "$1"
}

STAMP_FILE="$SOURCE/packages/server/build-stamp.json"
EXPECT_ID=""
EXPECT_AT=""
if [[ -f "$STAMP_FILE" && -n "$NODE_BIN" ]]; then
  EXPECT_ID="$(json_get id < "$STAMP_FILE" || true)"
  EXPECT_AT="$(json_get builtAt < "$STAMP_FILE" || true)"
fi

# Wait until the instance answers AND reports the new build. Right after a restart the old process can still answer
# for a moment, so a mismatch is only called stale once the wait runs out.
up=0
running_id=""
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/auth/status"; then
    up=1
    if [[ -z "$EXPECT_ID" ]]; then
      echo "    OK $TARGET_USER :$PORT (no build-stamp.json in the source, so the running build was not compared)"
      exit 0
    fi
    body="$(curl -fs "http://127.0.0.1:$PORT/api/build-stamp" 2>/dev/null || true)"
    running_id="$(printf '%s' "$body" | json_get build.id || true)"
    running_at="$(printf '%s' "$body" | json_get build.builtAt || true)"
    if [[ "$running_id" == "$EXPECT_ID" && "$running_at" == "$EXPECT_AT" ]]; then
      echo "    OK $TARGET_USER :$PORT running build ${EXPECT_ID:0:8} (built $EXPECT_AT)"
      exit 0
    fi
  fi
  sleep 2
done
if [[ "$up" -eq 1 ]]; then
  shown="${running_id:0:8}"
  echo "    STALE $TARGET_USER :$PORT answers but reports build ${shown:-none (no stamp)}; expected ${EXPECT_ID:0:8}." >&2
  exit 3
fi
echo "    ERROR: $TARGET_USER :$PORT did not answer within 60s; see $TARGET_HOME/Library/Logs/codenomad/server.err.log" >&2
exit 1
