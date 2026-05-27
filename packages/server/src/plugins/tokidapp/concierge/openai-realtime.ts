import { normalizeRealtimeVoice, type RealtimeVoiceId } from "./realtime-voices"
import { sanitizeSpeechText, VOICE_INSTRUCTIONS } from "./speech-sanitize"
import {
  investigateCodebase,
  generateFeature,
  runTests,
  gitStatus,
  gitCommitPush,
  triggerVercelDeploy,
  checkDeployStatus,
  spawnAgent,
  scheduleTask,
  listTasks,
  assignTask,
  rollbackDeploy,
  captureGitDiff,
} from "./codebase-tools"
import { buildLifecycleDAG, executeDAG } from "../orchestrator/dag-engine"
import { apiPost } from "../orchestrator/starguard-client"
import type { DAGNode, DAGDefinition } from "../orchestrator/types"

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
const STARGUARD_BASE = process.env.STARGUARD_BASE_URL || "https://starguard.vercel.app"
const VERCEL_DEPLOY_HOOK_URL = process.env.VERCEL_DEPLOY_HOOK_URL
const VERCEL_TOKEN = process.env.VERCEL_TOKEN
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID

interface RealtimeSession {
  ws: WebSocket
  sessionId: string
  connected: boolean
  outputVoice: RealtimeVoiceId
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
  {
    type: "function",
    name: "git_commit_push",
    description: "Commit all staged changes and push to the current branch on the remote.",
    parameters: {
      type: "object",
      properties: {
        commitMsg: { type: "string", description: "Commit message describing the changes" },
      },
      required: ["commitMsg"],
    },
  },
  {
    type: "function",
    name: "trigger_deploy",
    description: "Trigger a Vercel deployment via the configured deploy hook URL.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "check_deploy_status",
    description: "Check the latest Vercel deployment status.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "spawn_agent",
    description: "Spawn an OpenCode/OpenCoder/OpenAgent workspace for autonomous task execution.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description of the agent's task" },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "schedule_task",
    description: "Create and schedule a task in the TokiDAPP task system.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description of the task to schedule" },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "list_tasks",
    description: "List all tasks, optionally filtered by status or keyword.",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional filter keyword (pending, assigned, in progress, complete)" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "assign_task",
    description: "Assign an existing task to a specific user by email or user ID.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Task ID and assignee, e.g. 'assign task abc123 to user@example.com'" },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "rollback_deploy",
    description: "Rollback to the previous git commit and trigger a redeploy.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "capture_git_diff",
    description: "Capture the staged git diff summary without making changes.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "orchestrate",
    description: "Orchestrate a multi-step workflow via the DAG engine — can investigate, plan, generate, test, deploy, and more in parallel. Describes WHAT you want to accomplish.",
    parameters: {
      type: "object",
      properties: {
        intent: { type: "string", description: "What you want to accomplish, e.g. 'Investigate the auth flow and fix any issues'" },
        intentType: { type: "string", description: "Lifecycle template hint: QUERY_INFO, FULL_DEPLOY, FEATURE_GENERATION, INVESTIGATE_ISSUE", enum: ["QUERY_INFO", "FULL_DEPLOY", "FEATURE_GENERATION", "INVESTIGATE_ISSUE", "DEPLOY_ONLY"] },
      },
      required: ["intent"],
    },
  },
]

// ── Tool Implementations ─────────────────────────────────────

