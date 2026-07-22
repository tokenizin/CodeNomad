/**
 * Local Piper TTS streaming module.
 *
 * Spawns a Python child process (`local_tts_server.py`) that runs Piper TTS
 * on CPU.  Communicates via JSON-line IPC over stdin/stdout.  Text is split
 * into sentences for low-latency streaming playback — the user hears the first
 * sentence while later sentences are still synthesizing.
 *
 * @module local-tts
 */

import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { resolve } from "node:path"
import { resolveLocalVoicePython } from "./resolve-local-voice-python"

// ── Environment Configuration ───────────────────────────────────────────

/** Piper voice model (default: en_US-amy-medium). */
const LOCAL_TTS_VOICE = process.env.LOCAL_TTS_VOICE?.trim() || "en_US-amy-medium"

/** Speech rate multiplier (0.5–2.0, default 1.0). */
const LOCAL_TTS_SPEED = parseFloat(process.env.LOCAL_TTS_SPEED || "1.0") || 1.0

/** Enable sentence-based streaming (default: true). */
const LOCAL_TTS_SENTENCE_SPLITS =
  process.env.LOCAL_TTS_SENTENCE_SPLITS?.trim().toLowerCase() !== "false"

/** Python with piper — Homebrew python often lacks user packages. */
const PYTHON_EXECUTABLE = resolveLocalVoicePython(["piper"])

/** Maximum restart attempts before giving up. */
const MAX_RESTART_ATTEMPTS = 5

/** Base delay (ms) for exponential backoff on restart. */
const RESTART_BACKOFF_BASE_MS = 500

// ── Types ───────────────────────────────────────────────────────────────

/** Callbacks for LocalTTSConnection events. */
export interface LocalTTSCallbacks {
  /** Called with each base64-encoded raw PCM audio chunk (24 kHz mono). */
  onAudio?: (base64Chunk: string) => void
  /** Called when all audio for the current utterance has been sent. */
  onFlushed?: () => void
  /** Called on process error or synthesis failure. */
  onError?: (error: Error) => void
  /** Called when the Python process exits. */
  onClose?: (code: number) => void
}

/** Handle returned by createLocalTTSConnection. */
export interface LocalTTSConnection {
  /** Send text for TTS synthesis. Sentences are streamed individually. */
  speak(text: string): void
  /** Flush any buffered audio (signals end of utterance). */
  flush(): void
  /** Gracefully shut down the Python process. */
  close(): void
  /** Whether the underlying process is alive and ready. */
  readonly ready: boolean
}

/** JSON message types sent by the Python server. */
interface ServerMessage {
  type?: "ready" | "flushed" | "error"
  audio?: string
  message?: string
}

// ── Sentence Splitting ──────────────────────────────────────────────────

/**
 * Split text into sentences at `.`, `!`, `?`, `;` boundaries.
 * Preserves the delimiter at the end of each sentence.
 * Returns non-empty trimmed sentences.
 */
