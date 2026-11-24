# Per-person CodeNomad instances

`setup-codenomad-user.sh` gives another macOS user on the Mac Studio their own CodeNomad:

- runs as that macOS user via a system LaunchDaemon (`com.tokenizin.codenomad.<user>`), so it starts at boot without a GUI login
- own config, `auth.json` login, sessions, NomadWorks tasks and workspaces (`~<user>/Projects`); the user's home is locked to `700`
- shares the host's Ollama models over `http://127.0.0.1:11434` (no copies)
- `CODENOMAD_AUTH_PROVIDER=password`: remote visitors see the CodeNomad username/password page instead of the StarGuard portal, and StarGuard JWTs are refused
- served at `https://<user>.codenomad.tokenizin.com` through the existing cloudflared tunnel (ingress + DNS steps are printed at the end)

```bash
sudo scripts/multi-user/setup-codenomad-user.sh --user stas --port 9990
```

Re-run the script to update the user's copy of CodeNomad after pulling new code; answer `N` to keep the current password.
