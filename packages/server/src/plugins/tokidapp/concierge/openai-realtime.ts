import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { sanitizeSpeechText, VOICE_INSTRUCTIONS } from "./speech-sanitize"

declare const WebSocket: {
  new(url: string, protocols?: string | string[]): WebSocket
  readonly CLOSED: number
  readonly CLOSING: number
  readonly CONNECTING: number
  readonly OPEN: number
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""
/** Default: gpt-realtime-mini (GA). Override with OPENAI_REALTIME_MODEL. */
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-mini"
const WORKSPACE_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()

interface RealtimeSession {
  ws: WebSocket
  sessionId: string
  connected: boolean
  toolCallbacks: Map<string, (args: string) => Promise<string>>
  audioBytes: number
  pendingChunks: string[]
  onReady?: () => void
}

const sessions = new Map<string, RealtimeSession>()

// ── Tool Definitions (registered with OpenAI Realtime) ──────

const tools = [
  {
    type: "function",
    name: "investigate_codebase",
    description: "Search the codebase for files matching keywords. Returns file paths with previews.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for in the codebase" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "run_tests",
    description: "Run the test suite and return pass/fail results with duration.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "git_status",
    description: "Check current git branch, uncommitted changes, and recent commits.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "generate_feature",
    description: "Create new pages, components, or API routes. Specify the type and name.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description of what to generate" },
      },
      required: ["prompt"],
    },
  },
]

// ── Tool Implementations ─────────────────────────────────────

async function executeTool(name: string, argsStr: string): Promise<string> {
  try {
    switch (name) {
      case "investigate_codebase": {
        const { query } = JSON.parse(argsStr)
        const keywords = query.replace(/investigate|find|search/gi, "").trim().split(/\s+/).filter(Boolean)
        if (keywords.length === 0) return "Please provide search keywords."

        try {
          const pattern = keywords.join("|")
          const results = execSync(
            `rg -l -i "${pattern}" --type ts --type tsx --type css --glob '!node_modules' --glob '!.next' --glob '!public/codenomad' 2>/dev/null | head -15`,
            { cwd: WORKSPACE_ROOT, encoding: "utf-8", maxBuffer: 1024 * 1024 },
          )
          const files = results.trim().split("\n").filter(Boolean)
          if (files.length === 0) return `No files found for: ${keywords.join(", ")}`
          return `Found ${files.length} file(s):\n${files.map((f) => `- ${f}`).join("\n")}`
        } catch { return "Search failed." }
      }

      case "run_tests": {
        try {
          const output = execSync("bun run test 2>&1", { cwd: WORKSPACE_ROOT, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 120000 })
          const passMatch = output.match(/(\d+)\s+passed/i)
          const failMatch = output.match(/(\d+)\s+failed/i)
          return `Tests: ${passMatch?.[1] || "?"} passed, ${failMatch?.[1] || "0"} failed`
        } catch (e: any) { return `Test error: ${e.message || "unknown"}` }
      }

      case "git_status": {
        try {
          const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: WORKSPACE_ROOT, encoding: "utf-8" }).trim()
          const status = execSync("git status --short", { cwd: WORKSPACE_ROOT, encoding: "utf-8" }).trim()
          const changes = status ? status.split("\n").length : 0
          return `Branch: ${branch}\nUncommitted: ${changes} file(s)`
        } catch (e: any) { return `Git error: ${e.message}` }
      }

      case "generate_feature": {
        const { prompt } = JSON.parse(argsStr)
        const filesCreated: string[] = []
        const match = prompt.match(/(\w+)\s*(page|component|route)/i)
        if (!match) return "Specify what to create: page, component, or API route."

        const name = match[1].toLowerCase()
        const type = match[2].toLowerCase()

        if (type === "page") {
          const dir = path.join(WORKSPACE_ROOT, "src", "app", name)
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(
            path.join(dir, "page.tsx"),
            `'use client'\n\nexport default function ${name.charAt(0).toUpperCase() + name.slice(1)}Page() {\n  return <div className="p-8"><h1 className="text-2xl font-bold text-white">${name}</h1></div>\n}\n`,
          )
          filesCreated.push(`src/app/${name}/page.tsx`)
        }

        if (type === "component") {
          const compPascal = name.charAt(0).toUpperCase() + name.slice(1)
          const compDir = path.join(WORKSPACE_ROOT, "src", "components")
          fs.mkdirSync(compDir, { recursive: true })
          fs.writeFileSync(
            path.join(compDir, `${compPascal}.tsx`),
            `'use client'\n\nexport function ${compPascal}({ className = "" }: { className?: string }) {\n  return <div className={className}>${compPascal}</div>\n}\n`,
          )
          filesCreated.push(`src/components/${compPascal}.tsx`)
        }

        return filesCreated.length > 0
          ? `Created:\n${filesCreated.map((f) => `- ${f}`).join("\n")}`
          : "Could not determine what to create."
      }

      default:
        return `Unknown tool: ${name}`
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}

// ── Realtime Session Manager ─────────────────────────────────

