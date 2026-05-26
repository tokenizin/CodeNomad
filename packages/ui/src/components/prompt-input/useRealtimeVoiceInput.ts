import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { loadSpeechCapabilities } from "../../stores/speech"
import {
  canUseRealtimeVoice,
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

export function useRealtimeVoiceInput(options: UseRealtimeVoiceInputOptions) {
  const { t } = useI18n()
  const [isActive, setIsActive] = createSignal(false)
  const [isSupported, setIsSupported] = createSignal(false)

  let lastTranscriptLength = 0

  createEffect(() => {
    void loadSpeechCapabilities()
  })

  createEffect(() => {
    setIsSupported(canUseRealtimeVoice())
  })

  createEffect(() => {
    const currentState = getRealtimeVoiceState(options.instanceId)
    setIsActive(currentState === "recording" || currentState === "connecting")
  })

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
    const state = getRealtimeVoiceState(options.instanceId)
    if (state === "recording" || state === "connecting") {
      stopRealtimeVoice(options.instanceId)
      return
    }

    if (!canUseRealtimeVoice()) return
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
    state: () => getRealtimeVoiceState(options.instanceId),
    buttonTitle: () => {
      const state = getRealtimeVoiceState(options.instanceId)
      if (state === "recording") return t("promptInput.voiceInput.stop.title")
      if (state === "connecting") return t("promptInput.voiceInput.transcribing.title")
      return "Realtime Voice"
    },
  }
}
