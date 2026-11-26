---
description: Check the local Kiri-hosted Matriza instance (health, containers, blob, sidecar)
agent: matriza-local
---

Verify the parallel local Matriza deployment and report its state:

1. `curl -fsS http://127.0.0.1:9934/api/health` — expect HTTP 200 and `blobBackend: minio`.
2. `docker --context kiri compose -f /Users/alexshapiro/matriza/docker-compose.yml ps` — app, db and blob containers must be Up.
3. `cd /Users/alexshapiro/matriza && bun test && bunx tsc --noEmit --incremental false` — 100% pass.
4. Confirm the `matriza` sidecar is registered in `~/.config/codenomad/config.yaml` and `starworld/scripts/sidecar-registry.ts`.
5. Check `tasks/blocked/BLOCKER-2026-11-26-matriza-cloudflare-ingress.md` and report AC-4 live-ingress status honestly.

Do not touch the Vercel deployment and do not print secrets from `.env*` or the CodeNomad config.
