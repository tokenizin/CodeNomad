import { createEffect, createSignal, onMount, Show, type Component } from "solid-js"
import { Cpu, RefreshCw } from "lucide-solid"
import {
  localEngineServerSettings,
  preferences,
  setRustPlaygroundDefaultAgent,
  setRustPlaygroundPersist,
  toggleUseRustPlaygroundEngine,
  updateLocalEngineServerSettings,
} from "../../stores/preferences"
import { getActiveInstance, refreshEngineResources } from "../../stores/instances"
import { loadRustCatalog } from "../../stores/sessions"
import { serverApi } from "../../lib/api-client"
import { isUnauthorizedError, type LocalEngineStatus, type RustCatalog } from "../../lib/local-engine"
import { useI18n } from "../../lib/i18n"

/** Text field that saves on blur/Enter instead of every keystroke. */
const SettingField: Component<{
  title: string
  caption: string
  placeholder?: string
  value: string
  onSave: (value: string) => void
}> = (props) => {
  const [draft, setDraft] = createSignal(props.value)
  createEffect(() => setDraft(props.value))
  return (
    <div class="settings-toggle-row settings-toggle-row-compact">
      <div>
        <div class="settings-toggle-title">{props.title}</div>
        <div class="settings-toggle-caption">{props.caption}</div>
      </div>
      <input
        class="selector-input w-full max-w-xs"
        // Long captions otherwise squeeze the field to nothing.
        style={{ "min-width": "16rem", "flex-shrink": "0" }}
        type="text"
        spellcheck={false}
        placeholder={props.placeholder}
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onChange={(e) => {
          if (e.currentTarget.value.trim() !== props.value.trim()) props.onSave(e.currentTarget.value)
        }}
      />
    </div>
  )
}

const InfoRow: Component<{ label: string; value: string }> = (props) => (
  <div class="settings-info-row">
    <span class="settings-info-label">{props.label}</span>
    <span class="settings-info-value">{props.value}</span>
  </div>
)

