import { createEffect, createSignal, type Component } from "solid-js"
import { Cpu } from "lucide-solid"
import {
  preferences,
  setRustPlaygroundDefaultAgent,
  setRustPlaygroundPersist,
  toggleUseRustPlaygroundEngine,
  updatePreferences,
} from "../../stores/preferences"
import { serverApi } from "../../lib/api-client"
import type { PlaygroundRustStatus } from "../../lib/playground-rust"
import { useI18n } from "../../lib/i18n"

export const PlaygroundRustSettingsSection: Component = () => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<PlaygroundRustStatus | null>(null)
  const [statusError, setStatusError] = createSignal<string | null>(null)
  const [defaultAgent, setDefaultAgent] = createSignal(preferences().rustPlaygroundDefaultAgent)

  createEffect(() => {
    setDefaultAgent(preferences().rustPlaygroundDefaultAgent)
  })

  createEffect(() => {
    void serverApi
      .fetchPlaygroundRustStatus()
      .then((s) => {
        setStatus(s)
        setStatusError(null)
      })
      .catch((err: unknown) => {
        setStatus(null)
        setStatusError(err instanceof Error ? err.message : String(err))
      })
  })

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Cpu class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.playgroundRust.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.playgroundRust.subtitle")}</p>
            </div>
          </div>
          <span class="settings-scope-badge settings-scope-badge-ui">{t("settings.scope.ui")}</span>
        </div>

        <div class="settings-card-body settings-section-stack">
          <label class="settings-checkbox-toggle">
            <input
              type="checkbox"
              checked={preferences().useRustPlaygroundEngine}
              onChange={() => toggleUseRustPlaygroundEngine()}
            />
            <div>
              <div class="settings-toggle-title">{t("settings.playgroundRust.engine.title")}</div>
              <div class="settings-toggle-caption">{t("settings.playgroundRust.engine.subtitle")}</div>
            </div>
          </label>

          <label class="settings-checkbox-toggle">
            <input
              type="checkbox"
              checked={preferences().rustPlaygroundPersist}
              onChange={(e) => setRustPlaygroundPersist(e.currentTarget.checked)}
            />
            <div>
              <div class="settings-toggle-title">{t("settings.playgroundRust.persist.title")}</div>
              <div class="settings-toggle-caption">{t("settings.playgroundRust.persist.subtitle")}</div>
            </div>
          </label>

          <label class="settings-field">
            <span class="settings-field-label">{t("settings.playgroundRust.defaultAgent.label")}</span>
            <input
              class="settings-input"
              type="text"
              placeholder="product_manager"
              value={defaultAgent()}
              onInput={(e) => setDefaultAgent(e.currentTarget.value)}
              onChange={(e) => {
                const value = e.currentTarget.value
                setRustPlaygroundDefaultAgent(value)
                updatePreferences({ rustPlaygroundDefaultAgent: value.trim() })
              }}
            />
            <span class="settings-field-hint">{t("settings.playgroundRust.defaultAgent.hint")}</span>
          </label>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.playgroundRust.status.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.playgroundRust.status.subtitle")}</p>
          </div>
        </div>
        <div class="settings-card-body">
          {statusError() ? (
            <pre class="settings-code-block">{statusError()}</pre>
          ) : status() ? (
            <pre class="settings-code-block">{JSON.stringify(status(), null, 2)}</pre>
          ) : (
            <p class="settings-toggle-caption">{t("settings.playgroundRust.status.loading")}</p>
          )}
        </div>
      </div>
    </div>
  )
}
