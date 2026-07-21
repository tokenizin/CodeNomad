import WebSocket from "ws"
import { normalizeRealtimeVoice, type RealtimeVoiceId } from "./realtime-voices"
import { sanitizeAsrText, sanitizeSpeechText, VOICE_INSTRUCTIONS } from "./speech-sanitize"
import { executeTool } from "./openai-realtime"
import { voiceOrchestratorToolDefinitions } from "./voice-orchestrator-tools"

/** Tracks one active session per user — prevents two sessions for the same
 *  user across the voice WS and tokidapp WS (e.g. voice_abc + tokidapp_abc).
 *  When a new session starts for a user, any existing session is ended first. */
const activeUserSessions = new Map<string, string>() // userId → sessionId

// ── Latency Monitoring ────────────────────────────────────────

/** Latency metrics for a single Ornith session. */
export interface OrnithLatencyMetrics {
  /** Time to establish WebSocket connection (ms). */
  connectionMs: number
  /** Time to first audio chunk after sending a message (ms). */
  firstAudioMs: number
  /** Total round-trip time for the last request (ms). */
  responseMs: number
  /** Timestamp of the last measurement. */
  lastMeasuredAt: number
}

/** Default latency metrics (all zeros). */
const DEFAULT_LATENCY: OrnithLatencyMetrics = {
  connectionMs: 0,
  firstAudioMs: 0,
  responseMs: 0,
  lastMeasuredAt: 0,
}

/** Tracks latency across all active sessions. */
const sessionLatency = new Map<string, OrnithLatencyMetrics>()

/** Get current latency metrics for a session. */
export function getOrnithLatency(sessionId: string): OrnithLatencyMetrics {
  return sessionLatency.get(sessionId) ?? { ...DEFAULT_LATENCY }
}

/** Update a specific latency metric for a session. */
function setLatencyMetric(
  sessionId: string,
  key: keyof OrnithLatencyMetrics,
  value: number,
): void {
  const current = sessionLatency.get(sessionId) ?? { ...DEFAULT_LATENCY }
  current[key] = value
  current.lastMeasuredAt = Date.now()
  sessionLatency.set(sessionId, current)
  console.log(`[ornith-latency] ${key}: ${value}ms (session: ${sessionId})`)
}

/** Clear latency metrics for a session. */
function clearLatency(sessionId: string): void {
  sessionLatency.delete(sessionId)
}

/** Ornith 31B-dense model endpoint. Override with ORNITH_MODEL_ENDPOINT. */
const ORNITH_ENDPOINT = process.env.ORNITH_MODEL_ENDPOINT || "http://localhost:8080/v1"
/** Ornith API key (if required). Override with ORNITH_API_KEY. */
const ORNITH_API_KEY = process.env.ORNITH_API_KEY || ""
/** Default voice for Ornith engine. Override with ORNITH_DEFAULT_VOICE. */
const ORNITH_DEFAULT_VOICE = process.env.ORNITH_DEFAULT_VOICE || "ornith-default"

/** ── Voice Activity Detection calibration (env-var configurable) ── */

/** VAD activation threshold (0.0–1.0). Higher = less sensitive. Default: 0.7. */
const ORNITH_VAD_THRESHOLD = (() => {
  const raw = process.env.ORNITH_VAD_THRESHOLD?.trim()
  if (!raw) return 0.7
  const val = parseFloat(raw)
  return Number.isFinite(val) && val >= 0 && val <= 1 ? val : 0.7
})()

/** Audio captured before speech onset in ms. Default: 500. */
const ORNITH_VAD_PREFIX_PADDING_MS = (() => {
  const raw = process.env.ORNITH_VAD_PREFIX_PADDING_MS?.trim()
  if (!raw) return 500
  const val = parseInt(raw, 10)
  return Number.isFinite(val) && val > 0 ? val : 500
})()

/** Silence duration before end-of-turn in ms. Default: 500. */
const ORNITH_VAD_SILENCE_DURATION_MS = (() => {
  const raw = process.env.ORNITH_VAD_SILENCE_DURATION_MS?.trim()
  if (!raw) return 500
  const val = parseInt(raw, 10)
  return Number.isFinite(val) && val > 0 ? val : 500
})()

