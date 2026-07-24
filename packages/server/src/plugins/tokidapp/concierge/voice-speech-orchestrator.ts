/**
 * Unified Voice Session Orchestrator — thin routing layer.
 *
 * Dispatches voice sessions to the correct backend based on engine selection:
 *   engine: 'openai'   → existing OpenAI Realtime path (no changes)
 *   engine: 'local'    → whisper-stt + local-tts + Ollama LLM
 *   engine: 'deepgram' → deepgram-realtime.ts
 *   engine: 'ornith'   → ornith-realtime.ts (31B-dense)
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
  createOrnithSession,
  removeOrnithSession,
} from "./ornith-realtime"
import {
  createLocalSTTConnection,
  type LocalSTTConnection,
  type LocalSTTCallbacks,
} from "./local-stt"
import {
  createWhisperSTTConnection,
  checkHealth as checkWhisperHealth,
  type WhisperSTTConnection,
} from "./whisper-stt"
import {
  createLocalTTSConnection,
  type LocalTTSConnection,
  type LocalTTSCallbacks,
} from "./local-tts"
import {
  pickPiperVoiceForLocale,
  resolvePiperModelAndSynthesis,
} from "./piper-voice-catalog"
import {
  detectSpeechLanguage,
  planVoiceLocales,
  translateSpeechText,
  type SpeechLang,
} from "./voice-translate"
import { AudioBuffer, PreSessionAudioManager } from "./audio-buffer"
import type { RealtimeVoiceId } from "./realtime-voices"
import type { DeepgramVoiceId } from "./deepgram-speech"
import { sanitizeAsrText, sanitizeSpeechText, stripThinkingContent, isFillerTranscript, VOICE_INSTRUCTIONS } from "./speech-sanitize"
import type WebSocket from "ws"

// ── Engine Types ───────────────────────────────────────────────────────

/** Supported voice engine backends. */
export type VoiceEngine = "openai" | "local" | "deepgram" | "ornith"

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

  /** TTS voice (OpenAI / Deepgram / Piper profile id). */
  voice?: string
  /** Whisper server URL override (local engine). */
  whisperServerUrl?: string
  /** Piper voice / profile override (local engine). */
  localTtsVoice?: string
  /** Speech locale: en | id | auto. */
  locale?: "en" | "id" | "auto"
  /** Interpret mode: STT→EN for LLM, reply TTS in user language. */
  interpret?: boolean
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
/** Prefer Ornith when enabled — local voice fallback should use the same local chat model. */
const OLLAMA_PRIMARY_MODEL =
  process.env.OLLAMA_PRIMARY_MODEL?.trim() ||
  (process.env.ORNITH_ENABLED?.trim() === "true"
    ? process.env.ORNITH_MODEL_ID?.trim() || "ornith:latest"
    : "llama3.1:8b")
const OLLAMA_FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL?.trim() || "qwen3:8b"
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""
const CLOUD_MODEL = "gpt-4o-mini"
/** When true, local voice never calls OpenAI for LLM (default). */
const LOCAL_VOICE_NO_CLOUD =
  process.env.VOICE_LOCAL_NO_CLOUD?.trim().toLowerCase() !== "false"

const PRIMARY_MODEL_TIMEOUT = parseInt(process.env.PRIMARY_MODEL_TIMEOUT || "15000", 10)
const FAST_FALLBACK_TIMEOUT = parseInt(process.env.FAST_FALLBACK_TIMEOUT || "10000", 10)
const CLOUD_FALLBACK_TIMEOUT = parseInt(process.env.CLOUD_FALLBACK_TIMEOUT || "10000", 10)

const LOG_PREFIX = "[voice-speech-orchestrator]"

// ── Pre-session Audio Manager (exported for WS handler) ────────────────

/** Manages audio chunks that arrive before a session is fully initialized. */
export const preSessionAudio = new PreSessionAudioManager(256)

// ── LLM Provider Chain Builder ─────────────────────────────────────────

export interface BuildProviderChainOptions {
  /** When false, never append cloud OpenAI (used by local / no-cloud voice). Default true for Deepgram. */
  allowCloud?: boolean
}