async function executeTool(
  name: string,
  argsStr: string,
  config: {
    workspaceRoot: string
    starguardBase: string
    deployHookUrl?: string
    vercelToken?: string
    vercelProjectId?: string
    vercelTeamId?: string
  },
): Promise<string> {
  try {
    switch (name) {
      case "investigate_codebase": {
        const { query } = JSON.parse(argsStr)
        return await investigateCodebase(query, config.workspaceRoot)
      }

      case "run_tests": {
        return await runTests(config.workspaceRoot)
      }

      case "git_status": {
        return await gitStatus(config.workspaceRoot)
      }

      case "generate_feature": {
        const { prompt } = JSON.parse(argsStr)
        return await generateFeature(prompt, config.workspaceRoot)
      }

      case "git_commit_push": {
        const { commitMsg } = JSON.parse(argsStr)
        return await gitCommitPush(commitMsg, config.workspaceRoot, config.starguardBase)
      }

      case "trigger_deploy": {
        return await triggerVercelDeploy(config.deployHookUrl)
      }

      case "check_deploy_status": {
        return await checkDeployStatus({
          vercelToken: config.vercelToken,
          vercelProjectId: config.vercelProjectId,
          vercelTeamId: config.vercelTeamId,
        })
      }

      case "spawn_agent": {
        const { prompt } = JSON.parse(argsStr)
        return await spawnAgent(prompt, config.starguardBase, config.workspaceRoot)
      }

      case "schedule_task": {
        const { prompt } = JSON.parse(argsStr)
        return await scheduleTask(prompt, config.starguardBase)
      }

      case "list_tasks": {
        const { filter } = JSON.parse(argsStr)
        return await listTasks(filter || "", config.starguardBase)
      }

      case "assign_task": {
        const { prompt } = JSON.parse(argsStr)
        return await assignTask(prompt, config.starguardBase)
      }

      case "rollback_deploy": {
        return await rollbackDeploy()
      }

      case "capture_git_diff": {
        return await captureGitDiff(config.workspaceRoot)
      }

      case "orchestrate": {
        const { intent, intentType = "QUERY_INFO" } = JSON.parse(argsStr)

        // Create orchestrator session via StarGuard
        const sessionId = "voice_" + Date.now()
        const orchRes = await apiPost("/api/tokidapp/orchestrator", { sessionId, voiceMode: true })
        if (!orchRes.ok) {
          return "Failed to create orchestrator session."
        }
        const orchestrator = await orchRes.json()
        const orchestratorId = orchestrator.id

        // Build DAG from intent
        const { nodes, phases } = buildLifecycleDAG(
          intentType,
          intent,
          {},
        )

        const dag: DAGDefinition = {
          id: `dag_${Date.now()}`,
          nodes,
          createdAt: new Date().toISOString(),
        }

        // Execute DAG with default callbacks (no WS socket in voice context — results returned inline)
        const result = await executeDAG(orchestratorId, dag, {
          onNodeStart: () => {},
          onNodeComplete: () => {},
          onNodeFail: () => {},
          onApprovalRequired: async () => "approved",
          onBroadcast: () => {},
          onLog: () => {},
        })

        if (result.success) {
          return `Orchestration complete! ${result.completedNodes} tasks completed in ${(result.durationMs / 1000).toFixed(1)}s. Summary: ${result.completedNodes} steps succeeded.`
        } else {
          return `Orchestration finished with issues: ${result.failedNodes} failed, ${result.skippedNodes} skipped. ${result.error || ""}`
        }
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
  outputVoice: RealtimeVoiceId = normalizeRealtimeVoice(undefined),
): RealtimeSession {
  const ws = new WebSocket(REALTIME_URL, [
    "realtime",
    `openai-insecure-api-key.${OPENAI_API_KEY}`,
  ])

  const voice = normalizeRealtimeVoice(outputVoice)

  const session: RealtimeSession = {
    ws,
    sessionId,
    connected: false,
    outputVoice: voice,
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
            voice,
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

          const result = await executeTool(toolName, args, {
            workspaceRoot: WORKSPACE_ROOT,
            starguardBase: STARGUARD_BASE,
            deployHookUrl: VERCEL_DEPLOY_HOOK_URL,
            vercelToken: VERCEL_TOKEN,
            vercelProjectId: VERCEL_PROJECT_ID,
            vercelTeamId: VERCEL_TEAM_ID,
          })

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

export function getRealtimeSessionVoice(sessionId: string): RealtimeVoiceId | undefined {
  return sessions.get(sessionId)?.outputVoice
}
