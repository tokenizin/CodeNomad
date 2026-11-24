#!/usr/bin/env bash
# Sync a freshly built CodeNomad from the admin's checkout into a per-user instance and restart it.
#
# Per-user instances (setup-codenomad-user.sh) run their own copy in ~<user>/CodeNomad, so a build in the
# admin's checkout does not reach them by itself (Prestix runs straight from the admin's tree instead).
# This copies the source plus the built artifacts the server serves (UI bundle in packages/server/public,
# OpenCode plugin tarball in packages/server/dist/opencode-plugin), so the user's copy needs no rebuild.
# It runs `npm ci` as the user only when package-lock.json changed, then kickstarts the user's LaunchDaemon.
#
# Usage: sudo scripts/multi-user/sync-codenomad-user.sh --user stas [--source <CodeNomad checkout>]
#          [--no-install] [--no-restart] [--no-wait]
set -euo pipefail

TARGET_USER=""
SOURCE="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL=1
RESTART=1
WAIT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) TARGET_USER="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    --no-restart) RESTART=0; shift ;;
    --no-wait) WAIT=0; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$TARGET_USER" ]] || { echo "--user is required" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || { echo "Run with sudo (copies into another user's home)." >&2; exit 1; }
SOURCE="$(cd "$SOURCE" && pwd)"
id "$TARGET_USER" >/dev/null 2>&1 || { echo "macOS user '$TARGET_USER' does not exist." >&2; exit 1; }
[[ -f "$SOURCE/packages/server/src/index.ts" ]] || { echo "Not a CodeNomad checkout: $SOURCE" >&2; exit 1; }

TARGET_HOME="$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory | awk '{print $2}')"
TARGET_GROUP="$(id -gn "$TARGET_USER")"
INSTALL_DIR="$TARGET_HOME/CodeNomad"
LABEL="com.tokenizin.codenomad.${TARGET_USER}"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"

lock_hash() { [[ -f "$1" ]] && shasum "$1" | awk '{print $1}' || echo "none"; }
LOCK_BEFORE="$(lock_hash "$INSTALL_DIR/package-lock.json")"

echo "==> Syncing CodeNomad $SOURCE -> $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
# Source only: no node_modules (the user's own install), build output, local .env files or the admin's tasks/evidence.
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .env --exclude '.env.*' \
  --exclude tasks --exclude evidences --exclude temp --exclude .nomadworks \
  "$SOURCE"/ "$INSTALL_DIR"/
# The exclude above also drops vendored, git-tracked node_modules that npm ci does not recreate, e.g.
# packages/server/resources/git-graph/node_modules/vscode (the shim Git Graph's require("vscode") needs).
while IFS= read -r vendored; do
  mkdir -p "$INSTALL_DIR/$vendored"
  rsync -a --delete "$SOURCE/$vendored/" "$INSTALL_DIR/$vendored/"
done < <(cd "$SOURCE" && find packages/*/resources -type d -name node_modules -prune 2>/dev/null)
# Built artifacts the server serves: the UI bundle and the OpenCode plugin tarball (under the excluded dist/).
for built in packages/server/public packages/server/dist/opencode-plugin; do
  if [[ -d "$SOURCE/$built" ]]; then
    mkdir -p "$INSTALL_DIR/$built"
    rsync -a --delete "$SOURCE/$built/" "$INSTALL_DIR/$built/"
  else
    echo "    (no $built in the source yet; build CodeNomad first to ship it)"
  fi
done
chown -R "$TARGET_USER:$TARGET_GROUP" "$INSTALL_DIR"

if [[ "$INSTALL" -eq 1 ]]; then
  LOCK_AFTER="$(lock_hash "$INSTALL_DIR/package-lock.json")"
  if [[ "$LOCK_BEFORE" != "$LOCK_AFTER" || ! -d "$INSTALL_DIR/node_modules" ]]; then
    NODE_BIN="/opt/homebrew/bin/node"
    [[ -f "$PLIST" ]] && NODE_BIN="$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$PLIST" 2>/dev/null || echo "$NODE_BIN")"
    echo "==> Dependencies changed; running npm ci as $TARGET_USER"
    sudo -u "$TARGET_USER" -H env HOME="$TARGET_HOME" PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
      bash -c "cd '$INSTALL_DIR' && npm ci"
  else
    echo "==> Dependencies unchanged; skipping npm ci"
  fi
fi

[[ "$RESTART" -eq 1 ]] || exit 0
if ! launchctl print "system/$LABEL" >/dev/null 2>&1; then
  echo "No LaunchDaemon system/$LABEL loaded; run setup-codenomad-user.sh --user $TARGET_USER first." >&2
  exit 1
fi
echo "==> Restarting system/$LABEL"
launchctl kickstart -k "system/$LABEL"

[[ "$WAIT" -eq 1 ]] || exit 0
PORT="$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments" "$PLIST" 2>/dev/null | awk 'found { gsub(/ /, ""); print; exit } /--http-port/ { found = 1 }')"
[[ -n "$PORT" ]] || { echo "    (could not read --http-port from $PLIST; skipping health check)"; exit 0; }
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/auth/status"; then
    echo "    OK $TARGET_USER :$PORT"
    exit 0
  fi
  sleep 2
done
echo "    WARNING: $TARGET_USER :$PORT did not answer within 60s; see $TARGET_HOME/Library/Logs/codenomad/server.err.log" >&2
exit 1
