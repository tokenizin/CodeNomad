#!/usr/bin/env bash
# Provision a separate CodeNomad instance for another macOS user on the same machine.
#
# Each person gets:
#   - their own CodeNomad server process, running as their macOS user (file-permission silo)
#   - their own config, auth.json (username/password), sessions and NomadWorks tasks
#   - access to the host's shared Ollama models over http://127.0.0.1:11434 (read-only API use)
#   - their own public hostname via the existing Cloudflare tunnel
#
# Run on the Mac Studio from an admin account:
#   sudo scripts/multi-user/setup-codenomad-user.sh --user stas --port 9990
#
# Re-running is safe: it rebuilds, rewrites the launchd job and only replaces the password if you enter one.
set -euo pipefail

TARGET_USER=""
PORT="9990"
HOSTNAME_OVERRIDE=""
SOURCE_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OLLAMA_URL="http://127.0.0.1:11434"

usage() {
  cat <<EOF
Usage: sudo $0 --user <macos-user> [--port 9990] [--hostname codenomad-<user>.tokenizin.com] [--source <repo>]

  --user      Existing macOS account that will own the instance (required)
  --port      Loopback HTTP port for this instance (default 9990; must be unused)
  --hostname  Public hostname routed through the tunnel (default codenomad-<user>.tokenizin.com; keep it one level
              under tokenizin.com so Cloudflare Universal SSL covers it)
  --source    CodeNomad checkout to copy from (default: this repository)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) TARGET_USER="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --hostname) HOSTNAME_OVERRIDE="$2"; shift 2 ;;
    --source) SOURCE_REPO="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

