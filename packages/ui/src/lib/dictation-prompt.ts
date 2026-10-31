import { speechCapabilities } from "../stores/speech"

/** The Speech settings can transcribe (server STT) and this browser has a microphone API. */
export function canUseServerSpeechInput(): boolean {
  const caps = speechCapabilities()
  return Boolean(
    typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      caps?.available &&
      caps?.configured &&
      caps?.supportsStt,
  )
}

/** Append transcribed speech to the prompt and keep the caret and scroll at the end. */
export function insertSpokenText(
  composer: { prompt: () => string; setPrompt: (value: string) => void; getTextarea: () => HTMLTextAreaElement | null },
  text: string,
): void {
  const current = composer.prompt()
  const joiner = current.length > 0 && !/\s$/.test(current) ? " " : ""
  const next = `${current}${joiner}${text}`
  composer.setPrompt(next)
  const textarea = composer.getTextarea()
  if (textarea) {
    setTimeout(() => {
      textarea.setSelectionRange(next.length, next.length)
      textarea.scrollTop = textarea.scrollHeight
    }, 0)
  }
}
