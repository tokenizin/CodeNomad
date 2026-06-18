# Local LLM Adapter (Prompt Model Picker)

**Goal:** Surface locally running Ollama models in the CodeNomad prompt model picker without changing speech provider defaults.

## Architecture

Local LLM discovery is separate from speech STT/TTS:

1. **Server** (`packages/server/src/local-llm/service.ts`)
   - Queries `GET {OLLAMA_BASE_URL}/api/tags` (default `http://localhost:11434`)
   - Returns a normalized `LocalLlmModelsResponse`

2. **API route** (`GET /api/local-llm/models`)
   - Registered in `packages/server/src/server/routes/local-llm.ts`

3. **UI merge** (`packages/ui/src/lib/local-llm-providers.ts`)
   - Fetches local models from the CodeNomad server
   - Merges them into the OpenCode provider list used by the model selector

4. **Session stores**
   - `fetchProviders()` in `session-api.ts` merges local models into `providers()` in `session-state.ts`
   - `session-models.ts` exports `LOCAL_LLM_PROVIDER_ID` (`ollama`) and `isLocalLlmProvider()`

5. **OpenCode config** (`.opencode/opencode.jsonc`)
   - Declares the `ollama` provider so selected local models can actually run prompts

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama host for model discovery |
| `OLLAMA_MODEL` | `gemma4:latest` | Preferred default local model id |

## Validation

```bash
cd packages/server
bunx tsc --noEmit
node --import tsx --test src/local-llm/service.test.ts
```

With Ollama running:

```bash
curl http://localhost:11434/api/tags
curl http://localhost:9899/api/local-llm/models
```

Then open the model picker in a workspace — **Ollama (local)** models should appear alongside cloud providers.

## Notes

- Speech settings remain **OpenAI-compatible only**; this adapter does not change speech defaults.
- OpenCode must list models in `opencode.jsonc` for agentic tool use; the UI merge supplements discovery from the live Ollama install.
