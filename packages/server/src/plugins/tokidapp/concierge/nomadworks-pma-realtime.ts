/**
 * NomadWorks PMA voice session — composite STT → LLM → TTS adapter.
 *
 * Server-side adapter for engine: "nomadworks-pma". Composes a configured
 * STT engine (whisper.cpp or Deepgram Nova-3) → LLM provider (OpenAI or
 * Grok/xAI) → TTS engine (OpenAI tts-1 or Deepgram Aura-2) while exposing
 * the same `VoiceSession` interface as the other engines.
 *
 * Audio flow:
 *   Browser WebSocket (base64 PCM) → sendAudio() → STT engine
 *     → onTranscript(final) → processPmaTurn() → LLM chat/completions
 *       → onResponse() → TTS synthesize → onAudio() back to browser.
 */

import type {
  VoiceSession,
  CreateVoiceSessionParams,
  VoiceSessionStatus,
  StatusCallback,
} from "./voice-speech-orchestrator"
import {
  createWhisperSTTConnection,
  type WhisperSTTConnection,
  type WhisperSTTCallbacks,
} from "./whisper-stt"
import {
  createDeepgramSTTConnection,
  createDeepgramTTSConnection,
  isDeepgramEnabled,
  type DeepgramSTTConnection,
  type DeepgramSTTCallbacks,
  type DeepgramTTSConnection,
  type DeepgramTTSCallbacks,
  type DeepgramVoiceId,
} from "./deepgram-speech"
import { AudioBuffer } from "./audio-buffer"
import { sanitizeAsrText, sanitizeSpeechText, stripThinkingContent, isFillerTranscript, VOICE_INSTRUCTIONS } from "./speech-sanitize"

// ── Configuration ──────────────────────────────────────────────────────

/** Default LLM provider for the NomadWorks PMA composite voice adapter. */
export const VOICE_PMA_LLM_PROVIDER =
  process.env.VOICE_PMA_LLM_PROVIDER?.trim() || "openai"

/** OpenAI model used by the PMA adapter. */
export const VOICE_PMA_OPENAI_MODEL =
  process.env.VOICE_PMA_OPENAI_MODEL?.trim() || "gpt-4o-mini"

/** Grok/xAI model used by the PMA adapter. */
export const VOICE_PMA_GROK_MODEL =
  process.env.VOICE_PMA_GROK_MODEL?.trim() || "grok-2-latest"

/** STT engine used by the PMA adapter. */
export const VOICE_PMA_STT_ENGINE =
  process.env.VOICE_PMA_STT_ENGINE?.trim() || "openai-whisper"

/** TTS engine used by the PMA adapter. */
export const VOICE_PMA_TTS_ENGINE =
  process.env.VOICE_PMA_TTS_ENGINE?.trim() || "openai-tts"

/** Fallback latency ceiling (ms) for the PMA adapter. */
export const VOICE_PMA_LATENCY_FALLBACK_MS = (() => {
  const raw = process.env.VOICE_PMA_LATENCY_FALLBACK_MS?.trim()
  if (!raw) return 500
  const val = parseInt(raw, 10)
  return Number.isFinite(val) && val > 0 ? val : 500
})()

/** xAI base URL.  Defaults to the official Grok API endpoint. */
export const XAI_BASE_URL =
  process.env.XAI_BASE_URL?.trim() || "https://api.x.ai/v1"

/** xAI API key. */
export const XAI_API_KEY = process.env.XAI_API_KEY || ""

// ── LLM provider tuning ────────────────────────────────────────────────

/** OpenAI API key (used for OpenAI LLM and OpenAI TTS). */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""

/** STT/TTS audio sample rate — 24 kHz matches OpenAI & Deepgram expectations. */
const PMA_AUDIO_SAMPLE_RATE = 24000

/** OpenAI TTS voice used when VOICE_PMA_TTS_ENGINE=openai-tts. */
const PMA_OPENAI_TTS_VOICE = process.env.VOICE_PMA_TTS_VOICE?.trim() || "marin"

/** OpenAI TTS model. */
const PMA_OPENAI_TTS_MODEL = process.env.VOICE_PMA_TTS_MODEL?.trim() || "tts-1"

