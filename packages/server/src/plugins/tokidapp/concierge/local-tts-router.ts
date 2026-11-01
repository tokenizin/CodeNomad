/**
 * Backend router for the local voice engine's TTS.
 *
 * - No `voxVoice`  → Piper only, spawned eagerly. Behaviour is identical to using `createLocalTTSConnection` directly.
 * - With `voxVoice` → VoxCPM2 first. If an utterance fails before any audio reached the listener (sidecar down,
 *   model still loading, queue full, timeout), that sentence is spoken by Piper instead, and VoxCPM2 is skipped for
 *   `breakerMs` so a dead sidecar costs one failed request, not one per sentence. Piper is only spawned on first need.
 *
 * Factories are injected so this module does not import `local-tts.ts` (which probes Python at import time).
 *
 * @module local-tts-router
 */

import type { LocalSpeakOverrides, LocalTTSCallbacks, LocalTTSConnection, LocalTTSOptions } from "./local-tts"
import type { LocalSTTCallbacks, LocalSTTConnection, LocalSTTConnectionOptions } from "./local-stt"
import type { PiperSynthesisParams } from "./piper-voice-catalog"
import type { VoiceSessionEndContext } from "./voice-session-end"
import type { VoxCpmCallbacks, VoxCpmConnection, VoxCpmOptions, VoxCpmSpeakOverrides } from "./voxcpm-tts"

export type LocalTtsBackend = "piper" | "voxcpm"

/**
 * The local voice engine's process-bound dependencies.
 *
 * Production uses the real Piper / VoxCPM2 / STT factories and the real
 * session-end hook. Tests inject fakes instead of replacing a module with bun's
 * `mock.module`, which is process-wide and would leak the replacement into every
 * other test file in the run.
 */
export interface LocalEngineDeps {
  /** Piper (local TTS) connection factory. */
  createPiper: (options: LocalTTSOptions, callbacks: LocalTTSCallbacks) => LocalTTSConnection
  /** VoxCPM2 (sidecar TTS) connection factory. */
  createVox?: (options: VoxCpmOptions, callbacks: VoxCpmCallbacks<LocalSpeakOverrides>) => VoxCpmConnection<LocalSpeakOverrides>
  /** Local STT (faster-whisper) connection factory. */
  createStt?: (options: LocalSTTConnectionOptions & LocalSTTCallbacks) => LocalSTTConnection
  /** Post-session hook (wiki, recording, usage settlement). */
  onSessionEnd?: (ctx: VoiceSessionEndContext) => void
}

export interface LocalTtsRouterOptions {
  /** Sidecar voice id (no `voxcpm-` prefix). Omit for Piper only. */
  voxVoice?: string
  piper: { voice: string; synthesis: PiperSynthesisParams }
  createPiper: (options: LocalTTSOptions, callbacks: LocalTTSCallbacks) => LocalTTSConnection
  createVox?: (options: VoxCpmOptions, callbacks: VoxCpmCallbacks<LocalSpeakOverrides>) => VoxCpmConnection<LocalSpeakOverrides>
  /** How long VoxCPM2 is skipped after a failure. Default 30 s. */
  breakerMs?: number
  now?: () => number
  log?: (message: string) => void
}

export interface LocalTtsSpeak {
  /** Piper voice model + synthesis — used when Piper speaks (always for Piper-only, fallback otherwise). */
  piper: LocalSpeakOverrides
  /** VoxCPM2 overrides (voice, style, …). Ignored for Piper-only routers. */
  vox?: VoxCpmSpeakOverrides
}

export interface LocalTtsRouter {
  readonly backend: LocalTtsBackend
  readonly ready: boolean
  /** Backend that spoke (or will speak) the most recent utterance. */
  readonly lastBackend: LocalTtsBackend
  speak(text: string, overrides: LocalTtsSpeak): void
  flush(): void
  close(): void
}

export function createLocalTtsRouter(options: LocalTtsRouterOptions, callbacks: LocalTTSCallbacks): LocalTtsRouter {
  const now = options.now ?? Date.now
  const breakerMs = options.breakerMs ?? 30_000
  const log = options.log ?? ((m) => console.warn(m))
  let closed = false
  let voxDownUntil = 0
  let lastBackend: LocalTtsBackend = options.voxVoice ? "voxcpm" : "piper"

  let piper: LocalTTSConnection | null = null
  const getPiper = (): LocalTTSConnection =>
    (piper ??= options.createPiper({ voice: options.piper.voice, synthesis: options.piper.synthesis }, callbacks))

  const voxEnabled = Boolean(options.voxVoice && options.createVox)
  if (!voxEnabled) getPiper() // Piper-only: warm up now, exactly like the pre-router behaviour

  const vox = voxEnabled
    ? options.createVox!(
        { voice: options.voxVoice! },
        {
          ...callbacks,
          onUtteranceFailed: ({ text, error, audioEmitted, context }) => {
            if (closed) return
            if (audioEmitted) {
              // Part of the sentence already played; replaying it on another voice would repeat words.
              callbacks.onError?.(error)
              return
            }
            voxDownUntil = now() + breakerMs
            log(`[local-tts] VoxCPM2 failed (${error.message}); Piper fallback, VoxCPM2 paused ${Math.round(breakerMs / 1000)}s`)
            lastBackend = "piper"
            const p = getPiper()
            p.speak(text, context ?? options.piper)
            p.flush()
          },
        },
      )
    : null

  return {
    get backend() {
      return voxEnabled ? "voxcpm" : "piper"
    },
    get ready() {
      return vox ? !closed : (piper?.ready ?? false)
    },
    get lastBackend() {
      return lastBackend
    },
    speak(text, overrides) {
      if (closed) {
        callbacks.onError?.(new Error("Cannot speak — connection is closed"))
        return
      }
      if (vox && now() >= voxDownUntil) {
        lastBackend = "voxcpm"
        vox.speakWithContext(text, overrides.vox ?? {}, overrides.piper)
        return
      }
      lastBackend = "piper"
      getPiper().speak(text, overrides.piper)
    },
    flush() {
      if (closed) return
      vox?.flush()
      piper?.flush()
    },
    close() {
      if (closed) return
      closed = true
      vox?.close()
      piper?.close()
    },
  }
}
