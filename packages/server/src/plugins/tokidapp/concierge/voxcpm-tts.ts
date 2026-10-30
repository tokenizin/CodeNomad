/**
 * VoxCPM2 TTS for the local voice engine.
 *
 * Same contract as `createLocalTTSConnection` (speak / flush / close, base64 24 kHz mono PCM16 out), but the
 * audio comes from the VoxCPM2 sidecar (contracts repo, scripts/voxcpm-server, :9972) over HTTP instead of a
 * Piper child process. The sidecar streams 48 kHz PCM; it is resampled to the 24 kHz the browser plays.
 *
 * A voice is selected by id: `voxcpm-<sidecar voice>` (e.g. `voxcpm-concierge`, `voxcpm-marin`, or any voice
 * saved in the sidecar's library). Failures are reported per utterance through `onUtteranceFailed` so the
 * caller can fall back to Piper without losing the sentence.
 *
 * @module voxcpm-tts
 */

import type { LocalSpeakOverrides, LocalTTSCallbacks, LocalTTSConnection } from "./local-tts"
import { postSpeech, resolveVoxCpmConfig, sidecarErrorDetail } from "./voxcpm-client"
import { Pcm16Aligner, createTo24kResampler, int16ToPcm16Bytes, pcm16BytesToInt16, type PcmResampler } from "./pcm-resample"

export const VOXCPM_VOICE_PREFIX = "voxcpm-"
export const DEFAULT_VOXCPM_VOICE = "concierge"
/** The sidecar rejects input above 4000 chars; stay under it. */
const MAX_REQUEST_CHARS = 3500
const SIDECAR_VOICE_ID = /^[a-z0-9][a-z0-9_-]{1,47}$/

export function isVoxCpmVoice(id: string | undefined | null): boolean {
  return typeof id === "string" && id.startsWith(VOXCPM_VOICE_PREFIX) && SIDECAR_VOICE_ID.test(id.slice(VOXCPM_VOICE_PREFIX.length))
}

/** `voxcpm-marin` → `marin`. Returns undefined for anything that is not a VoxCPM voice id. */
export function toSidecarVoiceId(id: string | undefined | null): string | undefined {
  return isVoxCpmVoice(id) ? id!.slice(VOXCPM_VOICE_PREFIX.length) : undefined
}

/** Default voice for the local engine: `LOCAL_TTS_VOICE`, else VoxCPM2 when `LOCAL_TTS_BACKEND=voxcpm`, else Piper. */
export function defaultLocalTtsVoice(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.LOCAL_TTS_VOICE?.trim()
  if (explicit) return explicit
  return env.LOCAL_TTS_BACKEND?.trim().toLowerCase() === "voxcpm"
    ? `${VOXCPM_VOICE_PREFIX}${DEFAULT_VOXCPM_VOICE}`
    : "piper-en-female-professional"
}

/** Piper profile ids (`piper-en-male-ryan`) and raw Piper model keys (`en_US-lessac-high`). */
const PIPER_VOICE_LIKE = /^(piper-|[a-z]{2}_[A-Za-z]{2}-)/
const DEEPGRAM_VOICE_LIKE = /^aura-/

/**
 * Sidecar voice for the `/api/speech` `ttsVoice` setting. Accepts `voxcpm-<id>`, or a bare sidecar voice (the setting
 * defaults to the OpenAI name "marin", which the sidecar ships as a preset). A Piper id left over from an earlier
 * setup, or anything that is not a valid sidecar id, resolves to the default voice instead of a 404 on every request.
 */
export function resolveSpeechVoice(ttsVoice: string | undefined | null): string {
  const v = ttsVoice?.trim() ?? ""
  if (!v) return DEFAULT_VOXCPM_VOICE
  const prefixed = toSidecarVoiceId(v)
  if (prefixed) return prefixed
  // Piper and Deepgram (aura-*) voice names are never sidecar voices.
  if (PIPER_VOICE_LIKE.test(v) || DEEPGRAM_VOICE_LIKE.test(v) || !SIDECAR_VOICE_ID.test(v)) return DEFAULT_VOXCPM_VOICE
  return v
}

