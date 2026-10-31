/**
 * Microphone → speech segments → text, using the Speech settings' transcription (`/api/speech/transcribe`).
 *
 * Shared by prompt dictation and the local voice conversation. Each utterance is transcribed as soon as the speaker
 * pauses; `onAutoSend` fires once the speaker has been quiet for 4 s and every transcription has landed.
 */

import { serverApi } from "./api-client"
import { startPCM16Capture, type AudioCapture } from "./realtime-voice"
import { DictationSegmenter, base64ToInt16, bytesToBase64, encodeWav, frameLevel, type DictationTiming } from "./dictation"

export interface DictationCaptureCallbacks {
  onText: (text: string) => void
  onAutoSend: () => void
  onPendingChange?: (pending: number) => void
  onLevel?: (level: number) => void
  onError?: (message: string) => void
}

export interface DictationCapture {
  /** Stop listening. The utterance in progress is still transcribed (onText), but no auto-send follows. */
  stop(): Promise<void>
  readonly pending: number
}

export async function startDictationCapture(callbacks: DictationCaptureCallbacks, timing?: DictationTiming): Promise<DictationCapture> {
  const segmenter = new DictationSegmenter(timing)
  let pending = 0
  let chain: Promise<void> = Promise.resolve()
  let autoSendWanted = false
  let stopped = false

  const setPending = (n: number) => {
    pending = n
    callbacks.onPendingChange?.(n)
  }

  const maybeAutoSend = () => {
    if (!autoSendWanted || pending > 0 || stopped) return
    autoSendWanted = false
    callbacks.onAutoSend()
  }

  const transcribe = (pcm: Int16Array) => {
    setPending(pending + 1)
    chain = chain.then(async () => {
      try {
        const result = await serverApi.transcribeAudio({ audioBase64: bytesToBase64(encodeWav(pcm)), mimeType: "audio/wav" })
        const text = result.text?.trim()
        if (text) callbacks.onText(text)
      } catch (err) {
        callbacks.onError?.(err instanceof Error ? err.message : String(err))
      } finally {
        setPending(pending - 1)
        maybeAutoSend()
      }
    })
  }

  const capture: AudioCapture = await startPCM16Capture(
    (base64) => {
      if (stopped) return
      const frame = base64ToInt16(base64)
      callbacks.onLevel?.(frameLevel(frame))
      for (const event of segmenter.push(frame)) {
        if (event.type === "segment") transcribe(event.pcm)
        else {
          autoSendWanted = true
          maybeAutoSend()
        }
      }
    },
    { noiseGate: false },
  )

  return {
    async stop() {
      if (stopped) return chain
      stopped = true
      autoSendWanted = false
      const rest = segmenter.flush()
      capture.stop()
      callbacks.onLevel?.(0)
      if (rest) transcribe(rest)
      await chain
    },
    get pending() {
      return pending
    },
  }
}
