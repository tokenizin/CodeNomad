/**
 * Unified Voice Session Orchestrator — thin routing layer.
 *
 * Dispatches voice sessions to the correct backend based on engine selection:
 *   engine: 'openai'   → existing OpenAI Realtime path (no changes)
 *   engine: 'local'    → whisper-stt + local-tts + Ollama LLM
 *   engine: 'deepgram' → deepgram-realtime.ts
 *
 * Provides a unified VoiceSession interface across all engines, and a shared
 * LLM fallback chain (Ollama primary → Ollama fast → GPT-4o mini) for the
 * local and deepgram engines.
 *
 * @module voice-speech-orchestrator
 */

import {
  createRealtimeSession,
  endVoiceSession as endOpenAISession,
} from "./openai-realtime"
import {
  createDeepgramSession,
  endDeepgramSession,
  type DeepgramSession,
} from "./deepgram-realtime"
import {
  createLocalSTTConnection,
  type LocalSTTConnection,
  type LocalSTTCallbacks,
} from "./local-stt"
import {
  createLocalTTSConnection,
  type LocalTTSConnection,
  type LocalTTSCallbacks,
} from "./local-tts"
import { AudioBuffer, PreSessionAudioManager } from "./audio-buffer"
import type { RealtimeVoiceId } from "./realtime-voices"
import type { DeepgramVoiceId } from "./deepgram-speech"
import { sanitizeAsrText, sanitizeSpeechText, VOICE_INSTRUCTIONS } from "./speech-sanitize"

// ── Engine Types ───────────────────────────────────────────────────────

/** Supported voice engine backends. */
export type VoiceEngine = "openai" | "local" | "deepgram"

/** Session lifecycle states. */
export type VoiceSessionStatus =
  | "connecting"
  | "connected"
  | "processing"
  | "speaking"
  | "idle"
  | "error"

/** Lifecycle status callback. */
export type StatusCallback = (status: VoiceSessionStatus) => void

// ── Unified VoiceSession Interface ─────────────────────────────────────

/**
 * Unified interface across all voice engines. Callers interact with this
 * regardless of the underlying backend.
 */
export interface VoiceSession {
  /** Which engine this session uses. */
  engine: VoiceEngine
  /** Unique session ID (typically "voice_<userId>"). */
  sessionId: string
  /** Whether the session is currently active. */
  connected: boolean

  /** Send an audio chunk to the session (base64-encoded PCM or raw). */
  sendAudio(chunk: string): void
  /** Synthesize text to speech and stream audio back. */
  speak(text: string): void
  /** Stop the current TTS playback. */
  stop(): void
  /** Tear down the session and release resources. */
  destroy(): void

  // ── Event Callbacks ────────────────────────────────────────────

  /** Fires when user speech is transcribed (partial or final). */
  onTranscript: (text: string, isFinal: boolean) => void
  /** Fires when the assistant generates a text response. */
  onResponse: (text: string) => void
  /** Fires with base64-encoded audio chunks for playback. */
  onAudio: (base64Chunk: string) => void
  /** Fires when a voice command is recognized. */
  onCommand: (command: string, confidence: number) => void
  /** Fires on session lifecycle status changes. */
  onStatus: (callback: StatusCallback) => void
  /** Fires on errors. */
  onError: (error: Error) => void
}

// ── Create Session Parameters ──────────────────────────────────────────

/**
 * Parameters for createVoiceSession(). Engine-specific options are optional;
 * defaults are applied per-engine.
 */
export interface CreateVoiceSessionParams {
  /** Engine backend to use. */
  engine: VoiceEngine
  /** Unique session identifier. */
  sessionId: string
  /** User ID for safety tracking and session management. */
  userId?: string
  /** Enriched instructions (architecture digest, etc.). */
  enrichedInstructions?: string
  /** StarWorld / chat-html DB session ID for greeting dedup. */
  chatSessionId?: string
  /** Send messages to the frontend client WebSocket. */
  sendToClient?: (msg: string) => void

