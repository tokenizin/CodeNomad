import { For, Show, createSignal, onMount, type Component } from "solid-js"
import { RefreshCw } from "lucide-solid"
import { serverApi, type VoxCpmStatus } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import type { VoxCpmSpeechSettings, VoxCpmSttSource } from "../../stores/preferences"

/** Editable VoxCPM2 fields (numbers kept as text while typing). */
export type VoxCpmDraft = {
  baseUrl: string
  apiKey: string
  voice: string
  style: string
  quality: string
  speed: string
  instructions: string
  seed: string
  sttSource: VoxCpmSttSource
  sttApiKey: string
  sttModel: string
}

export function createVoxCpmDraft(settings: VoxCpmSpeechSettings, voice: string): VoxCpmDraft {
  return {
    baseUrl: settings.baseUrl ?? "",
    apiKey: "",
    voice,
    style: settings.style ?? "",
    quality: settings.quality ?? "",
    speed: settings.speed !== undefined ? String(settings.speed) : "",
    instructions: settings.instructions ?? "",
    seed: settings.seed !== undefined ? String(settings.seed) : "",
    sttSource: settings.sttSource,
    sttApiKey: "",
    sttModel: settings.sttModel ?? "",
  }
}

/** The settings update for a draft; secrets only when typed. */
export function voxCpmUpdateFromDraft(draft: VoxCpmDraft) {
  const speed = Number.parseFloat(draft.speed)
  const seed = Number.parseInt(draft.seed, 10)
  return {
    baseUrl: draft.baseUrl.trim() || undefined,
    style: draft.style || undefined,
    quality: draft.quality || undefined,
    speed: Number.isFinite(speed) && speed >= 0.25 && speed <= 4 ? speed : undefined,
    instructions: draft.instructions.trim() || undefined,
    seed: Number.isInteger(seed) ? seed : undefined,
    sttSource: draft.sttSource,
    sttModel: draft.sttModel.trim() || undefined,
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    ...(draft.sttApiKey.trim() ? { sttApiKey: draft.sttApiKey.trim() } : {}),
  }
}

/** The sidecar's built-in styles and qualities, used until it reports its own. */
const DEFAULT_STYLES = ["professional", "calm", "enthusiastic", "conversational", "news"]
const DEFAULT_QUALITIES = ["fast", "balanced", "high"]

