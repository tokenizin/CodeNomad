import { Button } from "@kobalte/core/button"
import {
  createSignal,
  onMount,
  onCleanup,
  type Component,
  createMemo,
  For,
  Show,
} from "solid-js"
import {
  Cpu, RefreshCw, Terminal, AlertCircle, AlertTriangle, CheckCircle, Info, Star, KeyRound, Clock,
  ChevronDown, ChevronRight, CreditCard, ExternalLink, Eye, EyeOff, Gift, HelpCircle, Maximize2, Power, ScrollText, Trash2,
} from "lucide-solid"

import { useI18n } from "../../lib/i18n"
import {
  deriveModelCategories,
  inconclusiveKind,
  largestContextKeys,
  providerGroups,
  rowsFromSyncResults,
  rowKey,
  type CapabilityKey,
  type ModelCategory,
  type ModelSyncFilter,
  type ProviderGroup,
  type SyncedModelRow,
} from "../../lib/model-sync/filter-models"
import { createModelSyncApi, type ModelSyncApi } from "../../lib/model-sync/api"
import { ModelSyncFiltersBar } from "./model-sync-filters-bar"
import { CAPABILITY_META } from "./model-sync-capabilities"
import { officialDetailsUrl, topUpUrl } from "./model-sync-provider-links"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "../action-overflow-menu"
import { uiState } from "../../stores/preferences"

type ModelSyncStatus = "idle" | "syncing" | "testing" | "syncComplete" | "syncError"

