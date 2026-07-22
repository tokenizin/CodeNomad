/**
 * Whisper.cpp Local STT — native C/C++ server with Core ML acceleration.
 *
 * Connects to a locally-running whisper.cpp server (whisper-server) for
 * real-time streaming STT via WebSocket and batch transcription via HTTP.
 * Zero cloud API keys required — runs fully offline on Apple Silicon.
 *
 * Features:
 * - Core ML acceleration on Apple Neural Engine (ANE)
 * - Built-in Silero-VAD for speech onset/end detection
 * - WebSocket streaming with auto-reconnect and exponential backoff
 * - HTTP POST batch transcription fallback
 * - Health check via GET /v1/status
 * - Model configurable via LOCAL_STT_MODEL env (large-v3 default)
 * - Server URL configurable via WHISPER_SERVER_URL env
 *
 * whisper-server defaults:
 *   Host: 127.0.0.1, Port: 8090
 *   WebSocket: ws://127.0.0.1:8090/stream
 *   HTTP: http://127.0.0.1:8090/v1/audio/transcriptions
 *   Health: http://127.0.0.1:8090/v1/status
 *
 * @module whisper-stt
 */

import WebSocket from "ws"

// ── Environment Configuration ───────────────────────────────────────────

/** whisper.cpp server URL (default: http://127.0.0.1:8090). */
const WHISPER_SERVER_URL = process.env.WHISPER_SERVER_URL?.trim() || "http://127.0.0.1:8090"
/** Whisper model name. Default: large-v3. */
const LOCAL_STT_MODEL = process.env.LOCAL_STT_MODEL?.trim() || "large-v3"
/** Language code. Default: en. */
const LOCAL_STT_LANGUAGE = process.env.LOCAL_STT_LANGUAGE?.trim() || "en"
/** VAD threshold (0-1). Default: 0.5. */
const LOCAL_STT_VAD_THRESHOLD = process.env.LOCAL_STT_VAD_THRESHOLD?.trim() || "0.5"

/** Max reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 5
/** Base backoff delay in ms (doubles each attempt). */
const BASE_BACKOFF_MS = 1000
/** Health check interval in ms. */
const HEALTH_CHECK_INTERVAL_MS = 15_000
/** HTTP request timeout in ms. */
const HTTP_TIMEOUT_MS = 30_000

// ── Types ───────────────────────────────────────────────────────────────

export interface WhisperSTTOptions {
  /** Server URL override (default from WHISPER_SERVER_URL env). */
  serverUrl?: string
  /** Model name override (default from LOCAL_STT_MODEL env). */
  model?: string
  /** Language override (default from LOCAL_STT_LANGUAGE env). */
  language?: string
  /** VAD threshold override (default from LOCAL_STT_VAD_THRESHOLD env). */
  vadThreshold?: number
}

/** Handle returned by createWhisperSTTConnection. */
export interface WhisperSTTConnection {
  /** Send a raw PCM audio chunk to the whisper server via WebSocket. */
  sendAudio(chunk: Buffer | string): void
  /** Batch transcription via HTTP POST (for speech settings panel test). */
  transcribe(audioBuffer: Buffer): Promise<WhisperTranscriptionResult>
  /** Close the WebSocket connection and stop health checks. */
  close(): void
  /** Whether the WebSocket connection is open and ready. */
  readonly isReady: boolean
  /** Whether the connection has been closed. */
  readonly isClosed: boolean
}

export interface WhisperSTTCallbacks {
  /** Called with each partial or final transcript. */
  onTranscript?: (text: string, isFinal: boolean) => void
  /** Called when VAD detects end of speech. */
  onUtteranceEnd?: () => void
  /** Called on connection error. */
  onError?: (error: Error) => void
  /** Called when the WebSocket connection closes. */
  onClose?: (code: number) => void
  /** Called when the WebSocket connection is ready for audio. */
  onReady?: () => void
}

export interface WhisperTranscriptionResult {
  text: string
  language?: string
  durationMs?: number
}

export interface WhisperHealthStatus {
  status: string
  model?: string
  cores?: number
  threads?: number
  [key: string]: unknown
}

// ── Utility Helpers ─────────────────────────────────────────────────────

/**
 * Build the WebSocket URL from the server base URL.
 * Converts http:// → ws:// and https:// → wss://.
 */
function buildWsUrl(serverUrl: string): string {
  const base = serverUrl.replace(/\/+$/, "")
  return base.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://")
}

/**
 * Normalize the server URL to ensure no trailing slash.
 */
function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "")
}

