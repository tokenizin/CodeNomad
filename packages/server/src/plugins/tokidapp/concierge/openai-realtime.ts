import WebSocket from "ws"
import { normalizeRealtimeVoice, type RealtimeVoiceId } from "./realtime-voices"
import { sanitizeAsrText, sanitizeSpeechText, VOICE_INSTRUCTIONS } from "./speech-sanitize"
import { getTargetAppWorkspaceRoot } from "../workspace-config"
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
  runA11yAudit,
  checkA11yScan,
  checkColorContrast,
  readFileContent,
  runLint,
  runTypeCheck,
  gitBranchAction,
  queryKnowledgeBase,
  getArchitectureDigest,
  getSepoliaDeployments,
} from "./codebase-tools"
import { bridge } from "../../../server/routes/nomadworks-bridge"
import { buildLifecycleDAG, executeDAG } from "../orchestrator/dag-engine"
import { apiPost } from "../orchestrator/starguard-client"
import type { DAGNode, DAGDefinition, ExecutionCallbacks } from "../orchestrator/types"
import { getTokidappSocket, tokidappSessionId } from "../../../server/ws-socket-registry"

/** Tracks one active session per user — prevents two sessions for the same
 *  user across the voice WS and tokidapp WS (e.g. voice_abc + tokidapp_abc).
 *  When a new session starts for a user, any existing session is ended first. */
const activeUserSessions = new Map<string, string>() // userId → sessionId

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""
/** Default: gpt-realtime-2 (GA). Override with OPENAI_REALTIME_MODEL. */
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2"
/** Reasoning effort: minimal, low, medium, high, xhigh. Default: low. */
const REALTIME_REASONING_EFFORT =
  process.env.OPENAI_REALTIME_REASONING_EFFORT?.trim() || "medium"

/** Only gpt-realtime-2 supports the reasoning parameter. */
const SUPPORTS_REASONING = REALTIME_MODEL === "gpt-realtime-2"

/** ── Voice Activity Detection calibration (env-var configurable) ── */

/** VAD activation threshold (0.0–1.0). Higher = less sensitive. Default: 0.9.
 *  The 0.9 threshold is intentionally high to reject low-level playback echo
 *  and background noise while still catching clear speech near the mic. */
const REALTIME_VAD_THRESHOLD = (() => {
  const raw = process.env.OPENAI_REALTIME_VAD_THRESHOLD?.trim()
  if (!raw) return 0.9
  const val = parseFloat(raw)
  return Number.isFinite(val) && val >= 0 && val <= 1 ? val : 0.9
})()
/** Audio captured before speech onset in ms. Default: 500.
 *  Increased from 300ms to capture first syllables that were being clipped
 *  in natural speech, especially for fast speakers. */
const REALTIME_VAD_PREFIX_PADDING_MS = (() => {
  const raw = process.env.OPENAI_REALTIME_VAD_PREFIX_PADDING_MS?.trim()
  if (!raw) return 500
  const val = parseInt(raw, 10)
  return Number.isFinite(val) && val > 0 ? val : 500
})()
/** Silence duration before end-of-turn in ms. Default: 500. */
const REALTIME_VAD_SILENCE_DURATION_MS = (() => {
  const raw = process.env.OPENAI_REALTIME_VAD_SILENCE_DURATION_MS?.trim()
  if (!raw) return 500
  const val = parseInt(raw, 10)
  return Number.isFinite(val) && val > 0 ? val : 500
})()

const WORKSPACE_ROOT = getTargetAppWorkspaceRoot()
const STARGUARD_BASE = process.env.STARGUARD_BASE_URL || "https://star-worlds.vercel.app"

interface RealtimeSession {
  ws: WebSocket
  sessionId: string
  connected: boolean
  outputVoice: RealtimeVoiceId
  toolCallbacks: Map<string, (args: string) => Promise<string>>
  audioBytes: number
  pendingChunks: string[]
  onReady?: () => void
  /** Track whether a response is currently in progress to avoid race conditions */
  responseInProgress: boolean
  /** Queue of response.create requests to send after current response completes */
  pendingResponseQueue: Array<() => void>
}

const sessions = new Map<string, RealtimeSession>()