export function splitSentences(text: string): string[] {
  if (!LOCAL_TTS_SENTENCE_SPLITS) return [text]

  const raw = text
    .split(/(?<=[.!?;])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

  return raw.length > 0 ? raw : [text]
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Resolve the absolute path to `local_tts_server.py`.
 * Looks in the same directory as this module.
 */
function resolvePythonScript(): string {
  return resolve(import.meta.dirname, "local_tts_server.py")
}

/**
 * Create a connection to the local Piper TTS server.
 *
 * Spawns a Python child process and manages its lifecycle.  Call `speak(text)`
 * to synthesize, receive audio via `onAudio(base64Chunk)`, and call `close()`
 * when done.
 *
 * @param voice - Piper voice name (default from LOCAL_TTS_VOICE env)
 * @param callbacks - Event callbacks
 * @returns A LocalTTSConnection handle
 */
export function createLocalTTSConnection(
  voice?: string,
  callbacks?: LocalTTSCallbacks,
): LocalTTSConnection {
  const resolvedVoice = voice || LOCAL_TTS_VOICE
  const { onAudio, onFlushed, onError, onClose } = callbacks || {}
  const scriptPath = resolvePythonScript()

  let proc: ChildProcess | null = null
  let closed = false
  let ready = false
  let restartAttempts = 0
  let lineBuffer = ""

  // ── Process Management ──────────────────────────────────────────────

  function spawnProcess() {
    if (closed) return

    proc = spawn(PYTHON_EXECUTABLE, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LOCAL_TTS_VOICE: resolvedVoice,
        LOCAL_TTS_SPEED: String(LOCAL_TTS_SPEED),
        // Prefer repo voices, then user cache
        PIPER_VOICE_DIR:
          process.env.PIPER_VOICE_DIR?.trim() ||
          resolve(process.cwd(), "models/piper-voices"),
      },
    })

    proc.stdout?.setEncoding("utf-8")
    proc.stderr?.setEncoding("utf-8")

    proc.stdout?.on("data", handleStdoutData)
    proc.stderr?.on("data", (chunk) => {
      console.error("[local-tts] python stderr:", chunk.trimEnd())
    })

    proc.on("error", (err) => {
      console.error("[local-tts] process error:", err.message)
      onError?.(new Error(`Python process error: ${err.message}`))
      scheduleRestart()
    })

    proc.on("close", (code) => {
      ready = false
      console.log("[local-tts] process exited with code:", code)
      onClose?.(code ?? 1)
      if (!closed) scheduleRestart()
    })

    console.log("[local-tts] spawned python3 pid:", proc.pid)
  }

  function scheduleRestart() {
    if (closed) return
    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      const msg = `Python process crashed ${MAX_RESTART_ATTEMPTS} times — giving up`
      console.error("[local-tts]", msg)
      onError?.(new Error(msg))
      return
    }

    const delay = RESTART_BACKOFF_BASE_MS * Math.pow(2, restartAttempts)
    restartAttempts++
    console.log(`[local-tts] restarting in ${delay}ms (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`)

    setTimeout(() => {
      if (!closed) spawnProcess()
    }, delay)
  }

  function resetBackoff() {
    restartAttempts = 0
  }

  // ── Stdout Handling ─────────────────────────────────────────────────

  function handleStdoutData(chunk: string) {
    lineBuffer += chunk

    // Process complete lines (delimited by newline)
    let newlineIdx: number
    while ((newlineIdx = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, newlineIdx).trim()
      lineBuffer = lineBuffer.slice(newlineIdx + 1)

      if (!line) continue
      handleLine(line)
    }
  }

  function handleLine(line: string) {
    let msg: ServerMessage
    try {
      msg = JSON.parse(line)
    } catch {
      console.warn("[local-tts] unparseable stdout line:", line.slice(0, 200))
      return
    }

    if (msg.type === "ready") {
      ready = true
      resetBackoff()
      console.log("[local-tts] server ready, voice:", resolvedVoice)
      return
    }

    if (msg.type === "flushed") {
      onFlushed?.()
      return
    }

    if (msg.type === "error") {
      console.error("[local-tts] server error:", msg.message)
      onError?.(new Error(msg.message || "Unknown server error"))
      return
    }

    if (msg.audio) {
      onAudio?.(msg.audio)
      return
    }

    console.warn("[local-tts] unknown server message:", JSON.stringify(msg).slice(0, 200))
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  function sendRequest(text: string, voiceOverride?: string, speedOverride?: number) {
    if (!proc?.stdin?.writable) {
      onError?.(new Error("Python process not running — cannot send text"))
      return
    }

    const request = {
      text,
      voice: voiceOverride || resolvedVoice,
      speed: speedOverride ?? LOCAL_TTS_SPEED,
    }

    proc.stdin.write(JSON.stringify(request) + "\n")
  }

  // Spawn immediately
  spawnProcess()

  // ── Public Interface ────────────────────────────────────────────────

  return {
    get ready() {
      return ready
    },

    speak(text: string): void {
      if (closed) {
        onError?.(new Error("Cannot speak — connection is closed"))
        return
      }
      if (!text.trim()) return

      const sentences = splitSentences(text)
      for (const sentence of sentences) {
        sendRequest(sentence)
      }
    },

    flush(): void {
      if (closed || !proc?.stdin?.writable) return
      // Send an empty text to trigger a flush from the server side
      // The server naturally flushes after each utterance, but this
      // provides an explicit flush signal for edge cases.
      proc.stdin.write(JSON.stringify({ text: "", voice: resolvedVoice }) + "\n")
    },

    close(): void {
      if (closed) return
      closed = true
      ready = false

      if (proc) {
        try {
          proc.stdin?.end()
        } catch {
          // stdin may already be closed
        }
        try {
          proc.kill("SIGTERM")
        } catch {
          // process may already be dead
        }
        // Force kill after 3s if SIGTERM doesn't work
        setTimeout(() => {
          if (proc && !proc.killed) {
            try {
              proc.kill("SIGKILL")
            } catch {
              // already dead
            }
          }
        }, 3000)
      }

      proc = null
      console.log("[local-tts] connection closed")
    },
  }
}
