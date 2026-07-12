/**
 * Deepgram Live STT (Nova-3/Flux) and Aura-2 TTS streaming client module.
 *
 * Uses the `ws` npm package (not Bun native WebSocket) because Bun's native
 * WebSocket silently drops custom `Authorization` headers, which Deepgram
 * requires for API authentication.
 *
 * STT: connects to `wss://api.deepgram.com/v1/listen` with configurable model,
 * language, encoding, endpointing, and sends KeepAlive messages every 5s.
 *
 * TTS: connects to `wss://api.deepgram.com/v1/speak` with configurable voice
 * (Aura-2 catalog), encoding, sample rate, and provides a `speak(text)` / flush
 * / close lifecycle.
 */

import WebSocket from "ws"

// ── Environment Configuration ───────────────────────────────────────────

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY?.trim() || ""
const DEEPGRAM_ENABLED = process.env.DEEPGRAM_ENABLED?.trim() === "true"
const DEEPGRAM_LIVE_STT_MODEL = process.env.DEEPGRAM_LIVE_STT_MODEL?.trim() || "nova-3"
const DEEPGRAM_TTS_VOICE = process.env.DEEPGRAM_TTS_VOICE?.trim() || "aura-asteria-en"

// ── Aura-2 Voice Catalog ────────────────────────────────────────────────

const KNOWN_AURA_VOICES = [
  "aura-asteria-en",
  "aura-luna-en",
  "aura-stella-en",
  "aura-athena-en",
  "aura-hera-en",
  "aura-orion-en",
  "aura-arcas-en",
  "aura-perseus-en",
  "aura-angus-en",
  "aura-orpheus-en",
  "aura-helios-en",
  "aura-zeus-en",
] as const

/** Valid Aura-2 TTS voice identifiers. */
export type DeepgramVoiceId = (typeof KNOWN_AURA_VOICES)[number]

const VALID_VOICES = new Set<string>(KNOWN_AURA_VOICES)

function normalizeVoice(voice?: string): DeepgramVoiceId {
  const v = (voice || DEEPGRAM_TTS_VOICE).trim().toLowerCase()
  if (VALID_VOICES.has(v)) return v as DeepgramVoiceId
  console.warn("[deepgram-speech] Unknown voice:", v, "— falling back to aura-asteria-en")
  return "aura-asteria-en"
}

// ── STT Types ───────────────────────────────────────────────────────────

export interface DeepgramSTTOptions {
  /** Deepgram Live STT model: nova-3 (default) or flux. */
  model?: string
  /** Language code (default: en). */
  language?: string
  /** Audio encoding (default: linear16). */
  encoding?: string
  /** Sample rate (default: 24000). */
  sampleRate?: number
  /** Whether to return interim results (default: true). */
  interimResults?: boolean
  /** Endpointing silence threshold in ms (default: 500). 0 = off. */
  endpointing?: number
  /** Utterance end silence threshold in ms (default: 1000). */
  utteranceEndMs?: number
}

/** Handle returned by createDeepgramSTTConnection. */
export interface DeepgramSTTConnection {
  /** Send a raw audio chunk (Buffer or base64 string) to the STT stream. */
  sendAudio(chunk: Buffer | string): void
  /** Close the STT WebSocket connection and stop KeepAlive. */
  close(): void
}

/** Callbacks for STT events. Set via createDeepgramSTTConnection options.on*. */
export interface DeepgramSTTCallbacks {
  onTranscript?: (text: string, isFinal: boolean) => void
  onUtteranceEnd?: () => void
  onError?: (error: Error) => void
  onClose?: (code: number) => void
}

// ── TTS Types ───────────────────────────────────────────────────────────

/** Handle returned by createDeepgramTTSConnection. */
export interface DeepgramTTSConnection {
  /** Send text to be synthesized and streamed as audio. */
  speak(text: string): void
  /** Flush any buffered audio (ensures all pending audio is sent before close). */
  flush(): void
  /** Close the TTS WebSocket connection. */
  close(): void
}

/** Callbacks for TTS events. */
export interface DeepgramTTSCallbacks {
  /** Called with each base64-encoded audio chunk. */
  onAudio?: (base64Chunk: string) => void
  /** Called after flush completes. */
  onFlushed?: () => void
  onError?: (error: Error) => void
  onClose?: (code: number) => void
}

// ── Utilities ───────────────────────────────────────────────────────────

