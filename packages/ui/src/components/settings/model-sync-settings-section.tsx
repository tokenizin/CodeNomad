import { Button } from "@kobalte/core/button"
import { createEffect, createMemo, createSignal, type Component } from "solid-js"
import { Cpu, RefreshCw, Terminal } from "lucide-solid"
import { useI18n } from "../../lib/i18n"

type ModelSyncStatus = "idle" | "syncing" | "syncComplete" | "syncError"

export const ModelSyncSettingsSection: Component = () => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<ModelSyncStatus>("idle")
  const [lastSync, setLastSync] = createSignal<number | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const handleSyncModels = async () => {
    setStatus("syncing")
    setError(null)
    // Note: Actual sync would be triggered via API call to server
    // For now, simulate with a timeout
    setTimeout(() => {
      setStatus("syncComplete")
      setLastSync(Date.now())
      setTimeout(() => setStatus("idle"), 2000)
    }, 1000)
  }

  const handleClearCache = async () => {
    setStatus("syncing")
    setTimeout(() => {
      setStatus("idle")
      setLastSync(Date.now())
    }, 500)
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

      {/* Model Review Card */}
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
          <p>{t("settings.section.modelSync.modelInfo")}</p>
          <div class="model-status-grid">
            <div class="status-chip available">
              <span>{t("settings.section.modelSync.available")}</span>
            </div>
            <div class="status-chip insufficient-funds">
              <span>{t("settings.section.modelSync.insufficientFunds")}</span>
            </div>
            <div class="status-chip error">
              <span>{t("settings.section.modelSync.error")}</span>
            </div>
            <div class="status-chip testing">
              <span>{t("settings.section.modelSync.testing")}</span>
            </div>
          </div>
          <p class="settings-small-text">
            {t("settings.section.modelSync.modelInfo2")}
          </p>
        </div>
      </div>
    </div>
  )
}