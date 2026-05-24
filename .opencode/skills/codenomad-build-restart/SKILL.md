---
name: codenomad-build-restart
description: Builds the CodeNomad server and UI package, then restarts the Mac mini tunnel on port 9899. Use after CodeNomad server/UI changes, auth or TokiDAPP route fixes, or when asked to rebuild and restart the tunnel for codenomad.tokenizin.com.
---

# CodeNomad build + tunnel restart

## Run from StarGuard repo root (`contracts/`)

```bash
bun run codenomad:build-restart
```

Or:

```bash
bash scripts/codenomad-build-restart.sh
```

## Steps

1. Build `@neuralnomads/codenomad` in `CodeNomad/` (last 8 log lines shown)
2. Restart tunnel via `scripts/start-codenomad-tunnel.sh --restart`

## After restart

- Verify: `curl -s http://127.0.0.1:9899/api/auth/status`
- Sessions are in-memory — users must redo StarGuard SSO launch if they get 401 on API calls.
