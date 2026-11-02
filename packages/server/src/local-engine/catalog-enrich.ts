/**
 * Fills in what the Claude Code (Rust) catalog leaves out. `--catalog` only
 * lists model ids, so the model picker had no context size, cost or
 * capabilities for them: no capability icons, and the capability / Free
 * filters hid every model. This looks each id up in the model-sync cache
 * (preferring the provider the agent's baseUrl points at) and, for an Ollama
 * endpoint, asks Ollama directly (`/api/show`) for ids the cache doesn't have.
 */
import type { RustCatalog } from "./rust-runner.js"
import type { SyncedModel, ModelSyncResult } from "../model-sync/service.js"
import type { OllamaModelConfig } from "../model-sync/providers/ollama.js"

export type CatalogModelDetails = Pick<SyncedModel, "limit" | "cost" | "capabilities"> &
  Partial<Pick<SyncedModel, "status" | "lastTested" | "errorDetails">> & {
    /** The model-sync provider the details came from, e.g. "ollama". */
    detailsFrom: string
  }

export type EnrichedRustCatalog = Omit<RustCatalog, "models"> & {
  models: Array<{ id: string; name?: string } & Partial<CatalogModelDetails>>
}

/** Model-sync provider ids an agent baseUrl most likely points at. */
const BASE_URL_PROVIDERS: Array<[RegExp, string]> = [
  [/:11434\b|ollama/i, "ollama"],
  [/openrouter\.ai/i, "openrouter"],
  [/nvidia\.com/i, "nvidia"],
  [/anthropic\.com/i, "anthropic"],
  [/api\.openai\.com/i, "openai"],
  [/googleapis\.com|generativelanguage/i, "google"],
  [/nousresearch/i, "nous"],
  [/opencode\.ai/i, "opencode-go"],
]

export function providerForBaseUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null
  for (const [pattern, providerId] of BASE_URL_PROVIDERS) {
    if (pattern.test(baseUrl)) return providerId
  }
  return null
}

/** Ollama host (no /v1 suffix) for an OpenAI-compatible Ollama baseUrl. */
export function ollamaHostFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl || providerForBaseUrl(baseUrl) !== "ollama") return undefined
  return baseUrl.replace(/\/+$/, "").replace(/\/(v1|api)$/, "")
}

function toDetails(model: SyncedModel | OllamaModelConfig, providerId: string): CatalogModelDetails {
  const synced = model as Partial<SyncedModel>
  return {
    limit: model.limit,
    cost: model.cost,
    capabilities: model.capabilities,
    ...(synced.status ? { status: synced.status } : {}),
    ...(synced.lastTested ? { lastTested: synced.lastTested } : {}),
    ...(synced.errorDetails ? { errorDetails: synced.errorDetails } : {}),
    detailsFrom: providerId,
  }
}

/**
 * Details for one catalog id. Order: the baseUrl's provider, then Ollama,
 * then any provider that lists the same id. Ids may carry a provider prefix
 * ("ollama/qwen3:8b"), which is also tried without it.
 */
export function findModelDetails(
  modelId: string,
  syncResults: ModelSyncResult[],
  preferredProvider: string | null,
): CatalogModelDetails | null {
  const candidates = [modelId]
  const slash = modelId.indexOf("/")
  if (slash > 0) candidates.push(modelId.slice(slash + 1))

  const order = [
    ...syncResults.filter((r) => r.providerId === preferredProvider),
    ...syncResults.filter((r) => r.providerId === "ollama" && r.providerId !== preferredProvider),
    ...syncResults.filter((r) => r.providerId !== preferredProvider && r.providerId !== "ollama"),
  ]
  for (const id of candidates) {
    for (const result of order) {
      const match = result.models.find((m) => m.id === id && Boolean(m.capabilities))
      if (match) return toDetails(match, result.providerId)
    }
  }
  return null
}

export async function enrichRustCatalog(
  catalog: RustCatalog,
  deps: {
    syncResults: () => ModelSyncResult[]
    fetchOllamaModels: (host?: string) => Promise<OllamaModelConfig[]>
  },
): Promise<EnrichedRustCatalog> {
  const preferred = providerForBaseUrl(catalog.baseUrl)
  const syncResults = deps.syncResults()
  const models: EnrichedRustCatalog["models"] = catalog.models.map((model) => ({
    ...model,
    ...(findModelDetails(model.id, syncResults, preferred) ?? {}),
  }))

  // Ollama endpoint and some ids still unknown (never synced, or pulled since):
  // ask Ollama itself. One /api/tags + /api/show per model, ~1s for 30 models.
  const missing = models.filter((m) => !m.capabilities)
  if (missing.length > 0 && preferred === "ollama") {
    try {
      const live = await deps.fetchOllamaModels(ollamaHostFromBaseUrl(catalog.baseUrl))
      const byId = new Map(live.map((m) => [m.id, m]))
      for (const model of missing) {
        const found = byId.get(model.id) ?? byId.get(model.id.slice(model.id.indexOf("/") + 1))
        if (found) Object.assign(model, toDetails(found, "ollama"))
      }
    } catch {
      // Ollama unreachable: leave these models without details.
    }
  }

  return { ...catalog, models }
}
