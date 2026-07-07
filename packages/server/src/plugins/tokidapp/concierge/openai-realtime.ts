import WebSocket from "ws"
import { normalizeRealtimeVoice, type RealtimeVoiceId } from "./realtime-voices"
import { sanitizeAsrText, sanitizeSpeechText, VOICE_INSTRUCTIONS } from "./speech-sanitize"
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
  visionAnalyze,
  generateMermaidDiagram,
  generateFile,
  readWikiPage,
  searchWiki,
  searchObsidianVault,
  readObsidianNote,
  getEntityConnections,
  writeWiki,
  lintWiki,
  updateWikiFromSession,
  compileToWiki,
  getWikiHealth,
  suggestRepairLinks,
} from "./codebase-tools"
import { bridge } from "../../../server/routes/nomadworks-bridge"
import { buildLifecycleDAG, executeDAG } from "../orchestrator/dag-engine"
import { apiPost } from "../orchestrator/starguard-client"
import type { DAGNode, DAGDefinition, ExecutionCallbacks } from "../orchestrator/types"
import { getTokidappSocket, tokidappSessionId, getUserIdFromSessionId } from "../../../server/ws-socket-registry"

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
  process.env.OPENAI_REALTIME_REASONING_EFFORT?.trim() || "low"

/** Only gpt-realtime-2 supports the reasoning parameter. */
const SUPPORTS_REASONING = REALTIME_MODEL === "gpt-realtime-2"

/** ── Voice Activity Detection calibration (env-var configurable) ── */

/** VAD activation threshold (0.0–1.0). Higher = less sensitive. Default: 0.7.
 *  Lowered from 0.9 to catch natural speech more reliably. If background
 *  noise or playback echo triggers false VAD activations, raise back up
 *  via OPENAI_REALTIME_VAD_THRESHOLD env var. */
