import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import { loadSpeechCapabilities } from "../../stores/speech"
import {
  canUseRealtimeVoice,
  getRealtimeVoiceError,
  getRealtimeVoiceState,
  getRealtimeVoiceTranscript,
  startRealtimeVoice,
  stopRealtimeVoice,
  disconnectRealtimeVoice,
} from "../../stores/realtime-voice"
import { useI18n } from "../../lib/i18n"

interface UseRealtimeVoiceInputOptions {
  instanceId: string
  prompt: Accessor<string>
  setPrompt: (value: string) => void
  getTextarea: () => HTMLTextAreaElement | null
  enabled: Accessor<boolean>
  disabled: Accessor<boolean>
}

const ACTIVE_STATES = new Set(["connecting", "connected", "recording", "speaking"])

export function useRealtimeVoiceInput(options: UseRealtimeVoiceInputOptions) {
  const { t } = useI18n()

  let lastTranscriptLength = 0

  createEffect(() => {
    void loadSpeechCapabilities()
  })

  const isSupported = createMemo(() => canUseRealtimeVoice())

  const state = createMemo(() => getRealtimeVoiceState(options.instanceId))

  const isActive = createMemo(() => ACTIVE_STATES.has(state()))

  const lastError = createMemo(() => getRealtimeVoiceError(options.instanceId))

  // Poll for transcript changes and append to prompt
  createEffect(() => {
    if (!isActive()) return
    const interval = setInterval(() => {
      const transcript = getRealtimeVoiceTranscript(options.instanceId)
      if (transcript.length > lastTranscriptLength) {
        const newText = transcript.slice(lastTranscriptLength)
        lastTranscriptLength = transcript.length
        const current = options.prompt()
        const textarea = options.getTextarea()
        const end = textarea ? textarea.selectionStart : current.length
        const before = current.slice(0, end)
        const after = current.slice(end)
        const prefix = end > 0 && !/\s$/.test(before) ? " " : ""
        const suffix = after.length > 0 && !/^\s/.test(after) ? " " : ""
        options.setPrompt(`${before}${prefix}${newText}${suffix}${after}`)
      }
    }, 100)
    onCleanup(() => clearInterval(interval))
  })

  function clearTranscript() {
    lastTranscriptLength = 0
  }

  async function toggleRecording(): Promise<void> {
    const current = state()
    if (current === "recording" || current === "connecting") {
      stopRealtimeVoice(options.instanceId)
      return
    }

    clearTranscript()
    await startRealtimeVoice(options.instanceId)
  }

  onCleanup(() => {
    disconnectRealtimeVoice(options.instanceId)
  })

  return {
    isActive,
    isSupported,
    toggleRecording,
    state,
    lastError,
    buttonTitle: () => {
      const err = lastError()
      if (err) return err
      const s = state()
      if (s === "recording") return t("promptInput.voiceInput.stop.title")
      if (s === "connecting") return t("promptInput.voiceInput.transcribing.title")
      if (s === "speaking") return "Assistant speaking…"
      return "Realtime Voice"
    },
  }
}
