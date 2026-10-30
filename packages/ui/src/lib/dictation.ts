/**
 * Speech/silence segmentation for prompt dictation.
 *
 * Fed with 24 kHz PCM16 frames from the microphone. It cuts the audio into utterances at short pauses (so each one
 * can be transcribed and typed into the prompt while the user keeps talking) and reports when the user has been
 * quiet long enough to send the prompt.
 */

export const DICTATION_SAMPLE_RATE = 24000

export interface DictationTiming {
  /** Pause that ends an utterance and sends it for transcription. */
  segmentPauseMs: number
  /** Pause after the last speech that sends the prompt. */
  autoSendPauseMs: number
  /** Longest utterance before it is cut anyway. */
  maxSegmentMs: number
  /** Utterances shorter than this are noise (clicks, coughs). */
  minSpeechMs: number
}

export const DEFAULT_DICTATION_TIMING: DictationTiming = {
  segmentPauseMs: 700,
  autoSendPauseMs: 4000,
  maxSegmentMs: 15000,
  minSpeechMs: 250,
}

export type SegmenterEvent = { type: "segment"; pcm: Int16Array } | { type: "autosend" }

/** Frame loudness (RMS of samples scaled to -1..1). */
export function frameLevel(frame: Int16Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] / 32768
    sum += v * v
  }
  return Math.sqrt(sum / frame.length)
}

export class DictationSegmenter {
  private frames: Int16Array[] = []
  private speechMs = 0
  private segmentMs = 0
  private silenceMs = 0
  /** Speech heard since the prompt was last sent (arms auto-send). */
  private heardSinceSend = false
  /** Adaptive floor: tracks background noise so a fixed threshold isn't needed. */
  private noiseFloor = 0.004

  constructor(private readonly timing: DictationTiming = DEFAULT_DICTATION_TIMING) {}

  push(frame: Int16Array): SegmenterEvent[] {
    const events: SegmenterEvent[] = []
    const ms = (frame.length / DICTATION_SAMPLE_RATE) * 1000
    const level = frameLevel(frame)
    const speaking = level > Math.max(0.012, this.noiseFloor * 3)
    if (!speaking) this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05

    if (speaking) {
      this.frames.push(frame)
      this.speechMs += ms
      this.segmentMs += ms
      this.silenceMs = 0
      if (this.speechMs >= this.timing.minSpeechMs) this.heardSinceSend = true
    } else {
      this.silenceMs += ms
      if (this.frames.length > 0) {
        // Keep the pause inside the utterance so words aren't clipped.
        this.frames.push(frame)
        this.segmentMs += ms
      }
    }

    const pauseEnds = this.frames.length > 0 && this.silenceMs >= this.timing.segmentPauseMs
    if (pauseEnds || this.segmentMs >= this.timing.maxSegmentMs) {
      const segment = this.cut()
      if (segment) events.push({ type: "segment", pcm: segment })
    }

    if (this.heardSinceSend && this.frames.length === 0 && this.silenceMs >= this.timing.autoSendPauseMs) {
      this.heardSinceSend = false
      events.push({ type: "autosend" })
    }
    return events
  }

  /** The utterance in progress (on stop), if it has enough speech. */
  flush(): Int16Array | null {
    return this.cut()
  }

  private cut(): Int16Array | null {
    const enough = this.speechMs >= this.timing.minSpeechMs
    const frames = this.frames
    this.frames = []
    this.speechMs = 0
    this.segmentMs = 0
    if (!enough || frames.length === 0) return null
    const total = frames.reduce((n, f) => n + f.length, 0)
    const out = new Int16Array(total)
    let offset = 0
    for (const f of frames) {
      out.set(f, offset)
      offset += f.length
    }
    return out
  }
}

/** 16-bit mono WAV around PCM samples. */
export function encodeWav(pcm: Int16Array, sampleRate = DICTATION_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i)
  }
  ascii(0, "RIFF")
  view.setUint32(4, 36 + pcm.length * 2, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(44 + i * 2, pcm[i], true)
  return bytes
}

export function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}
