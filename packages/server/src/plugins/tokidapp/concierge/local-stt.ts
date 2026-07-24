/**
 * Local STT Connection — faster-whisper streaming speech-to-text via Python child process.
 *
 * Spawns a Python server (`local_stt_server.py`) that uses faster-whisper
 * with Silero VAD for real-time speech detection and transcription.
 * Communicates via JSON-line IPC over stdin/stdout.
 *
 * Features:
 * - Metal GPU acceleration on Apple Silicon (M3 Ultra)
 * - Auto-restart on crash with exponential backoff
 * - Configurable model (large-v3, medium, small) via env vars
 * - Streaming VAD: detects speech onset/end without waiting for silence
 * - Health check via heartbeat messages
 *
 * @module local-stt
 */

import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { resolve } from "node:path"
import { resolveLocalVoicePython } from "./resolve-local-voice-python"

// ── Environment Configuration ───────────────────────────────────────────

/** faster-whisper model name. Default: base.en (fast local fallback). Override with large-v3 for quality. */
const LOCAL_STT_MODEL = process.env.LOCAL_STT_MODEL?.trim() || "base.en"
/** Device: cpu (default — reliable), cuda, metal. Avoid "auto" (float16 crash on Apple Silicon). */
const LOCAL_STT_DEVICE = process.env.LOCAL_STT_DEVICE?.trim() || "cpu"
/** Language code. Default: en. */
const LOCAL_STT_LANGUAGE = process.env.LOCAL_STT_LANGUAGE?.trim() || "en"
/** Beam search size. Default: 5. */
const LOCAL_STT_BEAM_SIZE = process.env.LOCAL_STT_BEAM_SIZE?.trim() || "5"
/** VAD threshold (0-1). Default: 0.65 (less sensitive than 0.5). */
const LOCAL_STT_VAD_THRESHOLD = process.env.LOCAL_STT_VAD_THRESHOLD?.trim() || "0.65"
/** Min speech duration ms before VAD accepts a segment. */
const LOCAL_STT_MIN_SPEECH_MS = process.env.LOCAL_STT_MIN_SPEECH_MS?.trim() || "450"
/** Silence ms before VAD ends an utterance. */
const LOCAL_STT_MIN_SILENCE_MS = process.env.LOCAL_STT_MIN_SILENCE_MS?.trim() || "800"
const LOCAL_STT_SPEECH_PAD_MS = process.env.LOCAL_STT_SPEECH_PAD_MS?.trim() || "200"

/** Python with faster-whisper — see resolve-local-voice-python.ts */
const PYTHON_EXECUTABLE = resolveLocalVoicePython(["faster_whisper", "numpy"])

/** Max restart attempts before giving up. */
const MAX_RESTART_ATTEMPTS = 5
/** Base backoff delay in ms (doubles each attempt). */
const BASE_BACKOFF_MS = 1000
/** Health check timeout — if no heartbeat in 30s, consider process dead. */
const HEALTH_CHECK_TIMEOUT_MS = 30000

// ── Types ───────────────────────────────────────────────────────────────

export interface LocalSTTConnectionOptions {
  /** Model name override (default from LOCAL_STT_MODEL env). */
  model?: string
  /** Device override (default from LOCAL_STT_DEVICE env). */
  device?: string
  /** Language override (default from LOCAL_STT_LANGUAGE env). */
  language?: string
  /** Beam size override (default from LOCAL_STT_BEAM_SIZE env). */
  beamSize?: number
  /** VAD threshold override (default from LOCAL_STT_VAD_THRESHOLD env). */
  vadThreshold?: number
  /** Custom environment variables to pass to the Python process. */
  env?: Record<string, string>
}

export interface LocalSTTConnection {
  /** Send a PCM audio chunk (base64-encoded) to the Python server. */
  sendAudio(chunk: string): void
  /** Send a flush command — forces transcription of any buffered audio. */
  flush(): void
  /** Send a reset command — clears all buffered audio. */
  reset(): void
  /** Gracefully shut down the Python process. */
  close(): void
  /** Whether the Python process is ready to accept audio. */
  readonly isReady: boolean
  /** Whether the connection is closed. */
  readonly isClosed: boolean
}

