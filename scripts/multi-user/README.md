# Per-person CodeNomad instances

`setup-codenomad-user.sh` gives another macOS user on the Mac Studio their own CodeNomad:

- runs as that macOS user via a system LaunchDaemon (`com.tokenizin.codenomad.<user>`), so it starts at boot without a GUI login
- own config, `auth.json` login, sessions, NomadWorks tasks and workspaces (`~<user>/Projects`); the user's home is locked to `700`
- shares the host's Ollama models over `http://127.0.0.1:11434` (no copies)
- migrates the admin's whole OpenCode setup with `migrate-opencode-setup.mjs` into `~<user>/.config/opencode/opencode.json`: providers and models, every agent and subagent, plugins, MCP servers, commands, skills, tools and instructions. It merges `~/.config/opencode`, `~/starworld`, `~/starworld/.opencode` and `~/starworld/CodeNomad/.opencode` in OpenCode's own precedence, copies every `{file:...}` prompt and auto-loaded folder (`agent(s)/`, `command(s)/`, `plugin(s)/`, `skill(s)/`, `tool(s)/` and so on), and rewrites paths so nothing points into the admin's home. Literal API keys and tokens are removed unless you answer yes to sharing them (`--with-secrets`, which also copies the admin's OpenCode `auth.json`). The run prints any `{env:VAR}` the user must provide and any MCP command still inside the admin's home. Run it standalone with `sudo node scripts/multi-user/migrate-opencode-setup.mjs --admin-home /Users/<admin> --target /Users/<user>/.config/opencode [--with-secrets] [--dry-run]`, then `chown -R <user> /Users/<user>/.config/opencode`.
- `CODENOMAD_AUTH_PROVIDER=password`: remote visitors see the CodeNomad username/password page instead of the StarGuard portal, and StarGuard JWTs are refused
- served at `https://codenomad-<user>.tokenizin.com` (one level under `tokenizin.com`, so Cloudflare's free Universal SSL certificate covers it; `<user>.codenomad.tokenizin.com` would not be covered) through the existing cloudflared tunnel (ingress + DNS steps are printed at the end)

```bash
sudo scripts/multi-user/setup-codenomad-user.sh --user stas --port 9990
```

Re-run the script to update the user's copy of CodeNomad after pulling new code; answer `N` to keep the current password.

## Lock the main (StarGuard) instance to its owner

The main `codenomad.tokenizin.com` instance accepts StarGuard sign-ins. Set this in its launch environment so only
the owner's account can open workspaces, the API, sidecars or a session:

```
CODENOMAD_OWNER_EMAILS=owner@example.com   # comma-separated, case-insensitive
```

Other StarGuard accounts get 403 at `/auth/starguard` and 401 on the CodeNomad API. StarWorld chat (`/api/tokidapp/*`)
still accepts any valid StarGuard account because it authorizes per user. If unset, startup logs a warning and any
valid StarGuard account is let in (the old behaviour).

## Local engine (Claude Code Rust)

`/api/local-engine` needs a `build-your-own-claude-code` checkout and an agent roster. The setup script copies the admin's `~/0-claudecode/build-your-own-claude-code` (without `target/`) to the user, and sets `CLAUDE_CODE_PLAYGROUND` and `CLAUDE_CODE_ROSTER` (the migrated `~/.config/opencode/opencode.json`) in the LaunchDaemon. The runner compiles with `cargo build --release` on first use and calls `bun`, so install both for the user:

```bash
sudo -u <user> -H sh -c 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y'
sudo -u <user> -H sh -c 'curl -fsSL https://bun.sh/install | bash'
```

## After every build: sync per-user instances

Per-user instances run their own copy in `~<user>/CodeNomad`, so a build in the admin's checkout doesn't reach them by itself (Prestix runs straight from the admin's tree). `sync-codenomad-user.sh` copies the source, the vendored `resources/*/node_modules`, and the built UI bundle (`packages/server/public`) and OpenCode plugin (`packages/server/dist/opencode-plugin`). It runs `npm ci` as the user only when `package-lock.json` changed, then kickstarts `system/com.tokenizin.codenomad.<user>`:

```bash
sudo scripts/multi-user/sync-codenomad-user.sh --user stas
```

StarWorld's `bun run codenomad:build-restart` does this automatically for every `/Library/LaunchDaemons/com.tokenizin.codenomad.<user>.plist` after it restarts Tokenizin and Prestix. It doesn't re-run the OpenCode migration, so per-user config edits (such as disabled MCP servers) are kept.
