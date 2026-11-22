import { Button } from "@kobalte/core/button"
import {
  createSignal,
  onMount,
  onCleanup,
  type Component,
  createMemo,
} from "solid-js"
import { Cpu, RefreshCw, Terminal, Image, Video, Brain, Music, Cloud, AlertCircle, AlertTriangle, CheckCircle, XCircle, Info, Globe, Sparkles, Star, KeyRound, Clock } from "lucide-solid"

import { useI18n } from "../../lib/i18n"
import type React from "react"

type ModelSyncStatus = "idle" | "syncing" | "testing" | "syncComplete" | "syncError"

interface SyncedModelRow {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  contextWindow: string
  capabilities: { tools: boolean; image: boolean; video: boolean; reasoning: boolean; audio: boolean; cloud: boolean }
  status: string
  type: string
  lastTested: number | null
  errorDetails?: string
}

// Group models by provider for the table
type ProviderGroup = {
  providerId: string
  providerName: string
  models: SyncedModelRow[]
}

function formatContext(ctx: number): string {
  return ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(1)}M` : ctx >= 1000 ? `${(ctx / 1000).toFixed(0)}K` : String(ctx)
}

function rowsFromSyncResults(results: any[]): SyncedModelRow[] {
  const rows: SyncedModelRow[] = []
  for (const r of results) {
    if (!r.models) continue
    for (const m of r.models) {
      rows.push({
        providerId: r.providerId,
        providerName: r.providerName,
        modelId: m.id,
        modelName: m.name,
        contextWindow: formatContext(m.limit?.context ?? 0) || "N/A",
        capabilities: m.capabilities || { tools: false, image: false, video: false, reasoning: false, audio: false, cloud: false },
        status: m.status || "unknown",
        type: m.source || "unknown",
        lastTested: m.lastTested ?? null,
        errorDetails: m.errorDetails ?? undefined,
      })
    }
  }
  return rows
}

const rowKey = (providerId: string, modelId: string) => `${providerId}/${modelId}`

// Category enum for model types
enum Category {
  Text = "text",
  Vision = "vision",
  Voice = "voice",
  Code = "code",
  Agent = "agent",
}

// Provider options for the dynamic dropdown
const PROVIDER_OPTIONS = [
  { value: "ollama", label: "Ollama" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  // add more providers as needed
]

// Search/filter helpers
function matchesSearch(model: SyncedModelRow, query: string): boolean {
  if (!query.trim()) return true
  const lower = query.toLowerCase()
  return (
    model.providerName.toLowerCase().includes(lower) ||
    model.modelName.toLowerCase().includes(lower) ||
    model.modelId.toLowerCase().includes(lower) ||
    model.contextWindow.toLowerCase().includes(lower)
  )
}

function matchesFilter(model: SyncedModelRow, filter: "capabilities" | "provider" | "model" | "id" | "category" | "all", query: string): boolean {
  if (filter === "all") return true
  switch (filter) {
    case "capabilities":
      // Show models that have at least one capability enabled
      return (
        model.capabilities.tools ||
        model.capabilities.image ||
        model.capabilities.video ||
        model.capabilities.reasoning ||
        model.capabilities.audio ||
        model.capabilities.cloud
      )
    case "provider":
      // Always show — filtered by search instead
      return true
    case "model":
      return matchesSearch(model, query)
    case "id":
      return model.modelId.toLowerCase().includes(query.toLowerCase())
    case "category":
      // Filter by model type containing the category keyword (case-insensitive)
      return (model.type || "").toLowerCase().includes(query.toLowerCase())
    default:
      return true
  }
}

// "unknown" plus errorDetails means the model was tested but the result was
// inconclusive. The server prefixes the details with the cause.
function inconclusiveKind(errorDetails?: string): "key" | "timeout" | "other" | null {
  if (!errorDetails) return null
  if (/^(No API key|Authentication error)/.test(errorDetails)) return "key"
  if (/^Timeout/.test(errorDetails)) return "timeout"
  return "other"
}

// Filter options mapping for search suggestions, keyed by filter type
const filterOptions: Record<
  "capabilities" | "provider" | "model" | "id" | "category" | "all",
  { label: string; options: string[] }
> = {
  capabilities: {
    label: "Capabilities",
    options: ["tools", "image", "video", "reasoning", "audio", "cloud"],
  },
  provider: {
    label: "Provider",
    options: ["ollama", "openai", "anthropic"],
  },
  model: {
    label: "Model",
    options: [], // populated dynamically from models
  },
  id: {
    label: "ID",
    options: [],
  },
  category: {
    label: "Category",
    options: ["favorite", "free", "require_credit", "active", "largest_context"],
  },
  all: {
    label: "All",
    options: [],
  },
}

// ModelIcon component that shows provider label + category icon
function ModelIcon({ providerId, type }: { providerId?: string; type?: string }) {
  // Provider name mapping
  const providerNames: Record<string, string> = {
    ollama: "Ollama",
    openai: "OpenAI",
    anthropic: "Anthropic",
  }

  // Category icon mapping
  const categoryIcons: Record<string, { icon: any; title: string }> = {
    text: { icon: Cpu, title: "Text" },
    vision: { icon: Image, title: "Vision" },
    voice: { icon: Music, title: "Voice" },
    code: { icon: Globe, title: "Code" },
    agent: { icon: Brain, title: "Agent" },
    favorite: { icon: Star, title: "Favorite" },
    free: { icon: Sparkles, title: "Free" },
    require_credit: { icon: Info, title: "Requires Credit" },
    active: { icon: CheckCircle, title: "Active" },
    largest_context: { icon: Info, title: "Largest Context" },
  }

  const providerLabel = providerNames[providerId ?? ""] || "Provider"
  const categoryInfo = categoryIcons[type ?? ""] || { icon: Info, title: "Unknown" }

  return (
    <span class="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-gray-400">
      <span title={providerLabel} class="text-xs opacity-70">
        {providerLabel.split("")[0]}
      </span>
      <categoryInfo.icon class="w-3 h-3" title={categoryInfo.title} />
    </span>
  )
}

export const ModelSyncSettingsSection: Component = () => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<ModelSyncStatus>("idle")
  const [lastSync, setLastSync] = createSignal<number | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [testSummary, setTestSummary] = createSignal<string | null>(null)
  const [models, setModels] = createSignal<SyncedModelRow[]>([])
  const [searchQuery, setSearchQuery] = createSignal<string>("")
  const [selectedFilter, setSelectedFilter] = createSignal<"capabilities" | "provider" | "model" | "id" | "category" | "all">("all")
  const [selectedProvider, setSelectedProvider] = createSignal<string | null>(null)

  const loadCached = async () => {
    try {
      const resp = await fetch("/api/model-sync/cached")
      if (!resp.ok) return
      const data = await resp.json()
      if (data?.results && Array.isArray(data.results)) {
        const cachedRows = rowsFromSyncResults(data.results)
        if (cachedRows.length > 0) setModels(cachedRows)
      }
    } catch {
      // Non-fatal — keep current table
    }
  }

  // Load cached results on mount, then poll every 5 seconds.
  // Polling pauses during sync/test so it doesn't overwrite in-flight rows.
  onMount(() => {
    void loadCached()
    const interval = setInterval(() => {
      if (status() === "idle") void loadCached()
    }, 5_000)
    onCleanup(() => clearInterval(interval))
  })

  const handleSyncModels = async () => {
    setStatus("syncing")
    setError(null)
    setModels([])
    try {
      const result = await fetch("/api/model-sync/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: [] }),
      })
      const data = await result.json()
      if (data && data.results) {
        setModels(rowsFromSyncResults(data.results))
      }
      setStatus("syncComplete")
      setLastSync(Date.now())

      // Dispatch event so model selector re-fetches providers with merged sync data
      window.dispatchEvent(new CustomEvent("model-sync-complete"))

      // Also persist synced models to opencode.json config
      try {
        await fetch("/api/model-sync/persist", { method: "POST" })
      } catch {
        // Non-fatal — persistence to config is best-effort
      }

      setTimeout(() => setStatus("idle"), 2000)
    } catch (e: unknown) {
      const err = e as Error
      setStatus("syncError")
      setError(err.message || "Sync failed")
      setTimeout(() => setStatus("idle"), 3000)
    }
  }

  const handleClearCache = async () => {
    try {
      await fetch("/api/model-sync/cache/clear", { method: "POST" })
      setLastSync(Date.now())
    } catch (e: unknown) {
      const err = e as Error
      setError(err.message || "Failed to clear cache")
    }
  }

  const handleTestModels = async () => {
    setStatus("testing")
    setError(null)
    setTestSummary(null)
    const snapshot = models()
    // Show every row as "testing" while the batch runs
    setModels(snapshot.map((m) => ({ ...m, status: "testing" })))
    try {
      // API keys are resolved server-side from env; none are sent from here
      const tests = snapshot.map((m) => ({
        providerId: m.providerId,
        modelId: m.modelId,
        timeoutMs: 15000,
      }))
      const result = await fetch("/api/model-sync/test/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tests, concurrency: Math.min(3, tests.length) }),
      })
      const data = await result.json()
      if (!result.ok) throw new Error(data?.error || `HTTP ${result.status}`)

      // Results come back in completion order, so match by provider/model, not index
      const byKey = new Map<string, any>()
      for (const r of data?.results ?? []) byKey.set(rowKey(r.providerId, r.modelId), r)

      // Drop models the server removed (provider returned 404/410)
      const removedCount = snapshot.filter((m) => byKey.get(rowKey(m.providerId, m.modelId))?.removed).length
      const updated = snapshot
        .filter((m) => !byKey.get(rowKey(m.providerId, m.modelId))?.removed)
        .map((m) => {
          const r = byKey.get(rowKey(m.providerId, m.modelId))
          if (!r) return m
          return {
            ...m,
            status: r.status,
            lastTested: r.testedAt ?? Date.now(),
            errorDetails: r.status === "available" ? undefined : r.errorDetails,
          }
        })

      setModels(updated)

      // Count only the rows this run tested
      const counts = { available: 0, noCredits: 0, error: 0, noKey: 0, notVerified: 0 }
      for (const m of updated) {
        const r = byKey.get(rowKey(m.providerId, m.modelId))
        if (!r) continue
        if (r.status === "available") counts.available++
        else if (r.status === "insufficient_funds") counts.noCredits++
        else if (r.status === "error") counts.error++
        else if (inconclusiveKind(r.errorDetails) === "key") counts.noKey++
        else counts.notVerified++
      }
      const parts = [t("settings.section.modelSync.summary.available", { count: counts.available })]
      if (counts.noKey) parts.push(t("settings.section.modelSync.summary.noKey", { count: counts.noKey }))
      if (counts.noCredits) parts.push(t("settings.section.modelSync.summary.noCredits", { count: counts.noCredits }))
      if (counts.error) parts.push(t("settings.section.modelSync.summary.error", { count: counts.error }))
      if (counts.notVerified) parts.push(t("settings.section.modelSync.summary.notVerified", { count: counts.notVerified }))
      setTestSummary(`${t("settings.section.modelSync.summary.tested", { count: byKey.size })} · ${parts.join(" · ")}`)

      // Statuses are saved on the server now; let the model selector refresh
      window.dispatchEvent(new CustomEvent("model-sync-complete"))
      if (removedCount > 0) {
        setError(`Removed ${removedCount} model(s) the provider no longer serves. Clear cache to bring them back.`)
      }
    } catch (e: unknown) {
      const err = e as Error
      setModels(snapshot) // restore previous statuses
      setError("Test failed: " + (err.message || "Unknown error"))
    } finally {
      setStatus("idle")
    }
  }

  // Test a single model by provider/model ID
  const testSingleModel = async (model: SyncedModelRow) => {
    setStatus("testing")
    setError(null)
    try {
      const result = await fetch("/api/model-sync/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: model.providerId,
          modelId: model.modelId,
          timeoutMs: 15000,
        }),
      })
      const data = await result.json()
      if (!result.ok) throw new Error(data?.error || `HTTP ${result.status}`)

      // Refresh the cached models to pick up the updated status from server-side applyModelTestResults
      window.dispatchEvent(new CustomEvent("model-sync-complete"))

      setStatus("idle")
    } catch (e: unknown) {
      const err = e as Error
      setError("Test failed: " + (err.message || "Unknown error"))
      setStatus("idle")
    }
  }

  const capabilityIcons = (caps: SyncedModelRow["capabilities"]) => {
    const icons: { icon: typeof Cpu; title: string; color: string }[] = []
    if (caps.tools) icons.push({ icon: Cpu, title: "Tools", color: "text-blue-400" })
    if (caps.image) icons.push({ icon: Image, title: "Vision", color: "text-green-400" })
    if (caps.video) icons.push({ icon: Video, title: "Video", color: "text-purple-400" })
    if (caps.reasoning) icons.push({ icon: Brain, title: "Reasoning", color: "text-orange-400" })
    if (caps.audio) icons.push({ icon: Music, title: "Audio", color: "text-pink-400" })
    if (caps.cloud) icons.push({ icon: Cloud, title: "Cloud", color: "text-cyan-400" })

    if (icons.length === 0) return <span class="text-muted-foreground text-xs">—</span>

    return (
      <div class="flex items-center gap-1">
        {icons.map((item, idx) => {
          const Icon = item.icon
          return (
            <div class="relative" title={item.title} {...{ key: idx }}>
              <Icon class="w-3.5 h-3.5 opacity-70 hover:opacity-100 transition-opacity" style={{ color: item.color }} />
            </div>
          )
        })}
      </div>
    )
  }

  const testModelButton = (model: SyncedModelRow) => {
    const isTesting = model.status === "testing"
    return (
      <Button
        class="selector-button selector-button-tertiary text-xs"
        disabled={isTesting || model.status === "unknown"}
        title={t("settings.section.modelSync.testModel.tooltip")}
        onClick={() => void testSingleModel(model)}
      >
        {isTesting ? (
          <span class="spinner spinner-tiny mr-1" />
        ) : (
          <RefreshCw class="w-3 h-3" />
        )}
        {isTesting ? "Testing" : t("settings.section.modelSync.testModel")}
      </Button>
    )
  }

  const statusBadgeColor = (modelStatus: string) => {
    const colors: Record<string, string> = {
      available: "text-green-400 bg-green-400/10",
      insufficient_funds: "text-yellow-400 bg-yellow-400/10",
      error: "text-red-400 bg-red-400/10",
      testing: "text-blue-400 bg-blue-400/10 animate-pulse",
    }
    return colors[modelStatus] || "text-gray-400 bg-gray-400/10"
  }

  // Status icon component - shows appropriate icon for each status, displays error details visibly
  function StatusIcon({ status, errorDetails }: { status?: string; errorDetails?: string }) {
    if (!status) return null

    // Tested, but the result says nothing about the model (no key, timeout,
    // unreachable). Still selectable, so grey; the icon says what to fix.
    const kind = status === "unknown" ? inconclusiveKind(errorDetails) : null
    if (kind) {
      const Icon = kind === "key" ? KeyRound : kind === "timeout" ? Clock : Info
      return (
        <span class="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-gray-400 bg-gray-400/10" title={errorDetails}>
          <Icon class="w-3 h-3" />
          {kind === "key" ? "Needs key" : "Not verified"}
        </span>
      )
    }

    const configs = {
      available: {
        icon: CheckCircle,
        color: "text-green-400 bg-green-400/10",
        title: "Model is available for use",
        label: "Available",
      },
      insufficient_funds: {
        icon: AlertTriangle,
        color: "text-yellow-400 bg-yellow-400/10",
        title: errorDetails || "Insufficient credits or quota exceeded",
        label: "No credits",
      },
      error: {
        icon: AlertCircle,
        color: "text-red-400 bg-red-400/10",
        title: errorDetails || "Model unavailable",
        label: "Error",
      },
      testing: {
        icon: Cpu,
        color: "text-blue-400 bg-blue-400/10 animate-pulse",
        title: "Model is being tested",
        label: "Testing",
      },
      unknown: {
        icon: Info,
        color: "text-gray-400 bg-gray-400/10",
        title: errorDetails || "Model status not yet tested",
        label: "Untested",
      },
    }

    const config = configs[status as keyof typeof configs]
    if (!config) return null

    const Icon = config.icon
    return (
      <span
        class={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${config.color}`}
        title={config.title}
      >
        <Icon class="w-3 h-3" />
        {config.label}
      </span>
    )
  }

  // Type icon component with generic fallback for unrecognized source values
  function TypeIcon({ type }: { type?: string }) {
    if (!type) return null

    const typeConfigs: Record<string, { icon: any; title: string; color: string }> = {
      star: { icon: Star, title: "Star", color: "text-yellow-400" },
      code: { icon: Globe, title: "Code", color: "text-blue-400" },
      voice: { icon: Music, title: "Voice", color: "text-pink-400" },
      image: { icon: Image, title: "Image", color: "text-green-400" },
      agent: { icon: Brain, title: "Agent", color: "text-orange-400" },
    }

    // Generic fallback for unrecognized source values
    const fallback: { icon: any; title: string; color: string } = {
      icon: Info,
      title: "Custom",
      color: "text-gray-500",
    }

    const config = typeConfigs[type.toLowerCase()] || fallback
    const Icon = config.icon
    return (
      <span
        class={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${config.color}`}
        title={config.title}
      >
        <Icon class="w-3 h-3" />
      </span>
    )
  }

  // Group models by provider for display, with search/filter applied
  const providerGroups = createMemo(() => {
    const groups: Record<string, ProviderGroup> = {}
    for (const model of models()) {
      // Apply filter and search
      if (!matchesFilter(model, selectedFilter(), searchQuery())) continue
      
      const existing = groups[model.providerId]
      if (existing) {
        existing.models.push(model)
      } else {
        groups[model.providerId] = {
          providerId: model.providerId,
          providerName: model.providerName,
          models: [model],
        }
      }
    }
    return Object.values(groups)
  })

  return (
    <div class="settings-section-stack">
      {/* Sync Controls Card */}
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <RefreshCw class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.section.modelSync.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.section.modelSync.subtitle")}</p>
            </div>
          </div>
        </div>

        <div class="settings-card-content">
          <div class="settings-action-bar">
            <Button
              class="selector-button selector-button-primary"
              disabled={status() === "syncing"}
              onClick={handleSyncModels}
            >
              {status() === "syncing" ? (
                <span class="spinner spinner-small" />
              ) : (
                <RefreshCw class="w-4 h-4 mr-2" />
              )}
              {t("settings.section.modelSync.syncButton")}
            </Button>

            <Button
              class="selector-button selector-button-secondary"
              disabled={status() !== "idle"}
              onClick={handleTestModels}
            >
              {t("settings.section.modelSync.testModelsButton")}
            </Button>

            <Button
              class="selector-button selector-button-secondary"
              disabled={status() !== "idle"}
              onClick={handleClearCache}
            >
              {t("settings.section.modelSync.clearCacheButton")}
            </Button>
          </div>

          {status() === "idle" && testSummary() && (
            <div class="settings-sync-status">
              <span>{testSummary()}</span>
            </div>
          )}

          {status() === "idle" && error() && (
            <div class="settings-sync-status">
              <span class="text-error">{error()}</span>
            </div>
          )}

          {status() !== "idle" && (
            <div class="settings-sync-status">
              {status() === "syncing" && <span>{t("settings.section.modelSync.syncing")}</span>}
              {status() === "syncComplete" && (
                <span>
                  {t("settings.section.modelSync.syncComplete")} {new Date(lastSync()!).toLocaleTimeString()}
                </span>
              )}
              {status() === "syncError" && (
                <span class="text-error">
                  {t("settings.section.modelSync.syncError")}: {error()}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Model List Card */}
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Terminal class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.section.modelSync.modelTitle")}</h3>
              <p class="settings-card-subtitle">{t("settings.section.modelSync.modelSubtitle")}</p>
            </div>
          </div>
        </div>

        <div class="settings-card-content">
          {models().length === 0 && status() === "syncComplete" && (
            <p class="text-muted-foreground">{t("settings.section.modelSync.noModelsYet")}</p>
          )}

          {models().length > 0 && (
            <div class="model-sync-table-wrapper">
              <div class="model-sync-filters-bar">
                <div class="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
                  {/* Search input */}
                  <div class="flex-1 sm:flex-order-1">
                    <input
                      type="text"
                      placeholder={t("settings.section.modelSync.search.placeholder")}
                      value={searchQuery()}
                      onInput={(e: Event) => setSearchQuery((e.target as HTMLInputElement | null)?.value ?? "")}
                      class="flex-1 input input-bordered w-full"
                    />
                  </div>
                  {/* Search suggestions popover - filter-aware options */}
                  {searchQuery() && (
                    <div
                      class="absolute left-0 mt-1 w-full rounded border bg-white shadow-sm z-10 overflow-auto"
                      style={{ height: '200px', width: 'calc(100% + 1rem)' }}
                    >
                      <div class="p-2 text-sm text-muted-foreground">
                        {filterOptions[selectedFilter()].label}:{" "}
                        {filterOptions[selectedFilter()].options
                          .slice(0, 5)
                          .map((opt) => (
                            <div
                              class="hover:text-primary cursor-pointer px-1 py-0.5 rounded"
                              onClick={() => {
                                setSearchQuery(opt)
                                setSelectedFilter(
                                  selectedFilter() === "model" || selectedFilter() === "category"
                                    ? "all"
                                    : selectedFilter()
                                )
                              }}
                            >
                              {opt}
                            </div>
                          ))}
                        {filterOptions[selectedFilter()].options.length > 5 && (
                          <div class="text-caption text-muted-foreground mt-1">
                            +{filterOptions[selectedFilter()].options.length - 5} more
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  
                  {/* Filter selector */}
                  <div class="sm:flex-order-2">
                    <select
                      value={selectedFilter()}
                      onChange={(e: Event) => setSelectedFilter((e.currentTarget as HTMLSelectElement).value as "capabilities" | "provider" | "model" | "id" | "category" | "all")}
                      class="select select-sm w-32"
                    >
                      <option value="all">{t("settings.section.modelSync.filter.provider")}</option>
                      <option value="capabilities">{t("settings.section.modelSync.filter.capabilities")}</option>
                      <option value="model">{t("settings.section.modelSync.filter.model")}</option>
                      <option value="id">{t("settings.section.modelSync.filter.id")}</option>
                      <option value="category">{t("settings.section.modelSync.filter.category")}</option>
                    </select>
                  {selectedFilter() === "provider" && (
                    <div class="flex items-center gap-2 mt-1">
                      <select
                        value={selectedProvider() ?? ""}
                        onChange={(e: Event) => setSelectedProvider((e.currentTarget as HTMLSelectElement).value || null)}
                        class="select select-xs w-24"
                      >
                        <option value="">-- Select Provider --</option>
                        {PROVIDER_OPTIONS.map((opt) => (
                          <option value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  </div>
                  
                  {/* Clear search */}
                  <button
                    onClick={() => setSearchQuery("")}
                    class="selector-button selector-button-tertiary text-xs sm:ml-2"
                    title={t("settings.section.modelSync.search.clear")}
                  >
                    {t("settings.section.modelSync.search.clear")}
                  </button>
                </div>
              </div>
              <table class="model-sync-table">
                <thead>
                  <tr>
                    <th style={{ color: "var(--text-muted)" }}>{t("settings.section.modelSync.provider")}</th>
                    <th style={{ color: "var(--text-muted)" }}>{t("settings.section.modelSync.modelName")}</th>
                    <th style={{ color: "var(--text-muted)" }}>{t("settings.section.modelSync.contextWindow")}</th>
                    <th style={{ color: "var(--text-muted)" }}>{t("settings.section.modelSync.capabilities")}</th>
                    <th style={{ color: "var(--text-muted)" }}>{t("settings.section.modelSync.status")}</th>
                    <th style={{ color: "var(--text-muted)" }}>{t("settings.section.modelSync.type")}</th>
                    <th style={{ color: "var(--text-muted)" }}>{t("settings.section.modelSync.lastTested")}</th>
                  </tr>
                </thead>
                <tbody>
                  {providerGroups().map((group: ProviderGroup) => (
                    <>
                      <tr {...{ key: group.providerId as unknown as React.Key }} class="provider-group">
                        <td colSpan={8} class="provider-header">
                          {t("settings.section.modelSync.provider")}: {group.providerName}
                        </td>
                      </tr>
                      {group.models.map((model: SyncedModelRow) => (
                          <tr {...{ key: `${model.providerId}-${model.modelId}` as unknown as React.Key }} class="model-row">
                          <td style={{ color: "var(--text-primary)" }}>{model.providerName}</td>
                          <td style={{ color: "var(--text-secondary)" }}>{model.modelName}</td>
                          <td style={{ color: "var(--text-secondary)" }}>{model.contextWindow}</td>
                          <td>{capabilityIcons(model.capabilities)}</td>
                          <td>
                            <StatusIcon status={model.status} errorDetails={model.errorDetails} />
                          </td>
                          <td>
                            <ModelIcon providerId={model.providerId} type={model.type} />
                          </td>
                          <td style={{ color: "var(--text-muted)" }}>
  {model.lastTested !== null && model.lastTested > 0 ? new Date(model.lastTested).toLocaleString() : "Never"}
</td>
                          <td>
                            {testModelButton(model)}
                          </td>
                        </tr>
                      ))}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {status() !== "syncComplete" && models().length === 0 && (
            <p class="text-muted-foreground text-sm">{t("settings.section.modelSync.waitingForSync")}</p>
          )}
        </div>
      </div>
    </div>
  )
}