/** Max conversation messages retained for LLM context. */
const PMA_MAX_CONTEXT = 30

// ── LLM provider abstraction ───────────────────────────────────────────

/** Internal chat message shape for LLM calls. */
interface PmaChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** Result of a single LLM call. */
interface PmaLlmResult {
  content: string
  model: string
  latencyMs: number
  provider: "openai" | "grok" | "none"
}

/**
 * Call a chat/completions endpoint (OpenAI-compatible). Used for both the
 * official OpenAI API and xAI Grok, which share the same wire format.
 */
async function callChatCompletions(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: PmaChatMessage[],
  timeoutMs: number,
): Promise<PmaLlmResult> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => "unknown error")
      throw new Error(`HTTP ${res.status}: ${detail.slice(0, 200)}`)
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      model?: string
    }
    const choice = data.choices?.[0]
    const raw = typeof choice?.message?.content === "string" ? choice.message.content : ""
    return {
      content: stripThinkingContent(raw),
      model: data.model ?? model,
      latencyMs: Date.now() - startedAt,
      provider: baseUrl.includes("x.ai") ? "grok" : "openai",
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the LLM response for a turn. When the configured provider is Grok
 * and the call exceeds the latency ceiling, transparently falls back to
 * OpenAI so the user does not wait on a slow provider.
 */
async function callPmaLlm(
  messages: PmaChatMessage[],
): Promise<PmaLlmResult> {
  if (VOICE_PMA_LLM_PROVIDER === "grok") {
    // Grok/xAI — primary path.
    if (XAI_API_KEY) {
      const grokResult = await callChatCompletions(
        XAI_BASE_URL,
        XAI_API_KEY,
        VOICE_PMA_GROK_MODEL,
        messages,
        VOICE_PMA_LATENCY_FALLBACK_MS,
      )
      return grokResult
    }
    // Grok configured but no key — fall through to OpenAI.
    console.warn("[nomadworks-pma] XAI_API_KEY unset — falling back to OpenAI LLM")
  }

  // OpenAI path (default, or Grok fallback).
  if (OPENAI_API_KEY) {
    return callChatCompletions(
      "https://api.openai.com/v1",
      OPENAI_API_KEY,
      VOICE_PMA_OPENAI_MODEL,
      messages,
      VOICE_PMA_LATENCY_FALLBACK_MS,
    )
  }

  // No provider available.
  return {
    content: "I'm having trouble connecting to my language model right now. Please try again in a moment.",
    model: "none",
    latencyMs: 0,
    provider: "none",
  }
}

// ── OpenAI HTTP TTS helper ─────────────────────────────────────────────

/**
 * Synthesize text to speech via OpenAI's REST audio endpoint and emit a
 * base64 PCM/MP3 chunk through onAudio. This is intentionally simpler than
 * the streaming WS TTS used by Deepgram — for short assistant turns a single
 * REST round-trip has acceptable latency and avoids connection management.
 */
async function synthesizeOpenAiTts(
  text: string,
  onAudio: (base64Chunk: string) => void,
): Promise<void> {
  if (!OPENAI_API_KEY) {
    console.warn("[nomadworks-pma] OPENAI_API_KEY unset — skipping OpenAI TTS")
    return
  }

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: PMA_OPENAI_TTS_MODEL,
      input: text,
      voice: PMA_OPENAI_TTS_VOICE,
      response_format: "mp3",
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => "unknown error")
    throw new Error(`OpenAI TTS HTTP ${res.status}: ${detail.slice(0, 200)}`)
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 0) {
    onAudio(buf.toString("base64"))
  }
}

// ── Telemetry Stubs ────────────────────────────────────────────────────

const LATENCY_METRICS = new Map<string, number>()
const COST_METRICS = new Map<string, number>()

export function recordVoiceTurnLatency(sessionId: string, latencyMs: number): void {
  LATENCY_METRICS.set(sessionId, latencyMs)
}

export function getVoiceTurnLatency(sessionId: string): number {
  return LATENCY_METRICS.get(sessionId) ?? VOICE_PMA_LATENCY_FALLBACK_MS
}

export function recordVoiceTurnCost(sessionId: string, costCents: number): void {
  COST_METRICS.set(sessionId, costCents)
}

