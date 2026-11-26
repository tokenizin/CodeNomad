---
description: Replicate any Vercel-hosted app into a like-for-like local Kiri stack (Postgres, MinIO, Cloudflare Tunnel, CodeNomad sidecar) via the dynamic vercel-mig-pm agent
agent: vercel-mig-pm
---

# /vercel-mig — CodeNomad mirror

Mirror of `/Users/alexshapiro/starworld/.opencode/command/vercel-mig.md` for the
CodeNomad command surface. Behaviour is identical; paths below are absolute
because the playbook and scripts live in the shared starworld checkout.

## Input grammar

```
/vercel-mig <site_url|repo_url|local_path> [--branch <branch>] [--vercel-project <project>] [--app-path <path>] [--dry-run]
```

`--dry-run` (and every script's default) performs no writes and no restarts.

## Workflow

1. Generate the run plan:
   ```
   bun /Users/alexshapiro/starworld/.opencode/skills/vercel-migration/scripts/discover.ts '<input>' [flags] --json
   ```
2. Brief the dynamic `vercel-mig-pm` agent with that plan AND the playbook at
   `/Users/alexshapiro/starworld/.opencode/skills/vercel-migration/SKILL.md` plus
   SCR `/Users/alexshapiro/matriza/docs/scrs/SCR-2026-11-26-002-vercel-mig-command.md`:
   ```
   Run /vercel-mig with plan: <paste discover.ts JSON>
   Playbook: /Users/alexshapiro/starworld/.opencode/skills/vercel-migration/SKILL.md
   SCR: /Users/alexshapiro/matriza/docs/scrs/SCR-2026-11-26-002-vercel-mig-command.md
   Derive the run-specific SCR, task file, numbered ACs, subagent prompts and
   dispatch manifest. Do not execute --apply steps until I approve the plan.
   ```
3. Emit the dispatch manifest with `dispatch-manifest.ts --plan <plan.json>`.
   Parallel discovery/spec/QA-design; serial runtime → data → infra; serial docs.
   When nested Task calls are unavailable, the invoking PMA executes the manifest.
4. Execute `apply.sh`, `migrate-data.ts` and `verify.ts` with `--apply` only after
   the PO approves the plan. Loop start → test → investigate until parity.
5. Deliver the evidence packet (`SUMMARY.md` + `logs/`, screenshots only for UI
   changes) and report. Never print secrets or mutate the live Vercel deployment,
   running containers, or `~/.config/codenomad/config.yaml` by hand.

All agents run on `opencode-go/hy4-flash-free`.
