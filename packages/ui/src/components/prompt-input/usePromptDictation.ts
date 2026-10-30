import { createSignal, onCleanup, type Accessor } from "solid-js"
import { serverApi } from "../../lib/api-client"
import { startPCM16Capture, type AudioCapture } from "../../lib/realtime-voice"
import { DictationSegmenter, base64ToInt16, bytesToBase64, encodeWav } from "../../lib/dictation"
import { loadSpeechCapabilities, speechCapabilities } from "../../stores/speech"
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

  let capture: AudioCapture | null = null
  let segmenter: DictationSegmenter | null = null
  let pending = 0
  let chain: Promise<void> = Promise.resolve()
  let sendWhenIdle = false
  let typedSinceSend = false
  let active = false

  void loadSpeechCapabilities()

  const canDictate = () => {
    const caps = speechCapabilities()
    return Boolean(
      typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" && caps?.available && caps?.configured && caps?.supportsStt,
    )
  }

  const updateState = () => {
    if (!active) setState("idle")
    else setState(pending > 0 ? "transcribing" : "listening")
  }

  function insertText(text: string) {
    const current = options.prompt()
    const joiner = current.length > 0 && !/\s$/.test(current) ? " " : ""
    const next = `${current}${joiner}${text}`
    options.setPrompt(next)
    typedSinceSend = true
    const textarea = options.getTextarea()
    if (textarea) {
      setTimeout(() => {
        textarea.setSelectionRange(next.length, next.length)
        textarea.scrollTop = textarea.scrollHeight
      }, 0)
    }
  }

  async function maybeSend() {
    if (!sendWhenIdle || pending > 0) return
    sendWhenIdle = false
    if (!typedSinceSend || !options.prompt().trim() || options.disabled()) return
    typedSinceSend = false
    lastAutoSendAt = Date.now()
    await options.send()
  }

  function transcribe(pcm: Int16Array) {
    pending += 1
    updateState()
    chain = chain.then(async () => {
      try {
        const result = await serverApi.transcribeAudio({ audioBase64: bytesToBase64(encodeWav(pcm)), mimeType: "audio/wav" })
        const text = result.text?.trim()
        if (text) insertText(text)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        pending -= 1
        updateState()
        await maybeSend()
      }
    })
  }

  async function start() {
    if (active || !canDictate() || options.disabled()) return
    setError(null)
    try {
      segmenter = new DictationSegmenter()
      active = true
      typedSinceSend = false
      sendWhenIdle = false
      capture = await startPCM16Capture(
        (base64) => {
          if (!segmenter || !active) return
          for (const event of segmenter.push(base64ToInt16(base64))) {
            if (event.type === "segment") transcribe(event.pcm)
            else {
              sendWhenIdle = true
              void maybeSend()
            }
          }
        },
        { noiseGate: false },
      )
      updateState()
    } catch (err) {
      active = false
      capture = null
      segmenter = null
      setError(err instanceof Error ? err.message : t("promptInput.voiceInput.error.permission"))
      updateState()
    }
  }

  /** Stop listening; whatever was said last is still transcribed into the prompt (not sent). */
  function stop() {
    if (!active) return
    const rest = segmenter?.flush()
    capture?.stop()
    capture = null
    segmenter = null
    if (rest) transcribe(rest)
    active = false
    sendWhenIdle = false
    // Let the last transcription land before going idle.
    void chain.then(updateState)
    updateState()
  }

  onCleanup(() => {
    resumeOnNextMount = active && Date.now() - lastAutoSendAt < 3000
    active = false
    capture?.stop()
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
    canDictate,
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