const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`

const MIN_AUDIO_BYTES = 4800 // 100ms @ 24kHz pcm16 mono

function flushPendingForSession(session: RealtimeSession) {
  if (!session.connected || session.pendingChunks.length === 0) return
  for (const chunk of session.pendingChunks) {
    session.ws.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: chunk }),
    )
    session.audioBytes += Math.floor(chunk.length * 0.75)
  }
  session.pendingChunks = []
}

export function createRealtimeSession(
  sessionId: string,
  onAudioDelta: (base64: string) => void,
  onTextDelta: (text: string) => void,
  onError: (error: string) => void,
  onReady?: () => void,
  onUserTranscript?: (text: string) => void,
  onResponseDone?: () => void,
): RealtimeSession {
  const ws = new WebSocket(REALTIME_URL, [
    "realtime",
    `openai-insecure-api-key.${OPENAI_API_KEY}`,
  ])

  const session: RealtimeSession = {
    ws,
    sessionId,
    connected: false,
    toolCallbacks: new Map(),
    audioBytes: 0,
    pendingChunks: [],
    onReady,
  }

  ws.addEventListener("open", () => {
    session.connected = true
    flushPendingForSession(session)

    const config = {
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["text", "audio"],
        instructions: VOICE_INSTRUCTIONS,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "gpt-4o-mini-transcribe" },
            // Push-to-talk: client commits on voice_stop (server VAD commits empty buffers).
            turn_detection: null,
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: "alloy",
          },
        },
        tools,
        tool_choice: "auto",
      },
    }
    ws.send(JSON.stringify(config))
  })

  ws.addEventListener("message", async (event: MessageEvent) => {
    try {
      const raw = typeof event.data === "string" ? event.data : await event.data.text()
      const parsed = JSON.parse(raw)

      switch (parsed.type) {
        case "session.created":
        case "session.updated":
          session.onReady?.()
          session.onReady = undefined
          break

        case "response.output_audio.delta":
        case "response.audio.delta":
          if (parsed.delta) onAudioDelta(parsed.delta)
          break

        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta":
          if (parsed.delta) onTextDelta(sanitizeSpeechText(parsed.delta))
          break

        case "response.output_text.delta":
        case "response.text.delta":
          if (parsed.delta) onTextDelta(sanitizeSpeechText(parsed.delta))
          break

        case "conversation.item.input_audio_transcription.completed":
        case "input_audio_transcription.completed": {
          const transcript =
            parsed.transcript ||
            parsed.item?.input_audio_transcription?.transcript ||
            ""
          if (transcript && onUserTranscript) {
            onUserTranscript(sanitizeSpeechText(transcript))
          }
          break
        }

        case "response.done":
        case "response.completed":
          onResponseDone?.()
          break

        case "conversation.item.created":
          break

        case "response.function_call_arguments.done": {
          const toolName = parsed.name
          const args = parsed.arguments || "{}"

          ws.send(JSON.stringify({ type: "response.cancel" }))

          const result = await executeTool(toolName, args)

          ws.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: parsed.call_id,
                output: result,
              },
            }),
          )

          ws.send(JSON.stringify({ type: "response.create" }))
          break
        }

        case "error": {
          const message = parsed.error?.message || "OpenAI Realtime error"
          if (/buffer too small|buffer only has 0/i.test(message)) break
          onError(message)
          break
        }

        case "rate_limits.updated":
          break
      }
    } catch {
      // Ignore parse errors
    }
  })

  ws.addEventListener("error", () => {
    onError("OpenAI Realtime connection error")
    session.connected = false
  })

  ws.addEventListener("close", () => {
    session.connected = false
    sessions.delete(sessionId)
  })

  sessions.set(sessionId, session)
  return session
}

// ── Audio Relay ──────────────────────────────────────────────

export function sendAudioChunk(sessionId: string, base64: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false

  if (!session.connected) {
    session.pendingChunks.push(base64)
    return true
  }

  session.audioBytes += Math.floor(base64.length * 0.75)
  session.ws.send(
    JSON.stringify({
      type: "input_audio_buffer.append",
      audio: base64,
    }),
  )
  return true
}

export function resetInputAudio(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.audioBytes = 0
  session.pendingChunks = []
  if (session.connected) {
    session.ws.send(JSON.stringify({ type: "input_audio_buffer.clear" }))
  }
}

export function hasEnoughInputAudio(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  const pendingBytes = session.pendingChunks.reduce(
    (sum, c) => sum + Math.floor(c.length * 0.75),
    0,
  )
  return session.audioBytes + pendingBytes >= MIN_AUDIO_BYTES
}

export function commitAudioBuffer(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session?.connected) return false

  if (session.pendingChunks.length > 0) flushPendingForSession(session)

  if (session.audioBytes < MIN_AUDIO_BYTES) {
    session.ws.send(JSON.stringify({ type: "input_audio_buffer.clear" }))
    session.audioBytes = 0
    return false
  }

  session.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }))
  session.ws.send(JSON.stringify({ type: "response.create" }))
  session.audioBytes = 0
  return true
}


export function clearAudioBuffer(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session?.connected) return false

  session.ws.send(JSON.stringify({ type: "input_audio_buffer.clear" }))
  return true
}

export function startVoiceSession(sessionId: string): boolean {
  if (sessions.has(sessionId)) return true // already connected
  return false // caller should create a new session
}

export function endVoiceSession(sessionId: string) {
  const session = sessions.get(sessionId)
  if (session) {
    session.ws.close()
    sessions.delete(sessionId)
  }
}

export function getRealtimeSession(sessionId: string): RealtimeSession | undefined {
  return sessions.get(sessionId)
}
