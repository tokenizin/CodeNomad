import { Button } from "@kobalte/core/button"
import {
  createSignal,
  onMount,
  onCleanup,
  createEffect,
  type Component,
  createMemo,
} from "solid-js"
import { Cpu, RefreshCw, Terminal, Image, Video, Brain, Music, Cloud, AlertCircle, AlertTriangle, CheckCircle, XCircle, Info, Globe, Sparkles, Star } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import type React from "react"

type ModelSyncStatus = "idle" | "syncing" | "testing" | "syncComplete" | "syncError"

/** One row produced by the /api/model-sync/test/batch handler below. */
interface ModelTestSummary {
  model: string
  provider: string
  status: string
  latencyMs?: number
  errorDetails?: string
}

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

export const ModelSyncSettingsSection: Component = () => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<ModelSyncStatus>("idle")
  const [lastSync, setLastSync] = createSignal<number | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [models, setModels] = createSignal<SyncedModelRow[]>([])

  // Load persisted sync results on mount so the table shows cached data immediately
  onMount(async () => {
    try {
      const resp = await fetch("/api/model-sync/cached")
      if (resp.ok) {
        const data = await resp.json()
        if (data?.results && Array.isArray(data.results)) {
          const cachedRows: SyncedModelRow[] = []
          for (const r of data.results) {
            if (r.models) {
              for (const m of r.models) {
                const ctx = m.limit?.context ?? 0
                const ctxStr = ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(1)}M` : ctx >= 1000 ? `${(ctx / 1000).toFixed(0)}K` : String(ctx)
                cachedRows.push({
                  providerId: r.providerId,
                  providerName: r.providerName,
                  modelId: m.id,
                  modelName: m.name,
                  contextWindow: ctxStr || "N/A",
                  capabilities: m.capabilities || { tools: false, image: false, video: false, reasoning: false, audio: false, cloud: false },
                  status: m.status || "unknown",
                  type: m.source || "unknown",
                  lastTested: m.lastTested ?? null,
                  errorDetails: m.errorDetails ?? null,
                })
              }
            }
          }
          if (cachedRows.length > 0) {
            setModels(cachedRows)
          }
        }
      }
    } catch {
      // Non-fatal — table starts empty
    }
  })

  // Poll for live status updates every 5 seconds
  createEffect(() => {
    const poll = async () => {
      try {
        const resp = await fetch("/api/model-sync/cached")
        if (resp.ok) {
          const data = await resp.json()
          if (data?.results && Array.isArray(data.results)) {
            const cachedRows: SyncedModelRow[] = []
            for (const r of data.results) {
              if (r.models) {
                for (const m of r.models) {
                  const ctx = m.limit?.context ?? 0
                  const ctxStr = ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(1)}M` : ctx >= 1000 ? `${(ctx / 1000).toFixed(0)}K` : String(ctx)
                  cachedRows.push({
                    providerId: r.providerId,
                    providerName: r.providerName,
                    modelId: m.id,
                    modelName: m.name,
                    contextWindow: ctxStr || "N/A",
                    capabilities: m.capabilities || { tools: false, image: false, video: false, reasoning: false, audio: false, cloud: false },
                    status: m.status || "unknown",
                    type: m.source || "unknown",
                    lastTested: m.lastTested ?? null,
                    errorDetails: m.errorDetails ?? null,
                  })
                }
              }
            }
            if (cachedRows.length > 0) {
              setModels(cachedRows)
            }
          }
        }
      } catch {
        // Non-fatal — continue polling
      }
    }
    poll()
    const interval = setInterval(poll, 5_000)
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
        const renderedModels: SyncedModelRow[] = []
        for (const r of data.results) {
          if (r.models) {
            for (const m of r.models) {
              const ctx = m.limit?.context ?? 0
              const ctxStr = ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(1)}M` : ctx >= 1000 ? `${(ctx / 1000).toFixed(0)}K` : String(ctx)
              renderedModels.push({
                providerId: r.providerId,
                providerName: r.providerName,
                modelId: m.id,
                modelName: m.name,
                contextWindow: ctxStr || "N/A",
                capabilities: m.capabilities || { tools: false, image: false, video: false, reasoning: false, audio: false, cloud: false },
                status: m.status || "unknown",
                type: m.source || "unknown",
                lastTested: m.lastTested ?? null,
                errorDetails: m.errorDetails ?? null,
              })
            }
          }
        }
        setModels(renderedModels)
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
    try {
      // Build test options from cached models
      const tests = models().map((m) => ({
        providerId: m.providerId,
        modelId: m.modelId,
        // Note: apiKey and baseUrl are not stored in cache; testing may fail
        // for models that require authentication not configured in the server
        apiKey: undefined,
        baseUrl: undefined,
        timeoutMs: 15000,
      }))
      const body = {
        tests,
        concurrency: Math.min(3, tests.length),
      }
      const result = await fetch("/api/model-sync/test/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await result.json()
      if (data && data.results && Array.isArray(data.results)) {
        const statusPromises: ModelTestSummary[] = data.results.map((r: any, i: number) => {
          const m = models()[i] || {}
          const statusText =
            r.status === "available" ? "✓ Available" :
            r.status === "insufficient_funds" ? "⚠ Insufficient Funds" :
            r.status === "error" ? "✗ Error" :
            r.status === "testing" ? "🔄 Testing..." : r.status
          return {
            model: m.modelName || `Model ${i}`,
            provider: m.providerId || `Provider ${i}`,
            status: statusText,
            latencyMs: r.latencyMs,
            errorDetails: r.errorDetails,
          }
        })
        setError(
          statusPromises
            .filter((s) => s.status.includes("Error") || s.status.includes("Insufficient"))
            .map((s) => `${s.provider}: ${s.model} - ${s.status}`)
            .join("\n")
        )
      }
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

    const configs = {
      available: {
        icon: CheckCircle,
        color: "text-green-400 bg-green-400/10",
        title: "Model is available for use",
      },
      insufficient_funds: {
        icon: AlertTriangle,
        color: "text-yellow-400 bg-yellow-400/10",
        title: errorDetails || "Insufficient credits or quota exceeded",
      },
      error: {
        icon: AlertCircle,
        color: "text-red-400 bg-red-400/10",
        title: errorDetails || "Model unavailable",
      },
      testing: {
        icon: Cpu,
        color: "text-blue-400 bg-blue-400/10 animate-pulse",
        title: "Model is being tested",
      },
      unknown: {
        icon: Info,
        color: "text-gray-400 bg-gray-400/10",
        title: errorDetails || "Model status not yet tested",
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

  // Group models by provider for display
  const providerGroups = createMemo(() => {
    const groups: Record<string, ProviderGroup> = {}
    for (const model of models()) {
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

          {status() !== "idle" && (
            <div class="settings-sync-status">
              {status() === "syncing" && <span>{t("settings.section.modelSync.syncing")}</span>}
              {status() === "testing" && <span>{t("settings.section.modelSync.testing")}</span>}
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
                        <td colSpan={7} class="provider-header">
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
                            <TypeIcon type={model.type} />
                          </td>
<td style={{ color: "var(--text-muted)" }}>
  {model.lastTested !== null && model.lastTested > 0 ? new Date(model.lastTested).toLocaleString() : "Never"}
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