// Category badges for the Model Status table. Categories are derived from real
// data (see deriveModelCategories). Status-like ones (available / error /
// untested) already show in the Status column, so they are filter-only.
const CATEGORY_META: Record<ModelCategory, { icon: typeof Star; color: string; badge: boolean }> = {
  favorite: { icon: Star, color: "#eab308", badge: true },
  free: { icon: Gift, color: "#22c55e", badge: true },
  requires_credit: { icon: CreditCard, color: "#f59e0b", badge: true },
  largest_context: { icon: Maximize2, color: "#3b82f6", badge: true },
  deactivated: { icon: Power, color: "var(--text-muted)", badge: true },
  hidden: { icon: EyeOff, color: "var(--text-muted)", badge: true },
  available: { icon: CheckCircle, color: "#22c55e", badge: false },
  error: { icon: AlertCircle, color: "#ef4444", badge: false },
  untested: { icon: HelpCircle, color: "var(--text-muted)", badge: false },
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
  const [selectedCapabilities, setSelectedCapabilities] = createSignal<CapabilityKey[]>([])
  // Provider groups the user collapsed, rows whose exception log is open, and
  // whether rows hidden via the actions menu are shown.
  const [collapsedProviders, setCollapsedProviders] = createSignal<ReadonlySet<string>>(new Set())
  const [openLogs, setOpenLogs] = createSignal<ReadonlySet<string>>(new Set())
  const [showHidden, setShowHidden] = createSignal(false)
  const toggleInSet = (setter: typeof setOpenLogs, key: string) =>
    setter((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const toggleCapability = (capability: CapabilityKey) =>
    setSelectedCapabilities((current) =>
      current.includes(capability) ? current.filter((c) => c !== capability) : [...current, capability],
    )

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
    setSelectedCapabilities([])
  }

  const rowsSignature = (rows: SyncedModelRow[]) =>
    rows
      .map(
        (r) =>
          `${r.providerId}/${r.modelId}:${r.status}:${r.lastTested ?? ""}:${r.contextWindow}:${r.type}:${r.errorDetails ?? ""}:${r.free ?? ""}:${r.hidden ? 1 : 0}:${r.deactivated ? 1 : 0}`,
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
    onCleanup(() => clearInterval(interval))
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

  // ── Row actions (quick-action menu) ──────────────────────────────────────
  const updateRow = (target: SyncedModelRow, patch: Partial<SyncedModelRow>) =>
    setModels((rows) =>
      rows.map((row) => (row.providerId === target.providerId && row.modelId === target.modelId ? { ...row, ...patch } : row)),
    )

  // Hide / deactivate are saved on the server; update the row first so the
  // table reacts immediately, and roll back if the save fails.
  const setVisibility = async (model: SyncedModelRow, patch: { hidden?: boolean; deactivated?: boolean }) => {
    const before = { hidden: model.hidden, deactivated: model.deactivated }
    updateRow(model, { hidden: patch.hidden ?? model.hidden, deactivated: patch.deactivated ?? model.deactivated })
    try {
      await modelSyncApi.setVisibility({ providerId: model.providerId, modelId: model.modelId, ...patch })
      // The model picker leaves deactivated models out; let it refresh.
      if (patch.deactivated !== undefined) window.dispatchEvent(new CustomEvent("model-sync-complete"))
    } catch (e: unknown) {
      updateRow(model, before)
      setError(t("settings.section.modelSync.actions.failed", { message: (e as Error).message || t("settings.section.modelSync.unknownError") }))
    }
  }

  const removeModel = async (model: SyncedModelRow) => {
    if (!window.confirm(t("settings.section.modelSync.actions.removeConfirm", { model: model.modelName }))) return
    try {
      await modelSyncApi.removeModel({ providerId: model.providerId, modelId: model.modelId })
      setModels((rows) => rows.filter((row) => !(row.providerId === model.providerId && row.modelId === model.modelId)))
      window.dispatchEvent(new CustomEvent("model-sync-complete"))
    } catch (e: unknown) {
      setError(t("settings.section.modelSync.actions.failed", { message: (e as Error).message || t("settings.section.modelSync.unknownError") }))
    }
  }

  const openExternal = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer")
  }

  const rowActions = (model: SyncedModelRow): ActionOverflowMenuItem[] => {
    const key = rowKey(model.providerId, model.modelId)
    const topUp = topUpUrl(model.providerId)
    const details = officialDetailsUrl(model.providerId, model.modelId)
    const iconClass = "w-3.5 h-3.5"
    return [
      {
        key: "log",
        label: openLogs().has(key) ? t("settings.section.modelSync.actions.hideLog") : t("settings.section.modelSync.actions.viewLog"),
        icon: <ScrollText class={iconClass} />,
        disabled: !model.errorDetails,
        onSelect: () => {
          toggleInSet(setOpenLogs, key)
        },
      },
      {
        key: "retest",
        label: t("settings.section.modelSync.actions.retest"),
        icon: <RefreshCw class={iconClass} />,
        disabled: status() !== "idle" || model.status === "testing",
        onSelect: () => testSingleModel(model),
      },
      {
        key: "topup",
        label: t("settings.section.modelSync.actions.topUp"),
        icon: <CreditCard class={iconClass} />,
        disabled: !topUp,
        onSelect: () => {
          if (topUp) openExternal(topUp)
        },
      },
      {
        key: "details",
        label: t("settings.section.modelSync.actions.details"),
        icon: <ExternalLink class={iconClass} />,
        disabled: !details,
        onSelect: () => {
          if (details) openExternal(details)
        },
      },
      {
        key: "hide",
        label: model.hidden ? t("settings.section.modelSync.actions.unhide") : t("settings.section.modelSync.actions.hide"),
        icon: model.hidden ? <Eye class={iconClass} /> : <EyeOff class={iconClass} />,
        onSelect: () => setVisibility(model, { hidden: !model.hidden }),
      },
      {
        key: "deactivate",
        label: model.deactivated ? t("settings.section.modelSync.actions.reactivate") : t("settings.section.modelSync.actions.deactivate"),
        icon: <Power class={iconClass} />,
        onSelect: () => setVisibility(model, { deactivated: !model.deactivated }),
      },
      {
        key: "remove",
        label: t("settings.section.modelSync.actions.remove"),
        icon: <Trash2 class={iconClass} />,
        destructive: true,
        onSelect: () => removeModel(model),
      },
    ]
  }

  const categoryBadges = (model: SyncedModelRow) => {
    const shown = (model.categories ?? []).filter((c) => CATEGORY_META[c].badge)
    if (shown.length === 0) return <span class="text-muted-foreground text-xs">—</span>
    return (
      <div class="model-sync-category-badges">
        {shown.map((category) => {
          const meta = CATEGORY_META[category]
          return (
            <span class="model-sync-category-badge" style={{ color: meta.color }} title={t(`settings.section.modelSync.category.${category}`)}>
              <meta.icon class="w-3 h-3" />
              <span>{t(`settings.section.modelSync.category.${category}`)}</span>
            </span>
          )
        })}
      </div>
    )
  }

  const capabilityIcons = (caps: SyncedModelRow["capabilities"]) => {
    const enabled = CAPABILITY_META.filter((cap) => caps?.[cap.key])
    if (enabled.length === 0) return <span class="text-muted-foreground text-xs">—</span>

    return (
      <div class="flex items-center gap-1">
        {enabled.map((cap) => (
          <span class="relative" title={t(cap.labelKey)}>
            <cap.icon class="w-3.5 h-3.5 opacity-80 hover:opacity-100 transition-opacity" style={{ color: cap.color }} />
          </span>
        ))}
      </div>
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

  // Group models by provider for display, with search/filter applied (pure module; P0-a/P0-b fixed)
  // Rows with derived categories. Favourites come from the model picker's preferences.
  const favoriteKeys = createMemo(() => {
    const keys = new Set<string>()
    for (const item of uiState().models.favorites ?? []) {
      if (item.providerId && item.modelId) keys.add(rowKey(item.providerId, item.modelId))
    }
    return keys
  })
  const enrichedRows = createMemo<SyncedModelRow[]>(() => {
    const rows = models()
    const largest = largestContextKeys(rows)
    const favorites = favoriteKeys()
    return rows.map((row) => ({ ...row, categories: deriveModelCategories(row, { favoriteKeys: favorites, largestContextKeys: largest }) }))
  })
  const hiddenCount = createMemo(() => models().filter((row) => row.hidden).length)

  const visibleGroups = createMemo<ProviderGroup[]>(() =>
    providerGroups(showHidden() ? enrichedRows() : enrichedRows().filter((row) => !row.hidden), {
      search: searchQuery(),
      filter: selectedFilter(),
      providerId: selectedFilter() === "provider" ? selectedProvider() : null,
      capabilities: selectedCapabilities(),
    }),
  )
  const visibleModels = createMemo(() => visibleGroups().flatMap((group) => group.models))


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
          {/* Render filters bar unconditionally so the search field and category filter are always available */}
          <ModelSyncFiltersBar
            rows={enrichedRows()}
            searchQuery={searchQuery()}
            onSearchChange={setSearchQuery}
            filter={selectedFilter()}
            onFilterChange={setSelectedFilter}
            providerId={selectedProvider()}
            onProviderChange={setSelectedProvider}
            providerOptions={providerOptions()}
            selectedCapabilities={selectedCapabilities()}
            onToggleCapability={toggleCapability}
          />

          {/* Visually-hidden polite announcement of the visible result count (P2-b) */}
          <span class="model-sync-sr-only" role="status" aria-live="polite">
            {t("settings.section.modelSync.resultsAnnouncement", { count: visibleModels().length })}
          </span>

          {models().length === 0 && status() === "syncComplete" && (
            <p class="text-muted-foreground">{t("settings.section.modelSync.noModelsYet")}</p>
          )}

          {hiddenCount() > 0 && (
            <label class="model-sync-show-hidden">
              <input type="checkbox" checked={showHidden()} onChange={(e) => setShowHidden(e.currentTarget.checked)} />
              {t("settings.section.modelSync.showHidden", { count: hiddenCount() })}
            </label>
          )}

          {visibleModels().length > 0 && (
            <div class="model-sync-table-scroll">
            <table class="model-sync-table">
              <thead>
                <tr>
                  <th>{t("settings.section.modelSync.provider")}</th>
                  <th>{t("settings.section.modelSync.modelName")}</th>
                  <th>{t("settings.section.modelSync.contextWindow")}</th>
                  <th>{t("settings.section.modelSync.capabilities")}</th>
                  <th>{t("settings.section.modelSync.status")}</th>
                  <th>{t("settings.section.modelSync.filter.category")}</th>
                  <th>{t("settings.section.modelSync.lastTested")}</th>
                  <th>{t("settings.section.modelSync.actions")}</th>
                </tr>
              </thead>
              <tbody>
                <For each={visibleGroups()}>
                  {(group: ProviderGroup) => {
                    const collapsed = () => collapsedProviders().has(group.providerId)
                    return (
                      <>
                        {/* Provider row: click to collapse/expand; sticky while its models scroll */}
                        <tr class="provider-group">
                          <td colSpan={8} class="provider-header model-sync-provider-sticky">
                            <button
                              type="button"
                              class="model-sync-group-toggle"
                              aria-expanded={!collapsed()}
                              onClick={() => toggleInSet(setCollapsedProviders, group.providerId)}
                            >
                              {collapsed() ? <ChevronRight class="w-3.5 h-3.5" /> : <ChevronDown class="w-3.5 h-3.5" />}
                              <span>{group.providerName}</span>
                              <span class="model-sync-group-count">{group.models.length}</span>
                            </button>
                          </td>
                        </tr>
                        <Show when={!collapsed()}>
                          <For each={group.models}>
                            {(model: SyncedModelRow) => {
                              const key = rowKey(model.providerId, model.modelId)
                              return (
                                <>
                                  <tr class="model-row" classList={{ "is-deactivated": !!model.deactivated, "is-hidden": !!model.hidden }}>
                                    <td style={{ color: "var(--text-primary)" }}>{model.providerName}</td>
                                    <td style={{ color: "var(--text-secondary)" }}>{model.modelName}</td>
                                    <td style={{ color: "var(--text-secondary)" }}>{model.contextWindow}</td>
                                    <td>{capabilityIcons(model.capabilities)}</td>
                                    <td>
                                      <StatusIcon status={model.status} errorDetails={model.errorDetails} />
                                    </td>
                                    <td>{categoryBadges(model)}</td>
                                    <td style={{ color: "var(--text-muted)" }}>
                                      {model.lastTested !== null && model.lastTested > 0 ? new Date(model.lastTested).toLocaleString() : t("settings.section.modelSync.lastTested.never")}
                                    </td>
                                    <td>
                                      <div class="model-sync-row-actions">
                                        {model.status === "testing" && <span class="spinner spinner-tiny" />}
                                        <ActionOverflowMenu
                                          label={t("settings.section.modelSync.actions.menu", { model: model.modelName })}
                                          items={rowActions(model)}
                                          triggerClass="model-sync-actions-trigger"
                                        />
                                      </div>
                                    </td>
                                  </tr>
                                  <Show when={openLogs().has(key) && model.errorDetails}>
                                    <tr class="model-sync-log-row">
                                      <td colSpan={8}>
                                        <div class="model-sync-log">
                                          <div class="model-sync-log-meta">
                                            {t("settings.section.modelSync.actions.logTitle")} · {model.status}
                                            {model.lastTested ? ` · ${new Date(model.lastTested).toLocaleString()}` : ""}
                                          </div>
                                          <pre>{model.errorDetails}</pre>
                                        </div>
                                      </td>
                                    </tr>
                                  </Show>
                                </>
                              )
                            }}
                          </For>
                        </Show>
                      </>
                    )
                  }}
                </For>
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