export interface LocalSTTCallbacks {
  /** Called with each partial or final transcript. */
  onTranscript?: (text: string, isFinal: boolean) => void
  /** Called when VAD detects end of speech. */
  onUtteranceEnd?: () => void
  /** Called on process error or crash. */
  onError?: (error: Error) => void
  /** Called when the Python process exits. */
  onClose?: (code: number | null) => void
  /** Called when the Python process is ready to accept audio. */
  onReady?: () => void
}

// ── Process Management ──────────────────────────────────────────────────

/**
 * Find the path to the Python server script.
 * Resolves relative to this file's directory.
 */
function findServerScript(): string {
  // __dirname in Bun/Node.js resolves to the directory of this file
  return resolve(__dirname, "local_stt_server.py")
}

/**
 * Build environment variables for the Python process.
 */
function buildProcessEnv(
  options?: LocalSTTConnectionOptions,
): Record<string, string> {
  const language =
    options?.language === undefined || options.language === null
      ? LOCAL_STT_LANGUAGE
      : options.language === "" || options.language === "auto"
        ? "auto"
        : options.language

  return {
    ...process.env,
    LOCAL_STT_MODEL: options?.model || LOCAL_STT_MODEL,
    LOCAL_STT_DEVICE: options?.device || LOCAL_STT_DEVICE,
    LOCAL_STT_LANGUAGE: language,
    LOCAL_STT_BEAM_SIZE: String(options?.beamSize ?? LOCAL_STT_BEAM_SIZE),
    LOCAL_STT_VAD_THRESHOLD: String(options?.vadThreshold ?? LOCAL_STT_VAD_THRESHOLD),
    LOCAL_STT_MIN_SPEECH_MS,
    LOCAL_STT_MIN_SILENCE_MS,
    LOCAL_STT_SPEECH_PAD_MS,
    PYTHONUNBUFFERED: "1",
    ...options?.env,
  }
}

// ── Factory Function ────────────────────────────────────────────────────

/**
 * Create a local STT connection that spawns a Python faster-whisper process.
 *
 * The Python process communicates via JSON-line IPC over stdin/stdout.
 * Audio chunks are sent as base64-encoded PCM 16-bit 24kHz mono.
 *
 * @param options - Configuration overrides and event callbacks
 * @returns A LocalSTTConnection handle for sending audio and managing the process
 */
