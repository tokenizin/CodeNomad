import { createSignal, onCleanup, type Accessor } from "solid-js"
import { startDictationCapture, type DictationCapture } from "../../lib/dictation-capture"
import { canUseServerSpeechInput, insertSpokenText } from "../../lib/dictation-prompt"
import { loadSpeechCapabilities } from "../../stores/speech"
import { useI18n } from "../../lib/i18n"

interface UsePromptDictationOptions {
  prompt: Accessor<string>
  setPrompt: (value: string) => void
  getTextarea: () => HTMLTextAreaElement | null
  /** Sends the prompt as it stands (the composer's normal send). */
  send: () => Promise<void> | void
  disabled: Accessor<boolean>
}

type DictationState = "idle" | "listening" | "transcribing"

/**
 * Sending the first prompt of a new chat creates the session, which remounts the composer. When dictation sent
 * that prompt, the next composer picks listening back up.
 */
let resumeOnNextMount = false
let lastAutoSendAt = 0

/**
 * Hands-free dictation into the prompt, transcribed by the Speech settings' STT (for VoxCPM2: faster-whisper on the
 * Mac). Each utterance is typed into the prompt as soon as it is transcribed; after 4 s of silence the prompt is
 * sent and listening continues until the user turns it off.
 */
export function usePromptDictation(options: UsePromptDictationOptions) {
  const { t } = useI18n()
  const [state, setState] = createSignal<DictationState>("idle")
  const [error, setError] = createSignal<string | null>(null)

  let capture: DictationCapture | null = null
  let typedSinceSend = false
  let active = false
  let starting = false

  void loadSpeechCapabilities()

  async function autoSend() {
    if (!typedSinceSend || !options.prompt().trim() || options.disabled()) return
    typedSinceSend = false
    lastAutoSendAt = Date.now()
    await options.send()
  }

  async function start() {
    if (active || starting || !canUseServerSpeechInput() || options.disabled()) return
    setError(null)
    starting = true
    try {
      typedSinceSend = false
      capture = await startDictationCapture({
        onText: (text) => {
          insertSpokenText(options, text)
          typedSinceSend = true
          setError(null)
        },
        onAutoSend: () => void autoSend(),
        onPendingChange: (pending) => active && setState(pending > 0 ? "transcribing" : "listening"),
        onError: (message) => setError(message),
      })
      active = true
      setState("listening")
    } catch (err) {
      capture = null
      setError(err instanceof Error ? err.message : t("promptInput.voiceInput.error.permission"))
      setState("idle")
    } finally {
      starting = false
    }
  }

  /** Stop listening; whatever was said last is still transcribed into the prompt (not sent). */
  function stop() {
    if (!active) return
    active = false
    const current = capture
    capture = null
    setState("idle")
    void current?.stop()
  }

  onCleanup(() => {
    resumeOnNextMount = active && Date.now() - lastAutoSendAt < 3000
    active = false
    void capture?.stop()
    capture = null
  })

  if (resumeOnNextMount) {
    resumeOnNextMount = false
    // Capabilities may still be loading on the new composer.
    void loadSpeechCapabilities().then(() => start())
  }

  return {
    state,
    error,
    canDictate: canUseServerSpeechInput,
    isActive: () => state() !== "idle",
    toggle: () => (active ? stop() : void start()),
    stop,
    title: () => {
      const err = error()
      if (err) return `${t("promptInput.dictation.error")}: ${err}`
      if (state() === "listening") return t("promptInput.dictation.listening")
      if (state() === "transcribing") return t("promptInput.dictation.transcribing")
      return t("promptInput.dictation.start")
    },
  }
}
