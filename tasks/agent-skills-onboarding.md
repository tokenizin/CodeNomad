# TASK — Third-Party Agent-Skills Onboarding (Security-Gated)

Status: Active

Date: 2026-06-14

## Summary

Onboard a vetted subset of the `@tech-leads-club/agent-skills` catalog into this
repo (`.opencode/skills/`) and add the `agent-skills` MCP lookup server to
`.opencode/opencode.jsonc`, so NomadWorks/OpenCode agents gain `search_skills`
plus a shortlist of role-mapped skills. Third-party prompts are an untrusted
surface, so this task is **security-gated**: no install or config edit happens
until Gate 1 (security + content audit) passes.

## Discussion Record

- PO requested a review of an external recommendation to onboard
  `@tech-leads-club/agent-skills`.
- Recommendation was written for a *different* machine (`/home/user/...` at
  commit `a5aeecd`, "no MCP client" Rust engine, 45 skills, 7 MCP servers, no
  `.nomadworks/`). On **this** Mac Studio (`tokenizin/CodeNomad` @ `e1136027f`)
  the real state is: config = `.opencode/opencode.jsonc`; 3 skill dirs
  (`codenomad-architecture-guide`, `codenomad-build-restart`, `findmea-geo`);
  2 MCP entries (`infra_sme`, `dev_ops` — both chrome-devtools); 1680-commit
  writable git; no `.nomadworks/` here (lives in parent `starworld/`).
- Prerequisites verified green on this host: CDN reachable
  (`@tech-leads-club/agent-skills` → HTTP 200 from registry.npmjs.org);
  Node v26.8.1 / npx 11.19.0 satisfies the "Node 24+" gate.
- PO decision (alert): **path = security-gated task**.
- PO decision (alert): **skills scoped** = `tlc-spec-driven`, `the-jury`,
  `security-threat-model`, `harness-eval`, `mermaid-studio`
  (omitted `create-adr`/`create-technical-design-doc`/`subagent-creator` from
  the original shortlist; `code-reviewer`, `debugger`, `deep-research`,
  `not-your-babysitter` excluded as already-local or session-override risk).

## Target install (post-approval)

```
npx @tech-leads-club/agent-skills install -s tlc-spec-driven the-jury \
  security-threat-model harness-eval mermaid-studio -a opencode claude-code
```

- Install target must resolve to `.opencode/skills/` (the folder OpenCode reads).
  Confirm after install; copy there if the CLI writes elsewhere.
- MCP block to add to `.opencode/opencode.jsonc`:

  ```json
  "agent-skills": {
    "type": "local",
    "command": ["npx", "-y", "@tech-leads-club/agent-skills-mcp"],
    "enabled": true
  }
  ```

## Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| AC-1 | Gate 1: security + content audit of catalog + each SKILL.md issued a written verdict (approve / approve-with-changes / reject) with risk notes | `cso` audit report attached to this task |
| AC-2 | Only the 5 approved skills install; no other skills pulled in | `ls .opencode/skills/` shows exactly 3 existing + 5 new |
| AC-3 | Skills land in `.opencode/skills/` (the folder OpenCode reads) | Dir listing |
| AC-4 | `agent-skills` MCP block added to `.opencode/opencode.jsonc`; config still parses | `opencode` config load / jsonc parse check |
| AC-5 | Each new SKILL.md read before enabling; no unreviewed prompt is left live | Checklist in this task |
| AC-6 | 0 regressions to existing 3 skills + 2 MCP entries | No existing entries removed/altered except additive MCP block |
| AC-7 | `.gitignore` covers any generated/temp install artifacts | Review of `.gitignore` |
| AC-8 | Atomic commit: skills + config + doc/codemap update in one commit | `git show --stat` |

## Gates

### Gate 1 — Security & Content Audit (BLOCKING, investigation track)

Owner: `cso`

Scope: treat the catalog as an untrusted external surface. Review:
- `agent-skills` CLI: install footprint, network calls, any postinstall/telemetry.
- `agent-skills-mcp` server: what it exposes, auth/token flow, reachability.
- Each of the 5 skills' `SKILL.md`: prompt-injection risk, secret/credential
  handling, destructive-command risk, "session override" (e.g. never-interrupt)
  patterns that could conflict with PMA delegate-and-bounce-back protocol.
- Verdict per skill + overall: approve / approve-with-changes / reject.

No repo changes. Output written back to this task + Evidence Packet.

### Gate 2 — Install & Config (implementation track, only after Gate 1 passes)

Owner: `tech_lead` — install into `.opencode/skills/`, add MCP block to
`.opencode/opencode.jsonc`, update codemap/doc, 100% checks, atomic commit.

## Reopen History

(none yet)