[[ -n "$TARGET_USER" ]] || { usage; exit 1; }
[[ "$(uname)" == "Darwin" ]] || { echo "This script targets macOS." >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
id "$TARGET_USER" >/dev/null 2>&1 || { echo "macOS user '$TARGET_USER' does not exist." >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "--port must be a number." >&2; exit 1; }

PUBLIC_HOST="${HOSTNAME_OVERRIDE:-codenomad-${TARGET_USER}.tokenizin.com}"
TARGET_HOME="$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory | awk '{print $2}')"
TARGET_GROUP="$(id -gn "$TARGET_USER")"
INSTALL_DIR="$TARGET_HOME/CodeNomad"
CONFIG_DIR="$TARGET_HOME/.config/codenomad"
WORKSPACE_ROOT="$TARGET_HOME/Projects"
LOG_DIR="$TARGET_HOME/Library/Logs/codenomad"
LABEL="com.tokenizin.codenomad.${TARGET_USER}"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"

as_user() { sudo -u "$TARGET_USER" -H env HOME="$TARGET_HOME" PATH="$USER_PATH" "$@"; }

# Node must live outside the admin's home (nvm/volta installs there are not readable by other users).
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" || "$NODE_BIN" == /Users/* ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [[ -z "$NODE_BIN" || "$NODE_BIN" == /Users/* ]]; then
  echo "Need a system-wide Node (e.g. 'brew install node'); found: ${NODE_BIN:-none}" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
USER_PATH="$TARGET_HOME/.opencode/bin:$TARGET_HOME/.local/bin:$TARGET_HOME/.bun/bin:$TARGET_HOME/.cargo/bin:$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "system/$LABEL" >/dev/null 2>&1; then
  echo "Port $PORT is already in use by another process; pick another with --port." >&2
  exit 1
fi

echo "==> Locking down $TARGET_HOME (owner-only access)"
chmod 700 "$TARGET_HOME"

echo "==> Copying CodeNomad from $SOURCE_REPO to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$WORKSPACE_ROOT" "$LOG_DIR"
# Same copy as every later build-restart (source, vendored node_modules, built UI/plugin); this script then
# installs dependencies, builds and installs the launchd job itself.
bash "$SOURCE_REPO/scripts/multi-user/sync-codenomad-user.sh" --user "$TARGET_USER" --source "$SOURCE_REPO" --mode root --no-install --no-restart
chown -R "$TARGET_USER:$TARGET_GROUP" "$INSTALL_DIR" "$TARGET_HOME/.config" "$WORKSPACE_ROOT" "$LOG_DIR"
chmod 700 "$CONFIG_DIR"

echo "==> Installing dependencies and building (as $TARGET_USER)"
as_user bash -c "cd '$INSTALL_DIR' && npm ci && npm run build --prefix packages/server"

# Run the server from source via tsx. packages/server/tsconfig.json sets rootDir to "../../../..", so the
# compiled output lands under a path-dependent folder (e.g. dist/stas/CodeNomad/...) that cannot find
# dist/server/routes/auth-pages or packages/server/public. The source entry finds both; the build above
# is still needed because it puts the UI bundle into packages/server/public.
TSX_CLI="$INSTALL_DIR/node_modules/tsx/dist/cli.mjs"
SERVER_ENTRY="$INSTALL_DIR/packages/server/src/index.ts"
for required in "$TSX_CLI" "$SERVER_ENTRY" "$INSTALL_DIR/packages/server/public/index.html"; do
  [[ -f "$required" ]] || { echo "Missing $required after the build; aborting before installing the launchd job." >&2; exit 1; }
done

echo "==> Migrating the admin's OpenCode setup to $TARGET_USER (models, agents, subagents, plugins, MCP, tools)"
# OpenCode only reads the open workspace's .opencode/ and ~/.config/opencode/, so without this the model and
# agent pickers are empty. Runs as root because the admin's configs and agent prompts live in the admin's home.
OPENCODE_DIR="$TARGET_HOME/.config/opencode"
ADMIN_USER="${SUDO_USER:-}"
ADMIN_HOME=""
[[ -n "$ADMIN_USER" && "$ADMIN_USER" != "root" ]] && ADMIN_HOME="$(dscl . -read "/Users/$ADMIN_USER" NFSHomeDirectory | awk '{print $2}')"
if [[ -z "$ADMIN_HOME" || ! -d "$ADMIN_HOME" ]]; then
  echo "WARNING: could not tell whose OpenCode setup to copy (run this script with sudo from the admin account); skipping." >&2
else
  migrate_opencode="y"
  if [[ -f "$OPENCODE_DIR/opencode.json" || -f "$OPENCODE_DIR/opencode.jsonc" ]]; then
    read -r -p "$OPENCODE_DIR already has a config. Replace it with $ADMIN_USER's setup (old one kept as .bak)? [y/N] " migrate_opencode
  fi
  if [[ "$migrate_opencode" =~ ^[Yy]$ ]]; then
    for existing in "$OPENCODE_DIR/opencode.json" "$OPENCODE_DIR/opencode.jsonc"; do
      [[ -f "$existing" ]] && mv "$existing" "$existing.bak"
    done
    read -r -p "Also copy $ADMIN_USER's API keys/tokens and OpenCode logins (shares your paid accounts)? [y/N] " share_secrets
    secrets_flag=()
    [[ "$share_secrets" =~ ^[Yy]$ ]] && secrets_flag=(--with-secrets)
    "$NODE_BIN" "$INSTALL_DIR/scripts/multi-user/migrate-opencode-setup.mjs" \
      --admin-home "$ADMIN_HOME" --target "$OPENCODE_DIR" ${secrets_flag[@]+"${secrets_flag[@]}"}
    chown -R "$TARGET_USER:$TARGET_GROUP" "$OPENCODE_DIR"
    [[ -d "$TARGET_HOME/.local" ]] && chown -R "$TARGET_USER:$TARGET_GROUP" "$TARGET_HOME/.local"
  fi
fi

echo "==> Local engine (Claude Code Rust playground) for $TARGET_USER"
# /api/local-engine needs a build-your-own-claude-code checkout (playground/rust/your_program.sh) and an agent
# roster. Copy the admin's checkout without build output (cargo rebuilds on first run) and point the roster at the
# migrated OpenCode config, which holds every agent and subagent.
PLAYGROUND_DIR="$TARGET_HOME/0-claudecode/build-your-own-claude-code"
PLAYGROUND_SRC=""
for candidate in "${ADMIN_HOME:-/nonexistent}/0-claudecode/build-your-own-claude-code" \
  "$(dirname "$SOURCE_REPO")/0-claudecode/build-your-own-claude-code" \
  "$(dirname "$(dirname "$SOURCE_REPO")")/0-claudecode/build-your-own-claude-code"; do
  if [[ -f "$candidate/playground/rust/your_program.sh" ]]; then PLAYGROUND_SRC="$candidate"; break; fi
done
if [[ -n "$PLAYGROUND_SRC" ]]; then
  mkdir -p "$PLAYGROUND_DIR"
  rsync -a --delete --exclude target --exclude node_modules --exclude .env --exclude '.env.*' \
    "$PLAYGROUND_SRC"/ "$PLAYGROUND_DIR"/
  chown -R "$TARGET_USER:$TARGET_GROUP" "$TARGET_HOME/0-claudecode"
  echo "    copied $PLAYGROUND_SRC -> $PLAYGROUND_DIR"
elif [[ ! -f "$PLAYGROUND_DIR/playground/rust/your_program.sh" ]]; then
  echo "WARNING: no build-your-own-claude-code checkout found; the local engine will report 'Claude Code (Rust) not found'." >&2
fi
ROSTER=""
for candidate in "$TARGET_HOME/.config/opencode/opencode.json" "$TARGET_HOME/.config/opencode/opencode.jsonc"; do
  if [[ -f "$candidate" ]]; then ROSTER="$candidate"; break; fi
done
for tool in cargo bun; do
  if ! as_user bash -c "command -v $tool" >/dev/null 2>&1; then
    echo "WARNING: '$tool' is not on $TARGET_USER's PATH; the local engine needs it (see scripts/multi-user/README.md)." >&2
  fi
done
LOCAL_ENGINE_ENV=""
[[ -f "$PLAYGROUND_DIR/playground/rust/your_program.sh" ]] && LOCAL_ENGINE_ENV+="    <key>CLAUDE_CODE_PLAYGROUND</key><string>${PLAYGROUND_DIR}</string>
"
[[ -n "$ROSTER" ]] && LOCAL_ENGINE_ENV+="    <key>CLAUDE_CODE_ROSTER</key><string>${ROSTER}</string>
"

echo "==> Setting the CodeNomad login for $TARGET_USER"
if [[ -f "$CONFIG_DIR/auth.json" ]]; then
  read -r -p "auth.json exists. Replace the password? [y/N] " replace
else
  replace="y"
fi
if [[ "$replace" =~ ^[Yy]$ ]]; then
  while true; do
    read -r -s -p "New CodeNomad password for '$TARGET_USER' (min 8 chars): " pw1; echo
    read -r -s -p "Repeat password: " pw2; echo
    [[ "$pw1" == "$pw2" && ${#pw1} -ge 8 ]] && break
    echo "Passwords did not match or were shorter than 8 characters; try again."
  done
  # Same scrypt record format as packages/server/src/auth/password-hash.ts; password goes over stdin, never argv.
  printf '%s' "$pw1" | as_user "$NODE_BIN" -e '
    const crypto = require("crypto"), fs = require("fs");
    const [file, username] = process.argv.slice(1);
    const password = fs.readFileSync(0, "utf8");
    const params = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64, params);
    const record = { version: 1, username, userProvided: true, updatedAt: new Date().toISOString(),
      password: { algorithm: "scrypt", saltBase64: salt.toString("base64"), hashBase64: hash.toString("base64"), keyLength: 64, params } };
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  ' "$CONFIG_DIR/auth.json" "$TARGET_USER"
  unset pw1 pw2
fi

echo "==> Writing launchd job $PLIST (runs as $TARGET_USER, starts at boot, no GUI login needed)"
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>UserName</key><string>${TARGET_USER}</string>
  <key>GroupName</key><string>${TARGET_GROUP}</string>
  <key>WorkingDirectory</key><string>${WORKSPACE_ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${TSX_CLI}</string>
    <string>${SERVER_ENTRY}</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--http</string><string>true</string>
    <string>--https</string><string>false</string>
    <string>--http-port</string><string>${PORT}</string>
    <string>--workspace-root</string><string>${WORKSPACE_ROOT}</string>
    <string>--config</string><string>${CONFIG_DIR}/config.yaml</string>
    <string>--username</string><string>${TARGET_USER}</string>
    <string>--ui-no-update</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${TARGET_HOME}</string>
    <key>USER</key><string>${TARGET_USER}</string>
    <key>PATH</key><string>${USER_PATH}</string>
    <key>CODENOMAD_AUTH_PROVIDER</key><string>password</string>
    <key>CODENOMAD_PUBLIC_URL</key><string>https://${PUBLIC_HOST}</string>
    <key>CODENOMAD_AUTH_COOKIE_NAME</key><string>codenomad_session_${TARGET_USER}</string>
    <key>TUNNEL_PUBLIC_URL</key><string>https://${PUBLIC_HOST}</string>
    <key>OLLAMA_BASE_URL</key><string>${OLLAMA_URL}</string>
    <key>OLLAMA_HOST</key><string>${OLLAMA_URL}</string>
${LOCAL_ENGINE_ENV}  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOG_DIR}/server.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/server.err.log</string>
</dict>
</plist>
PLIST
chown root:wheel "$PLIST"
chmod 644 "$PLIST"

# bootout returns before launchd has finished removing the job; bootstrapping while it is still loaded
# fails with "Bootstrap failed: 5: Input/output error". Wait until it is gone, then retry briefly.
if launchctl print "system/$LABEL" >/dev/null 2>&1; then
  echo "==> Unloading the previous launchd job"
  launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    launchctl print "system/$LABEL" >/dev/null 2>&1 || break
    sleep 1
  done
fi
bootstrapped=false
for _ in 1 2 3 4 5; do
  if launchctl bootstrap system "$PLIST" 2>/dev/null; then bootstrapped=true; break; fi
  sleep 2
done
if [[ "$bootstrapped" != true ]]; then
  launchctl bootstrap system "$PLIST" || {
    echo "launchctl could not load $PLIST. Try: sudo launchctl bootout system/$LABEL; sleep 5; sudo launchctl bootstrap system $PLIST" >&2
    exit 1
  }
fi

echo "==> Waiting for the server on 127.0.0.1:$PORT"
for _ in $(seq 1 45); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/auth/status" && break
  sleep 2
done
if curl -fsS "http://127.0.0.1:$PORT/api/auth/status"; then
  echo
else
  echo "Server did not answer on port $PORT. launchd state:" >&2
  launchctl print "system/$LABEL" 2>&1 | grep -E "state =|last exit|runs =" >&2 || true
  echo "--- last lines of $LOG_DIR/server.err.log:" >&2
  tail -n 40 "$LOG_DIR/server.err.log" >&2 2>/dev/null || true
  echo "--- last lines of $LOG_DIR/server.log:" >&2
  tail -n 20 "$LOG_DIR/server.log" >&2 2>/dev/null || true
  exit 1
fi

if ! curl -fsS -o /dev/null "$OLLAMA_URL/api/tags"; then
  echo "WARNING: Ollama is not answering at $OLLAMA_URL. Shared models need the host's Ollama running." >&2
fi
if ! as_user bash -c 'command -v opencode' >/dev/null; then
  echo "WARNING: 'opencode' is not on $TARGET_USER's PATH. Install it as $TARGET_USER (or 'brew install opencode') before opening workspaces." >&2
fi

cat <<EOF

Done. Remaining one-time step (tunnel), as the admin who owns the cloudflared tunnel:

  1. Add this ingress rule above the catch-all in your cloudflared config (or scripts/sync-tunnel-ingress.sh):
       - hostname: ${PUBLIC_HOST}
         service: http://127.0.0.1:${PORT}
  2. Create the DNS record:   cloudflared tunnel route dns <tunnel-name> ${PUBLIC_HOST}
  3. Restart cloudflared, then open https://${PUBLIC_HOST} and sign in as '${TARGET_USER}'.

Logs:      ${LOG_DIR}/server.log
Restart:   sudo launchctl kickstart -k system/${LABEL}
Remove:    sudo launchctl bootout system/${LABEL} && sudo rm ${PLIST}
EOF
