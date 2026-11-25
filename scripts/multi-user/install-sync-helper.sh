#!/usr/bin/env bash
# One-time setup so build-restart can sync per-user CodeNomad instances WITHOUT a sudo password.
#
# Run once from the admin account (it asks for your password this one time):
#   sudo scripts/multi-user/install-sync-helper.sh --admin alexshapiro --user stas [--user other ...]
# Re-run it with the full list of users to change who is covered. Remove everything with --uninstall.
#
# What it installs, and why this is safe to leave passwordless:
#   /usr/local/libexec/codenomad/peer-sync-apply   a copy of peer-sync-apply.sh owned by root and not writable by anyone
#                                                  else. It is NOT run from your repo: a password-free rule on a file you
#                                                  can edit would give root to anything running as you.
#   /Users/Shared/codenomad-sync/<user>            drop folder only the admin can write. The build is copied here.
#   /etc/sudoers.d/codenomad-sync                  checked with `visudo -cf` before it is put in place. For the admin
#                                                  only, and only these exact commands, no wildcards:
#                                                    - run peer-sync-apply, with no arguments, AS <user>
#                                                    - /bin/launchctl kickstart -k system/com.tokenizin.codenomad.<user>
# Nothing runs as root from a folder you can edit, and root never writes into <user>'s home: the apply step runs as
# <user> and pulls from the drop folder itself. Both commands are things the admin account could already do by typing
# its password; this only removes the prompt for these exact commands.
#
# Usage: sudo install-sync-helper.sh --admin <name> --user <name> [--user <name> ...]
#        sudo install-sync-helper.sh --uninstall
set -euo pipefail

ADMIN="${SUDO_USER:-}"
USERS=()
UNINSTALL=0
# DESTDIR is the usual packaging prefix; it is only for testing the install without touching the real system.
DESTDIR="${DESTDIR:-}"
HELPER_DIR="/usr/local/libexec/codenomad"
HELPER="$HELPER_DIR/peer-sync-apply"
DROP_ROOT="/Users/Shared/codenomad-sync"
SUDOERS="/etc/sudoers.d/codenomad-sync"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

fail() { echo "install-sync-helper: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin) ADMIN="$2"; shift 2 ;;
    --user) USERS+=("$2"); shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ "$EUID" -eq 0 ]] || fail "run it with sudo"
ROOT_GROUP="$(id -gn 0)"

if [[ "$UNINSTALL" -eq 1 ]]; then
  rm -f "$DESTDIR$SUDOERS" "$DESTDIR$HELPER"
  rmdir "$DESTDIR$HELPER_DIR" 2>/dev/null || true
  echo "Removed $SUDOERS and $HELPER."
  echo "Staged copies remain in $DROP_ROOT (delete it yourself if you want them gone)."
  exit 0
fi

NAME_RE='^[a-z_][a-z0-9_-]*$'
[[ -n "$ADMIN" ]] || fail "--admin is required (the account that runs build-restart)"
[[ "$ADMIN" =~ $NAME_RE ]] || fail "invalid admin name: $ADMIN"
[[ "$ADMIN" != "root" ]] || fail "the admin must not be root"
id "$ADMIN" >/dev/null 2>&1 || fail "no such user: $ADMIN"
[[ ${#USERS[@]} -gt 0 ]] || fail "at least one --user is required"
for u in "${USERS[@]}"; do
  [[ "$u" =~ $NAME_RE ]] || fail "invalid user name: $u"
  [[ "$u" != "root" && "$u" != "$ADMIN" ]] || fail "--user must be a different, non-root account: $u"
  id "$u" >/dev/null 2>&1 || fail "no such user: $u"
  [[ -f "/Library/LaunchDaemons/com.tokenizin.codenomad.$u.plist" ]] \
    || echo "note: no /Library/LaunchDaemons/com.tokenizin.codenomad.$u.plist yet; run setup-codenomad-user.sh --user $u before syncing."
done
[[ -f "$SCRIPT_DIR/peer-sync-apply.sh" ]] || fail "peer-sync-apply.sh not found next to this script"

install -d -m 755 -o root -g "$ROOT_GROUP" "$DESTDIR$HELPER_DIR"
install -m 755 -o root -g "$ROOT_GROUP" "$SCRIPT_DIR/peer-sync-apply.sh" "$DESTDIR$HELPER"
install -d -m 755 -o root -g "$ROOT_GROUP" "$DESTDIR$DROP_ROOT"
ADMIN_GROUP="$(id -gn "$ADMIN")"
for u in "${USERS[@]}"; do
  install -d -m 755 -o "$ADMIN" -g "$ADMIN_GROUP" "$DESTDIR$DROP_ROOT/$u"
done

RUNAS=""
RESTARTS=""
for u in "${USERS[@]}"; do
  RUNAS="${RUNAS:+$RUNAS, }$u"
  RESTARTS="${RESTARTS:+$RESTARTS, \\
    }/bin/launchctl kickstart -k system/com.tokenizin.codenomad.$u"
done

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
cat >"$TMP" <<EOF
# Managed by CodeNomad/scripts/multi-user/install-sync-helper.sh. Re-run it to change this; do not edit by hand.
# For ${ADMIN} only, and only these exact commands (no wildcards):
#   - run the root-owned peer-sync-apply, with no arguments, as a per-user account
#   - restart that account's CodeNomad LaunchDaemon
Cmnd_Alias CODENOMAD_PEER_APPLY = $HELPER ""
Cmnd_Alias CODENOMAD_PEER_RESTART = $RESTARTS
$ADMIN ALL=($RUNAS) NOPASSWD: CODENOMAD_PEER_APPLY
$ADMIN ALL=(root) NOPASSWD: CODENOMAD_PEER_RESTART
EOF
chmod 440 "$TMP"
# A broken sudoers file can lock everyone out of sudo, so never install one that does not parse.
visudo -cf "$TMP" >/dev/null || { visudo -cf "$TMP" >&2 || true; fail "generated sudoers file is invalid; nothing was installed"; }
install -d -m 755 -o root -g "$ROOT_GROUP" "$DESTDIR$(dirname "$SUDOERS")"
install -m 440 -o root -g "$ROOT_GROUP" "$TMP" "$DESTDIR$SUDOERS"

echo "Installed for admin '$ADMIN', users: ${USERS[*]}"
echo "  $HELPER"
echo "  $SUDOERS"
echo "  $DROP_ROOT/<user>   (one drop folder per user)"
echo ""
echo "Check it, as $ADMIN with NO password prompt. It should say nothing is staged yet (exit 1), not ask for a password:"
echo "  sudo -n -u ${USERS[0]} $HELPER; echo exit=\$?"
