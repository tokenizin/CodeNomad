#!/bin/bash
# Apply a staged CodeNomad build to THIS user's instance. Run as the per-user account (e.g. stas), never as root.
#
# install-sync-helper.sh copies this file to /usr/local/libexec/codenomad/peer-sync-apply (owned by root, not
# writable by anyone else) and adds a sudoers rule that lets the admin run exactly that path, with no arguments, as
# the per-user account:   sudo -n -u stas /usr/local/libexec/codenomad/peer-sync-apply
# The admin's sync-codenomad-user.sh first copies the build into /Users/Shared/codenomad-sync/<user>, a folder only the
# admin can write. This script then pulls from it into ~/CodeNomad as the user, so root never touches the user's
# home and no root-run code comes from a folder the admin can edit.
#
# Everything is derived from who is running it: there are no arguments and no environment settings to steer it.
# Runs on macOS's bash 3.2.
set -euo pipefail

fail() { echo "peer-sync-apply: $*" >&2; exit 1; }

[[ "$(id -u)" -ne 0 ]] || fail "run it as the instance's own user, not root"
ME="$(id -un)"
HOME_DIR="$(dscl . -read "/Users/$ME" NFSHomeDirectory | awk '{print $2}')"
[[ -n "$HOME_DIR" && -d "$HOME_DIR" ]] || fail "cannot find the home folder of $ME"
DROP="/Users/Shared/codenomad-sync/$ME"
INSTALL_DIR="$HOME_DIR/CodeNomad"
PLIST="/Library/LaunchDaemons/com.tokenizin.codenomad.$ME.plist"

[[ -f "$PLIST" ]] || fail "there is no per-user CodeNomad job for $ME ($PLIST)"
[[ -f "$DROP/packages/server/src/index.ts" ]] || fail "nothing is staged in $DROP"

lock_hash() { [[ -f "$1" ]] && shasum "$1" | awk '{print $1}' || echo "none"; }
LOCK_BEFORE="$(lock_hash "$INSTALL_DIR/package-lock.json")"

echo "    applying $DROP -> $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
# node_modules and dist stay as they are: npm ci owns node_modules here, and dist is not used.
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git --exclude .env --exclude '.env.*' \
  --exclude tasks --exclude evidences --exclude temp --exclude .nomadworks \
  "$DROP"/ "$INSTALL_DIR"/
# Vendored, git-tracked node_modules (for example Git Graph's vscode shim) that npm ci does not recreate.
while IFS= read -r vendored; do
  mkdir -p "$INSTALL_DIR/$vendored"
  rsync -a --delete "$DROP/$vendored/" "$INSTALL_DIR/$vendored/"
done < <(cd "$DROP" && find packages/*/resources -type d -name node_modules -prune 2>/dev/null)
# Built artifacts the server serves: the UI bundle and the OpenCode plugin tarball.
for built in packages/server/public packages/server/dist/opencode-plugin; do
  if [[ -d "$DROP/$built" ]]; then
    mkdir -p "$INSTALL_DIR/$built"
    rsync -a --delete "$DROP/$built/" "$INSTALL_DIR/$built/"
  fi
done

LOCK_AFTER="$(lock_hash "$INSTALL_DIR/package-lock.json")"
if [[ "$LOCK_BEFORE" != "$LOCK_AFTER" || ! -d "$INSTALL_DIR/node_modules" ]]; then
  # Same node the user's LaunchDaemon runs with.
  NODE_BIN="$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$PLIST" 2>/dev/null || true)"
  [[ -x "$NODE_BIN" ]] || NODE_BIN="/opt/homebrew/bin/node"
  echo "    dependencies changed or not installed yet; running npm ci"
  NODE_DIR="$(dirname "$NODE_BIN")"
  export HOME="$HOME_DIR"
  export PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  (cd "$INSTALL_DIR" && npm ci)
else
  echo "    dependencies unchanged; skipping npm ci"
fi
echo "    applied"