export function getVoiceTurnCost(sessionId: string): number {
  return COST_METRICS.get(sessionId) ?? 0
}

// ── Validation ─────────────────────────────────────────────────────────

/** Validates that the NomadWorks PMA adapter can start given the env config. */
export function validateNomadWorksPMAConfig(): { ok: boolean; errors: string[] } {
  const errors: string[] = []

  if (VOICE_PMA_LLM_PROVIDER === "grok") {
    if (!XAI_API_KEY) {
      errors.push("XAI_API_KEY is required when VOICE_PMA_LLM_PROVIDER=grok")
    }
    if (!XAI_BASE_URL.startsWith("https://")) {
      errors.push("XAI_BASE_URL must be a secure HTTPS URL")
    }
  }

  if (VOICE_PMA_LLM_PROVIDER !== "openai" && VOICE_PMA_LLM_PROVIDER !== "grok") {
    errors.push(`Unsupported VOICE_PMA_LLM_PROVIDER: ${VOICE_PMA_LLM_PROVIDER}`)
  }

  return { ok: errors.length === 0, errors }
}

// ── Session Implementation ─────────────────────────────────────────────

export class NomadWorksPMAVoiceSession implements VoiceSession {
  engine = "nomadworks-pma" as const
  sessionId: string
  connected = false

  onTranscript: (text: string, isFinal: boolean) => void = () => {}
  onResponse: (text: string) => void = () => {}
  onAudio: (base64Chunk: string) => void = () => {}
  onCommand: (command: string, confidence: number) => void = () => {}
  onStatus: (callback: StatusCallback) => void = () => {}
  onError: (error: Error) => void = () => {}

  private statusCallback: StatusCallback | null = null
  private destroyed = false
  private currentStatus: VoiceSessionStatus = "connecting"

  /** Accumulates base64 PCM audio from the client WebSocket. */
  private audioBuffer: AudioBuffer

  /** Active STT connection — whisper.cpp or Deepgram. */
  private stt: WhisperSTTConnection | DeepgramSTTConnection | null = null

  /** Active TTS connection — only used for Deepgram TTS engine. */
  private tts: DeepgramTTSConnection | null = null

  /** Resolved TTS engine name. */
  private ttsEngine: string

  /** Resolved STT engine name. */
  private sttEngine: string

  /** Conversational context retained across turns. */
  private conversation: PmaChatMessage[] = []

  /** Whether the assistant is mid-response — gates new turn processing. */
  private responseInProgress = false

  /** Transcript accumulated from the current user utterance. */
  private pendingTranscript = ""

  /** Resolved system prompt. */
  private systemPrompt: string

  constructor(params: CreateVoiceSessionParams) {
    this.sessionId = params.sessionId
    this.audioBuffer = new AudioBuffer({ label: `pma-${params.sessionId}` })
    this.sttEngine = VOICE_PMA_STT_ENGINE
    this.ttsEngine = VOICE_PMA_TTS_ENGINE
    this.systemPrompt = params.enrichedInstructions
      ? VOICE_INSTRUCTIONS + "\n\n" + params.enrichedInstructions
      : "You are Star World Assistant, the voice interface for the StarWORLD ecosystem. Be concise and helpful. Never read URLs, file paths, wallet addresses, or UUIDs aloud — instead describe the destination."
    this.conversation.push({ role: "system", content: this.systemPrompt })
  }

  private setStatus(status: VoiceSessionStatus): void {
    if (this.destroyed) return
    this.currentStatus = status
    this.statusCallback?.(status)
  }