function buildDeepgramAuthHeaders(): Record<string, string> {
  if (!DEEPGRAM_API_KEY) {
    throw new Error(
      "DEEPGRAM_API_KEY is not configured. Set the DEEPGRAM_API_KEY environment variable " +
      "in the CodeNomad .env file. Key prefix: check https://console.deepgram.com/",
    )
  }
  return { Authorization: `Token ${DEEPGRAM_API_KEY}` }
}

/** Check whether Deepgram is enabled (env gate). */
export function isDeepgramEnabled(): boolean {
  return DEEPGRAM_ENABLED && DEEPGRAM_API_KEY.length > 0
}

/** Return the current STT model name from env. */
export function getDeepgramSTTModel(): string {
  return DEEPGRAM_LIVE_STT_MODEL
}

/** Return the current TTS voice name from env. */
export function getDeepgramTTSVoice(): string {
  return DEEPGRAM_TTS_VOICE
}

// ── STT Connection Factory ──────────────────────────────────────────────

/**
 * Create a WebSocket connection to Deepgram's Live STT API.
 *
 * Connects to `wss://api.deepgram.com/v1/listen` with the configured model,
 * language, encoding, and endpointing. Sends KeepAlive messages every 5
 * seconds to prevent idle timeout.
 *
 * @param options - STT configuration overrides
 * @param callbacks - Event callbacks
 * @returns A DeepgramSTTConnection handle
 */