const WORKSPACE_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()
const STARGUARD_BASE = process.env.STARGUARD_BASE_URL || "https://star-worlds.vercel.app"

interface OrnithSession {
  ws: WebSocket
  sessionId: string
  connected: boolean
  outputVoice: RealtimeVoiceId
  audioBytes: number
  pendingChunks: string[]
  onReady?: () => void
  /** Track whether a response is currently in progress to avoid race conditions */
  responseInProgress: boolean
  /** Queue of response.create requests to send after current response completes */
  pendingResponseQueue: Array<() => void>
  /** Collected user+assistant transcript lines for post-session wiki update */
  transcript: string[]
  /** Send a message to the frontend client WebSocket (not the Ornith WS).
   *  Used for tool_result, clickflow prompts, and other client-destined messages. */
  sendToClient?: (msg: string) => void
}

const sessions = new Map<string, OrnithSession>()

/** TokiDAPP chat sessions that already received the opening voice greeting. */
const voiceGreetingPlayedForChatSession = new Set<string>()

// ── Tool Definitions (registered with Ornith Realtime) ──────

const tools = [
  {
    type: "function",
    name: "wait_for_user",
    description: "Call when audio is silence, background noise, or speech not addressed to you. Ends the turn without a spoken reply.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "parse_commands",
    description: "Parse user input for commands, @agent mentions, [A→B: directives], pipeline syntax (A|B|C), and #tags. Returns structured interpretations you can act on. Call this FIRST when the user uses /commands, @mentions, [brackets], pipes, or any structured syntax. Do NOT guess what a command means — let this tool tell you.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "The full raw user input text to parse for commands" },
      },
      required: ["input"],
    },
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
        status: { type: "string", description: "Filter by status: active, completed, blocked" },
        keyword: { type: "string", description: "Filter by keyword in task name" },
      },
    },
  },
  {
    type: "function",
    name: "assign_task",
    description: "Assign a task to an agent.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID to assign" },
        agentId: { type: "string", description: "Agent ID to assign to" },
      },
      required: ["taskId", "agentId"],
    },
  },
  {
    type: "function",
    name: "rollback_deploy",
    description: "Rollback the last deployment.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "capture_git_diff",
    description: "Capture the current git diff for analysis.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "run_a11y_audit",
    description: "Run accessibility audit on the current page.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "check_a11y_scan",
    description: "Check accessibility scan results.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "check_color_contrast",
    description: "Check color contrast ratios for accessibility.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "read_file_content",
    description: "Read the content of a file.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to read" },
      },
      required: ["filePath"],
    },
  },
  {
    type: "function",
    name: "run_lint",
    description: "Run linting on the codebase.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "run_type_check",
    description: "Run TypeScript type checking.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "git_branch_action",
    description: "Perform git branch operations (create, switch, delete).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform: create, switch, delete" },
        branchName: { type: "string", description: "Name of the branch" },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "get_architecture_digest",
    description: "Get a digest of the architecture knowledge base.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "vision_analyze",
    description: "Analyze an image using vision capabilities.",
    parameters: {
      type: "object",
      properties: {
        imageUrl: { type: "string", description: "URL of the image to analyze" },
        prompt: { type: "string", description: "Prompt for analysis" },
      },
      required: ["imageUrl"],
    },
  },
  {
    type: "function",
    name: "generate_mermaid_diagram",
    description: "Generate a Mermaid diagram from a description.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Description of the diagram to generate" },
      },
      required: ["description"],
    },
  },
  {
    type: "function",
    name: "generate_file",
    description: "Generate a file with specified content.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to generate" },
        content: { type: "string", description: "Content of the file" },
      },
      required: ["filePath", "content"],
    },
  },
  {
    type: "function",
    name: "google_search",
    description: "Search Google for information.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "read_wiki_page",
    description: "Read a page from the wiki.",
    parameters: {
      type: "object",
      properties: {
        pageName: { type: "string", description: "Name of the wiki page" },
      },
      required: ["pageName"],
    },
  },
  {
    type: "function",
    name: "search_wiki",
    description: "Search the wiki for content.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "search_obsidian_vault",
    description: "Search the Obsidian vault for notes.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "read_obsidian_note",
    description: "Read a note from the Obsidian vault.",
    parameters: {
      type: "object",
      properties: {
        notePath: { type: "string", description: "Path to the note" },
      },
      required: ["notePath"],
    },
  },
  {
    type: "function",
    name: "get_entity_connections",
    description: "Get connections for an entity in the knowledge graph.",
    parameters: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "ID of the entity" },
      },
      required: ["entityId"],
    },
  },
  {
    type: "function",
    name: "write_wiki",
    description: "Write content to a wiki page.",
    parameters: {
      type: "object",
      properties: {
        pageName: { type: "string", description: "Name of the wiki page" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["pageName", "content"],
    },
  },
  {
    type: "function",
    name: "lint_wiki",
    description: "Lint the wiki for issues.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "update_wiki_from_session",
    description: "Update wiki from the current session.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "compile_to_wiki",
    description: "Compile content to wiki format.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "get_wiki_health",
    description: "Check wiki health status.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "suggest_repair_links",
    description: "Suggest repairs for broken links in the wiki.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  ...voiceOrchestratorToolDefinitions,
]

/** Map Ornith tool definition names → openai-realtime executeTool case names. */
const ORNITH_TOOL_ALIASES: Record<string, string> = {
  check_a11y_scan: "check_a11y",
  run_type_check: "run_typecheck",
  git_branch_action: "git_branch",
  generate_mermaid_diagram: "generate_diagram",
  google_search: "web_search",
  update_wiki_from_session: "session_summary",
  compile_to_wiki: "compile_wiki",
  get_wiki_health: "wiki_health",
  suggest_repair_links: "suggest_repairs",
  write_wiki: "write_to_wiki",
  voice_ask_user_pick_one: "ask_user_pick_one",
  voice_ask_user_confirm: "ask_user_confirm",
  read_file_content: "read_file",
}

async function runOrnithTool(
  name: string,
  args: string,
  session: OrnithSession,
): Promise<string> {
  if (name === "wait_for_user") return "OK"
  if (name === "get_architecture_digest") {
    // Not yet in shared executeTool — return a clear stub rather than "Unknown tool".
    return "Architecture digest is not available on the Ornith engine yet."
  }
  const toolName = ORNITH_TOOL_ALIASES[name] ?? name
  return executeTool(toolName, args, {
    workspaceRoot: WORKSPACE_ROOT,
    starguardBase: STARGUARD_BASE,
    sessionId: session.sessionId,
    sendFn: session.sendToClient,
  })
}

// ── Session Management ──────────────────────────────────────

function generateSessionId(): string {
  return `ornith_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

function cleanupSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (session) {
    session.ws.close()
    sessions.delete(sessionId)

    // Clean up active user sessions
    for (const [userId, sid] of activeUserSessions.entries()) {
      if (sid === sessionId) {
        activeUserSessions.delete(userId)
        break
      }
    }
  }
  clearLatency(sessionId)
}

// ── WebSocket Connection ────────────────────────────────────

export function createOrnithSession(
  ws: WebSocket,
  sessionId: string,
  voiceId: string = ORNITH_DEFAULT_VOICE,
  sendToClient?: (msg: string) => void
): OrnithSession {
  const connectionStart = Date.now()

  const session: OrnithSession = {
    ws,
    sessionId,
    connected: false,
    outputVoice: normalizeRealtimeVoice(voiceId),
    audioBytes: 0,
    pendingChunks: [],
    responseInProgress: false,
    pendingResponseQueue: [],
    transcript: [],
    sendToClient,
  }

  sessions.set(sessionId, session)

  // Track connection latency
  setLatencyMetric(sessionId, 'connectionMs', Date.now() - connectionStart)

  return session
}

export function getOrnithSession(sessionId: string): OrnithSession | undefined {
  return sessions.get(sessionId)
}

export function removeOrnithSession(sessionId: string): void {
  cleanupSession(sessionId)
}

// ── Audio Processing ────────────────────────────────────────

function encodeAudioForOrnith(audioData: Float32Array): string {
  // Convert Float32Array to base64 PCM16
  const buffer = new ArrayBuffer(audioData.length * 2)
  const view = new DataView(buffer)
  
  for (let i = 0; i < audioData.length; i++) {
    const sample = Math.max(-1, Math.min(1, audioData[i]))
    view.setInt16(i * 2, sample * 0x7FFF, true)
  }
  
  const uint8Array = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i])
  }
  
  return btoa(binary)
}

function decodeOrnithAudio(base64Audio: string): Float32Array {
  // Convert base64 PCM16 to Float32Array
  const binary = atob(base64Audio)
  const bytes = new Uint8Array(binary.length)
  
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  
  const view = new DataView(bytes.buffer)
  const float32Array = new Float32Array(bytes.length / 2)
  
  for (let i = 0; i < float32Array.length; i++) {
    const sample = view.getInt16(i * 2, true)
    float32Array[i] = sample / 0x7FFF
  }
  
  return float32Array
}

// ── Message Handlers ────────────────────────────────────────

export async function handleOrnithMessage(
  session: OrnithSession,
  message: string
): Promise<void> {
  try {
    const data = JSON.parse(message)
    
    switch (data.type) {
      case "session.update":
        await handleSessionUpdate(session, data.session)
        break
        
      case "input_audio_buffer.append":
        await handleAudioBuffer(session, data.audio)
        break
        
      case "input_audio_buffer.commit":
        await handleAudioCommit(session)
        break
        
      case "response.create":
        await handleResponseCreate(session, data)
        break
        
      case "conversation.item.create":
        await handleConversationItem(session, data.item)
        break
        
      default:
        console.warn(`[ornith] Unknown message type: ${data.type}`)
    }
  } catch (error) {
    console.error(`[ornith] Error handling message:`, error)
    session.ws.send(JSON.stringify({
      type: "error",
      error: { message: "Failed to process message" }
    }))
  }
}

async function handleSessionUpdate(
  session: OrnithSession,
  sessionConfig: any
): Promise<void> {
  // Update session configuration
  if (sessionConfig.output_modalities) {
    // Handle output modalities
  }
  
  if (sessionConfig.instructions) {
    // Update voice instructions
  }
  
  if (sessionConfig.audio) {
    // Update audio configuration
  }
  
  if (sessionConfig.tools) {
    // Update tools
  }
  
  // Send session.updated confirmation
  session.ws.send(JSON.stringify({
    type: "session.updated",
    session: sessionConfig
  }))
}

async function handleAudioBuffer(
  session: OrnithSession,
  audioBase64: string
): Promise<void> {
  // Buffer audio data
  session.pendingChunks.push(audioBase64)
}

async function handleAudioCommit(session: OrnithSession): Promise<void> {
  // Process buffered audio
  const audioData = session.pendingChunks.join('')
  session.pendingChunks = []
  
  // Send to Ornith endpoint for processing
  try {
    const response = await fetch(`${ORNITH_ENDPOINT}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ORNITH_API_KEY && { 'Authorization': `Bearer ${ORNITH_API_KEY}` })
      },
      body: JSON.stringify({
        audio: audioData,
        model: "whisper-1"
      })
    })
    
    const result = await response.json()
    
    if (result.text) {
      // Send transcript to client
      session.ws.send(JSON.stringify({
        type: "conversation.item.created",
        item: {
          id: `item_${Date.now()}`,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: result.text }]
        }
      }))
      
      // Add to transcript
      session.transcript.push(`User: ${result.text}`)
    }
  } catch (error) {
    console.error(`[ornith] Audio transcription error:`, error)
  }
}