export function createLocalSTTConnection(
  options?: LocalSTTConnectionOptions & LocalSTTCallbacks,
): LocalSTTConnection {
  const {
    onTranscript,
    onUtteranceEnd,
    onError,
    onClose,
    onReady,
    ...configOptions
  } = options || {}

  const serverScript = findServerScript()
  const env = buildProcessEnv(configOptions)
  const label = `[local-stt ${configOptions.model || LOCAL_STT_MODEL}]`

  let closed = false
  let ready = false
  let restartAttempts = 0
  let healthCheckTimer: ReturnType<typeof setInterval> | null = null
  let lastHeartbeatMs = Date.now()
  let process: ChildProcess | null = null

  // EventEmitter for internal event coordination
  const emitter = new EventEmitter()

  function log(msg: string): void {
    console.log(`${label} ${msg}`)
  }

  function spawnProcess(): ChildProcess {
    const args = [serverScript]
    log(`Spawning: ${PYTHON_EXECUTABLE} ${args.join(" ")}`)

    const child = spawn(PYTHON_EXECUTABLE, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: resolve(__dirname),
    })

    process = child

    // Handle stdout (JSON-line IPC)
    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean)
      for (const line of lines) {
        handleStdoutLine(line)
      }
    })

    // Handle stderr (logs from Python)
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim()
      if (text) {
        // Forward Python logs to console
        for (const line of text.split("\n")) {
          console.log(`${label} [python] ${line}`)
        }
      }
    })

    // Handle process exit
    child.on("exit", (code, signal) => {
      log(`Process exited (code=${code}, signal=${signal})`)
      ready = false
      stopHealthCheck()

      if (!closed) {
        const detail =
          signal != null
            ? `Python process killed (${signal})`
            : `Python process exited with code ${code}`
        onError?.(new Error(detail))
        onClose?.(code)

        // Auto-restart with backoff
        if (restartAttempts < MAX_RESTART_ATTEMPTS) {
          const delay = BASE_BACKOFF_MS * Math.pow(2, restartAttempts)
          restartAttempts++
          log(`Restarting in ${delay}ms (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`)
          setTimeout(() => {
            if (!closed) {
              spawnProcess()
            }
          }, delay)
        } else {
          log(`Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached, giving up`)
          onError?.(new Error(`Failed to start Python process after ${MAX_RESTART_ATTEMPTS} attempts`))
        }
      }
    })

    // Handle spawn errors
    child.on("error", (err) => {
      log(`Spawn error: ${err.message}`)
      onError?.(err)
    })

    startHealthCheck()
    return child
  }

  function handleStdoutLine(line: string): void {
    try {
      const msg = JSON.parse(line)

      switch (msg.type) {
        case "ready":
          ready = true
          restartAttempts = 0 // Reset backoff on successful start
          lastHeartbeatMs = Date.now()
          log("Python server ready")
          onReady?.()
          break

        case "transcript":
          onTranscript?.(msg.text, msg.is_final === true)
          break

        case "utterance_end":
          onUtteranceEnd?.()
          break

        case "heartbeat":
          lastHeartbeatMs = Date.now()
          break

        case "error":
          log(`Python error: ${msg.message}`)
          onError?.(new Error(msg.message))
          break

        case "status":
          log(`Status: ${msg.message}`)
          break

        case "pong":
          // Heartbeat response
          lastHeartbeatMs = Date.now()
          break
      }
    } catch (err) {
      // Not JSON — log and continue
      if (line.trim()) {
        console.log(`${label} [python raw] ${line}`)
      }
    }
  }

  function startHealthCheck(): void {
    stopHealthCheck()
    healthCheckTimer = setInterval(() => {
      if (!ready || closed) return

      const elapsed = Date.now() - lastHeartbeatMs
      if (elapsed <= HEALTH_CHECK_TIMEOUT_MS) return

      // Still alive? Heartbeats only arrive when Python isn't blocked — probe first.
      if (process?.pid) {
        try {
          process.kill(0)
          // Process exists — send ping and refresh timer instead of SIGKILL.
          if (process.stdin?.writable) {
            process.stdin.write(JSON.stringify({ type: "ping" }) + "\n")
          }
          lastHeartbeatMs = Date.now()
          log(`No heartbeat for ${elapsed}ms but process alive (pid=${process.pid}) — pinged`)
          return
        } catch {
          // fall through to kill/restart
        }
      }

      log(`No heartbeat for ${elapsed}ms, process may be dead`)
      onError?.(new Error(`Python process unresponsive (${elapsed}ms since last heartbeat)`))

      if (process) {
        try {
          process.kill("SIGKILL")
        } catch {
          // Process may already be dead
        }
      }
    }, HEALTH_CHECK_TIMEOUT_MS / 2)
  }

  function stopHealthCheck(): void {
    if (healthCheckTimer !== null) {
      clearInterval(healthCheckTimer)
      healthCheckTimer = null
    }
  }

  // Spawn the Python process on creation
  spawnProcess()

  // Return the connection handle
  const connection: LocalSTTConnection = {
    sendAudio(chunk: string): void {
      if (closed || !process?.stdin?.writable) {
        return
      }
      const msg = JSON.stringify({ type: "audio", data: chunk })
      process.stdin.write(msg + "\n")
    },

    flush(): void {
      if (closed || !process?.stdin?.writable) {
        return
      }
      process.stdin.write(JSON.stringify({ type: "flush" }) + "\n")
    },

    reset(): void {
      if (closed || !process?.stdin?.writable) {
        return
      }
      process.stdin.write(JSON.stringify({ type: "reset" }) + "\n")
    },

    close(): void {
      if (closed) return
      closed = true
      stopHealthCheck()
      log("Closing connection")

      if (process) {
        try {
          process.stdin?.end()
          process.kill("SIGTERM")
          // Give Python a chance to clean up, then force kill
          setTimeout(() => {
            try {
              process?.kill("SIGKILL")
            } catch {
              // Already dead
            }
          }, 2000)
        } catch (err) {
          log(`Error during close: ${(err as Error).message}`)
        }
      }
    },

    get isReady(): boolean {
      return ready
    },

    get isClosed(): boolean {
      return closed
    },
  }

  return connection
}