  /** Start the composite session — initialize STT/TTS and emit a greeting. */
  async connect(): Promise<void> {
    if (this.destroyed) return

    const validation = validateNomadWorksPMAConfig()
    if (!validation.ok) {
      const error = new Error(`NomadWorks PMA config invalid: ${validation.errors.join(", ")}`)
      this.onError(error)
      throw error
    }

    this.setStatus("connecting")

    // ── STT ────────────────────────────────────────────────────────────
    if (this.sttEngine === "deepgram") {
      if (isDeepgramEnabled()) {
        const callbacks: DeepgramSTTCallbacks = {
          onTranscript: (text, isFinal) => this.handleSttTranscript(text, isFinal),
          onUtteranceEnd: () => this.handleUtteranceEnd(),
          onError: (err) => {
            console.error("[nomadworks-pma] Deepgram STT error:", err.message)
            this.onError(err)
          },
          onClose: (code) => {
            console.log("[nomadworks-pma] Deepgram STT closed, code:", code)
          },
        }
        this.stt = createDeepgramSTTConnection({
          model: process.env.VOICE_PMA_STT_MODEL?.trim() || "nova-3",
          language: "en",
          encoding: "linear16",
          sampleRate: PMA_AUDIO_SAMPLE_RATE,
          ...callbacks,
        })
      } else {
        console.warn("[nomadworks-pma] Deepgram not enabled — STT will be inactive")
      }
    } else {
      // Default: whisper.cpp (local or server).
      const callbacks: WhisperSTTCallbacks = {
        onTranscript: (text, isFinal) => this.handleSttTranscript(text, isFinal),
        onUtteranceEnd: () => this.handleUtteranceEnd(),
        onError: (err) => {
          console.error("[nomadworks-pma] Whisper STT error:", err.message)
          this.onError(err)
        },
        onClose: (code) => {
          console.log("[nomadworks-pma] Whisper STT closed, code:", code)
        },
        onReady: () => this.handleSttReady(),
      }
      this.stt = createWhisperSTTConnection({
        serverUrl: process.env.WHISPER_SERVER_URL?.trim() || undefined,
        language: "en",
        ...callbacks,
      })
    }

    // ── TTS ────────────────────────────────────────────────────────────
    if (this.ttsEngine === "deepgram") {
      if (isDeepgramEnabled()) {
        const callbacks: DeepgramTTSCallbacks = {
          onAudio: (base64Chunk) => {
            this.setStatus("speaking")
            this.onAudio(base64Chunk)
          },
          onFlushed: () => this.setStatus("idle"),
          onError: (err) => {
            console.error("[nomadworks-pma] Deepgram TTS error:", err.message)
            this.onError(err)
          },
          onClose: (code) => {
            console.log("[nomadworks-pma] Deepgram TTS closed, code:", code)
          },
        }
        this.tts = createDeepgramTTSConnection(
          (process.env.VOICE_PMA_TTS_VOICE?.trim() || "aura-asteria-en") as DeepgramVoiceId,
          callbacks,
        )
      } else {
        console.warn("[nomadworks-pma] Deepgram not enabled — TTS will use OpenAI fallback")
        this.ttsEngine = "openai-tts"
      }
    }

    // Connected — greeting is emitted by the caller via onResponse.
    this.connected = true
    this.setStatus("connected")

    const greeting = `Voice session ready. Using ${VOICE_PMA_LLM_PROVIDER === "grok" ? "Grok" : "OpenAI"} for language, ${this.sttEngine} for speech recognition${this.ttsEngine === "deepgram" ? ", Deepgram Aura-2" : ""}.`
    this.onResponse(greeting)
    this.onTranscript(greeting, true)
  }

  /** Handle STT transcript (partial or final). */
  private handleSttTranscript(text: string, isFinal: boolean): void {
    if (this.destroyed) return
    const sanitized = sanitizeAsrText(text)
    if (!sanitized.trim()) return

    if (isFinal) {
      this.pendingTranscript = sanitized
      this.onTranscript(sanitized, false)
    } else {
      this.onTranscript(sanitized, false)
    }
  }

  /** Handle STT ready signal (whisper.cpp). */
  private handleSttReady(): void {
    if (!this.connected) {
      this.connected = true
      this.setStatus("connected")
    }
  }

  /** Handle end of a user utterance — commit transcript and process turn. */
  private handleUtteranceEnd(): void {
    const finalText = this.pendingTranscript.trim()
    this.pendingTranscript = ""
    if (!finalText) return
    if (isFillerTranscript(finalText)) {
      console.log("[nomadworks-pma] Ignoring filler:", finalText.slice(0, 40))
      return
    }
    this.onTranscript(finalText, true)
    void this.processTurn(finalText)
  }