/**
 * Sidecar voice for the ornith engine, or undefined to keep Piper. Precedence:
 *   1. a `voxcpm-<id>` voice from the client → VoxCPM2
 *   2. an explicit Piper voice from the client → Piper
 *   3. no explicit TTS voice (an Ornith label such as `ornith-default`, nothing, a placeholder), then
 *      `LOCAL_TTS_VOICE=voxcpm-<id>` → that voice; `LOCAL_TTS_BACKEND=voxcpm` → the default voice; otherwise Piper.
 */
export function resolveOrnithVoxVoice(
  voiceId: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = toSidecarVoiceId(voiceId)
  if (explicit) return explicit
  if (PIPER_VOICE_LIKE.test(voiceId?.trim() ?? "")) return undefined
  const fromEnvVoice = toSidecarVoiceId(env.LOCAL_TTS_VOICE?.trim())
  if (fromEnvVoice) return fromEnvVoice
  return env.LOCAL_TTS_BACKEND?.trim().toLowerCase() === "voxcpm" ? DEFAULT_VOXCPM_VOICE : undefined
}

/** Keep the speaker's voice, but swap the stock concierge pair when the reply language changes. */
export function pickVoxCpmVoiceForLocale(voice: string, lang: "en" | "id"): string {
  if (lang === "id" && voice === "concierge") return "concierge-id"
  if (lang === "en" && voice === "concierge-id") return "concierge"
  return voice
}

export interface VoxCpmSpeakOverrides {
  /** Sidecar voice id (no `voxcpm-` prefix). */
  voice?: string
  style?: "professional" | "calm" | "enthusiastic" | "conversational" | "news"
  quality?: "fast" | "balanced" | "high"
  /** Free-text delivery direction, e.g. "warm, unhurried". */
  control?: string
  speed?: number
}

export interface VoxCpmUtteranceFailure<C = unknown> {
  text: string
  overrides: VoxCpmSpeakOverrides
  context: C | undefined
  error: Error
  /** True once any audio for this utterance reached the listener — replaying it elsewhere would duplicate speech. */
  audioEmitted: boolean
}

export interface VoxCpmCallbacks<C = unknown> extends LocalTTSCallbacks {
  /** When set, per-utterance failures go here instead of `onError`. */
  onUtteranceFailed?: (failure: VoxCpmUtteranceFailure<C>) => void
}

export interface VoxCpmOptions {
  /** Sidecar voice id (no prefix). */
  voice: string
  baseUrl?: string
  apiKey?: string
  /** Whole-utterance timeout. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface VoxCpmConnection<C = unknown> extends LocalTTSConnection {
  speak(text: string, overrides?: LocalSpeakOverrides & VoxCpmSpeakOverrides): void
  /** Like `speak`, and hands `context` back to `onUtteranceFailed` so the caller can replay the sentence elsewhere. */
  speakWithContext(text: string, overrides: VoxCpmSpeakOverrides, context: C): void
}

/** Split into pieces the sidecar accepts, preferring sentence boundaries. */
export function chunkForSidecar(text: string, max = MAX_REQUEST_CHARS): string[] {
  const t = text.trim()
  if (t.length <= max) return t ? [t] : []
  const out: string[] = []
  let cur = ""
  for (const sentence of t.split(/(?<=[.!?;。！？])\s+/)) {
    let s = sentence
    while (s.length > max) {
      const cut = Math.max(s.lastIndexOf(" ", max), max >> 1)
      if (cur) { out.push(cur); cur = "" }
      out.push(s.slice(0, cut).trim())
      s = s.slice(cut).trim()
    }
    if (cur && cur.length + s.length + 1 > max) { out.push(cur); cur = s }
    else cur = cur ? `${cur} ${s}` : s
  }
  if (cur) out.push(cur)
  return out.filter(Boolean)
}

