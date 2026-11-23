import { Button } from "@kobalte/core/button"
import {
  createSignal,
  onMount,
  onCleanup,
  type Component,
  createMemo,
  For,
} from "solid-js"
import { Cpu, RefreshCw, Terminal, Image, Video, Brain, Music, Cloud, AlertCircle, AlertTriangle, CheckCircle, Info, Globe, Star, KeyRound, Clock } from "lucide-solid"

import { useI18n, type TranslateParams } from "../../lib/i18n"
import type React from "react"
import {
  CAPABILITY_KEYS,
  inconclusiveKind,
  providerGroups,
  rowsFromSyncResults,
  rowKey,
  type ModelSyncFilter,
  type ProviderGroup,
  type SyncedModelRow,
} from "../../lib/model-sync/filter-models"
import { createModelSyncApi, type ModelSyncApi } from "../../lib/model-sync/api"

type ModelSyncStatus = "idle" | "syncing" | "testing" | "syncComplete" | "syncError"
type Translate = (key: string, params?: TranslateParams) => string

// i18n keys for the filter selector labels (values live in all 10 locale files).
const FILTER_LABEL_KEYS: Record<ModelSyncFilter, string> = {
  all: "settings.section.modelSync.filter.all",
  capabilities: "settings.section.modelSync.filter.capabilities",
  provider: "settings.section.modelSync.filter.provider",
  model: "settings.section.modelSync.filter.model",
  id: "settings.section.modelSync.filter.id",
  category: "settings.section.modelSync.filter.category",
}

// Type labels for the source/type icons. Unrecognized sources use the "custom" label.
const TYPE_LABEL_KEYS: Record<string, string> = {
  star: "settings.section.modelSync.type.star",
  code: "settings.section.modelSync.type.code",
  voice: "settings.section.modelSync.type.voice",
  image: "settings.section.modelSync.type.image",
  agent: "settings.section.modelSync.type.agent",
}

