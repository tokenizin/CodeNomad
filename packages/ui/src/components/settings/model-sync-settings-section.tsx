import { Button } from "@kobalte/core/button"
import { createSignal, type Component } from "solid-js"
import { Cpu, RefreshCw, Terminal, Image, Video, Brain, Music, Cloud } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { For } from "solid-js"

type ModelSyncStatus = "idle" | "syncing" | "syncComplete" | "syncError"

interface SyncedModelRow {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  contextWindow: string
  capabilities: { tools: boolean; image: boolean; video: boolean; reasoning: boolean; audio: boolean; cloud: boolean }
  status: string
  type: string
}

export const ModelSyncSettingsSection: Component = () => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<ModelSyncStatus>("idle")
  const [lastSync, setLastSync] = createSignal<number | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [models, setModels] = createSignal<SyncedModelRow[]>([])

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
              })
            }
          }
        }
        setModels(renderedModels)
      }
      setStatus("syncComplete")
      setLastSync(Date.now())
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
        <For each={icons}>{(item, idx) => {
          const Icon = item.icon
          return (
            <div class="relative" title={item.title} {...{ key: idx() }}>
              <Icon class="w-3.5 h-3.5 opacity-70 hover:opacity-100 transition-opacity" style={{ color: item.color }} />
            </div>
          )
        }}</For>
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
              onClick={handleClearCache}
            >
              {t("settings.section.modelSync.clearCacheButton")}
            </Button>
          </div>

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
                  <For each={models()}>
                    {(model) => (
                      <tr class="border-b hover:bg-gray-50" {...{ key: `${model.providerId}-${model.modelId}` }}>
                        <td class="px-4 py-2 text-sm font-medium text-gray-900">{model.modelId}</td>
                        <td class="px-4 py-2 text-sm text-gray-500">{model.modelName}</td>
                        <td class="px-4 py-2 text-sm text-gray-500">{model.contextWindow}</td>
                        <td class="px-4 py-2">{capabilityIcons(model.capabilities)}</td>
                        <td class="px-4 py-2">
                          <span class={`px-2 py-1 rounded text-xs font-medium ${statusBadgeColor(model.status)}`} title={model.status}>
                            {model.status}
                          </span>
                        </td>
                        <td class="px-4 py-2 text-sm text-gray-500">{model.type}</td>
                      </tr>
                    )}
                  </For>
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