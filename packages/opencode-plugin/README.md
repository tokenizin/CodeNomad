# CodeNomad OpenCode Plugin

## TLDR
Packaged OpenCode plugin injected into every OpenCode instance that CodeNomad launches. It provides the CodeNomad bridge for local event exchange between the CLI server and OpenCode.

## What it is
An npm-packable plugin package. Production builds ship a local `.tgz` and inject it through `OPENCODE_CONFIG_CONTENT`; dev runs reference the TypeScript plugin entry directly with a `file://` URL.

## How it works
- CodeNomad sets `OPENCODE_CONFIG_CONTENT` when spawning each OpenCode instance (`packages/server/src/workspaces/manager.ts`).
- The server packs this package during build (`packages/server/scripts/package-opencode-plugin.mjs`).
- OpenCode loads the plugin from `plugin` entries injected into the config content.
- The `CodeNomadPlugin` reads `CODENOMAD_INSTANCE_ID` + `CODENOMAD_BASE_URL`, connects to `GET /workspaces/:id/plugin/events`, and posts to `POST /workspaces/:id/plugin/event` (`packages/opencode-plugin/plugin/lib/client.ts`).
- The server exposes the plugin routes and maps events into the UI SSE pipeline (`packages/server/src/server/routes/plugin.ts`, `packages/server/src/plugins/handlers.ts`).

## Ollama quota fallback
- The plugin's `event` hook watches for `session.error`. When the error looks like a rate-limit/quota/token-limit failure (HTTP 429/402, or a message matching "rate limit", "quota", "insufficient credits", etc.) it automatically replays the session's last user turn on the local Ollama model instead of leaving the session dead.
- This means a subagent pinned to a free-tier cloud model (e.g. `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`) that runs out of quota for the period keeps working locally instead of erroring out.
- Fallback model defaults to `qwen3.6:latest` (36B MoE, 262k context, tool calling + reasoning + vision — the most capable all-rounder in the local Ollama library, able to cover the same tools/instructions as any cloud-backed agent). Override with `CODENOMAD_OLLAMA_FALLBACK_MODEL`; the Ollama host defaults to `OLLAMA_BASE_URL` (`http://127.0.0.1:11434`).
- Requires the target project's `opencode.json` to already declare an `ollama` provider with that model (this repo's root `opencode.json` does). If Ollama is unreachable or the provider/model isn't recognized, the attempt just logs and leaves the session in its original errored state — it never throws into the host process.
- Logic lives in `packages/opencode-plugin/plugin/lib/ollama-fallback.ts`; wired into the `event` hook in `packages/opencode-plugin/plugin/codenomad.ts`.

## Expectations
- Local-only bridge (no auth/token yet).
- Plugin must fail startup if it cannot connect after 3 retries.
- Keep plugin entrypoints thin; put shared logic under `plugin/lib/` to avoid autoloaded helpers.
- Keep event shapes small and explicit; use `type` + `properties` only.

## Ideas
- Add feature modules under `plugin/lib/features/` (tool lifecycle, permission prompts, custom commands).
- Expand `/workspaces/:id/plugin/*` with dedicated endpoints as needed.
- Promote stable event shapes and version tags once the protocol settles.

## Pointers
- Plugin entry: `packages/opencode-plugin/plugin/codenomad.ts`
- Plugin client: `packages/opencode-plugin/plugin/lib/client.ts`
- Plugin server routes: `packages/server/src/server/routes/plugin.ts`
- Plugin event handling: `packages/server/src/plugins/handlers.ts`
- Workspace env injection: `packages/server/src/workspaces/manager.ts`
