import { Button } from "@kobalte/core/button"
import { createEffect, createMemo, createSignal, type Component } from "solid-js"
import { Cpu, RefreshCw, Terminal, Eye, Mic, Image, Video, Brain, Music, Cloud, AlertTriangle, AlertCircle } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { useHttp } from "../../lib/http"

type ModelSyncStatus = "idle" | "syncing" | "syncComplete" | "syncError"
type ModelVisibility = "all" | "available" | "error" | "insufficient_funds" | "testing"

export const ModelSyncSettingsSection: Component = () => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<ModelSyncStatus>("idle")
  const [lastSync, setLastSync] = createSignal<number | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [models, setModels] = createSignal<Array<{
    providerId: string
    providerName: string
    modelId: string
    modelName: string
    contextWindow: string
    capabilities: { tools: boolean; image: boolean; video: boolean; reasoning: boolean; audio: boolean; cloud: boolean }
    status: string
    type: string
  }>>([])

  const handleSyncModels = async () => {
    setStatus("syncing")
    setError(null)
    setModels([])
    try {
      // Fetch synced models from server
      const result = await fetch("/api/model-sync/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: [] })
      })
      const data = await result.json()
      if (data && data.results) {
        const renderedModels = data.results.map((r: any) => ({
          providerId: r.providerId,
          providerName: r.providerName,
          modelId: r.id,
          modelName: r.name,
          contextWindow: r.limit ? `${r.limit.context > 1000000 ? (r.limit.context / 1000000).toFixed(1) + 'M' : r.limit.context > 1000 ? (r.limit.context / 1000).toFixed(0) + 'K' : r.limit.context}` : 'N/A',
          capabilities: r.capabilities || { tools: false, image: false, video: false, reasoning: false, audio: false, cloud: false },
          status: r.status || 'unknown',
          type: r.source || 'unknown'
        }))
        setModels(renderedModels)
      }
      setStatus("syncComplete")
      setLastSync(Date.now())
      setTimeout(() => setStatus("idle"), 2000)
    } catch (e: any) {
      setStatus("syncError")
      setError(e.message || "Sync failed")
      setTimeout(() => setStatus("idle"), 3000)
    }
  }

  const handleClearCache = async () => {
    try {
      await fetch("/api/model-sync/cache/clear", { method: "POST" })
      setLastSync(Date.now())
    } catch (e: any) {
      setError(e.message || "Failed to clear cache")
    }
  }

  // Format capability indicators as icon string
  const capabilityIcons = (caps: { tools: boolean; image: boolean; video: boolean; reasoning: boolean; audio: boolean; cloud: boolean }) => {
    const icons: string[] = []
    if (caps.tools) icons.push(<Cpu key="tools" class="w-3 h-3" />)
    if (caps.image) icons.push(<Image key="image" class="w-3 h-3" />)
    if (caps.video) icons.push(<Video key="video" class="w-3 h-3" />)
    if (caps.reasoning) icons.push(<Brain key="reasoning" class="w-3 h-3" />)
    if (caps.audio) icons.push(<Mic key="audio" class="w-3 h-3" />)
    if (caps.cloud) icons.push(<Cloud key="cloud" class="w-3 h-3" />)
    return icons.length > 0 ? icons : <span class="text-muted-foreground">None</span>
  }

  // Status badge color
  const statusBadgeColor = (status: string) => {
    const colors: Record<string, string> = {
      available: 'text-green-400 bg-green-400/10',
      'insufficient_funds': 'text-yellow-400 bg-yellow-400/10',
      error: 'text-red-400 bg-red-400/10',
      testing: 'text-blue-400 bg-blue-400/10 animate-pulse'
    }
    return colors[status] || 'text-gray-400 bg-gray-400/10'
  }

  return (
    <div class="settings-section-stack">
      {/* Sync Controls Card */}
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Sync class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.section.modelSync.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.section.modelSync.subtitle")}</p>
            </div>
          </div>
        </div>

        <div class="settings-card-content">
          {/* Sync button */}
          <div class="settings-action-bar">
            <Button
              variant="primary"
              disabled={status() === "syncing"}
              onClick={handleSyncModels}
            >
              {status() === "syncing" ? (
                <span class="spinner spinner-small" />
              ) : (
                <RefreshCw class="mr-2" />
              )}
              {t("settings.section.modelSync.syncButton")}
            </Button>

            {/* Clear cache button */}
            <Button
              variant="secondary"
              disabled={status() !== "idle"}
              onClick={handleClearCache}
            >
              {t("settings.section.modelSync.clearCacheButton")}
            </Button>
          </div>

          {/* Status display */}
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
            <p class="text-muted-foreground">
              {t("settings.section.modelSync.noModelsYet")}
            </p>
          )}

          {models().length > 0 && (
            <div class="table-responsive">
              <table class="w-full collapse-table">
                <thead>
                  <tr>
                    <th class="px-4 py-2 text-left text-xs font-medium capitalize text-gray-400">
                      {t("settings.section.modelSync.modelId")}
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium capitalize text-gray-400">
                      {t("settings.section.modelSync.modelName")}
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium capitalize text-gray-400">
                      {t("settings.section.modelSync.contextWindow")}
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium capitalize text-gray-400">
                      {t("settings.section.modelSync.capabilities")}
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium capitalize text-gray-400">
                      {t("settings.section.modelSync.status")}
                    </th>
                    <th class="px-4 py-2 text-left text-xs font-medium capitalize text-gray-400">
                      {t("settings.section.modelSync.type")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {models().map((model) => {
                    // Filter by status if not 'all'
                    const showModel = true // Always show all for now
                    
                    return (
                      <tr key={`${model.providerId}-${model.modelId}`} class="border-b hover:bg-gray-50">
                        <td class="px-4 py-2 text-sm font-medium text-gray-900">
                          {model.modelId}
                        </td>
                        <td class="px-4 py-2 text-sm text-gray-500">
                          {model.modelName}
                        </td>
                        <td class="px-4 py-2 text-sm text-gray-500">
                          {model.contextWindow}
                        </td>
                        <td class="px-4 py-2">
                          {capabilityIcons(model.capabilities)}
                        </td>
                        <td class="px-4 py-2">
                          <span class={`px-2 py-1 rounded text-xs font-medium ${statusBadgeColor(model.status)}`}
                            title={model.status}
                          >
                            {model.status}
                          </span>
                        </td>
                        <td class="px-4 py-2 text-sm text-gray-500">
                          {model.type}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Empty state */}
          {status() !== "syncComplete" && models().length === 0 && (
            <p class="text-muted-foreground text-sm">
              {t("settings.section.modelSync.waitingForSync")}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}