const REALTIME_VAD_THRESHOLD = (() => {
  const raw = process.env.OPENAI_REALTIME_VAD_THRESHOLD?.trim()
  if (!raw) return 0.7
  const val = parseFloat(raw)
  return Number.isFinite(val) && val >= 0 && val <= 1 ? val : 0.7
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

const WORKSPACE_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()
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
  /** Collected user+assistant transcript lines for post-session wiki update */
  transcript: string[]
}

const sessions = new Map<string, RealtimeSession>()

/** TokiDAPP chat sessions that already received the opening voice greeting. */
const voiceGreetingPlayedForChatSession = new Set<string>()

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
    name: "vision_analyze",
    description: "Analyze an image using AI vision. Call this proactively when you detect that the user has attached an image (the file context will include images with 'Use vision_analyze to inspect'). Also use when the user asks about image contents. Pass the image URL from the file attachment.",
    parameters: {
      type: "object",
      properties: {
        imageUrl: { type: "string", description: "URL of the image to analyze (from the file attachment)" },
        prompt: { type: "string", description: "Optional specific question about the image. Default: general description." },
      },
      required: ["imageUrl"],
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
  {
    type: "function",
    name: "generate_diagram",
    description: "Generate a Mermaid diagram from a text description. Use this when the user asks you to create a diagram, chart, flowchart, sequence diagram, architecture diagram, or any visual representation. Returns Mermaid source code that can be rendered client-side.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "What diagram to generate — describe the nodes, relationships, flow, or structure" },
        diagramType: { type: "string", description: "Optional Mermaid diagram type hint: flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, gitgraph, quadrantChart, timeline, etc." },
      },
      required: ["description"],
    },
  },
  {
    type: "function",
    name: "generate_file",
    description: "Generate a downloadable file — Mermaid diagram SVG, document, or code snippet. For Mermaid diagrams, pass the mermaid source code as content and type=mermaid_svg. The result includes a download URL the user can open to save the file. Use this when the user wants to download a diagram, save generated content, or export a file.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["mermaid_svg", "document", "code"], description: "Type of file to generate." },
        content: { type: "string", description: "The content of the file. For mermaid_svg: pass the raw Mermaid source code. For document: text content. For code: code snippet." },
        fileName: { type: "string", description: "Optional filename with extension (e.g. 'architecture-diagram.mmd', 'notes.txt'). Auto-generated if omitted." },
        title: { type: "string", description: "A short title for the file (used in the generated filename if fileName is not provided)." },
      },
      required: ["type", "content"],
    },
  },
  {
    type: "function",
    name: "read_wiki_page",
    description: "Read a wiki entity page from the StarCARD architecture wiki. Returns full markdown content including frontmatter and wikilinks. Use when you need detailed info about a specific entity.",
    parameters: {
      type: "object",
      properties: {
        pageName: { type: "string", description: "Entity page name (e.g. 'RevenuePool', 'DynamicSplitter', 'StarCHAIN')" },
      },
      required: ["pageName"],
    },
  },
  {
    type: "function",
    name: "search_wiki",
    description: "Search the StarCARD architecture wiki by keyword. Returns matching pages with context. Use for broad queries or when unsure which page to read.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (e.g. 'bridge', 'revenue pool', 'membership')" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "get_entity_connections",
    description: "Get all connections (wikilinks) for a wiki entity — what it connects to and what connects to it. Use after read_wiki_page to trace dependencies.",
    parameters: {
      type: "object",
      properties: {
        pageName: { type: "string", description: "Entity page name (e.g. 'DynamicSplitter')" },
      },
      required: ["pageName"],
    },
  },
  {
    type: "function",
    name: "write_to_wiki",
    description: "Update a wiki entity page. Use when the user shares new information or corrections about an entity. Supports full page write or section-targeted update.",
    parameters: {
      type: "object",
      properties: {
        pageName: { type: "string", description: "Entity page name to update" },
        content: { type: "string", description: "New content to write (full page or section replacement)" },
        section: { type: "string", description: "Optional: specific section heading to update (e.g. 'Connected To'). If omitted, replaces entire page." },
      },
      required: ["pageName", "content"],
    },
  },
  {
    type: "function",
    name: "lint_wiki",
    description: "Run a health check on the StarCARD architecture wiki. Reports orphan pages, broken wikilinks, stale pages, and index gaps. Use periodically or when the user asks about wiki health or quality.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "session_summary",
    description: "Summarize the current voice session and update the wiki with new insights. Use at the end of a conversation to capture key architecture facts discussed during the session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The current session ID" },
      },
      required: ["sessionId"],
    },
  },
  {
    type: "function",
    name: "compile_wiki",
    description: "Compile a raw source document into wiki updates. Processes meeting notes, transcripts, or design docs and extracts entity information into the architecture wiki.",
    parameters: {
      type: "object",
      properties: {
        sourcePath: { type: "string", description: "Path to raw source file relative to docs/starworld/raw/ (e.g. 'meetings/2026-06-27.md')" },
        dryRun: { type: "boolean", description: "If true, preview what would be updated without writing. Default false." },
      },
      required: ["sourcePath"],
    },
  },
  {
    type: "function",
    name: "wiki_health",
    description: "Get a health dashboard for the architecture wiki. Shows entity count, orphan pages, broken links, stale pages, and an overall health score. Use when the user asks about wiki quality or health.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "suggest_repairs",
    description: "Analyze broken wikilinks in the wiki and suggest likely fixes. Returns a list of broken links with suggested corrections based on fuzzy name matching.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "search_obsidian_vault",
    description: "Search the Obsidian vault for project documentation, strategy docs, meeting notes, and live context. Use this for questions about project planning, architecture decisions, membership models, marketing plans, and any document stored in the StarWorld Obsidian knowledge base.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms to find in vault notes" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "read_obsidian_note",
    description: "Read a specific note from the Obsidian vault by its path. Use after search_obsidian_vault to get the full content of a note.",
    parameters: {
      type: "object",
      properties: {
        notePath: { type: "string", description: "Path to the note relative to vault root, e.g. Dashboard/Live-Context/Live-Context.md" },
      },
      required: ["notePath"],
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

      case "vision_analyze": {
        const { imageUrl, prompt } = JSON.parse(argsStr)
        return await visionAnalyze(imageUrl, prompt)
      }

      case "generate_diagram": {
        const { description, diagramType } = JSON.parse(argsStr)
        return await generateMermaidDiagram(description, diagramType)
      }

      case "generate_file": {
        const { type, content, fileName, title } = JSON.parse(argsStr)
        const result = await generateFile({ type, content, fileName, title })
        // Return a summary that includes the download URL
        return `✅ File generated: ${result.fileName} (${result.fileSize} bytes)\nURL: ${result.url}\n\nThe Mermaid source is also included in this response as a \`\`\`mermaid code block that will render as a diagram in the chat.`
      }

      case "read_wiki_page": {
        const { pageName } = JSON.parse(argsStr)
        return await readWikiPage(pageName)
      }

      case "search_wiki": {
        const { query } = JSON.parse(argsStr)
        return await searchWiki(query)
      }

      case "get_entity_connections": {
        const { pageName } = JSON.parse(argsStr)
        return await getEntityConnections(pageName)
      }

      case "write_to_wiki": {
        const { pageName, content, section } = JSON.parse(argsStr)
        return await writeWiki(pageName, content, section)
      }

      case "lint_wiki": {
        return await lintWiki()
      }

      case "session_summary": {
        const { sessionId: sid } = JSON.parse(argsStr)
        const session = sessions.get(sid)
        const transcriptText = session?.transcript?.join("\n") || ""
        return await updateWikiFromSession(sid, transcriptText)
      }

      case "compile_wiki": {
        const { sourcePath, dryRun = false } = JSON.parse(argsStr)
        return await compileToWiki(sourcePath, dryRun)
      }

      case "wiki_health": {
        return await getWikiHealth()
      }

      case "suggest_repairs": {
        return await suggestRepairLinks()
      }

      case "search_obsidian_vault": {
        const { query } = JSON.parse(argsStr)
        return await searchObsidianVault(query)
      }

      case "read_obsidian_note": {
        const { notePath } = JSON.parse(argsStr)
        return await readObsidianNote(notePath)
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
  /** StarWorld / chat-html DB session — greeting plays once per this id. */
  chatSessionId?: string,
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
      transcript: [],
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
    transcript: [],
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
          console.log("[openai-realtime] OpenAI session ready event: session.created for session:", sessionId)
          session.onReady?.()
          {
            const greetKey = (chatSessionId || "").trim() || sessionId
            if (!voiceGreetingPlayedForChatSession.has(greetKey)) {
              voiceGreetingPlayedForChatSession.add(greetKey)

              // Build enriched greeting with preloaded ecosystem context
              const digest = enrichedInstructions || ""
              const hasContext = digest.length > 100

              const greetingText = hasContext
                ? `You are Star World Assistant, the voice and chat assistant for the StarWORLD ecosystem. You have deep knowledge of the entire project loaded into your context — including smart contracts, data models, architecture entities, deployment addresses, and ecosystem components.

Greet the user warmly and briefly (under 120 characters). Mention that you have full knowledge of the StarWORLD ecosystem and are ready to help. Do NOT list capabilities — just greet and ask what they need. Never read URLs, file paths, wallet addresses, or UUIDs aloud.`
                : `You are Star World Assistant. Greet the user briefly — under 100 characters, no capability listing. If you know their name or role from context, use it. Just ask what they need. Do NOT call any tools — this is just a greeting. Never read URLs, file paths, wallet addresses, or UUIDs aloud — instead say the destination name and that a link is provided.`

              const greeting: any = {
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "system",
                  content: [
                    {
                      type: "input_text",
                      text: greetingText,
                    },
                  ],
                },
              }
              ws.send(JSON.stringify(greeting))
              ws.send(JSON.stringify({ type: "response.create" }))
              session.responseInProgress = true
            }
          }
          break

        case "session.updated":
          console.log("[openai-realtime] OpenAI session ready event: session.updated for session:", sessionId)
          break

        // Audio deltas (GA event names + legacy fallbacks)
        case "response.output_audio.delta":
        case "response.audio.delta":
          if (parsed.delta) onAudioDelta(parsed.delta)
          break

        // Text deltas (GA event names + legacy fallbacks)
        case "response.output_text.delta":
        case "response.text.delta":
          if (parsed.delta) onTextDelta(parsed.delta)
          break

        // Audio transcript deltas (GA event names + legacy fallbacks)
        //
        // CRITICAL: With output_modalities: ["audio"] the model generates only
        // audio, NOT text. The "audio_transcript" is an ASR transcription of
        // the generated speech. Send raw deltas — the client runs restoreWordSpacing
        // once when the full utterance is committed to chat.
        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta":
          if (parsed.delta) onTextDelta(parsed.delta)
          break

        // User transcription (GA event names + legacy fallbacks)
        case "conversation.item.input_audio_transcription.completed":
        case "conversation.item.input_audio_transcription.done":
        case "input_audio_transcription.completed":
        case "input_audio_buffer.transcription.completed": {
          const transcript = extractUserTranscript(parsed)
          if (transcript) {
            console.log("[openai-realtime] user transcript for session:", sessionId, "→", transcript.slice(0, 120))
            onUserTranscript?.(sanitizeAsrText(transcript))
            session.transcript.push(`[user] ${sanitizeAsrText(transcript)}`)
          }
          break
        }

        case "conversation.item.input_audio_transcription.delta":
        case "input_audio_transcription.delta": {
          const delta = typeof parsed.delta === "string" ? parsed.delta : ""
          if (delta) {
            console.log("[openai-realtime] user transcript delta for session:", sessionId, "→", delta.slice(0, 80))
          }
          break
        }

        case "conversation.item.done": {
          const item = parsed.item as Record<string, unknown> | undefined
          if (item?.role === "user") {
            const transcript = extractUserTranscript({ item })
            if (transcript) {
              console.log("[openai-realtime] user transcript (item.done) for session:", sessionId, "→", transcript.slice(0, 120))
              onUserTranscript?.(sanitizeAsrText(transcript))
              session.transcript.push(`[user] ${sanitizeAsrText(transcript)}`)
            }
          }
          break
        }

        case "input_audio_buffer.speech_started":
          console.log("[openai-realtime] VAD speech_started for session:", sessionId)
          break

        case "input_audio_buffer.speech_stopped":
          console.log("[openai-realtime] VAD speech_stopped for session:", sessionId)
          break

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
          if (/cancellation failed|no active response found/i.test(message)) {
            console.log("[openai-realtime] Benign cancel race for session:", sessionId, "—", message)
            session.responseInProgress = false
            break
          }
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
            // Generic error: reset the responseInProgress flag to prevent it
            // from getting stuck (e.g. after a failed input_image fetch).
            // Without this, the voice session goes completely silent — no
            // subsequent utterances or text injections can trigger a response.
            session.responseInProgress = false
            // Flush the pending queue so any queued injection retries
            setTimeout(() => {
              while (session.pendingResponseQueue.length > 0) {
                const next = session.pendingResponseQueue.shift()!
                next()
              }
            }, 500)
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

// Pre-session audio buffer — chunks may arrive before createRealtimeSession finishes.
const preSessionAudio = new Map<string, string[]>()
const PRE_SESSION_CAP = 256

export function sendAudioChunk(sessionId: string, base64: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) {
    const q = preSessionAudio.get(sessionId) ?? []
    if (q.length < PRE_SESSION_CAP) q.push(base64)
    preSessionAudio.set(sessionId, q)
    return true
  }

  const backlog = preSessionAudio.get(sessionId)
  if (backlog?.length) {
    preSessionAudio.delete(sessionId)
    for (const chunk of backlog) sendAudioChunk(sessionId, chunk)
  }

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

function extractUserTranscript(parsed: Record<string, unknown>): string {
  if (typeof parsed.transcript === "string" && parsed.transcript.trim()) {
    return parsed.transcript.trim()
  }
  const item = parsed.item as Record<string, unknown> | undefined
  if (item) {
    const inputTx = item.input_audio_transcription as Record<string, unknown> | undefined
    if (typeof inputTx?.transcript === "string" && inputTx.transcript.trim()) {
      return inputTx.transcript.trim()
    }
    const content = item.content
    if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as Record<string, unknown>
        if (typeof p.transcript === "string" && p.transcript.trim()) return p.transcript.trim()
      }
    }
  }
  return ""
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
    // Fire-and-forget: update wiki with session transcript before closing
    const transcriptText = session.transcript?.join("\n") || ""
    if (transcriptText.trim()) {
      updateWikiFromSession(sessionId, transcriptText).catch(console.error)
    }

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

/** Two-step lookup for the active Realtime session.
 *  Step 1: direct sessionId match (same socket — covers ~99% of usage).
 *  Step 2: userId-derived lookup via activeUserSessions (cross-socket fallback). */
export function getRealtimeSessionForUser(sessionId: string): RealtimeSession | undefined {
  const direct = sessions.get(sessionId)
  if (direct?.connected) return direct

  const userId = getUserIdFromSessionId(sessionId)
  if (!userId) return undefined

  const activeSessionId = activeUserSessions.get(userId)
  if (!activeSessionId || activeSessionId === sessionId) return undefined

  const fallback = sessions.get(activeSessionId)
  return fallback?.connected ? fallback : undefined
}

/** Cancel the current in-progress Realtime response for a session.
 *  Safe to call repeatedly — no-op if nothing is in progress. */
export function cancelRealtimeResponse(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session?.connected || !session.responseInProgress) return
  session.ws.send(JSON.stringify({ type: "response.cancel" }))
  session.responseInProgress = false
  const next = session.pendingResponseQueue.shift()
  if (next) next()
}

export function getRealtimeSessionVoice(sessionId: string): RealtimeVoiceId | undefined {
  return sessions.get(sessionId)?.outputVoice
}