async function handleResponseCreate(
  session: OrnithSession,
  data: any
): Promise<void> {
  if (session.responseInProgress) {
    // Queue the response
    session.pendingResponseQueue.push(() => handleResponseCreate(session, data))
    return
  }

  session.responseInProgress = true
  const responseStart = Date.now()

  try {
    // Get the last user message
    const lastUserMessage = session.transcript
      .filter(t => t.startsWith('User: '))
      .pop()
      ?.replace('User: ', '')

    if (!lastUserMessage) {
      session.responseInProgress = false
      return
    }

    // Call Ornith endpoint for chat completion
    const response = await fetch(`${ORNITH_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ORNITH_API_KEY && { 'Authorization': `Bearer ${ORNITH_API_KEY}` })
      },
      body: JSON.stringify({
        model: "ornith-31b-dense",
        messages: [
          { role: "system", content: VOICE_INSTRUCTIONS },
          { role: "user", content: lastUserMessage }
        ],
        tools: tools.map(t => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters
          }
        })),
        stream: true
      })
    })
    
    // Process streaming response
    const reader = response.body?.getReader()
    if (!reader) {
      session.responseInProgress = false
      return
    }
    
    let fullResponse = ""
    
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      
      const chunk = new TextDecoder().decode(value)
      const lines = chunk.split('\n').filter(line => line.trim() !== '')
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') continue
          
          try {
            const parsed = JSON.parse(data)
            const content = parsed.choices?.[0]?.delta?.content
            if (content) {
              fullResponse += content
              
              // Send audio chunk
              await sendAudioChunk(session, content)
            }
            
            // Handle tool calls
            const toolCalls = parsed.choices?.[0]?.delta?.tool_calls
            if (toolCalls) {
              for (const toolCall of toolCalls) {
                await handleToolCall(session, toolCall)
              }
            }
          } catch (e) {
            // Ignore parsing errors
          }
        }
      }
    }
    
    // Add response to transcript
    if (fullResponse) {
      session.transcript.push(`Assistant: ${fullResponse}`)
    }
    
  } catch (error) {
    console.error(`[ornith] Response creation error:`, error)
  } finally {
    // Track total response latency
    setLatencyMetric(session.sessionId, 'responseMs', Date.now() - responseStart)

    session.responseInProgress = false

    // Process queued responses
    if (session.pendingResponseQueue.length > 0) {
      const nextResponse = session.pendingResponseQueue.shift()
      if (nextResponse) {
        await nextResponse()
      }
    }
  }
}

async function sendAudioChunk(
  session: OrnithSession,
  text: string
): Promise<void> {
  const chunkStart = Date.now()

  try {
    // Convert text to speech using Ornith TTS
    const response = await fetch(`${ORNITH_ENDPOINT}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ORNITH_API_KEY && { 'Authorization': `Bearer ${ORNITH_API_KEY}` })
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice: session.outputVoice
      })
    })

    if (response.ok) {
      const audioBuffer = await response.arrayBuffer()
      const base64Audio = Buffer.from(audioBuffer).toString('base64')

      // Track first audio latency
      const firstAudioMs = Date.now() - chunkStart
      if (getOrnithLatency(session.sessionId).firstAudioMs === 0) {
        setLatencyMetric(session.sessionId, 'firstAudioMs', firstAudioMs)
      }

      // Send audio chunk to client
      session.ws.send(JSON.stringify({
        type: "response.audio.delta",
        delta: base64Audio
      }))

      session.audioBytes += audioBuffer.byteLength
    }
  } catch (error) {
    console.error(`[ornith] Audio chunk error:`, error)
  }
}