interface QueueItem<C> {
  text: string
  overrides: VoxCpmSpeakOverrides
  context: C | undefined
}

export function createVoxCpmTTSConnection<C = unknown>(
  options: VoxCpmOptions,
  callbacks: VoxCpmCallbacks<C> = {},
): VoxCpmConnection<C> {
  const config = resolveVoxCpmConfig(options)

  const queue: QueueItem<C>[] = []
  let current: AbortController | null = null
  let pumping = false
  let flushPending = false
  let closed = false

  function maybeFlushed() {
    if (closed || pumping || queue.length > 0 || !flushPending) return
    flushPending = false
    callbacks.onFlushed?.()
  }

  async function synthesize(item: QueueItem<C>): Promise<boolean> {
    const ctrl = new AbortController()
    current = ctrl
    let audioEmitted = false
    try {
      const body = {
        input: item.text,
        voice: item.overrides.voice ?? options.voice,
        stream: true,
        response_format: "pcm",
        ...(item.overrides.style ? { style: item.overrides.style } : {}),
        ...(item.overrides.quality ? { quality: item.overrides.quality } : {}),
        ...(item.overrides.control ? { control: item.overrides.control } : {}),
        ...(item.overrides.speed ? { speed: item.overrides.speed } : {}),
      }
      const res = await postSpeech(config, body, { signal: ctrl.signal, fetchImpl: options.fetchImpl })
      if (!res.ok || !res.body) {
        const detail = res.ok ? "" : await sidecarErrorDetail(res)
        throw new Error(`VoxCPM2 sidecar ${res.status}${detail ? `: ${detail}` : ""}`)
      }

      const rate = Number(res.headers.get("x-sample-rate")) || 48000
      const resampler: PcmResampler = createTo24kResampler(rate)
      const aligner = new Pcm16Aligner()
      const emit = (samples: Int16Array) => {
        if (samples.length === 0 || closed) return
        audioEmitted = true
        callbacks.onAudio?.(int16ToPcm16Bytes(samples).toString("base64"))
      }

      const reader = res.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const aligned = aligner.push(value)
        if (aligned.length) emit(resampler.push(pcm16BytesToInt16(aligned)))
      }
      emit(resampler.end())
      return true
    } catch (err) {
      if (closed) return true // aborted by close(): not a failure
      const error = err instanceof Error ? err : new Error(String(err))
      if (callbacks.onUtteranceFailed) {
        callbacks.onUtteranceFailed({ text: item.text, overrides: item.overrides, context: item.context, error, audioEmitted })
      } else {
        callbacks.onError?.(error)
      }
      return false
    } finally {
      current = null
    }
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      for (let item = queue.shift(); item && !closed; item = queue.shift()) await synthesize(item)
    } finally {
      pumping = false
      maybeFlushed()
    }
  }

  function enqueue(text: string, overrides: VoxCpmSpeakOverrides, context: C | undefined) {
    if (closed) {
      callbacks.onError?.(new Error("Cannot speak — connection is closed"))
      return
    }
    for (const piece of chunkForSidecar(text)) queue.push({ text: piece, overrides, context })
    void pump()
  }

  return {
    // The sidecar is stateless HTTP: "ready" means "will try", availability is judged per utterance.
    get ready() {
      return !closed
    },
    get voiceModel() {
      return `voxcpm:${options.voice}`
    },
    speak(text, overrides) {
      enqueue(text, { voice: overrides?.voice, style: overrides?.style, quality: overrides?.quality, control: overrides?.control, speed: overrides?.speed }, undefined)
    },
    speakWithContext(text, overrides, context) {
      enqueue(text, overrides, context)
    },
    flush() {
      if (closed) return
      flushPending = true
      // Nothing queued → report on a microtask so callers never see onFlushed re-enter speak().
      queueMicrotask(maybeFlushed)
    },
    close() {
      if (closed) return
      closed = true
      queue.length = 0
      current?.abort()
    },
  }
}