/**
 * Build the LLM fallback chain: Ollama primary → Ollama fast → optional Cloud GPT-4o mini.
 * Cloud is omitted when allowCloud=false or OPENAI_API_KEY is unset.
 */
export function buildProviderChain(options: BuildProviderChainOptions = {}): LLMProvider[] {
  const allowCloud = options.allowCloud !== false
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

  if (allowCloud && OPENAI_API_KEY) {
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
 * Call a single LLM provider.
 * Ollama/Ornith: native `/api/chat` with `think: false` (avoids CoT in content).
 * Others: OpenAI-compatible `/v1/chat/completions`.
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
    const useOllamaNative = provider.name.startsWith("ollama")

    if (useOllamaNative) {
      const body = {
        model: provider.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        think: false,
      }
      const res = await fetch(`${provider.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const errorText = await res.text().catch(() => "unknown error")
        throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`)
      }
      const data = (await res.json()) as any
      const raw =
        typeof data?.message?.content === "string" ? data.message.content : ""
      return {
        content: stripThinkingContent(raw),
        toolCalls: [],
        model: provider.model,
        latencyMs: Date.now() - startTime,
      }
    }

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
    const content = stripThinkingContent(
      typeof message?.content === "string" ? message.content : "",
    )

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
  options: BuildProviderChainOptions = {},
): Promise<LLMResponse> {
  const chain = buildProviderChain(options)
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
 * Create a unified VoiceSession backed by local STT + Piper TTS + Ollama LLM.
 *
 * Pipeline: Browser Audio → whisper.cpp (preferred) or faster-whisper → Ollama
 *           (no cloud) → Piper TTS → Audio back to browser.
 *
 * STT backend: WHISPER_SERVER healthy → whisper-stt; else Python local-stt.
 */
function createLocalSession(params: CreateVoiceSessionParams): VoiceSession {
  const {
    sessionId,
    voice,
    localTtsVoice,
    enrichedInstructions,
    chatSessionId,
    whisperServerUrl,
    locale = "en",
    interpret = false,
  } = params

  const voiceKey = localTtsVoice || voice
  const localePlan = planVoiceLocales({ locale, interpret })
  const piperProfile = pickPiperVoiceForLocale(voiceKey, locale === "auto" ? "en" : locale)
  const piperResolved = resolvePiperModelAndSynthesis(piperProfile.id)

  // Status management
  let currentStatus: VoiceSessionStatus = "connecting"
  const statusCallbacks: StatusCallback[] = []
  const commandCallbacks: Array<(cmd: string, conf: number) => void> = []

  // Event callback slots — route assigns session.onTranscript = … (setters)
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
  let lastUserLang: SpeechLang = locale === "id" ? "id" : "en"

  // Build system prompt
  const interpretHint = interpret
    ? "\n\nYou receive English transcripts (possibly translated from Indonesian). Reply in clear English; the system will speak the reply in the user's language."
    : locale === "id"
      ? "\n\nThe user speaks Indonesian. Reply in Bahasa Indonesia."
      : ""
  const systemPrompt = enrichedInstructions
    ? VOICE_INSTRUCTIONS + "\n\n" + enrichedInstructions + interpretHint
    : "You are Star World Assistant. Greet the user briefly and ask what they need." +
      interpretHint
  conversation.push({
    role: "system",
    content: systemPrompt,
    timestamp: Date.now(),
  })

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
    { voice: piperResolved.model, synthesis: piperResolved.synthesis },
    ttsCallbacks,
  )

  function speakLocalized(text: string, ttsLang: SpeechLang) {
    const profile = pickPiperVoiceForLocale(
      voiceKey || piperProfile.id,
      ttsLang,
    )
    const resolved = resolvePiperModelAndSynthesis(profile.id)
    tts.speak(text, {
      voice: resolved.model,
      ...resolved.synthesis,
    })
    tts.flush()
  }

  // ── STT (whisper.cpp preferred, Python faster-whisper fallback) ──

  /** Accumulate finals; commit only on utterance_end (avoids re-ASR spam). */
  let pendingUtterance = ""

  function commitPendingUtterance() {
    const sanitized = sanitizeAsrText(pendingUtterance)
    pendingUtterance = ""
    if (!sanitized.trim()) return
    if (isFillerTranscript(sanitized)) {
      console.log(`${LOG_PREFIX} Ignoring filler transcript:`, sanitized.slice(0, 40))
      return
    }

    console.log(`${LOG_PREFIX} Local STT transcript:`, sanitized.slice(0, 120))

    transcriptCb(sanitized, true)
    transcript.push(`[user] ${sanitized}`)

    if (!responseInProgress) {
      void processLocalMessage(sanitized)
    }
  }

  const sttCallbacks: LocalSTTCallbacks = {
    onTranscript: (text, isFinal) => {
      const sanitized = sanitizeAsrText(text)
      if (!sanitized.trim()) return
      if (isFinal) {
        // Keep latest final segment until silence ends the turn
        pendingUtterance = sanitized
        transcriptCb(sanitized, false)
      } else {
        transcriptCb(sanitized, false)
      }
    },
    onUtteranceEnd: () => {
      console.log(`${LOG_PREFIX} Utterance end for local session:`, sessionId)
      commitPendingUtterance()
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

  const preferWhisper = process.env.LOCAL_STT_BACKEND?.trim() === "whisper"

  let stt: LocalSTTConnection | WhisperSTTConnection
  let sttBackend: "whisper" | "python" = "python"

  if (preferWhisper) {
    sttBackend = "whisper"
    stt = createWhisperSTTConnection({
      serverUrl: whisperServerUrl,
      language: localePlan.sttLanguage ?? undefined,
      ...sttCallbacks,
    })
    console.log(`${LOG_PREFIX} Local STT backend: whisper.cpp`)
  } else {
    stt = createLocalSTTConnection({
      language: localePlan.sttLanguage === null ? "auto" : localePlan.sttLanguage,
      model: localePlan.sttModel,
      ...sttCallbacks,
    })
    console.log(
      `${LOG_PREFIX} Local STT backend: python faster-whisper`,
      `lang=${localePlan.sttLanguage ?? "auto"}`,
      `model=${localePlan.sttModel || "default"}`,
    )
  }

  // Mark connected when Piper is ready even if STT is still warming (mic can buffer).
  setTimeout(() => {
    if (!connected && tts.ready) {
      connected = true
      emitStatus("connected")
    }
  }, 1500)

  // ── LLM Processing (local only — no OpenAI) ─────────────────────

  async function processLocalMessage(userText: string) {
    if (responseInProgress) return
    responseInProgress = true
    emitStatus("processing")

    try {
      const detected = detectSpeechLanguage(userText)
      lastUserLang = locale === "auto" ? detected : locale === "id" ? "id" : "en"
      const plan = planVoiceLocales({
        locale,
        interpret,
        detectedFromText: detected,
      })

      let llmUserText = userText
      if (plan.llmLang !== plan.userLang || (interpret && detected !== "en")) {
        const fromLang = interpret ? detected : plan.userLang
        if (fromLang !== plan.llmLang) {
          llmUserText = await translateSpeechText(userText, fromLang, plan.llmLang)
          console.log(
            `${LOG_PREFIX} Translated user ${fromLang}→${plan.llmLang}:`,
            llmUserText.slice(0, 100),
          )
        }
      }

      conversation.push({
        role: "user",
        content: llmUserText,
        timestamp: Date.now(),
      })

      const maxContext = 30
      const recentConversation = conversation.slice(-maxContext)
      const llmMessages: ChatMessage[] = recentConversation.map((m) => ({
        role: m.role,
        content: m.content,
      }))

      const llmResponse = await callLLMWithFallback(llmMessages, [], {
        allowCloud: !LOCAL_VOICE_NO_CLOUD ? true : false,
      })

      if (llmResponse.content) {
        const cleanContent = stripThinkingContent(llmResponse.content)
        if (!cleanContent.trim()) {
          console.warn(`${LOG_PREFIX} Empty content after stripping think blocks`)
          return
        }
        conversation.push({
          role: "assistant",
          content: cleanContent,
          timestamp: Date.now(),
        })

        let speakText = cleanContent
        const ttsLang = interpret ? lastUserLang : plan.ttsLang
        if (ttsLang !== plan.llmLang) {
          speakText = await translateSpeechText(
            cleanContent,
            plan.llmLang,
            ttsLang,
          )
          console.log(
            `${LOG_PREFIX} Translated reply ${plan.llmLang}→${ttsLang}:`,
            speakText.slice(0, 100),
          )
        }

        speakText = sanitizeSpeechText(speakText)
        transcript.push(`[assistant] ${speakText}`)
        responseCb(speakText)
        speakLocalized(speakText, ttsLang)
      }
    } catch (err) {
      const errorMsg = `Error processing message: ${(err as Error).message}`
      console.error(`${LOG_PREFIX} ${errorMsg}`)
      errorCb(new Error(errorMsg))

      try {
        speakLocalized(
          lastUserLang === "id"
            ? "Maaf, terjadi kesalahan. Silakan coba lagi."
            : "I encountered an error processing that. Please try again.",
          lastUserLang,
        )
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
  if (!localGreetingPlayed.has(greetKey)) {
    localGreetingPlayed.add(greetKey)
    const greetingText =
      locale === "id"
        ? "Halo! Saya asisten suara lokal di mesin ini. Ada yang bisa dibantu?"
        : "Hello! I'm your local voice assistant on this machine. How can I help?"
    conversation.push({
      role: "assistant",
      content: greetingText,
      timestamp: Date.now(),
    })
    transcript.push(`[assistant] ${sanitizeSpeechText(greetingText)}`)
    setTimeout(() => {
      responseCb(greetingText)
      speakLocalized(greetingText, locale === "id" ? "id" : "en")
      emitStatus("connected")
      connected = true
    }, 250)
  } else {
    emitStatus("connected")
    connected = true
  }

  // ── Return unified session (property setters for route wiring) ──

  const session: VoiceSession = {
    engine: "local",
    sessionId,
    get connected() {
      return connected
    },

    sendAudio(chunk: string) {
      if (!connected) {
        audioBuffer.addChunk(chunk)
        stt.sendAudio(chunk)
        return
      }
      audioBuffer.addChunk(chunk)
      stt.sendAudio(chunk)
    },

    speak(text: string) {
      if (!text.trim()) return
      emitStatus("speaking")
      speakLocalized(text, lastUserLang)
    },

    stop() {
      try {
        if (sttBackend === "whisper") {
          ;(stt as unknown as LocalSTTConnection).flush()
        } else if (sttBackend === "python") {
          (stt as LocalSTTConnection).flush()
        }
      } catch {
        /* non-critical */
      }
      commitPendingUtterance()
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

    onTranscript: () => {},
    onResponse: () => {},
    onAudio: () => {},
    onCommand: (command, confidence) => {
      for (const cb of commandCallbacks) cb(command, confidence)
    },
    onStatus: (cb: StatusCallback) => {
      statusCallbacks.push(cb)
      cb(currentStatus)
    },
    onError: () => {},
  }

  Object.defineProperty(session, "onTranscript", {
    get: () => transcriptCb,
    set: (cb: (text: string, isFinal: boolean) => void) => {
      transcriptCb = cb
    },
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(session, "onResponse", {
    get: () => responseCb,
    set: (cb: (text: string) => void) => {
      responseCb = cb
    },
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(session, "onAudio", {
    get: () => audioCb,
    set: (cb: (chunk: string) => void) => {
      audioCb = cb
    },
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(session, "onError", {
    get: () => errorCb,
    set: (cb: (err: Error) => void) => {
      errorCb = cb
    },
    enumerable: true,
    configurable: true,
  })

  void checkWhisperHealth(whisperServerUrl || process.env.WHISPER_SERVER_URL || "http://127.0.0.1:8090")
    .then(() => {
      console.log(`${LOG_PREFIX} whisper.cpp healthy (sttBackend=${sttBackend})`)
    })
    .catch(() => {
      if (sttBackend === "whisper") {
        console.warn(
          `${LOG_PREFIX} whisper.cpp not reachable — start with: LOCAL_STT_MODEL=base.en bun run whisper:start`,
        )
      }
    })

  return session
}

/** Module-level greeting dedup for local engine. */
const localGreetingPlayed = new Set<string>()

// ── Deepgram Engine Adapter ────────────────────────────────────────────

/**
 * Create a unified VoiceSession backed by deepgram-realtime.ts.
 * Thin adapter: wraps DeepgramSession in the unified VoiceSession interface.
 */
async function createDeepgramAdapter(params: CreateVoiceSessionParams): Promise<VoiceSession> {
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
  const deepgramSession: DeepgramSession = await createDeepgramSession({
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

// ── Ornith Engine Adapter ──────────────────────────────────────────────

/**
 * Create a unified VoiceSession backed by ornith-realtime.ts.
 * createOrnithSession expects a client WebSocket; when called via the
 * orchestrator alone we use a stub until the voice WS route wires the real socket.
 */
function createOrnithAdapter(params: CreateVoiceSessionParams): VoiceSession {
  const { sessionId, voice, sendToClient } = params

  const statusCallbacks: StatusCallback[] = []
  let transcriptCb: (text: string, isFinal: boolean) => void = () => {}
  let responseCb: (text: string) => void = () => {}
  let audioCb: (chunk: string) => void = () => {}
  let errorCb: (err: Error) => void = () => {}

  function emitStatus(status: VoiceSessionStatus) {
    for (const cb of statusCallbacks) cb(status)
  }

  emitStatus("connecting")

  const stubWs = {
    send() {},
    close() {},
    readyState: 1,
  } as unknown as WebSocket

  const ornithSession = createOrnithSession(
    stubWs,
    sessionId,
    {
      voiceId: voice || undefined,
      sendToClient,
      locale: params.locale || "en",
      interpret: Boolean(params.interpret),
    },
  )

  emitStatus("connected")

  return {
    engine: "ornith",
    sessionId,
    connected: ornithSession.connected,

    sendAudio(_chunk: string) {
      console.warn(
        `${LOG_PREFIX} sendAudio on Ornith session — wire via voice WS + ornith-realtime`,
      )
    },

    speak(_text: string) {
      console.warn(
        `${LOG_PREFIX} speak() on Ornith session — use ornith-realtime response path`,
      )
    },

    stop() {
      emitStatus("idle")
    },

    destroy() {
      removeOrnithSession(sessionId)
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

    onCommand: (_command, _confidence) => {},

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
 *   - 'ornith'   → Ornith 31B-dense path
 *
 * Returns a VoiceSession with a consistent interface regardless of engine.
 *
 * @param params - Session configuration including engine selection
 * @returns A VoiceSession handle
 */
export async function createVoiceSession(
  params: CreateVoiceSessionParams,
): Promise<VoiceSession> {
  const { engine, sessionId } = params

  console.log(`${LOG_PREFIX} Creating session: engine=${engine}, sessionId=${sessionId}`)

  switch (engine) {
    case "openai":
      return createOpenAISession(params)

    case "local":
      return createLocalSession(params)

    case "deepgram":
      return await createDeepgramAdapter(params)

    case "ornith":
      return createOrnithAdapter(params)

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
export async function createAndRegisterVoiceSession(
  params: CreateVoiceSessionParams,
): Promise<VoiceSession> {
  // Destroy any existing session with the same ID
  const existing = activeSessions.get(params.sessionId)
  if (existing) {
    console.warn(
      `${LOG_PREFIX} Replacing existing session: ${params.sessionId} (engine: ${existing.engine})`
    )
    existing.destroy()
  }

  const session = await createVoiceSession(params)
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
    case "ornith":
      return (
        process.env.ORNITH_ENABLED?.trim() === "true" ||
        !!process.env.ORNITH_MODEL_ENDPOINT?.trim()
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
  if (isEngineAvailable("ornith")) engines.push("ornith")
  if (isEngineAvailable("local")) engines.push("local")
  return engines
}