async function handleToolCall(
  session: OrnithSession,
  toolCall: any
): Promise<void> {
  const { id, function: func } = toolCall
  
  if (func && func.name) {
    try {
      const result = await runOrnithTool(func.name, func.arguments || "{}", session)
      
      // Send tool result
      session.ws.send(JSON.stringify({
        type: "conversation.item.created",
        item: {
          id: `item_${Date.now()}`,
          type: "function_call_output",
          call_id: id,
          output: result
        }
      }))
      
      // Add to transcript
      session.transcript.push(`Tool: ${func.name} → ${result.substring(0, 100)}...`)
    } catch (error) {
      console.error(`[ornith] Tool call error:`, error)
    }
  }
}

async function handleConversationItem(
  session: OrnithSession,
  item: any
): Promise<void> {
  if (item.type === "message" && item.role === "user") {
    // Handle text input
    const text = item.content?.[0]?.text
    if (text) {
      session.transcript.push(`User: ${text}`)
      
      // Trigger response
      await handleResponseCreate(session, {})
    }
  }
}

// ── Export Functions ─────────────────────────────────────────

export function getOrnithSessions(): Map<string, OrnithSession> {
  return sessions
}

export function getOrnithSessionCount(): number {
  return sessions.size
}

export function cleanupAllOrnithSessions(): void {
  for (const [sessionId] of sessions) {
    cleanupSession(sessionId)
  }
}