  // ── Engine-Specific Overrides (optional) ─────────────────────

  /** TTS voice (OpenAI: RealtimeVoiceId, Deepgram: DeepgramVoiceId). */
  voice?: string
  /** Whisper server URL override (local engine). */
  whisperServerUrl?: string
  /** Piper voice override (local engine). */
  localTtsVoice?: string
}

// ── LLM Fallback Chain (Shared) ───────────────────────────────────────

/**
 * LLM provider configuration for the fallback chain.
 * Used by both local and deepgram engines.
 */
interface LLMProvider {
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs: number
}

/** Chat message format for LLM calls. */
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  tool_call_id?: string
  name?: string
}

/** Tool call in OpenAI function-calling format. */
interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** LLM response shape. */
interface LLMResponse {
  content: string
  toolCalls: ToolCall[]
  model: string
  latencyMs: number
}

// ── Environment Configuration ──────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434"
const OLLAMA_PRIMARY_MODEL = process.env.OLLAMA_PRIMARY_MODEL?.trim() || "llama3.1:8b"
const OLLAMA_FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL?.trim() || "qwen3:8b"
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""
const CLOUD_MODEL = "gpt-4o-mini"

const PRIMARY_MODEL_TIMEOUT = parseInt(process.env.PRIMARY_MODEL_TIMEOUT || "15000", 10)
const FAST_FALLBACK_TIMEOUT = parseInt(process.env.FAST_FALLBACK_TIMEOUT || "10000", 10)
const CLOUD_FALLBACK_TIMEOUT = parseInt(process.env.CLOUD_FALLBACK_TIMEOUT || "10000", 10)

const LOG_PREFIX = "[voice-speech-orchestrator]"

// ── Pre-session Audio Manager (exported for WS handler) ────────────────

/** Manages audio chunks that arrive before a session is fully initialized. */
export const preSessionAudio = new PreSessionAudioManager(256)

// ── LLM Provider Chain Builder ─────────────────────────────────────────

/**
 * Build the LLM fallback chain: Ollama primary → Ollama fast → Cloud GPT-4o mini.
 * Cloud fallback is only included when OPENAI_API_KEY is set.
 */
export function buildProviderChain(): LLMProvider[] {
  const chain: LLMProvider[] = [
    {
      name: "ollama-primary",
      baseUrl: OLLAMA_BASE_URL,
      model: OLLAMA_PRIMARY_MODEL,
      timeoutMs: PRIMARY_MODEL_TIMEOUT,
    },
    {
      name: "ollama-fallback",
      baseUrl: OLLAMA_BASE_URL,
      model: OLLAMA_FALLBACK_MODEL,
      timeoutMs: FAST_FALLBACK_TIMEOUT,
    },
  ]

  if (OPENAI_API_KEY) {
    chain.push({
      name: "cloud-openai",
      baseUrl: "https://api.openai.com",
      model: CLOUD_MODEL,
      apiKey: OPENAI_API_KEY,
      timeoutMs: CLOUD_FALLBACK_TIMEOUT,
    })
  }

  return chain
}

// ── Single-Provider LLM Call ───────────────────────────────────────────

/**
 * Call a single LLM provider with OpenAI-compatible chat/completions API.
 * Returns parsed response with content and optional tool calls.
 */