export function createDeepgramSTTConnection(
  options?: DeepgramSTTOptions & DeepgramSTTCallbacks,
): DeepgramSTTConnection {
  const model = options?.model || DEEPGRAM_LIVE_STT_MODEL
  const language = options?.language || "en"
  const encoding = options?.encoding || "linear16"
  const sampleRate = options?.sampleRate ?? 24000
  const interimResults = options?.interimResults ?? true
  const endpointing = options?.endpointing ?? 500
  const utteranceEndMs = options?.utteranceEndMs ?? 1000

  const { onTranscript, onUtteranceEnd, onError, onClose } = options || {}

  const params = new URLSearchParams({
    model,
    language,
    encoding,
    sample_rate: String(sampleRate),
    interim_results: String(interimResults),
    endpointing: String(endpointing),
    utterance_end_ms: String(utteranceEndMs),
  })

  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`
  const headers = buildDeepgramAuthHeaders()

  console.log("[deepgram-speech] STT connecting to:", url.replace(/\?.*/, "?<params-hidden>"))

  const ws = new WebSocket(url, { headers })

  let keepAliveTimer: ReturnType<typeof setInterval> | null = null
  let closed = false

  // Begin KeepAlive interval once connected
  ws.addEventListener("open", () => {
    console.log("[deepgram-speech] STT connected")
    keepAliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "KeepAlive" }))
      }
    }, 5000)
  })

  ws.addEventListener("message", (event: any) => {
    try {
      const raw = typeof event.data === "string" ? event.data : event.data.toString()
      const parsed = JSON.parse(raw)

      switch (parsed.type) {
        case "Results": {
          const alt = parsed.channel?.alternatives?.[0]
          if (alt?.transcript) {
            onTranscript?.(alt.transcript, parsed.is_final === true)
          }
          break
        }

        case "UtteranceEnd":
          onUtteranceEnd?.()
          break

        case "Metadata":
          // Connection metadata — no action needed
          break

        default:
          // Unknown message types are logged but not treated as errors
          if (parsed.type !== "KeepAlive") {
            console.log("[deepgram-speech] STT unhandled message type:", parsed.type)
          }
      }
    } catch (err) {
      console.error("[deepgram-speech] STT message parse error:", err)
    }
  })

  ws.addEventListener("error", (err: any) => {
    if (closed) return
    const msg = err?.message || "Deepgram STT WebSocket error"
    console.error("[deepgram-speech] STT error:", msg)
    onError?.(new Error(msg))
  })

  ws.addEventListener("close", (event: any) => {
    closed = true
    stopKeepAlive()
    console.log("[deepgram-speech] STT closed, code:", event?.code, "reason:", event?.reason)
    onClose?.(event?.code ?? 1006)
  })

  function stopKeepAlive() {
    if (keepAliveTimer !== null) {
      clearInterval(keepAliveTimer)
      keepAliveTimer = null
    }
  }

  return {
    sendAudio(chunk: Buffer | string): void {
      if (ws.readyState !== WebSocket.OPEN) {
        console.warn("[deepgram-speech] STT sendAudio dropped — connection not open")
        return
      }
      ws.send(chunk)
    },

    close(): void {
      if (closed) return
      closed = true
      stopKeepAlive()
      ws.close()
    },
  }
}

// ── TTS Connection Factory ──────────────────────────────────────────────

/**
 * Create a WebSocket connection to Deepgram's Aura-2 TTS streaming API.
 *
 * Connects to `wss://api.deepgram.com/v1/speak` with the configured voice,
 * encoding, and sample rate. Call `speak(text)` to synthesize audio, receive
 * chunks via `onAudio(base64Chunk)`. Call `flush()` to flush audio buffer.
 * Call `close()` when done.
 *
 * @param voice - Aura-2 voice ID (default from DEEPGRAM_TTS_VOICE env)
 * @param callbacks - Event callbacks
 * @returns A DeepgramTTSConnection handle
 */
export function createDeepgramTTSConnection(
  voice?: DeepgramVoiceId | string,
  callbacks?: DeepgramTTSCallbacks,
): DeepgramTTSConnection {
  const resolvedVoice = normalizeVoice(voice)
  const { onAudio, onFlushed, onError, onClose } = callbacks || {}

  const params = new URLSearchParams({
    encoding: "linear16",
    sample_rate: "24000",
  })

  const url = `wss://api.deepgram.com/v1/speak?${params.toString()}`
  const headers = buildDeepgramAuthHeaders()

  console.log("[deepgram-speech] TTS connecting to:", url.replace(/\?.*/, "?<params-hidden>"))

  const ws = new WebSocket(url, { headers })

  let closed = false

  ws.addEventListener("open", () => {
    console.log("[deepgram-speech] TTS connected, voice:", resolvedVoice)
  })

  ws.addEventListener("message", (event: any) => {
    // Deepgram TTS sends binary audio chunks. Non-binary messages are metadata JSON.
    if (typeof event.data === "string" || event.data instanceof String) {
      try {
        const parsed = JSON.parse(event.data.toString())
        if (parsed.type === "Metadata") {
          // Audio metadata — no action needed for streaming
          return
        }
        if (parsed.type === "Flushed") {
          onFlushed?.()
          return
        }
        if (parsed.type === "Warning" || parsed.type === "error") {
          const msg = parsed.message || parsed.description || "Deepgram TTS warning"
          console.warn("[deepgram-speech] TTS warning:", msg)
          return
        }
      } catch {
        // Not JSON — unexpected text message, log and continue
        console.warn("[deepgram-speech] TTS unexpected text message:", event.data)
      }
      return
    }

    // Binary message = audio data (ws library sends Buffer by default)
    try {
      const buf: Buffer = Buffer.isBuffer(event.data) ? event.data : Buffer.from(event.data as ArrayBuffer)
      if (buf.length > 0) {
        onAudio?.(buf.toString("base64"))
      }
    } catch (err) {
      console.error("[deepgram-speech] TTS audio conversion error:", err)
    }
  })

  ws.addEventListener("error", (err: any) => {
    if (closed) return
    const msg = err?.message || "Deepgram TTS WebSocket error"
    console.error("[deepgram-speech] TTS error:", msg)
    onError?.(new Error(msg))
  })

  ws.addEventListener("close", (event: any) => {
    closed = true
    console.log("[deepgram-speech] TTS closed, code:", event?.code, "reason:", event?.reason)
    onClose?.(event?.code ?? 1006)
  })

  return {
    speak(text: string): void {
      if (ws.readyState !== WebSocket.OPEN) {
        console.warn("[deepgram-speech] TTS speak dropped — connection not open")
        return
      }
      const message = JSON.stringify({
        type: "Speak",
        text,
        ...(resolvedVoice ? { voice: resolvedVoice } : {}),
      })
      ws.send(message)
    },

    flush(): void {
      if (ws.readyState !== WebSocket.OPEN) {
        console.warn("[deepgram-speech] TTS flush dropped — connection not open")
        return
      }
      ws.send(JSON.stringify({ type: "Flush" }))
    },

    close(): void {
      if (closed) return
      closed = true
      try {
        ws.send(JSON.stringify({ type: "Close" }))
      } catch {
        // Connection may already be closing
      }
      ws.close()
    },
  }
}