// ModelIcon component that shows provider label + category icon
function ModelIcon({ providerName, type, t }: { providerName?: string; type?: string; t: Translate }) {
  const label = providerName || t("settings.section.modelSync.provider")
  const categoryInfo = type
    ? { icon: Info, title: type }
    : { icon: Info, title: t("settings.section.modelSync.modelIcon.unknown") }

  return (
    <span class="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-gray-400">
      <span title={label} class="text-xs opacity-70">
        {label.split("")[0]}
      </span>
      <span title={categoryInfo.title}>
        <categoryInfo.icon class="w-3 h-3" />
      </span>
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
  const [selectedFilter, setSelectedFilter] = createSignal<ModelSyncFilter>("all")
  const [selectedProvider, setSelectedProvider] = createSignal<string | null>(null)
  // Search suggestion listbox state (P2-b / a11y)
  const [suggestionsOpen, setSuggestionsOpen] = createSignal(false)
  const [activeSuggestionIndex, setActiveSuggestionIndex] = createSignal(-1)
  let searchWrapRef: HTMLDivElement | undefined

  const modelSyncApi: ModelSyncApi = createModelSyncApi({ fetchImpl: (input, init) => fetch(input, init) })

  // Providers that currently have synced models (drives the provider filter).
  // REOPEN-AC-1: stable equality prevents option DOM churn/reset on poll refresh.
  const providerOptions = createMemo(
    () => {
      const byId = new Map<string, string>()
      for (const m of models()) byId.set(m.providerId, m.providerName)
      return Array.from(byId.entries()).map(([value, label]) => ({ value, label }))
    },
    [] as Array<{ value: string; label: string }>,
    {
      equals: (a, b) =>
        a.length === b.length && a.every((opt, i) => opt.value === b[i]?.value && opt.label === b[i]?.label),
    },
  )

  const handleClearFilters = () => {
    setSearchQuery("")
    setSelectedFilter("all")
    setSelectedProvider(null)
    setSuggestionsOpen(false)
    setActiveSuggestionIndex(-1)
  }

  const rowsSignature = (rows: SyncedModelRow[]) =>
    rows
      .map(
        (r) =>
          `${r.providerId}/${r.modelId}:${r.status}:${r.lastTested ?? ""}:${r.contextWindow}:${r.type}:${r.errorDetails ?? ""}`,
      )
      .join("|")

  const ensureProviderSelection = (rows: SyncedModelRow[]) => {
    const selected = selectedProvider()
    if (!selected) return
    const exists = rows.some((r) => r.providerId === selected)
    if (!exists) {
      // REOPEN-AC-1: provider disappeared from refreshed data — clear explicitly.
      setSelectedProvider(null)
    }
  }

  const loadCached = async () => {
    try {
      const data = await modelSyncApi.getCachedModels()
      const cachedRows = rowsFromSyncResults(data.results)
      if (cachedRows.length > 0) {
        // REOPEN-AC-1: avoid unnecessary signal churn so poll refresh does not reset UI state.
        if (rowsSignature(cachedRows) !== rowsSignature(models())) {
          setModels(cachedRows)
        }
        ensureProviderSelection(cachedRows)
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
    // REOPEN-AC-2: close suggestions on outside click without breaking option mousedown selection.
    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!searchWrapRef || !target) return
      if (!searchWrapRef.contains(target)) {
        setSuggestionsOpen(false)
        setActiveSuggestionIndex(-1)
      }
    }
    document.addEventListener("mousedown", handleDocumentMouseDown)
    onCleanup(() => {
      clearInterval(interval)
      document.removeEventListener("mousedown", handleDocumentMouseDown)
    })
  })

  const handleSyncModels = async () => {
    setStatus("syncing")
    setError(null)
    setModels([])
    try {
      const data = await modelSyncApi.syncModels({ providers: [] })
      const syncedRows = rowsFromSyncResults(data.results)
      setModels(syncedRows)
      ensureProviderSelection(syncedRows)
      setStatus("syncComplete")
      setLastSync(Date.now())

      // Dispatch event so model selector re-fetches providers with merged sync data
      window.dispatchEvent(new CustomEvent("model-sync-complete"))

      // Also persist synced models to opencode.json config
      try {
        await modelSyncApi.persist()
      } catch {
        // Non-fatal — persistence to config is best-effort
      }

      setTimeout(() => setStatus("idle"), 2000)
    } catch (e: unknown) {
      const err = e as Error
      setStatus("syncError")
      setError(err.message || t("settings.section.modelSync.syncError"))
      setTimeout(() => setStatus("idle"), 3000)
    }
  }

  const handleClearCache = async () => {
    try {
      await modelSyncApi.clearCache()
      setLastSync(Date.now())
    } catch (e: unknown) {
      const err = e as Error
      setError(err.message || t("settings.section.modelSync.clearCacheFailed"))
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
      const data = await modelSyncApi.testModels({ tests, concurrency: Math.min(3, tests.length) })

      // Results come back in completion order, so match by provider/model, not index
      const byKey = new Map<string, any>()
      for (const r of data.results) byKey.set(rowKey(r.providerId, r.modelId), r)

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
      ensureProviderSelection(updated)

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
        setError(t("settings.section.modelSync.sync.removed", { count: removedCount }))
      }
    } catch (e: unknown) {
      const err = e as Error
      setModels(snapshot) // restore previous statuses
      setError(t("settings.section.modelSync.testFailed", { message: err.message || t("settings.section.modelSync.unknownError") }))
    } finally {
      setStatus("idle")
    }
  }

  // Test a single model by provider/model ID. "unknown" rows are testable —
  // that is exactly the state we want to resolve.
  const testSingleModel = async (model: SyncedModelRow) => {
    setStatus("testing")
    setError(null)
    try {
      await modelSyncApi.testModel({ providerId: model.providerId, modelId: model.modelId, timeoutMs: 15000 })

      // Refresh the cached models so the tested row's status updates immediately.
      await loadCached()
      window.dispatchEvent(new CustomEvent("model-sync-complete"))

      setStatus("idle")
    } catch (e: unknown) {
      const err = e as Error
      setError(t("settings.section.modelSync.testFailed", { message: err.message || t("settings.section.modelSync.unknownError") }))
      setStatus("idle")
    }
  }

  const capabilityIcons = (caps: SyncedModelRow["capabilities"]) => {
    const icons: { icon: typeof Cpu; key: string; color: string }[] = []
    if (caps.tools) icons.push({ icon: Cpu, key: "settings.section.modelSync.capability.tools", color: "text-blue-400" })
    if (caps.image) icons.push({ icon: Image, key: "settings.section.modelSync.capability.image", color: "text-green-400" })
    if (caps.video) icons.push({ icon: Video, key: "settings.section.modelSync.capability.video", color: "text-purple-400" })
    if (caps.reasoning) icons.push({ icon: Brain, key: "settings.section.modelSync.capability.reasoning", color: "text-orange-400" })
    if (caps.audio) icons.push({ icon: Music, key: "settings.section.modelSync.capability.audio", color: "text-pink-400" })
    if (caps.cloud) icons.push({ icon: Cloud, key: "settings.section.modelSync.capability.cloud", color: "text-cyan-400" })

    if (icons.length === 0) return <span class="text-muted-foreground text-xs">—</span>

    return (
      <div class="flex items-center gap-1">
        {icons.map((item, idx) => {
          const Icon = item.icon
          return (
            <div class="relative" title={t(item.key)} {...{ key: idx }}>
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
        disabled={isTesting}
        title={t("settings.section.modelSync.testModel.tooltip")}
        onClick={() => void testSingleModel(model)}
      >
        {isTesting ? (
          <span class="spinner spinner-tiny mr-1" />
        ) : (
          <RefreshCw class="w-3 h-3" />
        )}
        {isTesting ? t("settings.section.modelSync.status.testing") : t("settings.section.modelSync.testModel")}
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
          {kind === "key" ? t("settings.section.modelSync.status.needsKey") : t("settings.section.modelSync.status.notVerified")}
        </span>
      )
    }

    const configs = {
      available: {
        icon: CheckCircle,
        color: "text-green-400 bg-green-400/10",
        title: errorDetails || t("settings.section.modelSync.status.available"),
        label: t("settings.section.modelSync.status.available"),
      },
      insufficient_funds: {
        icon: AlertTriangle,
        color: "text-yellow-400 bg-yellow-400/10",
        title: errorDetails || t("settings.section.modelSync.status.insufficientFunds"),
        label: t("settings.section.modelSync.status.insufficientFunds"),
      },
      error: {
        icon: AlertCircle,
        color: "text-red-400 bg-red-400/10",
        title: errorDetails || t("settings.section.modelSync.status.error"),
        label: t("settings.section.modelSync.status.error"),
      },
      testing: {
        icon: Cpu,
        color: "text-blue-400 bg-blue-400/10 animate-pulse",
        title: t("settings.section.modelSync.status.testing"),
        label: t("settings.section.modelSync.status.testing"),
      },
      unknown: {
        icon: Info,
        color: "text-gray-400 bg-gray-400/10",
        title: errorDetails || t("settings.section.modelSync.status.unknown"),
        label: t("settings.section.modelSync.status.unknown"),
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
      star: { icon: Star, title: t(TYPE_LABEL_KEYS.star), color: "text-yellow-400" },
      code: { icon: Globe, title: t(TYPE_LABEL_KEYS.code), color: "text-blue-400" },
      voice: { icon: Music, title: t(TYPE_LABEL_KEYS.voice), color: "text-pink-400" },
      image: { icon: Image, title: t(TYPE_LABEL_KEYS.image), color: "text-green-400" },
      agent: { icon: Brain, title: t(TYPE_LABEL_KEYS.agent), color: "text-orange-400" },
    }

    // Generic fallback for unrecognized source values
    const fallback: { icon: any; title: string; color: string } = {
      icon: Info,
      title: t("settings.section.modelSync.type.custom"),
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

  // Group models by provider for display, with search/filter applied (pure module; P0-a/P0-b fixed)
  const visibleGroups = createMemo<ProviderGroup[]>(() =>
    providerGroups(models(), {
      search: searchQuery(),
      filter: selectedFilter(),
      providerId: selectedFilter() === "provider" ? selectedProvider() : null,
    }),
  )
  const visibleModels = createMemo(() => visibleGroups().flatMap((group) => group.models))

  // P1-d: derive suggestions from the loaded rows instead of permanently-empty
  // static arrays. Capabilities stay a fixed vocabulary from the pure module.
  const suggestionOptions = createMemo<string[]>(() => {
    const dedupe = (values: string[]) => Array.from(new Set(values.filter(Boolean)))
    const rows = models()
    switch (selectedFilter()) {
      case "capabilities":
        return [...CAPABILITY_KEYS]
      case "provider":
        return dedupe(rows.map((r) => r.providerId))
      case "model":
        return dedupe(rows.flatMap((r) => [r.modelName, r.modelId]))
      case "id":
        return dedupe(rows.map((r) => r.modelId))
      case "category":
        return dedupe(rows.map((r) => r.type))
      default:
        return dedupe(rows.flatMap((r) => [r.providerName, r.modelName, r.modelId, r.type]))
    }
  })

  // P1-c: selecting a suggestion only sets the search query; it never changes
  // the active filter, so the current scope is preserved.
  const selectSuggestion = (option: string) => {
    setSearchQuery(option)
    setSuggestionsOpen(false)
    setActiveSuggestionIndex(-1)
  }

  // P2-b: full combobox keyboard support.
  const handleSearchKeyDown = (event: KeyboardEvent) => {
    const options = suggestionOptions()
    if (event.key === "Escape") {
      setSuggestionsOpen(false)
      setActiveSuggestionIndex(-1)
      return
    }
    if (!suggestionsOpen() || options.length === 0) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveSuggestionIndex((index) => (index + 1) % options.length)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveSuggestionIndex((index) => (index <= 0 ? options.length - 1 : index - 1))
    } else if (event.key === "Home") {
      event.preventDefault()
      setActiveSuggestionIndex(0)
    } else if (event.key === "End") {
      event.preventDefault()
      setActiveSuggestionIndex(options.length - 1)
    } else if (event.key === "Enter" && activeSuggestionIndex() >= 0) {
      event.preventDefault()
      selectSuggestion(options[activeSuggestionIndex()])
    }
  }

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

          {models().length > 0 && visibleModels().length > 0 && (
            <div class="model-sync-table-wrapper">
              <div class="model-sync-filters-bar">
                <div class="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
                  {/* Search input + suggestions (REOPEN-AC-2: relative anchor, outside click, accessible listbox) */}
                  <div class="flex-1 sm:flex-order-1 relative" ref={searchWrapRef}>
                    <input
                      type="text"
                      id="model-sync-search"
                      role="combobox"
                      aria-label={t("settings.section.modelSync.search.placeholder")}
                      aria-autocomplete="list"
                      aria-controls="model-sync-suggestion-list"
                      aria-expanded={suggestionsOpen() && suggestionOptions().length > 0}
                      aria-activedescendant={
                        suggestionsOpen() && activeSuggestionIndex() >= 0
                          ? `model-sync-suggestion-${activeSuggestionIndex()}`
                          : undefined
                      }
                      placeholder={t("settings.section.modelSync.search.placeholder")}
                      value={searchQuery()}
                      onInput={(e: Event) => {
                        setSearchQuery((e.target as HTMLInputElement | null)?.value ?? "")
                        setSuggestionsOpen(true)
                        setActiveSuggestionIndex(-1)
                      }}
                      onFocus={() => setSuggestionsOpen(true)}
                      onBlur={() => {
                        // Close when focus leaves the search wrapper. Option mousedown preventDefault
                        // keeps input focus, so option selection is unaffected.
                        setTimeout(() => {
                          if (!searchWrapRef?.contains(document.activeElement)) {
                            setSuggestionsOpen(false)
                            setActiveSuggestionIndex(-1)
                          }
                        }, 0)
                      }}
                      onKeyDown={handleSearchKeyDown}
                      class="flex-1 input input-bordered w-full"
                    />
                    {searchQuery() && suggestionsOpen() && suggestionOptions().length > 0 && (
                      <div
                        id="model-sync-suggestion-list"
                        role="listbox"
                        aria-label={t(FILTER_LABEL_KEYS[selectedFilter()])}
                        class="absolute left-0 mt-1 w-full rounded border bg-white shadow-sm z-10 overflow-auto"
                        style={{ "max-height": "200px" }}
                      >
                        <div class="p-2 text-sm text-muted-foreground" role="presentation">
                          <span class="text-caption">{t(FILTER_LABEL_KEYS[selectedFilter()])}:</span>{" "}
                          <For each={suggestionOptions()}>
                            {(opt, index) => (
                              <div
                                id={`model-sync-suggestion-${index()}`}
                                role="option"
                                aria-selected={index() === activeSuggestionIndex()}
                                class={`cursor-pointer px-1 py-0.5 rounded ${index() === activeSuggestionIndex() ? "text-primary bg-[var(--surface-hover)]" : "hover:text-primary"}`}
                                onMouseDown={(e: MouseEvent) => e.preventDefault()}
                                onClick={() => selectSuggestion(opt)}
                              >
                                {opt}
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {/* Filter selector */}
                  <div class="sm:flex-order-2">
                    <select
                      value={selectedFilter()}
                      onChange={(e: Event) => {
                        setSelectedFilter((e.currentTarget as HTMLSelectElement).value as ModelSyncFilter)
                        setSuggestionsOpen(false)
                        setActiveSuggestionIndex(-1)
                      }}
                      class="select select-sm w-32"
                    >
                      <option value="all">{t("settings.section.modelSync.filter.all")}</option>
                      <option value="capabilities">{t("settings.section.modelSync.filter.capabilities")}</option>
                      <option value="provider">{t("settings.section.modelSync.filter.provider")}</option>
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
                        <option value="">{t("settings.section.modelSync.provider.placeholder")}</option>
                        <For each={providerOptions()}>
                          {(opt) => <option value={opt.value}>{opt.label}</option>}
                        </For>
                      </select>
                    </div>
                  )}
                  </div>
                  
                  {/* Clear search */}
                  <button
                    onClick={() => {
                      setSearchQuery("")
                      setSuggestionsOpen(false)
                      setActiveSuggestionIndex(-1)
                    }}
                    class="selector-button selector-button-tertiary text-xs sm:ml-2"
                    title={t("settings.section.modelSync.search.clear")}
                  >
                    {t("settings.section.modelSync.search.clear")}
                  </button>
                </div>
              </div>
              {/* Visually-hidden polite announcement of the visible result count (P2-b) */}
              <span class="model-sync-sr-only" role="status" aria-live="polite">
                {t("settings.section.modelSync.resultsAnnouncement", { count: visibleModels().length })}
              </span>
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
                    <th style={{ color: "var(--text-muted)" }}>{t("settings.section.modelSync.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleGroups().map((group: ProviderGroup) => (
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
                            <ModelIcon providerName={model.providerName} type={model.type} t={t} />
                          </td>
                          <td style={{ color: "var(--text-muted)" }}>
                            {model.lastTested !== null && model.lastTested > 0 ? new Date(model.lastTested).toLocaleString() : t("settings.section.modelSync.lastTested.never")}
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

          {models().length > 0 && visibleModels().length === 0 && (
            <div class="settings-sync-status">
              <span class="text-muted-foreground">{t("settings.section.modelSync.noResults")}</span>
              <button
                class="selector-button selector-button-tertiary text-xs"
                onClick={handleClearFilters}
              >
                {t("settings.section.modelSync.clearAllFilters")}
              </button>
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