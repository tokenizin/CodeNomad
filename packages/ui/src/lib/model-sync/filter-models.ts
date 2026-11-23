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
  /** Raw context window in tokens (0 when unknown). */
  contextTokens?: number
  /** true when the provider reports a price of 0 for input and output; undefined when no price is known. */
  free?: boolean
  /** Hidden from this table via the actions menu (server-persisted). */
  hidden?: boolean
  /** Deactivated via the actions menu: kept out of the model picker (server-persisted). */
  deactivated?: boolean
  /** Derived category keys (see deriveModelCategories); used by the "category" filter. */
  categories?: ModelCategory[]
}

/**
 * Model categories shown in the Model Status table. None of these are stored
 * on the model: they are derived from real data each render, the same way the
 * model picker derives Favorite / Free / insufficient credit.
 */
export const MODEL_CATEGORIES = [
  "favorite",
  "free",
  "requires_credit",
  "available",
  "error",
  "untested",
  "largest_context",
  "deactivated",
  "hidden",
] as const
export type ModelCategory = (typeof MODEL_CATEGORIES)[number]

export function deriveModelCategories(
  row: SyncedModelRow,
  ctx: { favoriteKeys?: ReadonlySet<string>; largestContextKeys?: ReadonlySet<string> } = {},
): ModelCategory[] {
  const key = rowKey(row.providerId, row.modelId)
  const out: ModelCategory[] = []
  if (ctx.favoriteKeys?.has(key)) out.push("favorite")
  if (row.free === true) out.push("free")
  if (row.status === "insufficient_funds") out.push("requires_credit")
  else if (row.status === "available") out.push("available")
  else if (row.status === "error") out.push("error")
  else if (row.status === "unknown" && !row.lastTested) out.push("untested")
  if (ctx.largestContextKeys?.has(key)) out.push("largest_context")
  if (row.deactivated) out.push("deactivated")
  if (row.hidden) out.push("hidden")
  return out
}

/** Keys of the model(s) with the largest known context window in each provider. */
export function largestContextKeys(rows: readonly SyncedModelRow[]): Set<string> {
  const best = new Map<string, number>()
  for (const row of rows) {
    const tokens = row.contextTokens ?? 0
    if (tokens > (best.get(row.providerId) ?? 0)) best.set(row.providerId, tokens)
  }
  const keys = new Set<string>()
  for (const row of rows) {
    const max = best.get(row.providerId) ?? 0
    if (max > 0 && (row.contextTokens ?? 0) === max) keys.add(rowKey(row.providerId, row.modelId))
  }
  return keys
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
  /**
   * Capability toggles (icon bar). A model must have ALL of these enabled
   * (AND logic, same as the model picker). Empty/undefined → no restriction.
   */
  capabilities?: readonly CapabilityKey[]
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
      const cost = (model.cost ?? undefined) as { input?: number; output?: number } | undefined
      const contextTokens = Number(limit?.context ?? limit?.input ?? 0) || 0
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
        contextTokens,
        free: cost && typeof cost.input === "number" && typeof cost.output === "number" ? cost.input === 0 && cost.output === 0 : undefined,
        hidden: model.hidden === true || undefined,
        deactivated: model.deactivated === true || undefined,
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
 * - `category`     → field-scoped to the row's derived categories (favorite, free,
 *                    requires_credit, …; "_" may be typed as a space). Rows without
 *                    derived categories fall back to row `type`. Empty query = no text filter.
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
      // REOPEN-AC-3: field-scoped to categories (or row.type when none are derived); no broad fallback.
      if (!q) return true
      if (model.categories) {
        const wanted = q.replace(/\s+/g, "_")
        return model.categories.some((c) => c.includes(wanted))
      }
      return (model.type || "").toLowerCase().includes(q)
    default:
      return true
  }
}

export function providerGroups(models: readonly SyncedModelRow[], opts?: ModelFilterOptions): ProviderGroup[] {
  const search = opts?.search ?? ""
  const filter = opts?.filter ?? "all"
  const providerId = opts?.providerId ?? null
  const requiredCaps = opts?.capabilities ?? []

  const groups: ProviderGroup[] = []
  const byId = new Map<string, ProviderGroup>()
  for (const model of models ?? []) {
    if (providerId && model.providerId !== providerId) continue
    if (!matchesFilter(model, filter, search, providerId)) continue
    if (requiredCaps.length > 0 && !requiredCaps.every((cap) => model.capabilities?.[cap])) continue

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