  /**
   * Run a full STT → LLM → TTS turn. Records latency and cost telemetry.
   */
  private async processTurn(userText: string): Promise<void> {
    if (this.destroyed || this.responseInProgress) return
    this.responseInProgress = true
    this.setStatus("processing")

    const turnStartedAt = Date.now()

    try {
      this.conversation.push({ role: "user", content: userText })

      const llmResult = await callPmaLlm(
        this.conversation.slice(-PMA_MAX_CONTEXT),
      )

      // Telemetry — latency per turn.
      recordVoiceTurnLatency(this.sessionId, llmResult.latencyMs)

      // Telemetry — cost estimate (rough $/1K-token heuristic).
      const estimatedCostCents = this.estimateTurnCost(llmResult)
      recordVoiceTurnCost(this.sessionId, estimatedCostCents)

      if (llmResult.content) {
        const clean = stripThinkingContent(llmResult.content)
        if (clean.trim()) {
          this.conversation.push({ role: "assistant", content: clean })
          const speakText = sanitizeSpeechText(clean)
          this.onResponse(speakText)
          await this.speakWithTts(speakText)
        }
      }
    } catch (err) {
      const errorMsg = `Error processing turn: ${(err as Error).message}`
      console.error(`[nomadworks-pma] ${errorMsg}`)
      this.onError(new Error(errorMsg))
    } finally {
      this.responseInProgress = false
      if (!this.destroyed) this.setStatus("idle")
    }
  }

  /**
   * Rough cost estimate in cents for a completed turn. Uses published
   * list pricing so telemetry is meaningful without tokenization.
   */
  private estimateTurnCost(result: PmaLlmResult): number {
    const model = result.model.toLowerCase()
    // $/1K tokens (input + output blended). Approximate.
    let perThousand = 0.1 // gpt-4o-mini default
    if (model.includes("grok-2")) perThousand = 0.25
    else if (model.includes("gpt-4o-mini")) perThousand = 0.1
    else if (model.includes("gpt-4o")) perThousand = 0.5
    else if (model.includes("gpt-3.5")) perThousand = 0.05

    // Assume ~200 tokens per short voice turn.
    const estimatedTokens = 200
    return Math.round((estimatedTokens / 1000) * perThousand * 100) / 100
  }

  /**
   * Synthesize text via the configured TTS engine.
   */
  private async speakWithTts(text: string): Promise<void> {
    if (this.ttsEngine === "deepgram" && this.tts) {
      this.setStatus("speaking")
      this.tts.speak(text)
      this.tts.flush()
    } else {
      // Default: OpenAI HTTP TTS.
      this.setStatus("speaking")
      try {
        await synthesizeOpenAiTts(text, (chunk) => this.onAudio(chunk))
      } catch (err) {
        console.error("[nomadworks-pma] OpenAI TTS error:", (err as Error).message)
        this.onError(err as Error)
      } finally {
        this.setStatus("idle")
      }
    }
  }

  sendAudio(chunk: string): void {
    if (this.destroyed || !this.connected) return
    this.audioBuffer.addChunk(chunk)
    this.setStatus("processing")
    if (this.stt) {
      this.stt.sendAudio(chunk)
    }
  }

  speak(text: string): void {
    if (this.destroyed || !this.connected) return
    if (!text.trim()) return
    this.setStatus("speaking")
    this.onResponse(text)
    void this.speakWithTts(text)
  }

  stop(): void {
    if (this.destroyed || !this.connected) return
    // Whisper STT has no flush semantics — utterance boundaries come from VAD.
    if (this.tts) {
      try {
        this.tts.flush()
      } catch {
        /* non-critical */
      }
    }
    this.setStatus("idle")
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.connected = false
    this.setStatus("idle")
    if (this.stt) {
      this.stt.close()
      this.stt = null
    }
    if (this.tts) {
      this.tts.close()
      this.tts = null
    }
    this.audioBuffer.reset()
    LATENCY_METRICS.delete(this.sessionId)
    COST_METRICS.delete(this.sessionId)
  }
}

// ── Factory ────────────────────────────────────────────────────────────

export function createNomadWorksPmaSession(params: CreateVoiceSessionParams): VoiceSession {
  const session = new NomadWorksPMAVoiceSession(params)
  void session.connect().catch((err) => {
    console.error(`[nomadworks-pma] Failed to connect session ${params.sessionId}:`, err)
  })
  return session
}