// ── Tool Definitions (registered with OpenAI Realtime) ──────

const tools = [
  {
    type: "function",
    name: "wait_for_user",
    description: "Call when audio is silence, background noise, or speech not addressed to you. Ends the turn without a spoken reply.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "investigate_codebase",
    description: "Search the codebase by filename or identifier. Use this when you need specific import paths, class names, function names, or TypeScript types — NOT for conceptual questions (use query_knowledge_base instead). Extract 2-5 precise search terms from the user's question; do NOT pass the full user message.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "2-5 specific keywords or identifiers (e.g. 'RevenuePool DynamicSplitter' — NOT the full user message)" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "query_knowledge_base",
    description: "Query the StarCARD architecture knowledge base for entities (contracts, chains, venues, tokens, actors, diagrams). Use this to look up ecosystem architecture instead of grep-searching code.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search (name, description, or keyword)" },
        domain: { type: "string", description: "Filter by domain: SYSTEM_ARCHITECTURE, MULTI_CHAIN, FINANCIAL_MODEL, GOVERNANCE, SMART_CONTRACT, IMPLEMENTATION_TIMELINE, RWA, SYSTEM_STATE, COMPLIANCE" },
        category: { type: "string", description: "Filter by category: CONTRACT, CHAIN, VENUE, TOKEN, INFRASTRUCTURE, ACTOR, TREASURY, BRIDGE, COMPLIANCE, ORGANIZATION, FLOW, DOCUMENT, METRIC" },
      },
    },
  },
  {
    type: "function",
    name: "get_sepolia_deployments",
    description: "Get all known Sepolia testnet contract addresses for the StarCARD ecosystem (DynamicSplitter, StarBridge, STARX token, etc.).",
    parameters: {
      type: "object",
      properties: {},
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
        prompt: { type: "string", description: "Description of the agent's task and desired output" },
        context: { type: "string", description: "Summarize what you've already discovered or decided so the spawned agent doesn't start from zero. Include key findings, file paths, git state, or decisions." },
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
    name: "run_a11y_audit",
    description: "Run a full accessibility audit on a URL using Lighthouse. Returns score (0-100) and detailed issue list.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to audit (e.g. https://star-worlds.vercel.app or localhost:3000)" },
      },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "check_a11y",
    description: "Run an axe-core accessibility scan on a URL. Returns violations grouped by impact level.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to scan for accessibility violations" },
      },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "check_color_contrast",
    description: "Check color contrast ratios in a CSS or design file. Lists detected colors for manual review.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the CSS or component file to check" },
      },
      required: ["filePath"],
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a file or list a directory. Returns contents (up to 200 lines) for files, or listing for directories.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file or directory to read" },
      },
      required: ["filePath"],
    },
  },
  {
    type: "function",
    name: "run_lint",
    description: "Run the project linter and return error/warning counts with the last 30 lines of output.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "run_typecheck",
    description: "Run TypeScript type checking (tsc --noEmit) and report any type errors found.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "git_branch",
    description: "Manage git branches: list all branches, create a new branch (with name), switch to a branch, or delete a branch.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "switch", "delete"], description: "Branch action to perform" },
        branchName: { type: "string", description: "Branch name (required for create, switch, delete)" },
      },
      required: ["action"],
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
  {
    type: "function",
    name: "nomadworks_invoke",
    description: "Create a NomadWorks task for structured multi-agent orchestration — use when the user's request involves investigation, feature work, or a complex change that should be tracked as a formal task. The task appears in the Evidence Browser and Causal Graph tabs.",
    parameters: {
      type: "object",
      properties: {
        intent: { type: "string", description: "What needs to be accomplished — the full task description" },
        agentType: { type: "string", description: "NomadWorks agent type: developer, business_analyst, tech_lead, technical_architect, or qa_engineer", enum: ["developer", "business_analyst", "tech_lead", "technical_architect", "qa_engineer"] },
        contextDescription: { type: "string", description: "Summary of relevant findings, decisions, or state from the current conversation to pass to the agent" },
        complexity: { type: "string", description: "Task complexity: tiny for small fixes, standard for bounded work, complex for multi-step", enum: ["tiny", "standard", "complex"] },
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
    sessionId?: string  // e.g. "voice_<userId>" — used for progress callbacks
  },
): Promise<string> {
  try {
    switch (name) {
      case "investigate_codebase": {
        const { query } = JSON.parse(argsStr)
        return await investigateCodebase(query, config.workspaceRoot)
      }

      case "query_knowledge_base": {
        const { query = "", domain, category } = JSON.parse(argsStr)
        return await queryKnowledgeBase(query, domain, category)
      }

      case "get_sepolia_deployments": {
        return await getSepoliaDeployments()
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
        return await triggerVercelDeploy(config.workspaceRoot)
      }

      case "check_deploy_status": {
        return await checkDeployStatus(config.workspaceRoot)
      }

      case "spawn_agent": {
        const { prompt, context: parentContext } = JSON.parse(argsStr)
        const enrichedPrompt = parentContext
          ? `Parent context (discoveries so far):\n${parentContext}\n\nTask:\n${prompt}`
          : prompt
        return await spawnAgent(enrichedPrompt, config.starguardBase, config.workspaceRoot)
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

      case "run_a11y_audit": {
        const { url } = JSON.parse(argsStr)
        return await runA11yAudit(url, config.workspaceRoot)
      }

      case "check_a11y": {
        const { url } = JSON.parse(argsStr)
        return await checkA11yScan(url, config.workspaceRoot)
      }

      case "check_color_contrast": {
        const { filePath } = JSON.parse(argsStr)
        return await checkColorContrast(filePath, config.workspaceRoot)
      }

      case "read_file": {
        const { filePath } = JSON.parse(argsStr)
        return await readFileContent(filePath, config.workspaceRoot)
      }

      case "run_lint": {
        return await runLint(config.workspaceRoot)
      }

      case "run_typecheck": {
        return await runTypeCheck(config.workspaceRoot)
      }

      case "git_branch": {
        const { action, branchName } = JSON.parse(argsStr)
        return await gitBranchAction(action, branchName, config.workspaceRoot)
      }

      case "orchestrate": {
        const { intent, intentType = "QUERY_INFO" } = JSON.parse(argsStr)

        // Resolve orchestrator session from config.sessionId (voice_<userId>)
        // or fall back to a generated one (no tokidapp WS progress possible).
        const orchSessionId = config.sessionId || ("voice_" + Date.now())
        const orchRes = await apiPost("/api/tokidapp/orchestrator", { sessionId: orchSessionId, voiceMode: true })
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

        // If the user has a tokidapp WS socket open, stream DAG progress to it
        // so the Pipeline and Causal tabs update in real time.
        const userId = config.sessionId ? getUserIdFromSessionId(config.sessionId) : null
        const tokidappSocket = userId ? getTokidappSocket(tokidappSessionId(userId)) : undefined

        const callbacks: ExecutionCallbacks = tokidappSocket
          ? {
              onNodeStart: (node) => {
                tokidappSocket.send(JSON.stringify({
                  type: "dag_node_status",
                  nodeId: node.title,
                  nodeName: node.title,
                  status: "RUNNING",
                  progress: 0,
                }))
              },
              onNodeComplete: (node) => {
                tokidappSocket.send(JSON.stringify({
                  type: "dag_node_status",
                  nodeId: node.title,
                  nodeName: node.title,
                  status: "COMPLETED",
                  progress: 100,
                  output: node.toolOutput,
                }))
              },
              onNodeFail: (node, error) => {
                tokidappSocket.send(JSON.stringify({
                  type: "dag_node_status",
                  nodeId: node.title,
                  nodeName: node.title,
                  status: "FAILED",
                  progress: 0,
                  error,
                }))
              },
              onApprovalRequired: async (node, ctx) => {
                // Voice path: auto-approve (no approval modal possible over voice)
                // Future: could send an approval_request WS message and wait
                return "approved" as const
              },
              onBroadcast: () => {},
              onLog: () => {},
              onCausalGraphUpdate: (cNodes, cEdges) => {
                tokidappSocket.send(JSON.stringify({
                  type: "causal_graph_update",
                  causalNodes: cNodes,
                  causalEdges: cEdges,
                }))
              },
            }
          : {
              // No tokidapp WS — fall back to silent execution
              onNodeStart: () => {},
              onNodeComplete: () => {},
              onNodeFail: () => {},
              onApprovalRequired: async () => "approved" as const,
              onBroadcast: () => {},
              onLog: () => {},
              onCausalGraphUpdate: () => {},
            }

        const result = await executeDAG(orchestratorId, dag, callbacks)

        // Collect DAG node outputs to feed back into Realtime conversation context
        const outputEntries = Object.entries(result.outputs || {})
          .filter(([, v]) => v && typeof v === "string" && v.length < 2000)
          .slice(0, 8)
        const outputsSummary = outputEntries.length > 0
          ? "\n\nKey outputs:\n" + outputEntries.map(([k, v]) => `[${k}]: ${v.slice(0, 300)}`).join("\n")
          : ""

        if (result.success) {
          return `Orchestration complete! ${result.completedNodes} tasks completed in ${(result.durationMs / 1000).toFixed(1)}s.${outputsSummary}`
        } else {
          return `Orchestration finished with issues: ${result.failedNodes} failed, ${result.skippedNodes} skipped. ${result.error || ""}${outputsSummary}`
        }
      }

      case "nomadworks_invoke": {
        const { intent, agentType = "developer", contextDescription = "", complexity = "standard" } = JSON.parse(argsStr)
        const workspaceRoot = config.workspaceRoot
        const sessionId = config.sessionId || `voice_${Date.now()}`

        // Gather context from what the concierge has already discussed
        const context: Record<string, unknown> = {}
        if (contextDescription) context.contextDescription = contextDescription
        context.source = "concierge"
        context.sessionId = sessionId

        const result = await bridge.createTaskFile({
          intent,
          agentType,
          context,
          complexity,
          sessionId,
        })

        // Also try to notify the tokidapp WS so the Evidence tab gets live updates
        try {
          const userId = sessionId ? sessionId.replace(/^voice_/, "") : null
          if (userId) {
            const { getTokidappSocket, tokidappSessionId } = await import("../../../server/ws-socket-registry")
            const socket = getTokidappSocket(tokidappSessionId(userId))
            if (socket) {
              socket.send(JSON.stringify({
                type: "nomadworks_task_status",
                taskId: result.taskId,
                status: "created",
                title: intent.slice(0, 120),
                agentType,
                complexity,
              }))
              // Start watching for task completion so the Evidence Browser gets
              // live causal + evidence updates when the PMA finishes processing
              bridge.watchTask(result.taskId, (msg) => socket.send(msg))
            }
          }
        } catch {
          // Non-critical — task was created regardless
        }

        return `NomadWorks task created: ${result.taskId} (${agentType}, ${complexity}). Task file: ${result.taskFilePath}. Evidence will appear in the Evidence Browser and Causal tabs once the task is completed.`
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

/** Simple hash for safety identifier — privacy-preserving, not cryptographic. */
function hashSafetyId(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

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
  userId?: string,
  /** Optional enriched instructions appended to VOICE_INSTRUCTIONS.
   *  Used to inject architecture knowledge base digest at session start. */
  enrichedInstructions?: string,
): RealtimeSession {
  console.log("[openai-realtime] createRealtimeSession sessionId:", sessionId, "hasKey:", !!OPENAI_API_KEY, "keyPrefix:", OPENAI_API_KEY ? OPENAI_API_KEY.substring(0, 8) + "..." : "none")
  if (!OPENAI_API_KEY) {
    const msg = "OPENAI_API_KEY is not configured. Voice mode requires an OpenAI API key."
    console.error("[openai-realtime]", msg)
    onError(msg)
    // Return a stub session that never connects
    const stubWs = new WebSocket("wss://localhost:0") as any
    stubWs.readyState = 3 // CLOSED
    return {
      ws: stubWs,
      sessionId,
      connected: false,
      outputVoice: normalizeRealtimeVoice(outputVoice),
      toolCallbacks: new Map(),
      audioBytes: 0,
      pendingChunks: [],
      onReady,
      responseInProgress: false,
      pendingResponseQueue: [],
    }
  }

  const wsHeaders: Record<string, string> = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
  }
  if (userId) {
    wsHeaders["OpenAI-Safety-Identifier"] = hashSafetyId(userId)
  }

  console.log("[openai-realtime] connecting to OpenAI Realtime URL:", REALTIME_URL)
  const ws = new WebSocket(REALTIME_URL, ["realtime"], { headers: wsHeaders })

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
    responseInProgress: false,
    pendingResponseQueue: [],
  }

  /** Send response.create, guarding against concurrent responses */
  function sendResponseCreate() {
    if (session.responseInProgress) {
      console.log("[openai-realtime] response already in progress, queuing for session:", sessionId)
      session.pendingResponseQueue.push(() => {
        if (session.connected) {
          session.responseInProgress = true
          session.ws.send(JSON.stringify({ type: "response.create" }))
        }
      })
      return
    }
    session.responseInProgress = true
    session.ws.send(JSON.stringify({ type: "response.create" }))
  }

  /** Cancel the current in-progress response so a new one can start */
  function cancelCurrentResponse() {
    if (session.responseInProgress) {
      session.ws.send(JSON.stringify({ type: "response.cancel" }))
      session.responseInProgress = false
      // Drain any queued responses
      const next = session.pendingResponseQueue.shift()
      if (next) next()
    }
  }

  ws.addEventListener("open", () => {
    console.log("[openai-realtime] OpenAI WS connected for session:", sessionId)
    session.connected = true
    flushPendingForSession(session)

    const instructions = enrichedInstructions
      ? VOICE_INSTRUCTIONS + "\n\n" + enrichedInstructions
      : VOICE_INSTRUCTIONS

    const config = {
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        instructions,
        ...(SUPPORTS_REASONING ? { reasoning: { effort: REALTIME_REASONING_EFFORT } } : {}),
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "gpt-4o-mini-transcribe" },
            // Server-side VAD for continuous voice — auto-detects when user stops speaking.
            // Calibrate via OPENAI_REALTIME_VAD_* env vars (threshold, prefix_padding_ms, silence_duration_ms).
            turn_detection: {
              type: "server_vad",
              threshold: REALTIME_VAD_THRESHOLD,
              prefix_padding_ms: REALTIME_VAD_PREFIX_PADDING_MS,
              silence_duration_ms: REALTIME_VAD_SILENCE_DURATION_MS,
            },
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

  ws.addEventListener("message", async (event: any) => {
    try {
      const raw = typeof event.data === "string" ? event.data : event.data.toString()
      const parsed = JSON.parse(raw)

      switch (parsed.type) {
        case "session.created":
        case "session.updated":
          console.log("[openai-realtime] OpenAI session ready event:", parsed.type, "for session:", sessionId)
          // Keep onReady persistent — fires on every session-ready event (initial + voice change)
          session.onReady?.()
          break

        // Audio deltas (GA event names + legacy fallbacks)
        case "response.output_audio.delta":
        case "response.audio.delta":
          if (parsed.delta) onAudioDelta(parsed.delta)
          break

        // Text deltas (GA event names + legacy fallbacks)
        case "response.output_text.delta":
        case "response.text.delta":
          if (parsed.delta) onTextDelta(sanitizeSpeechText(parsed.delta))
          break

        // Audio transcript deltas (GA event names + legacy fallbacks)
        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta":
          if (parsed.delta) onTextDelta(sanitizeSpeechText(parsed.delta))
          break

        // User transcription (GA event names + legacy fallbacks)
        case "conversation.item.input_audio_transcription.completed":
        case "input_audio_transcription.completed": {
          const transcript =
            parsed.transcript ||
            parsed.item?.input_audio_transcription?.transcript ||
            ""
          if (transcript && onUserTranscript) {
            onUserTranscript(sanitizeAsrText(transcript))
          }
          break
        }

        // Response done (GA event names + legacy fallbacks)
        case "response.done":
        case "response.completed":
          session.responseInProgress = false
          onResponseDone?.()
          // With VAD, the server auto-resumes listening after response completes.
          // Notify client that voice is ready again.
          session.onReady?.()
          // Drain any queued response.create requests
          {
            const next = session.pendingResponseQueue.shift()
            if (next) next()
          }
          // Flush audio chunks that were buffered during response generation
          flushPendingForSession(session)
          break

        case "conversation.item.created":
          break

        // Function call (GA event names + legacy fallbacks)
        case "response.function_call_arguments.done": {
          const toolName = parsed.name
          const args = parsed.arguments || "{}"

          // Skip response.cancel for wait_for_user — it's a no-op tool
          if (toolName !== "wait_for_user") {
            cancelCurrentResponse()
          }

          const result = await executeTool(toolName, args, {
            workspaceRoot: WORKSPACE_ROOT,
            starguardBase: STARGUARD_BASE,
            sessionId: session.sessionId,
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

          // Only create new response for non-wait tools
          if (toolName !== "wait_for_user") {
            sendResponseCreate()
          }
          break
        }

        case "error": {
          const message = parsed.error?.message || "OpenAI Realtime error"
          if (/buffer too small|buffer only has 0/i.test(message)) break
          // If there's an "active response in progress" error, reset the tracking state
          // and do NOT propagate to the client — this is a recoverable server-side race.
          if (/active response in progress/i.test(message)) {
            console.log("[openai-realtime] Active response error — resetting response state and processing queue")
            session.responseInProgress = false
            // Process any queued responses after a short delay
            setTimeout(() => {
              while (session.pendingResponseQueue.length > 0) {
                const next = session.pendingResponseQueue.shift()!
                next()
              }
            }, 100)
          } else {
            onError(message)
          }
          break
        }

        case "rate_limits.updated":
          break
      }
    } catch {
      // Ignore parse errors
    }
  })

  ws.addEventListener("error", (err: any) => {
    console.log("[openai-realtime] OpenAI WS error for session:", sessionId, "error:", err?.message || String(err))
    onError("OpenAI Realtime connection error")
    session.connected = false
  })

  ws.addEventListener("close", (event: any) => {
    console.log("[openai-realtime] OpenAI WS closed for session:", sessionId, "code:", event?.code, "reason:", event?.reason)
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

  // Buffer chunks while a response is generating to avoid "active response in progress" errors
  if (session.responseInProgress) {
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
  // Guard against concurrent responses — queue if one is already in progress
  if (session.responseInProgress) {
    console.log("[openai-realtime] commitAudioBuffer: response in progress, queuing for session:", sessionId)
    session.pendingResponseQueue.push(() => {
      if (session.connected) {
        session.responseInProgress = true
        session.ws.send(JSON.stringify({ type: "response.create" }))
      }
    })
  } else {
    session.responseInProgress = true
    session.ws.send(JSON.stringify({ type: "response.create" }))
  }
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
    // Remove listeners before closing so the old session's async close handler
    // doesn't accidentally delete a newly-created session with the same ID.
    session.ws.onclose = null
    session.ws.onerror = null
    session.ws.close()
    sessions.delete(sessionId)
  }
  // Clean up per-user tracking — only remove if this was the tracked session
  // for that user, in case it was already replaced by a newer one.
  for (const [userId, trackedId] of activeUserSessions) {
    if (trackedId === sessionId) {
      activeUserSessions.delete(userId)
      break
    }
  }
}

/** Get the userId from a sessionId (supports "voice_*" and "tokidapp_*" prefixes). */
function getUserIdFromSessionId(sessionId: string): string | null {
  if (sessionId.startsWith("voice_")) return sessionId.slice(6)
  if (sessionId.startsWith("tokidapp_")) return sessionId.slice(9)
  return null
}

/** Ensure only one Realtime session is active per user.
 *  If another session (with a different prefix) already exists for this user, end it first.
 *  Returns true if the caller should proceed, false if it was already handled. */
export function ensureSingleUserSession(sessionId: string): boolean {
  const userId = getUserIdFromSessionId(sessionId)
  if (!userId) return true // can't determine user, allow

  const existingSessionId = activeUserSessions.get(userId)
  if (existingSessionId && existingSessionId !== sessionId) {
    // Another session exists for this user — end it before creating a new one
    endVoiceSession(existingSessionId)
  }

  activeUserSessions.set(userId, sessionId)
  return true
}

export function getRealtimeSession(sessionId: string): RealtimeSession | undefined {
  return sessions.get(sessionId)
}

export function getRealtimeSessionVoice(sessionId: string): RealtimeVoiceId | undefined {
  return sessions.get(sessionId)?.outputVoice
}
