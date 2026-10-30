import { createEffect, createSignal, For, onMount, Show, type Component } from "solid-js"
import { Cpu, RefreshCw } from "lucide-solid"
import {
  localEngineServerSettings,
  preferences,
  setLocalEngineKind,
  setRustPlaygroundDefaultAgent,
  setRustPlaygroundPersist,
  toggleUseRustPlaygroundEngine,
  updateLocalEngineServerSettings,
} from "../../stores/preferences"
import { serverApi } from "../../lib/api-client"
import { isUnauthorizedError, type LocalEngineKind, type LocalEngineStatus } from "../../lib/local-engine"
import { useI18n } from "../../lib/i18n"

const PERMISSION_MODES = ["", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const

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

export const PlaygroundRustSettingsSection: Component = () => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<LocalEngineStatus | null>(null)
  const [statusError, setStatusError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)

  const engine = () => preferences().localEngineKind
  const server = () => localEngineServerSettings()

  const refresh = async () => {
    setLoading(true)
    try {
      setStatus(await serverApi.fetchLocalEngineStatus())
      setStatusError(null)
    } catch (err) {
      setStatus(null)
      setStatusError(
        isUnauthorizedError(err)
          ? t("settings.playgroundRust.status.unauthorized")
          : err instanceof Error
            ? err.message
            : String(err),
      )
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void refresh())

  const saveServer = (patch: Parameters<typeof updateLocalEngineServerSettings>[0]) => {
    setSaveError(null)
    void updateLocalEngineServerSettings(patch)
      .then(() => refresh())
      .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : String(err)))
  }

  const activeEngine = () => (engine() === "claude-cli" ? status()?.claude : status()?.rustPlayground)
  const engineReady = () => Boolean(activeEngine()?.ok)

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

          <Show when={preferences().useRustPlaygroundEngine && status() && !engineReady()}>
            <p class="settings-error-message">{t("settings.playgroundRust.engine.notReady")}</p>
          </Show>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.playgroundRust.kind.title")}</div>
              <div class="settings-toggle-caption">{t("settings.playgroundRust.kind.subtitle")}</div>
            </div>
            <select
              class="selector-input w-full max-w-xs"
              value={engine()}
              onChange={(e) => setLocalEngineKind(e.currentTarget.value as LocalEngineKind)}
            >
              <option value="claude-cli">{t("settings.playgroundRust.kind.claude")}</option>
              <option value="rust-playground">{t("settings.playgroundRust.kind.rust")}</option>
            </select>
          </div>

          <SettingField
            title={t("settings.playgroundRust.defaultAgent.label")}
            caption={t("settings.playgroundRust.defaultAgent.hint")}
            placeholder="product_manager"
            value={preferences().rustPlaygroundDefaultAgent}
            onSave={(value) => setRustPlaygroundDefaultAgent(value)}
          />

          <Show when={engine() === "rust-playground"}>
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
          </Show>
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
          <Show when={engine() === "claude-cli"}>
            <SettingField
              title={t("settings.playgroundRust.claudeBinary.title")}
              caption={t("settings.playgroundRust.claudeBinary.subtitle")}
              placeholder="claude"
              value={server().claudeBinary ?? ""}
              onSave={(value) => saveServer({ claudeBinary: value })}
            />
            <div class="settings-toggle-row settings-toggle-row-compact">
              <div>
                <div class="settings-toggle-title">{t("settings.playgroundRust.permissionMode.title")}</div>
                <div class="settings-toggle-caption">{t("settings.playgroundRust.permissionMode.subtitle")}</div>
              </div>
              <select
                class="selector-input w-full max-w-xs"
                value={server().permissionMode ?? ""}
                onChange={(e) => saveServer({ permissionMode: e.currentTarget.value })}
              >
                <For each={PERMISSION_MODES}>
                  {(mode) => (
                    <option value={mode}>{mode ? mode : t("settings.playgroundRust.permissionMode.inherit")}</option>
                  )}
                </For>
              </select>
            </div>
          </Show>

          <Show when={engine() === "rust-playground"}>
            <SettingField
              title={t("settings.playgroundRust.playgroundRoot.title")}
              caption={t("settings.playgroundRust.playgroundRoot.subtitle")}
              placeholder="~/0-claudecode/build-your-own-claude-code"
              value={server().playgroundRoot ?? ""}
              onSave={(value) => saveServer({ playgroundRoot: value })}
            />
          </Show>

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
            onClick={() => void refresh()}
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
                <div class="settings-info-row">
                  <span class="settings-info-label">{t("settings.playgroundRust.status.claude")}</span>
                  <span class="settings-info-value">
                    {current().claude?.ok
                      ? `${current().claude?.version ?? ""} — ${current().claude?.binary ?? ""}`
                      : current().claude?.error ?? t("settings.playgroundRust.status.missing")}
                  </span>
                </div>
                <div class="settings-info-row">
                  <span class="settings-info-label">{t("settings.playgroundRust.status.rust")}</span>
                  <span class="settings-info-value">
                    {current().rustPlayground?.ok
                      ? current().rustPlayground?.bridge ?? ""
                      : current().rustPlayground?.error ?? t("settings.playgroundRust.status.missing")}
                  </span>
                </div>
                <div class="settings-info-row">
                  <span class="settings-info-label">{t("settings.playgroundRust.status.agents")}</span>
                  <span class="settings-info-value">
                    {current().opencodeConfig ?? t("settings.playgroundRust.status.missing")}
                  </span>
                </div>
                <div class="settings-info-row">
                  <span class="settings-info-label">{t("settings.playgroundRust.status.folders")}</span>
                  <span class="settings-info-value">
                    {(current().workspaceRoots ?? []).join(", ") || t("settings.playgroundRust.status.noFolders")}
                  </span>
                </div>
              </>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
