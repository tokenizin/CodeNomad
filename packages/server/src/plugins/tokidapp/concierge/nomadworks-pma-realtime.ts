/**
 * NomadWorks PMA voice session — foundation stub.
 *
 * This is the server-side adapter for engine: "nomadworks-pma".  It composes
 * STT → LLM → TTS by delegating to the configured provider (OpenAI or Grok/xAI)
 * while exposing the same `VoiceSession` interface as the other engines.
 *
 * At this foundation stage the adapter is a transparent stub: it wires the
 * lifecycle and emits a short greeting so callers can verify end-to-end routing.
 * The actual provider-specific LLM/TTS implementation will land in a follow-up
 * slice.
 */

import type { VoiceSession, CreateVoiceSessionParams } from "./voice-speech-orchestrator"

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
  onStatus: (callback: import("./voice-speech-orchestrator").StatusCallback) => void = () => {}
  onError: (error: Error) => void = () => {}

  private statusCallback: import("./voice-speech-orchestrator").StatusCallback | null = null
  private destroyed = false

  constructor(params: CreateVoiceSessionParams) {
    this.sessionId = params.sessionId
  }

  private setStatus(status: import("./voice-speech-orchestrator").VoiceSessionStatus): void {
    this.statusCallback?.(status)
  }

  /** Start the composite session. */
  async connect(): Promise<void> {
    if (this.destroyed) return

    const validation = validateNomadWorksPMAConfig()
    if (!validation.ok) {
      const error = new Error(`NomadWorks PMA config invalid: ${validation.errors.join(", ")}`)
      this.onError(error)
      throw error
    }

    this.connected = true
    this.setStatus("connected")

    // Foundation: emit a brief greeting so the caller can verify routing.
    const greeting = `NomadWorks PMA voice session ${this.sessionId} connected using provider ${VOICE_PMA_LLM_PROVIDER}.`
    this.onResponse(greeting)
    this.onTranscript(greeting, true)
  }

  sendAudio(chunk: string): void {
    if (this.destroyed || !this.connected) return
    // Stub: in the full implementation this will feed the configured STT engine.
    void chunk
    this.setStatus("processing")
  }

  speak(text: string): void {
    if (this.destroyed || !this.connected) return
    this.setStatus("speaking")
    this.onResponse(text)
    // Stub: in the full implementation this will stream TTS audio via onAudio.
    this.setStatus("idle")
  }

  stop(): void {
    if (this.destroyed || !this.connected) return
    this.setStatus("idle")
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.connected = false
    this.setStatus("idle")
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
