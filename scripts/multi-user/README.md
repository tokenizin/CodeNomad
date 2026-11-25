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

## Give an instance its own look (UI skin)

Set `CODENOMAD_UI_SKIN` in the user's LaunchDaemon to give that instance its own skin; other instances are unaffected.
`matriza` is the dark theme of matriza.vercel.app (near-black, gold and purple, Lato) over a turning gold globe, with
the spinning Tokenizin logo, on both the sign-in page and the app. It keeps dark mode on.

```bash
sudo /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:CODENOMAD_UI_SKIN string matriza" /Library/LaunchDaemons/com.tokenizin.codenomad.stas.plist
sudo launchctl bootout system/com.tokenizin.codenomad.stas
sudo launchctl bootstrap system /Library/LaunchDaemons/com.tokenizin.codenomad.stas.plist
```

`kickstart -k` is not enough here: it restarts the job with the definition launchd already loaded, so a changed
environment needs `bootout` + `bootstrap`. If `bootstrap` fails with `5: Input/output error`, the job was still being
unloaded; wait a few seconds and run it again. The instance needs a build that includes the skin (sync it as below).
Unknown names are ignored with a warning.

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

Per-user instances run their own copy in `~<user>/CodeNomad`, so a build in the admin's checkout doesn't reach them by itself (Prestix runs straight from the admin's tree). `sync-codenomad-user.sh` copies the source, the vendored `resources/*/node_modules`, the built UI bundle (`packages/server/public`), the OpenCode plugin (`packages/server/dist/opencode-plugin`) and `build-stamp.json`. It runs `npm ci` as the user only when `package-lock.json` changed, kickstarts `system/com.tokenizin.codenomad.<user>`, then waits until the instance reports the build that was just made:

```bash
scripts/multi-user/sync-codenomad-user.sh --user stas
```

Exit status: `0` synced and running the new build; `3` restarted but still reporting another build (**stale**); `1` failed. StarWorld's `bun run codenomad:build-restart` runs this for every `/Library/LaunchDaemons/com.tokenizin.codenomad.<user>.plist` after it restarts Tokenizin and Prestix, and turns a `3` or `1` into an alert without stopping the rest of the deploy. It doesn't re-run the OpenCode migration, so per-user config edits (such as disabled MCP servers) are kept.

### Build stamp

`npm run build` ends by writing `packages/server/build-stamp.json` (commit, branch, uncommitted-changes flag, build time; git-ignored). A server reads it once at startup and reports it on `GET /api/build-stamp`, so the stamp describes the build the process was *started* from. The route needs no login but answers only a direct loopback request: anything carrying a proxy or tunnel header (`X-Forwarded-*`, `Forwarded`, `Cf-Connecting-Ip`, `Cf-Ray`, `Cf-Visitor`) gets a 404, so it isn't published through the tunnel.

### Passwordless sync (one-time)

Without this, the sync asks for your sudo password (or fails with no terminal). Install it once:

```bash
sudo scripts/multi-user/install-sync-helper.sh --admin alexshapiro --user stas
```

Give it every per-user account each time you run it. It installs a root-owned copy of `peer-sync-apply.sh` in `/usr/local/libexec/codenomad/`, a drop folder `/Users/Shared/codenomad-sync/<user>` that only the admin can write, and `/etc/sudoers.d/codenomad-sync` (checked with `visudo -cf` before it is used). The sudoers file allows the admin exactly two things, with no wildcards: run that helper, with no arguments, as `<user>`; and `/bin/launchctl kickstart -k system/com.tokenizin.codenomad.<user>`.

Why it is safe to leave passwordless:
- Nothing runs as root from a folder you can edit (a password-free rule on a script inside your repo would hand root to anything running as you), and root never writes into `<user>`'s home: the admin copies the build into the drop folder, and the helper then runs *as `<user>`* and pulls from it.
- Both commands are things the admin account can already do by typing its password; this removes the prompt for those exact commands only.
- The helper accepts no arguments and is steered by nothing but who runs it, so it can't be pointed at another path or user.

Check it (no password prompt; it should say nothing is staged yet and exit 1):

```bash
sudo -n -u stas /usr/local/libexec/codenomad/peer-sync-apply; echo exit=$?
```

Remove it with `sudo scripts/multi-user/install-sync-helper.sh --uninstall`.