export const PlaygroundRustSettingsSection: Component = () => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<LocalEngineStatus | null>(null)
  const [catalog, setCatalog] = createSignal<RustCatalog | null>(null)
  const [statusError, setStatusError] = createSignal<string | null>(null)
  const [catalogError, setCatalogError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)

  const server = () => localEngineServerSettings()
  const errorText = (err: unknown) =>
    isUnauthorizedError(err) ? t("settings.playgroundRust.status.unauthorized") : err instanceof Error ? err.message : String(err)

  /** Engine status, plus what the agent reports for the open workspace. */
  const refresh = async (fresh = false) => {
    setLoading(true)
    try {
      const current = await serverApi.fetchLocalEngineStatus()
      setStatus(current)
      setStatusError(null)
      const instance = getActiveInstance()
      if (current.rust?.ok && instance?.id) {
        try {
          setCatalog((await loadRustCatalog(instance.id, { fresh })) ?? null)
          setCatalogError(null)
        } catch (err) {
          setCatalog(null)
          setCatalogError(errorText(err))
        }
      } else {
        setCatalog(null)
        setCatalogError(instance ? null : t("settings.playgroundRust.catalog.noWorkspace"))
      }
    } catch (err) {
      setStatus(null)
      setStatusError(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void refresh())

  const saveServer = (patch: Parameters<typeof updateLocalEngineServerSettings>[0]) => {
    setSaveError(null)
    void updateLocalEngineServerSettings(patch)
      .then(() => refresh(true))
      .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : String(err)))
  }

  const toggleEngine = () => {
    toggleUseRustPlaygroundEngine()
    // Pickers and slash commands switch between OpenCode and Claude Code (Rust).
    setTimeout(() => void refreshEngineResources(), 300)
  }

  const listNames = (items: Array<{ name?: string; id?: string }> | undefined) =>
    (items ?? []).map((item) => item.name ?? item.id ?? "").filter(Boolean).join(", ") || "—"

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
          <span class="settings-scope-badge">{t("settings.scope.ui")}</span>
        </div>

        <div class="settings-card-body settings-section-stack">
          <label class="settings-checkbox-toggle">
            <input type="checkbox" checked={preferences().useRustPlaygroundEngine} onChange={toggleEngine} />
            <div>
              <div class="settings-toggle-title">{t("settings.playgroundRust.engine.title")}</div>
              <div class="settings-toggle-caption">{t("settings.playgroundRust.engine.subtitle")}</div>
            </div>
          </label>

          <Show when={preferences().useRustPlaygroundEngine && status() && !status()?.rust?.ok}>
            <p class="settings-error-message">{t("settings.playgroundRust.engine.notReady")}</p>
          </Show>

          <SettingField
            title={t("settings.playgroundRust.defaultAgent.label")}
            caption={t("settings.playgroundRust.defaultAgent.hint")}
            placeholder="claude-code"
            value={preferences().rustPlaygroundDefaultAgent}
            onSave={(value) => setRustPlaygroundDefaultAgent(value)}
          />

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
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.playgroundRust.server.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.playgroundRust.server.subtitle")}</p>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>
        <div class="settings-card-body settings-section-stack">
          <SettingField
            title={t("settings.playgroundRust.playgroundRoot.title")}
            caption={t("settings.playgroundRust.playgroundRoot.subtitle")}
            placeholder="~/0-claudecode/build-your-own-claude-code"
            value={server().playgroundRoot ?? ""}
            onSave={(value) => saveServer({ playgroundRoot: value })}
          />
          <SettingField
            title={t("settings.playgroundRust.opencodeConfig.title")}
            caption={t("settings.playgroundRust.opencodeConfig.subtitle")}
            placeholder="~/starworld/CodeNomad/.opencode/opencode.jsonc"
            value={server().opencodeConfig ?? ""}
            onSave={(value) => saveServer({ opencodeConfig: value })}
          />
          <SettingField
            title={t("settings.playgroundRust.extraRoots.title")}
            caption={t("settings.playgroundRust.extraRoots.subtitle")}
            placeholder="~/starworld, ~/projects/other"
            value={(server().extraRoots ?? []).join(", ")}
            onSave={(value) => saveServer({ extraRoots: value.split(",") })}
          />
          <Show when={saveError()}>
            <p class="settings-error-message">{saveError()}</p>
          </Show>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.playgroundRust.status.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.playgroundRust.status.subtitle")}</p>
          </div>
          <button
            type="button"
            class="selector-button selector-button-secondary"
            disabled={loading()}
            onClick={() => void refresh(true)}
          >
            <RefreshCw class="w-4 h-4" />
            <span>{t("settings.playgroundRust.status.refresh")}</span>
          </button>
        </div>
        <div class="settings-card-body settings-section-stack">
          <Show when={statusError()}>
            <p class="settings-error-message">{statusError()}</p>
          </Show>
          <Show when={!statusError() && !status()}>
            <p class="settings-toggle-caption">{t("settings.playgroundRust.status.loading")}</p>
          </Show>
          <Show when={status()}>
            {(current) => (
              <>
                <InfoRow
                  label={t("settings.playgroundRust.status.rust")}
                  value={current().rust?.ok ? current().rust?.runner ?? "" : current().rust?.error ?? t("settings.playgroundRust.status.missing")}
                />
                <InfoRow
                  label={t("settings.playgroundRust.status.agents")}
                  value={current().opencodeConfig ?? t("settings.playgroundRust.status.missing")}
                />
                <InfoRow
                  label={t("settings.playgroundRust.status.folders")}
                  value={(current().workspaceRoots ?? []).join(", ") || t("settings.playgroundRust.status.noFolders")}
                />
              </>
            )}
          </Show>
          <Show when={catalogError()}>
            <p class="settings-error-message">{catalogError()}</p>
          </Show>
          <Show when={catalog()}>
            {(cat) => (
              <>
                <InfoRow label={t("settings.playgroundRust.catalog.endpoint")} value={cat().baseUrl ?? "—"} />
                <InfoRow label={t("settings.playgroundRust.catalog.defaultModel")} value={cat().model} />
                <InfoRow
                  label={t("settings.playgroundRust.catalog.models")}
                  value={cat().modelsError ? `${listNames(cat().models)} (${cat().modelsError})` : listNames(cat().models)}
                />
                <InfoRow label={t("settings.playgroundRust.catalog.agents")} value={listNames(cat().agents)} />
                <InfoRow label={t("settings.playgroundRust.catalog.commands")} value={listNames(cat().commands)} />
              </>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