// ── Connection Factory ──────────────────────────────────────────────────

/**
 * Create a whisper.cpp STT connection via WebSocket with HTTP batch fallback.
 *
 * Connects to the whisper-server WebSocket endpoint for real-time streaming.
 * Audio chunks are sent as raw PCM (16-bit, 24kHz, mono). The server returns
 * JSON messages with transcript results.
 *
 * Falls back to HTTP POST for batch transcription (speech settings panel).
 *
 * Auto-reconnects on connection loss with exponential backoff.
 *
 * @param options - Configuration overrides and event callbacks
 * @returns A WhisperSTTConnection handle
 */
export function createWhisperSTTConnection(
  options?: WhisperSTTOptions & WhisperSTTCallbacks,
): WhisperSTTConnection {
  const {
    onTranscript,
    onUtteranceEnd,
    onError,
    onClose,
    onReady,
    ...configOptions
  } = options || {}

  const serverUrl = normalizeServerUrl(configOptions.serverUrl || WHISPER_SERVER_URL)
  const model = configOptions.model || LOCAL_STT_MODEL
  const language = configOptions.language || LOCAL_STT_LANGUAGE
  const vadThreshold = configOptions.vadThreshold ?? parseFloat(LOCAL_STT_VAD_THRESHOLD)

  const wsUrl = buildWsUrl(serverUrl)
  const label = `[whisper-stt ${model}]`

  let ws: WebSocket | null = null
  let closed = false
  let ready = false
  let reconnectAttempts = 0
  let healthCheckTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function log(msg: string): void {
    console.log(`${label} ${msg}`)
  }

  // ── WebSocket Connection ────────────────────────────────────────

  function connect(): void {
    if (closed) return

    const streamUrl = `${wsUrl}/stream`
    log(`Connecting to ${streamUrl}`)

    try {
      ws = new WebSocket(streamUrl)
    } catch (err) {
      log(`WebSocket constructor error: ${(err as Error).message}`)
      onError?.(new Error(`WebSocket connection failed: ${(err as Error).message}`))
      scheduleReconnect()
      return
    }

    ws.addEventListener("open", () => {
      ready = true
      reconnectAttempts = 0
      log("Connected")
      startHealthCheck()
      onReady?.()
    })

    ws.addEventListener("message", (event: any) => {
      try {
        const raw = typeof event.data === "string" ? event.data : event.data.toString()
        const parsed = JSON.parse(raw)
        handleServerMessage(parsed)
      } catch (err) {
        console.error(`${label} Message parse error:`, err)
      }
    })

    ws.addEventListener("error", (err: any) => {
      if (closed) return
      const msg = err?.message || "whisper WebSocket error"
      log(`Error: ${msg}`)
      onError?.(new Error(msg))
    })

    ws.addEventListener("close", (event: any) => {
      ready = false
      stopHealthCheck()
      log(`Closed, code: ${event?.code}, reason: ${event?.reason || "none"}`)
      onClose?.(event?.code ?? 1006)

      if (!closed) {
        scheduleReconnect()
      }
    })
  }

  // ── Message Handling ────────────────────────────────────────────

  function handleServerMessage(msg: any): void {
    // whisper-server returns various message formats depending on mode:
    // Streaming: { text: "...", is_final: bool }
    // Batch:     { text: "..." } or { results: [...] }
    // VAD:       { type: "vad", ... }

    if (msg.type === "vad" || msg.type === "silence" || msg.type === "speech_end") {
      onUtteranceEnd?.()
      return
    }

    if (typeof msg.text === "string" && msg.text.length > 0) {
      const isFinal = msg.is_final === true || msg.isFinal === true
      onTranscript?.(msg.text, isFinal)
      return
    }

    // Handle result arrays from some whisper-server variants
    if (Array.isArray(msg.results)) {
      for (const result of msg.results) {
        if (typeof result.text === "string" && result.text.length > 0) {
          const isFinal = result.is_final === true || result.isFinal === true
          onTranscript?.(result.text, isFinal)
        }
      }
      return
    }

    // Heartbeat / pong responses — no action needed
    if (msg.type === "pong" || msg.type === "heartbeat") {
      return
    }

    // Log unknown message types for debugging
    if (msg.type && msg.type !== "KeepAlive") {
      console.log(`${label} Unhandled message type: ${msg.type}`)
    }
  }

  // ── Auto-Reconnect ──────────────────────────────────────────────

  function scheduleReconnect(): void {
    if (closed || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`)
        onError?.(new Error(`Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`))
      }
      return
    }

    const delay = BASE_BACKOFF_MS * Math.pow(2, reconnectAttempts)
    reconnectAttempts++
    log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  // ── Health Check ────────────────────────────────────────────────

  function startHealthCheck(): void {
    stopHealthCheck()
    healthCheckTimer = setInterval(async () => {
      if (closed || !ready) return

      try {
        const status = await checkHealth(serverUrl)
        if (status.status !== "ok" && status.status !== "running") {
          log(`Health check warning: status=${status.status}`)
        }
      } catch (err) {
        log(`Health check failed: ${(err as Error).message}`)
        // Don't force reconnect on health check failure — the WS connection
        // may still be fine. Only log for diagnostics.
      }
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  function stopHealthCheck(): void {
    if (healthCheckTimer !== null) {
      clearInterval(healthCheckTimer)
      healthCheckTimer = null
    }
  }

  // ── Start Connection ────────────────────────────────────────────

  connect()

  // ── Return Handle ───────────────────────────────────────────────

  const connection: WhisperSTTConnection = {
    sendAudio(chunk: Buffer | string): void {
      if (closed || !ws || ws.readyState !== WebSocket.OPEN) {
        console.warn(`${label} sendAudio dropped — connection not open`)
        return
      }
      ws.send(chunk)
    },

    async transcribe(audioBuffer: Buffer): Promise<WhisperTranscriptionResult> {
      return batchTranscribe(serverUrl, audioBuffer, model, language)
    },

    close(): void {
      if (closed) return
      closed = true
      ready = false
      stopHealthCheck()
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      log("Closing")
      if (ws) {
        try {
          ws.close(1000)
        } catch {
          // Already closing
        }
        ws = null
      }
    },

    get isReady(): boolean {
      return ready && ws?.readyState === WebSocket.OPEN
    },

    get isClosed(): boolean {
      return closed
    },
  }

  return connection
}

// ── Batch Transcription ────────────────────────────────────────────────

/**
 * Transcribe an audio buffer via HTTP POST to the whisper server.
 * Used by the speech settings panel "Test" button and the SpeechProvider.
 *
 * @param serverUrl - whisper.cpp server base URL
 * @param audioBuffer - Audio data (WAV, WebM, MP3, etc.)
 * @param model - Model name
 * @param language - Language code
 * @returns Transcription result
 */
export async function batchTranscribe(
  serverUrl: string,
  audioBuffer: Buffer,
  model: string = LOCAL_STT_MODEL,
  language: string = LOCAL_STT_LANGUAGE,
): Promise<WhisperTranscriptionResult> {
  const url = `${normalizeServerUrl(serverUrl)}/inference`
  const startedAt = Date.now()

  console.log(`[whisper-stt] Batch transcribe: ${url}, model=${model}, lang=${language}, bytes=${audioBuffer.byteLength}`)

  // Build multipart form data (server uses /inference with multipart file field)
  const boundary = `----whisper${Date.now().toString(36)}`
  const parts: Buffer[] = []

  // File part
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`,
    ),
  )
  parts.push(audioBuffer)
  parts.push(Buffer.from("\r\n"))

  parts.push(Buffer.from(`--${boundary}--\r\n`))

  const body = Buffer.concat(parts)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`whisper transcription failed (${response.status}): ${detail || response.statusText}`)
    }

    const data = await response.json() as any
    const text = typeof data?.text === "string" ? data.text : ""

    console.log(`[whisper-stt] Transcription complete: ${text.length} chars, ${Date.now() - startedAt}ms`)

    return {
      text,
      language: data?.language || language,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ── Health Check ───────────────────────────────────────────────────────

/**
 * Check whisper-server health via GET /v1/status.
 *
 * @param serverUrl - whisper.cpp server base URL
 * @returns Health status object
 */
export async function checkHealth(serverUrl: string): Promise<WhisperHealthStatus> {
  const base = normalizeServerUrl(serverUrl)
  const candidates = [`${base}/v1/status`, `${base}/health`, `${base}/`]

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)

  try {
    let lastError: Error | null = null
    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
        })
        if (!response.ok) {
          lastError = new Error(`Health check failed: HTTP ${response.status}`)
          continue
        }
        const data = (await response.json().catch(() => ({}))) as any
        return {
          status: data?.status || "ok",
          model: data?.model,
          cores: data?.cores,
          threads: data?.threads,
          ...data,
        }
      } catch (err) {
        lastError = err as Error
      }
    }
    throw lastError || new Error("whisper health check failed")
  } finally {
    clearTimeout(timeout)
  }
}