export const VoxCpmSpeechFields: Component<{
  draft: VoxCpmDraft
  settings: VoxCpmSpeechSettings
  onChange: <K extends keyof VoxCpmDraft>(key: K, value: VoxCpmDraft[K]) => void
}> = (props) => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<VoxCpmStatus | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      setStatus(await serverApi.fetchVoxCpmStatus())
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }
  onMount(() => void refresh())

  const statusText = () => {
    const s = status()
    if (loadError()) return loadError()!
    if (!s) return t("settings.speech.voxcpm.status.checking")
    if (!s.reachable) return s.error ?? t("settings.speech.voxcpm.status.unreachable", { url: s.baseUrl })
    if (s.error && !s.ready) return s.error
    const parts = [
      s.ready ? t("settings.speech.voxcpm.status.ready") : t("settings.speech.voxcpm.status.loading"),
      s.device,
      t("settings.speech.voxcpm.status.voices", { count: String(s.voices.length) }),
      s.formats?.length ? s.formats.join(", ") : undefined,
    ].filter(Boolean)
    return s.error ? `${parts.join(" · ")} — ${s.error}` : parts.join(" · ")
  }

  const voices = () => status()?.voices ?? []
  const voiceKnown = () => voices().some((v) => v.id === props.draft.voice)
  const styles = () => (status()?.styles.length ? status()!.styles : DEFAULT_STYLES)
  const qualities = () => (status()?.qualities.length ? status()!.qualities : DEFAULT_QUALITIES)

  return (
    <>
      <div class="settings-toggle-row settings-toggle-row-compact">
        <div>
          <div class="settings-toggle-title">{t("settings.speech.voxcpm.status.title")}</div>
          <div class="settings-toggle-caption">{statusText()}</div>
        </div>
        <button
          type="button"
          class="selector-button selector-button-secondary w-auto whitespace-nowrap inline-flex items-center gap-2"
          disabled={loading()}
          onClick={() => void refresh()}
        >
          <RefreshCw class="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t("settings.speech.voxcpm.status.refresh")}</span>
        </button>
      </div>

      <Row label={t("settings.speech.voxcpm.baseUrl.title")} caption={t("settings.speech.voxcpm.baseUrl.subtitle")}>
        <input
          class="selector-input w-full"
          value={props.draft.baseUrl}
          placeholder="http://127.0.0.1:9972"
          onInput={(e) => props.onChange("baseUrl", e.currentTarget.value)}
        />
      </Row>

      <Row
        label={t("settings.speech.voxcpm.apiKey.title")}
        caption={
          props.settings.hasApiKey
            ? t("settings.speech.voxcpm.apiKey.saved")
            : status()?.hasKey
              ? t("settings.speech.voxcpm.apiKey.found")
              : t("settings.speech.voxcpm.apiKey.subtitle")
        }
      >
        <input
          class="selector-input w-full"
          type="password"
          value={props.draft.apiKey}
          placeholder={props.settings.hasApiKey || status()?.hasKey ? "••••••••" : undefined}
          onInput={(e) => props.onChange("apiKey", e.currentTarget.value)}
        />
      </Row>

      <Row label={t("settings.speech.voxcpm.voice.title")} caption={t("settings.speech.voxcpm.voice.subtitle")}>
        <Show
          when={voices().length > 0}
          fallback={
            <input
              class="selector-input w-full"
              value={props.draft.voice}
              placeholder="concierge"
              onInput={(e) => props.onChange("voice", e.currentTarget.value)}
            />
          }
        >
          <select class="selector-input w-full" value={props.draft.voice} onInput={(e) => props.onChange("voice", e.currentTarget.value)}>
            <Show when={!voiceKnown()}>
              <option value={props.draft.voice}>{props.draft.voice || t("settings.speech.voxcpm.voice.default")}</option>
            </Show>
            <optgroup label={t("settings.speech.voxcpm.voice.builtin")}>
              <For each={voices().filter((v) => v.builtin)}>{(v) => <option value={v.id}>{`${v.name} (${v.id})`}</option>}</For>
            </optgroup>
            <Show when={voices().some((v) => !v.builtin)}>
              <optgroup label={t("settings.speech.voxcpm.voice.library")}>
                <For each={voices().filter((v) => !v.builtin)}>{(v) => <option value={v.id}>{`${v.name} (${v.id})`}</option>}</For>
              </optgroup>
            </Show>
          </select>
        </Show>
      </Row>

      <Row label={t("settings.speech.voxcpm.style.title")} caption={t("settings.speech.voxcpm.style.subtitle")}>
        <select class="selector-input w-full" value={props.draft.style} onInput={(e) => props.onChange("style", e.currentTarget.value)}>
          <option value="">{t("settings.speech.voxcpm.option.default")}</option>
          <For each={styles()}>{(style) => <option value={style}>{style}</option>}</For>
        </select>
      </Row>

      <Row label={t("settings.speech.voxcpm.instructions.title")} caption={t("settings.speech.voxcpm.instructions.subtitle")}>
        <input
          class="selector-input w-full"
          value={props.draft.instructions}
          placeholder={t("settings.speech.voxcpm.instructions.placeholder")}
          onInput={(e) => props.onChange("instructions", e.currentTarget.value)}
        />
      </Row>

      <Row label={t("settings.speech.voxcpm.quality.title")} caption={t("settings.speech.voxcpm.quality.subtitle")}>
        <select class="selector-input w-full" value={props.draft.quality} onInput={(e) => props.onChange("quality", e.currentTarget.value)}>
          <option value="">{t("settings.speech.voxcpm.option.default")}</option>
          <For each={qualities()}>{(quality) => <option value={quality}>{quality}</option>}</For>
        </select>
      </Row>

      <Row label={t("settings.speech.voxcpm.speed.title")} caption={t("settings.speech.voxcpm.speed.subtitle")}>
        <input
          class="selector-input w-full"
          type="number"
          min="0.25"
          max="4"
          step="0.05"
          value={props.draft.speed}
          placeholder="1.0"
          onInput={(e) => props.onChange("speed", e.currentTarget.value)}
        />
      </Row>

      <Row label={t("settings.speech.voxcpm.seed.title")} caption={t("settings.speech.voxcpm.seed.subtitle")}>
        <input
          class="selector-input w-full"
          type="number"
          step="1"
          value={props.draft.seed}
          onInput={(e) => props.onChange("seed", e.currentTarget.value)}
        />
      </Row>

      <Row label={t("settings.speech.voxcpm.stt.title")} caption={t("settings.speech.voxcpm.stt.subtitle")}>
        <select
          class="selector-input w-full"
          value={props.draft.sttSource}
          onInput={(e) => props.onChange("sttSource", e.currentTarget.value as VoxCpmSttSource)}
        >
          <option value="local">{t("settings.speech.voxcpm.stt.local")}</option>
          <option value="whisper">{t("settings.speech.voxcpm.stt.whisper")}</option>
          <option value="deepgram">{t("settings.speech.voxcpm.stt.deepgram")}</option>
        </select>
      </Row>

      <Show when={props.draft.sttSource === "deepgram"}>
        <Row
          label={t("settings.speech.voxcpm.sttKey.title")}
          caption={props.settings.hasSttApiKey ? t("settings.speech.voxcpm.sttKey.saved") : t("settings.speech.voxcpm.sttKey.subtitle")}
        >
          <input
            class="selector-input w-full"
            type="password"
            value={props.draft.sttApiKey}
            placeholder={props.settings.hasSttApiKey ? "••••••••" : undefined}
            onInput={(e) => props.onChange("sttApiKey", e.currentTarget.value)}
          />
        </Row>
        <Row label={t("settings.speech.voxcpm.sttModel.title")} caption={t("settings.speech.voxcpm.sttModel.subtitle")}>
          <input
            class="selector-input w-full"
            value={props.draft.sttModel}
            placeholder="nova-3"
            onInput={(e) => props.onChange("sttModel", e.currentTarget.value)}
          />
        </Row>
      </Show>
    </>
  )
}

const Row: Component<{ label: string; caption: string; children: any }> = (props) => (
  <div class="settings-toggle-row settings-toggle-row-compact">
    <div>
      <div class="settings-toggle-title">{props.label}</div>
      <div class="settings-toggle-caption">{props.caption}</div>
    </div>
    <div class="w-full min-w-0 sm:min-w-[18rem] sm:max-w-[24rem]">{props.children}</div>
  </div>
)