async function callLLMProvider(
  provider: LLMProvider,
  messages: ChatMessage[],
  toolDefs: unknown[] = [],
): Promise<LLMResponse> {
  const startTime = Date.now()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), provider.timeoutMs)

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (provider.apiKey) {
      headers["Authorization"] = `Bearer ${provider.apiKey}`
    }

    const body = {
      model: provider.model,
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      tool_choice: toolDefs.length > 0 ? "auto" : undefined,
      stream: false,
    }

    const res = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => "unknown error")
      throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`)
    }

    const data = (await res.json()) as any
    const choice = data.choices?.[0]
    if (!choice) throw new Error("No choices in response")

    const message = choice.message
    const content = typeof message?.content === "string" ? message.content : ""

    const toolCalls: ToolCall[] = []
    if (Array.isArray(message?.tool_calls)) {
      for (const tc of message.tool_calls) {
        if (tc.type === "function" && tc.function?.name) {
          toolCalls.push({
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments || {}),
          })
        }
      }
    }

    return {
      content,
      toolCalls,
      model: provider.model,
      latencyMs: Date.now() - startTime,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

// ── LLM Fallback Chain (Exported) ──────────────────────────────────────

/**
 * Call LLM with automatic fallback chain. Tries each provider in order;
 * on timeout or connection error, falls through to the next.
 *
 * Exported so deepgram-realtime.ts can use the same chain instead of
 * duplicating the logic.
 *
 * @param messages - Conversation context
 * @param toolDefs - Tool definitions (OpenAI function-calling format)
 * @returns LLM response from the first successful provider
 */
export async function callLLMWithFallback(
  messages: ChatMessage[],
  toolDefs: unknown[] = [],
): Promise<LLMResponse> {
  const chain = buildProviderChain()
  let lastError: Error | null = null

  for (const provider of chain) {
    try {
      console.log(
        `${LOG_PREFIX} Trying LLM provider: ${provider.name} (${provider.model})`
      )
      const response = await callLLMProvider(provider, messages, toolDefs)
      console.log(
        `${LOG_PREFIX} LLM response from ${provider.name}:`,
        `latency=${response.latencyMs}ms, content=${response.content.length} chars, toolCalls=${response.toolCalls.length}`
      )
      return response
    } catch (err) {
      const error = err as Error
      const isAbort = error.name === "AbortError"
      console.warn(
        `${LOG_PREFIX} LLM provider ${provider.name} failed:`,
        isAbort ? `timeout after ${provider.timeoutMs}ms` : error.message
      )
      lastError = error
    }
  }

  const errorMsg = lastError
    ? `All LLM providers failed. Last error: ${lastError.message}`
    : "No LLM providers available"
  console.error(`${LOG_PREFIX} ${errorMsg}`)
  return {
    content:
      "I'm having trouble connecting to my language model right now. Please try again in a moment.",
    toolCalls: [],
    model: "none",
    latencyMs: 0,
  }
}

// ── OpenAI Realtime Adapter ────────────────────────────────────────────

/**
 * Create a unified VoiceSession backed by the existing OpenAI Realtime path.
 * Thin adapter: maps VoiceSession callbacks to OpenAI's callback API.
 */
function createOpenAISession(params: CreateVoiceSessionParams): VoiceSession {
  const {
    sessionId,
    userId,
    enrichedInstructions,
    chatSessionId,
    sendToClient,
  } = params

  const statusCallbacks: StatusCallback[] = []
  const commandCallbacks: Array<(cmd: string, conf: number) => void> = []

  // Adapter callbacks — wired to VoiceSession event slots
  let transcriptCb: (text: string, isFinal: boolean) => void = () => {}
  let responseCb: (text: string) => void = () => {}
  let audioCb: (chunk: string) => void = () => {}
  let errorCb: (err: Error) => void = () => {}

  // Notify all registered status listeners
  function emitStatus(status: VoiceSessionStatus) {
    for (const cb of statusCallbacks) cb(status)
  }

  // Delegate to the existing createRealtimeSession factory
  const realtimeSession = createRealtimeSession(
    sessionId,
    /* onAudioDelta */ (base64) => audioCb(base64),
    /* onTextDelta */ (text) => responseCb(text),
    /* onError */ (err) => errorCb(new Error(err)),
    /* onReady */ () => emitStatus("connected"),
    /* onUserTranscript */ (text) => transcriptCb(text, true),
    /* onResponseDone */ () => emitStatus("idle"),
    /* outputVoice */ (params.voice as RealtimeVoiceId) || undefined,
    userId,
    enrichedInstructions,
    chatSessionId,
    sendToClient,
  )

  // Emit initial connecting status
  emitStatus("connecting")

  return {
    engine: "openai",
    sessionId,
    connected: realtimeSession.connected,

    sendAudio(_chunk: string) {
      // OpenAI Realtime path handles audio via ws.send in its own module
      // The caller should use openai-realtime.ts's sendAudioChunk() directly
      // This is a thin passthrough — the orchestrator doesn't duplicate WS logic
      console.warn(
        `${LOG_PREFIX} sendAudio on OpenAI session — use openai-realtime.sendAudioChunk() directly`
      )
    },

    speak(_text: string) {
      // OpenAI Realtime generates speech internally via response.create
      console.warn(
        `${LOG_PREFIX} speak() on OpenAI session — use tool calls for speech generation`
      )
    },

    stop() {
      // Cancel in-progress response
      try {
        const { cancelRealtimeResponse } = require("./openai-realtime")
        cancelRealtimeResponse(sessionId)
      } catch {
        // Non-critical
      }
      emitStatus("idle")
    },

    destroy() {
      endOpenAISession(sessionId)
      emitStatus("error") // Final status — session ended
    },

    onTranscript: (text, isFinal) => {
      transcriptCb(text, isFinal)
    },

    onResponse: (text) => {
      responseCb(text)
    },

    onAudio: (chunk) => {
      audioCb(chunk)
    },

    onCommand: (command, confidence) => {
      for (const cb of commandCallbacks) cb(command, confidence)
    },

    onStatus: (cb: StatusCallback) => {
      statusCallbacks.push(cb)
    },

    onError: (err) => {
      errorCb(err)
    },
  }
}

// ── Local Engine Adapter ───────────────────────────────────────────────

/**
 * Create a unified VoiceSession backed by whisper-stt + local-tts + Ollama LLM.
 *
 * Pipeline: Browser Audio → whisper-stt (transcription) → Ollama LLM fallback chain
 *           → local-tts (Piper) → Audio back to browser.
 */
function createLocalSession(params: CreateVoiceSessionParams): VoiceSession {
  const {
    sessionId,
    userId,
    localTtsVoice,
    enrichedInstructions,
    chatSessionId,
    sendToClient,
  } = params

  // Status management
  let currentStatus: VoiceSessionStatus = "connecting"
  const statusCallbacks: StatusCallback[] = []
  const commandCallbacks: Array<(cmd: string, conf: number) => void> = []

  // Event callback slots (set by caller via VoiceSession properties)
  let transcriptCb: (text: string, isFinal: boolean) => void = () => {}
  let responseCb: (text: string) => void = () => {}
  let audioCb: (chunk: string) => void = () => {}
  let errorCb: (err: Error) => void = () => {}

  function emitStatus(status: VoiceSessionStatus) {
    currentStatus = status
    for (const cb of statusCallbacks) cb(status)
  }

  // Conversation context for LLM
  interface ConversationMessage {
    role: "system" | "user" | "assistant"
    content: string
    timestamp: number
  }
  const conversation: ConversationMessage[] = []
  const transcript: string[] = []
  let responseInProgress = false
  let connected = false

  // Build system prompt
  const systemPrompt = enrichedInstructions
    ? VOICE_INSTRUCTIONS + "\n\n" + enrichedInstructions
    : "You are Star World Assistant. Greet the user briefly and ask what they need."

  // Audio buffer for incoming chunks
  const audioBuffer = new AudioBuffer({
    label: `local-stt-${sessionId}`,
    minBytes: 4800,
  })

  // ── TTS (Piper) ──────────────────────────────────────────────────

  const ttsCallbacks: LocalTTSCallbacks = {
    onAudio: (base64Chunk) => {
      emitStatus("speaking")
      audioCb(base64Chunk)
    },
    onFlushed: () => {
      emitStatus("idle")
    },
    onError: (err) => {
      console.error(`${LOG_PREFIX} Local TTS error:`, err.message)
      errorCb(err)
    },
    onClose: (code) => {
      console.log(`${LOG_PREFIX} Local TTS closed, code:`, code)
    },
  }

  const tts: LocalTTSConnection = createLocalTTSConnection(
    localTtsVoice,
    ttsCallbacks,
  )

  // ── STT (Whisper) ────────────────────────────────────────────────

  const sttCallbacks: LocalSTTCallbacks = {
    onTranscript: (text, isFinal) => {
      if (!isFinal) return
      const sanitized = sanitizeAsrText(text)
      if (!sanitized.trim()) return

      console.log(`${LOG_PREFIX} Local STT transcript:`, sanitized.slice(0, 120))

      transcriptCb(sanitized, true)
      transcript.push(`[user] ${sanitized}`)

      // Add to conversation context
      conversation.push({
        role: "user",
        content: sanitized,
        timestamp: Date.now(),
      })

      // Process through LLM
      if (!responseInProgress) {
        processLocalMessage(sanitized)
      }
    },
    onUtteranceEnd: () => {
      console.log(`${LOG_PREFIX} Utterance end for local session:`, sessionId)
    },
    onError: (err) => {
      console.error(`${LOG_PREFIX} Local STT error:`, err.message)
      errorCb(err)
    },
    onClose: (code) => {
      console.log(`${LOG_PREFIX} Local STT closed, code:`, code)
    },
    onReady: () => {
      connected = true
      emitStatus("connected")
    },
  }

  const stt: LocalSTTConnection = createLocalSTTConnection(sttCallbacks)

  // ── LLM Processing ───────────────────────────────────────────────

  async function processLocalMessage(userText: string) {
    if (responseInProgress) return
    responseInProgress = true
    emitStatus("processing")

    try {
      // Build messages for LLM (last 30 messages for context)
      const maxContext = 30
      const recentConversation = conversation.slice(-maxContext)
      const llmMessages: ChatMessage[] = recentConversation.map((m) => ({
        role: m.role,
        content: m.content,
      }))

      const llmResponse = await callLLMWithFallback(llmMessages)

      if (llmResponse.content) {
        conversation.push({
          role: "assistant",
          content: llmResponse.content,
          timestamp: Date.now(),
        })
        transcript.push(`[assistant] ${sanitizeSpeechText(llmResponse.content)}`)

        responseCb(llmResponse.content)

        // Synthesize speech via Piper TTS
        tts.speak(llmResponse.content)
        tts.flush()
      }
    } catch (err) {
      const errorMsg = `Error processing message: ${(err as Error).message}`
      console.error(`${LOG_PREFIX} ${errorMsg}`)
      errorCb(new Error(errorMsg))

      try {
        tts.speak("I encountered an error processing that. Please try again.")
        tts.flush()
      } catch {
        // Non-critical
      }
    } finally {
      responseInProgress = false
      emitStatus("idle")
    }
  }

  // ── Play greeting ─────────────────────────────────────────────────

  const greetKey = (chatSessionId || "").trim() || sessionId
  // Simple greeting dedup via module-level set
  if (!localGreetingPlayed.has(greetKey)) {
    localGreetingPlayed.add(greetKey)
    const greetingText = "Hello! I'm your local voice assistant. How can I help?"
    conversation.push({
      role: "assistant",
      content: greetingText,
      timestamp: Date.now(),
    })
    transcript.push(`[assistant] ${sanitizeSpeechText(greetingText)}`)
    responseCb(greetingText)
    tts.speak(greetingText)
    tts.flush()
    setTimeout(() => emitStatus("connected"), 200)
  } else {
    emitStatus("connected")
  }

  // ── Return unified session ────────────────────────────────────────

  return {
    engine: "local",
    sessionId,
    connected,

    sendAudio(chunk: string) {
      if (!connected) {
        console.warn(`${LOG_PREFIX} sendAudio dropped — local session not connected`)
        return
      }
      audioBuffer.addChunk(chunk)
      stt.sendAudio(chunk)
    },

    speak(text: string) {
      if (!text.trim()) return
      emitStatus("speaking")
      tts.speak(text)
      tts.flush()
    },

    stop() {
      tts.flush()
      emitStatus("idle")
    },

    destroy() {
      connected = false
      stt.close()
      tts.close()
      audioBuffer.reset()
      emitStatus("error")
    },

    onTranscript: (text, isFinal) => {
      transcriptCb(text, isFinal)
    },

    onResponse: (text) => {
      responseCb(text)
    },

    onAudio: (chunk) => {
      audioCb(chunk)
    },

    onCommand: (command, confidence) => {
      for (const cb of commandCallbacks) cb(command, confidence)
    },

    onStatus: (cb: StatusCallback) => {
      statusCallbacks.push(cb)
    },

    onError: (err) => {
      errorCb(err)
    },
  }
}

/** Module-level greeting dedup for local engine. */
const localGreetingPlayed = new Set<string>()

// ── Deepgram Engine Adapter ────────────────────────────────────────────

/**
 * Create a unified VoiceSession backed by deepgram-realtime.ts.
 * Thin adapter: wraps DeepgramSession in the unified VoiceSession interface.
 */
function createDeepgramAdapter(params: CreateVoiceSessionParams): VoiceSession {
  const {
    sessionId,
    userId,
    voice,
    enrichedInstructions,
    chatSessionId,
    sendToClient,
  } = params

  const statusCallbacks: StatusCallback[] = []
  const commandCallbacks: Array<(cmd: string, conf: number) => void> = []

  let transcriptCb: (text: string, isFinal: boolean) => void = () => {}
  let responseCb: (text: string) => void = () => {}
  let audioCb: (chunk: string) => void = () => {}
  let errorCb: (err: Error) => void = () => {}

  function emitStatus(status: VoiceSessionStatus) {
    for (const cb of statusCallbacks) cb(status)
  }

  emitStatus("connecting")

  // Delegate to the existing createDeepgramSession factory
  const deepgramSession: DeepgramSession = createDeepgramSession({
    sessionId,
    onAudioDelta: (base64) => audioCb(base64),
    onTextDelta: (text) => responseCb(text),
    onError: (err) => errorCb(new Error(err)),
    onReady: () => emitStatus("connected"),
    onUserTranscript: (text) => transcriptCb(text, true),
    onResponseDone: () => emitStatus("idle"),
    voice: voice as DeepgramVoiceId | undefined,
    userId,
    enrichedInstructions,
    chatSessionId,
    sendToClient,
  })

  // Cast to access methods added by createDeepgramSession
  const dgSession = deepgramSession as DeepgramSession & {
    sendAudio?: (base64Chunk: string) => void
    sendMessage?: (text: string) => void
    destroy?: () => void
  }

  return {
    engine: "deepgram",
    sessionId,
    connected: deepgramSession.connected,

    sendAudio(chunk: string) {
      if (dgSession.sendAudio) {
        dgSession.sendAudio(chunk)
      } else {
        console.warn(`${LOG_PREFIX} Deepgram session sendAudio not available`)
      }
    },

    speak(text: string) {
      if (dgSession.sendMessage) {
        dgSession.sendMessage(text)
      } else {
        console.warn(`${LOG_PREFIX} Deepgram session sendMessage not available`)
      }
    },

    stop() {
      // Deepgram doesn't have a native stop — TTS will complete naturally
      emitStatus("idle")
    },

    destroy() {
      endDeepgramSession(sessionId)
      emitStatus("error")
    },

    onTranscript: (text, isFinal) => {
      transcriptCb(text, isFinal)
    },

    onResponse: (text) => {
      responseCb(text)
    },

    onAudio: (chunk) => {
      audioCb(chunk)
    },

    onCommand: (command, confidence) => {
      for (const cb of commandCallbacks) cb(command, confidence)
    },

    onStatus: (cb: StatusCallback) => {
      statusCallbacks.push(cb)
    },

    onError: (err) => {
      errorCb(err)
    },
  }
}

// ── Factory Function ───────────────────────────────────────────────────

/**
 * Create a unified VoiceSession for the specified engine.
 *
 * Routes to the correct backend:
 *   - 'openai'   → existing OpenAI Realtime WebSocket path
 *   - 'local'    → whisper-stt + local-tts + Ollama LLM
 *   - 'deepgram' → Deepgram STT → LLM → Deepgram TTS
 *
 * Returns a VoiceSession with a consistent interface regardless of engine.
 *
 * @param params - Session configuration including engine selection
 * @returns A VoiceSession handle
 */
export function createVoiceSession(
  params: CreateVoiceSessionParams,
): VoiceSession {
  const { engine, sessionId } = params

  console.log(`${LOG_PREFIX} Creating session: engine=${engine}, sessionId=${sessionId}`)

  switch (engine) {
    case "openai":
      return createOpenAISession(params)

    case "local":
      return createLocalSession(params)

    case "deepgram":
      return createDeepgramAdapter(params)

    default: {
      const _exhaustive: never = engine
      throw new Error(`${LOG_PREFIX} Unknown engine: ${String(_exhaustive)}`)
    }
  }
}

// ── Session Management ─────────────────────────────────────────────────

/** Active unified sessions indexed by sessionId. */
const activeSessions = new Map<string, VoiceSession>()

/**
 * Create a voice session and register it in the active sessions map.
 * Prevents duplicate sessions for the same sessionId.
 */
export function createAndRegisterVoiceSession(
  params: CreateVoiceSessionParams,
): VoiceSession {
  // Destroy any existing session with the same ID
  const existing = activeSessions.get(params.sessionId)
  if (existing) {
    console.warn(
      `${LOG_PREFIX} Replacing existing session: ${params.sessionId} (engine: ${existing.engine})`
    )
    existing.destroy()
  }

  const session = createVoiceSession(params)
  activeSessions.set(params.sessionId, session)
  return session
}

/**
 * Get an active session by ID.
 */
export function getVoiceSession(sessionId: string): VoiceSession | undefined {
  return activeSessions.get(sessionId)
}

/**
 * Destroy a session and remove it from the active sessions map.
 */
export function endVoiceSession(sessionId: string): void {
  const session = activeSessions.get(sessionId)
  if (session) {
    session.destroy()
    activeSessions.delete(sessionId)
  }
}

/**
 * Get the count of active sessions.
 */
export function getActiveVoiceSessionCount(): number {
  let count = 0
  for (const session of Array.from(activeSessions.values())) {
    if (session.connected) count++
  }
  return count
}

/**
 * Check if a session exists and is connected.
 */
export function hasActiveVoiceSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId)
  return !!session?.connected
}

// ── Engine Capability Check ────────────────────────────────────────────

/**
 * Check if a specific engine is available (API keys configured, services reachable).
 */
export function isEngineAvailable(engine: VoiceEngine): boolean {
  switch (engine) {
    case "openai":
      return !!process.env.OPENAI_API_KEY
    case "deepgram":
      return (
        process.env.DEEPGRAM_ENABLED?.trim() === "true" &&
        !!process.env.DEEPGRAM_API_KEY
      )
    case "local":
      // Local engines don't require API keys — they use on-device models.
      // Availability depends on the Python processes being installed.
      return true
    default:
      return false
  }
}

/**
 * Get the list of available engines based on current configuration.
 */
export function getAvailableEngines(): VoiceEngine[] {
  const engines: VoiceEngine[] = []
  if (isEngineAvailable("openai")) engines.push("openai")
  if (isEngineAvailable("deepgram")) engines.push("deepgram")
  if (isEngineAvailable("local")) engines.push("local")
  return engines
}
