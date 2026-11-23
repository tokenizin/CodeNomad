/**
 * Pure, locally testable Model Sync module (SCR-2026-11-23-001, TASK-2026-11-23-004).
 *
 * Dependency-free row mapping + search/filter/grouping logic for the CodeNomad
 * Model Sync panel. No Solid / DOM / fetch runtime dependencies — pure functions
 * and types only, so they can be unit-tested with `node:test`.
 */

export type ModelSyncFilter = "all" | "capabilities" | "provider" | "model" | "id" | "category"

export interface ModelCapabilities {
  tools: boolean
  image: boolean
  video: boolean
  reasoning: boolean
  audio: boolean
  cloud: boolean
}

export interface SyncedModelRow {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  contextWindow: string
  capabilities: ModelCapabilities
  status: string
  type: string
  lastTested: number | null
  errorDetails?: string
}

export interface ProviderGroup {
  providerId: string
  providerName: string
  models: SyncedModelRow[]
}

export interface ModelFilterOptions {
  /** Free-text search across provider/model/model-id/context-window. Empty/blank → no filtering. */
  search?: string
  /** Active filter kind. Defaults to "all". */
  filter?: ModelSyncFilter
  /** Provider id to restrict rows to (provider selector). `null`/undefined → no restriction. */
  providerId?: string | null
}

export const CAPABILITY_KEYS = ["tools", "image", "video", "reasoning", "audio", "cloud"] as const
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  tools: false,
  image: false,
  video: false,
  reasoning: false,
  audio: false,
  cloud: false,
}

export function formatContext(ctx: number): string {
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`
  if (ctx >= 1000) return `${(ctx / 1000).toFixed(0)}K`
  return String(ctx)
}

export function rowsFromSyncResults(results: readonly unknown[] | null | undefined): SyncedModelRow[] {
  const rows: SyncedModelRow[] = []
  for (const r of results ?? []) {
    const result = r as { providerId?: string; providerName?: string; models?: unknown }
    const models = result?.models as unknown[] | undefined
    if (!models) continue
    const providerId = String(result?.providerId ?? "")
    const providerName = String(result?.providerName ?? result?.providerId ?? "")
    for (const m of models) {
      const model = m as Record<string, unknown>
      const limit = (model.limit ?? undefined) as { context?: number; input?: number } | undefined
      rows.push({
        providerId,
        providerName,
        modelId: String(model.id ?? ""),
        modelName: String(model.name ?? model.id ?? ""),
        contextWindow: formatContext(Number(limit?.context ?? limit?.input ?? 0)) || "N/A",
        capabilities: (model.capabilities ?? DEFAULT_CAPABILITIES) as ModelCapabilities,
        status: String(model.status ?? "unknown"),
        type: String(model.source ?? "unknown"),
        lastTested: model.lastTested === null || model.lastTested === undefined ? null : Number(model.lastTested),
        errorDetails: (model.errorDetails as string | undefined) ?? undefined,
      })
    }
  }
  return rows
}

export function rowKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/** Case-insensitive substring match over provider/model/model-id/context window. Empty/blank query → true (no filtering). */
export function matchesSearch(model: SyncedModelRow, query: string | null | undefined): boolean {
  const q = (query ?? "").trim().toLowerCase()
  if (!q) return true
  return (
    model.providerName.toLowerCase().includes(q) ||
    model.modelName.toLowerCase().includes(q) ||
    model.modelId.toLowerCase().includes(q) ||
    model.contextWindow.toLowerCase().includes(q)
  )
}

/** True when the model has at least one enabled capability; with a capability query, true when enabled for that capability. */
export function hasCapability(model: SyncedModelRow, capability?: string): boolean {
  const caps = model.capabilities
  const enabled = CAPABILITY_KEYS.filter((k) => caps[k])
  const q = (capability ?? "").trim().toLowerCase()
  if (!q) return enabled.length > 0
  return enabled.some((k) => k === q || k.includes(q) || q.includes(k))
}

/**
 * Filter composition for the Model Sync panel.
 *
 * Semantics (REOPEN-AC-3: scoped filters do not fall back to broad matchesSearch):
 * - `all`          → free-text search over provider/model/id/context (P0-a).
 * - `capabilities` → capability-scoped (P1-b). Empty query = any enabled capability;
 *                    non-empty query matches enabled capability key (exact/substring).
 * - `provider`     → providerId scope ANDed with free-text search (P0-b).
 * - `model`        → field-scoped to modelName + modelId only. Empty query = no text filter.
 * - `id`           → field-scoped to modelId only. Empty query = no text filter.
 * - `category`     → field-scoped to row `type` (sync source/category label, e.g. "ollama",
 *                    "openai"). Empty query = no text filter.
 */
export function matchesFilter(
  model: SyncedModelRow,
  filter: ModelSyncFilter,
  query: string,
  providerId?: string | null,
): boolean {
  const q = (query ?? "").trim().toLowerCase()
  switch (filter) {
    case "all":
      // P0-a fix: free-text search applies even under the default "all" filter.
      return matchesSearch(model, query)
    case "capabilities":
      // P1-b fix: capability filter honors its own query/suggestions.
      return hasCapability(model, q)
    case "provider":
      // P0-b fix: provider filter is reachable and scoped by provider id, ANDed with search.
      if (providerId && model.providerId !== providerId) return false
      return matchesSearch(model, query)
    case "model":
      // REOPEN-AC-3: field-scoped to model name/id only; no broad matchesSearch fallback.
      return !q ? true : `${model.modelName} ${model.modelId}`.toLowerCase().includes(q)
    case "id":
      // REOPEN-AC-3: field-scoped to model id only; no broad matchesSearch fallback.
      return !q ? true : model.modelId.toLowerCase().includes(q)
    case "category":
      // REOPEN-AC-3: field-scoped to row.type (sync source/category) only; no broad fallback.
      return !q ? true : (model.type || "").toLowerCase().includes(q)
    default:
      return true
  }
}

export function providerGroups(models: readonly SyncedModelRow[], opts?: ModelFilterOptions): ProviderGroup[] {
  const search = opts?.search ?? ""
  const filter = opts?.filter ?? "all"
  const providerId = opts?.providerId ?? null

  const groups: ProviderGroup[] = []
  const byId = new Map<string, ProviderGroup>()
  for (const model of models ?? []) {
    if (providerId && model.providerId !== providerId) continue
    if (!matchesFilter(model, filter, search, providerId)) continue

    let group = byId.get(model.providerId)
    if (!group) {
      group = { providerId: model.providerId, providerName: model.providerName, models: [] }
      byId.set(model.providerId, group)
      groups.push(group)
    }
    group.models.push(model)
  }
  return groups
}

/**
 * "unknown" plus errorDetails means the model was tested but the result was
 * inconclusive. The server prefixes the details with the cause.
 */
export function inconclusiveKind(errorDetails?: string): "key" | "timeout" | "other" | null {
  if (!errorDetails) return null
  if (/^(No API key|Authentication error)/.test(errorDetails)) return "key"
  if (/^Timeout/.test(errorDetails)) return "timeout"
  return "other"
}
