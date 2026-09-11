/**
 * Deepgram Voice Session Manager — parallel to openai-realtime.ts.
 *
 * Architecture:
 *   Browser Audio → Deepgram Live STT (Nova-3) → Text transcription
 *     → LLM Orchestrator (Ollama primary → Ollama fast → Cloud GPT-4o mini)
 *     → Tool Execution (same registry as OpenAI path)
 *     → Deepgram Aura-2 TTS → Audio back to browser
 *
 * Key differences from OpenAI Realtime path:
 *   - STT, LLM, and TTS are separate services (not a single WS)
 *   - LLM uses OpenAI-compatible chat/completions API (Ollama or cloud)
 *   - Tool calls are parsed from LLM text output (no native function calling in Ollama)
 *   - Audio buffering uses the shared AudioBuffer class
 *
 * Uses the `ws` npm package (not Bun native WebSocket) because Bun's native
 * WebSocket silently drops custom `Authorization` headers.
 *
 * @module deepgram-realtime
 */

import {
  createDeepgramSTTConnection,
  createDeepgramTTSConnection,
  isDeepgramEnabled,
  type DeepgramSTTConnection,
  type DeepgramTTSConnection,
  type DeepgramVoiceId,
} from "./deepgram-speech"
import { AudioBuffer, PreSessionAudioManager } from "./audio-buffer"
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
  googleSearch,
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
import {
  createTask,
  checkTaskStatus,
  voiceAskUserPickOne,
  voiceAskUserConfirm,
  delegateToAgent,
  createLinearChain,
  requestApproval,
  findRepoRoot,
  voiceOrchestratorToolDefinitions,
} from "./voice-orchestrator-tools"
import { bridge } from "../../../server/routes/nomadworks-bridge"
import { parseInput, resolveActions, formatParseSummary } from "./commands-router"
import { buildLifecycleDAG, executeDAG } from "../orchestrator/dag-engine"
import { apiPost } from "../orchestrator/starguard-client"
import type { DAGNode, DAGDefinition, ExecutionCallbacks } from "../orchestrator/types"
import { createMessage, createMessages, findMessagesBySession } from "../../../lib/tokidapp-queries"
import {
  onVoiceSessionEnd,
  type VoiceSessionEndReason,
} from "./voice-session-end"
import { openVoiceAgentSession } from "./voice-session-start"
import {
  openAiUsage,
  meterVoiceTurn,
  type ResolvedUsage,
} from "../../../lib/ai-usage"
import { getTokidappSocket, tokidappSessionId, getUserIdFromSessionId } from "../../../server/ws-socket-registry"
// knowledge-cache is used by the caller to build enrichedInstructions — no direct import needed here

// ── Environment Configuration ───────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434"
const OLLAMA_PRIMARY_MODEL = process.env.OLLAMA_PRIMARY_MODEL?.trim() || "llama3.1:8b"
const OLLAMA_FALLBACK_MODEL = process.env.OLLAMA_FALLBACK_MODEL?.trim() || "qwen3:8b"
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""
const CLOUD_MODEL = "gpt-4o-mini"

const PRIMARY_MODEL_TIMEOUT = parseInt(process.env.PRIMARY_MODEL_TIMEOUT || "15000", 10)
const FAST_FALLBACK_TIMEOUT = parseInt(process.env.FAST_FALLBACK_TIMEOUT || "10000", 10)
const CLOUD_FALLBACK_TIMEOUT = parseInt(process.env.CLOUD_FALLBACK_TIMEOUT || "10000", 10)

const WORKSPACE_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()
const STARGUARD_BASE = process.env.STARGUARD_BASE_URL || "https://star-worlds.vercel.app"

/** Default voice for Deepgram Aura-2 TTS. */
const DEFAULT_VOICE: DeepgramVoiceId = "aura-asteria-en"

// ── Tool Definitions (OpenAI function-calling format) ─────────

/**
 * Tool definitions in OpenAI function-calling format.
 * Used with Ollama and cloud LLMs that support tool use.
 * Same tool set as openai-realtime.ts for feature parity.
 */
const tools = [
  {
    type: "function" as const,
    name: "wait_for_user",
    description: "Call when audio is silence, background noise, or speech not addressed to you. Ends the turn without a spoken reply.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    type: "function" as const,
    name: "parse_commands",
    description: "Parse user input for commands, @agent mentions, [A→B: directives], pipeline syntax (A|B|C), and #tags. Returns structured interpretations you can act on. Call this FIRST when the user uses /commands, @mentions, [brackets], pipes, or any structured syntax.",
    parameters: {
      type: "object" as const,
      properties: {
        input: { type: "string" as const, description: "The full raw user input text to parse for commands" },
      },
      required: ["input"],
    },
  },
  {
    type: "function" as const,
    name: "investigate_codebase",
    description: "Search the codebase by filename or identifier. Use this when you need specific import paths, class names, function names, or TypeScript types.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "2-5 specific keywords or identifiers" },
      },
      required: ["query"],
    },
  },
  {
    type: "function" as const,
    name: "query_knowledge_base",
    description: "Query the StarCARD architecture knowledge base for entities (contracts, chains, venues, tokens, actors, diagrams).",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Free-text search (name, description, or keyword)" },
        domain: { type: "string" as const, description: "Filter by domain" },
        category: { type: "string" as const, description: "Filter by category" },
      },
    },
  },
  {
    type: "function" as const,
    name: "get_sepolia_deployments",
    description: "Get all known Sepolia testnet contract addresses for the StarCARD ecosystem.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    type: "function" as const,
    name: "run_tests",
    description: "Run the test suite and return pass/fail results with duration.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    type: "function" as const,
    name: "git_status",
    description: "Check current git branch, uncommitted changes, and recent commits.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    type: "function" as const,
    name: "generate_feature",
    description: "Create new pages, components, or API routes. Specify the type and name.",
    parameters: {
      type: "object" as const,
      properties: {
        prompt: { type: "string" as const, description: "Description of what to generate" },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function" as const,
    name: "git_commit_push",
    description: "Commit all staged changes and push to the current branch on the remote.",
    parameters: {
      type: "object" as const,
      properties: {
        commitMsg: { type: "string" as const, description: "Commit message describing the changes" },
      },
      required: ["commitMsg"],
    },
  },
  {
    type: "function" as const,
    name: "trigger_deploy",
    description: "Trigger a Vercel deployment via the configured deploy hook URL.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    type: "function" as const,
    name: "check_deploy_status",
    description: "Check the latest Vercel deployment status.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    type: "function" as const,
    name: "spawn_agent",
    description: "Spawn an OpenCode/OpenCoder/OpenAgent workspace for autonomous task execution.",
    parameters: {
      type: "object" as const,
      properties: {
        prompt: { type: "string" as const, description: "Description of the agent's task" },
        context: { type: "string" as const, description: "Context summary for the spawned agent" },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function" as const,
    name: "read_file",
    description: "Read a file or list a directory.",
    parameters: {
      type: "object" as const,
      properties: {
        filePath: { type: "string" as const, description: "Path to the file or directory" },
      },
      required: ["filePath"],
    },
  },
  {
    type: "function" as const,
    name: "vision_analyze",
    description: "Analyze an image using AI vision.",
    parameters: {
      type: "object" as const,
      properties: {
        imageUrl: { type: "string" as const, description: "URL of the image" },
        prompt: { type: "string" as const, description: "Question about the image" },
      },
      required: ["imageUrl"],
    },
  },
  {
    type: "function" as const,
    name: "run_lint",
    description: "Run the project linter and return error/warning counts.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    type: "function" as const,
    name: "run_typecheck",
    description: "Run TypeScript type checking (tsc --noEmit).",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    type: "function" as const,
    name: "web_search",
    description: "Search the web for current information using Tavily web search.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "The search query" },
        numResults: { type: "number" as const, description: "Number of results (1-10)" },
      },
      required: ["query"],
    },
  },
  {
    type: "function" as const,
    name: "read_wiki_page",
    description: "Read a wiki entity page from the StarCARD architecture wiki.",
    parameters: {
      type: "object" as const,
      properties: {
        pageName: { type: "string" as const, description: "Entity page name" },
      },
      required: ["pageName"],
    },
  },
  {
    type: "function" as const,
    name: "search_wiki",
    description: "Search the StarCARD architecture wiki by keyword.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search terms" },
      },
      required: ["query"],
    },
  },
  {
    type: "function" as const,
    name: "get_entity_connections",
    description: "Get all connections (wikilinks) for a wiki entity.",
    parameters: {
      type: "object" as const,
      properties: {
        pageName: { type: "string" as const, description: "Entity page name" },
      },
      required: ["pageName"],
    },
  },
  {
    type: "function" as const,
    name: "write_to_wiki",
    description: "Update a wiki entity page.",
    parameters: {
      type: "object" as const,
      properties: {
        pageName: { type: "string" as const, description: "Entity page name to update" },
        content: { type: "string" as const, description: "New content" },
        section: { type: "string" as const, description: "Optional section heading to target" },
      },
      required: ["pageName", "content"],
    },
  },
  {
    type: "function" as const,
    name: "lint_wiki",
    description: "Run a health check on the StarCARD architecture wiki.",
    parameters: { type: "object" as const, properties: {} },
  },
  {
    type: "function" as const,
    name: "generate_diagram",
    description: "Generate a Mermaid diagram from a text description.",
    parameters: {
      type: "object" as const,
      properties: {
        description: { type: "string" as const, description: "What diagram to generate" },
        diagramType: { type: "string" as const, description: "Optional Mermaid diagram type hint" },
      },
      required: ["description"],
    },
  },
  {
    type: "function" as const,
    name: "generate_file",
    description: "Generate a downloadable file.",
    parameters: {
      type: "object" as const,
      properties: {
        type: { type: "string" as const, enum: ["mermaid_svg", "document", "code"], description: "Type of file" },
        content: { type: "string" as const, description: "The content of the file" },
        fileName: { type: "string" as const, description: "Optional filename" },
        title: { type: "string" as const, description: "A short title" },
      },
      required: ["type", "content"],
    },
  },
  {
    type: "function" as const,
    name: "search_obsidian_vault",
    description: "Search the Obsidian vault for project documentation.",
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search terms" },
      },
      required: ["query"],
    },
  },
  {
    type: "function" as const,
    name: "read_obsidian_note",
    description: "Read a specific note from the Obsidian vault by its path.",
    parameters: {
      type: "object" as const,
      properties: {
        notePath: { type: "string" as const, description: "Path to the note" },
      },
      required: ["notePath"],
    },
  },
  ...voiceOrchestratorToolDefinitions,
]

// ── Tool Execution ─────────────────────────────────────────────

const TOOL_TIMEOUT_MS = 30_000

/**
 * Execute a tool call. Reuses the same logic as openai-realtime.ts's executeTool.
 * Extracted here to avoid circular imports while maintaining feature parity.
 */
async function executeTool(
  name: string,
  argsStr: string,
  config: {
    workspaceRoot: string
    starguardBase: string
    sessionId?: string
    sendFn?: (msg: string) => void
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
      case "get_sepolia_deployments":
        return await getSepoliaDeployments()
      case "run_tests":
        return await runTests(config.workspaceRoot)
      case "git_status":
        return await gitStatus(config.workspaceRoot)
      case "generate_feature": {
        const { prompt } = JSON.parse(argsStr)
        return await generateFeature(prompt, config.workspaceRoot)
      }
      case "git_commit_push": {
        const { commitMsg } = JSON.parse(argsStr)
        return await gitCommitPush(commitMsg, config.workspaceRoot, config.starguardBase)
      }
      case "trigger_deploy":
        return await triggerVercelDeploy(config.workspaceRoot)
      case "check_deploy_status":
        return await checkDeployStatus(config.workspaceRoot)
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
      case "rollback_deploy":
        return await rollbackDeploy()
      case "capture_git_diff":
        return await captureGitDiff(config.workspaceRoot)
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
        const fileResult = await generateFile({ type, content, fileName, title })
        return JSON.stringify({
          type: "generate_file_result",
          url: fileResult.url,
          fileName: fileResult.fileName,
          fileSize: fileResult.fileSize,
          mimeType: fileResult.mimeType,
          markdownContent: fileResult.markdownContent,
          text: `${fileResult.markdownContent}\n\n_File also available for download: ${fileResult.url}_`,
        })
      }
      case "web_search": {
        const { query, numResults } = JSON.parse(argsStr)
        return await googleSearch(query, numResults ?? 5)
      }
      case "parse_commands": {
        const { input } = JSON.parse(argsStr)
        const parseResult = parseInput(input)
        const actions = resolveActions(parseResult)
        return JSON.stringify({
          summary: formatParseSummary(parseResult),
          hasCommands: parseResult.hasCommands,
          tags: parseResult.tags,
          cleanText: parseResult.cleanText,
          actions: actions.map((a) => ({
            actionType: a.actionType,
            targetAgent: a.targetAgent,
            commandName: a.commandName,
            commandArgs: a.commandArgs,
            instruction: a.instruction,
            confidence: a.confidence,
            requiresConfirmation: a.requiresConfirmation,
          })),
        }, null, 2)
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
      case "lint_wiki":
        return await lintWiki()
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
      case "wiki_health":
        return await getWikiHealth()
      case "suggest_repairs":
        return await suggestRepairLinks()
      case "search_obsidian_vault": {
        const { query } = JSON.parse(argsStr)
        return await searchObsidianVault(query)
      }
      case "read_obsidian_note": {
        const { notePath } = JSON.parse(argsStr)
        return await readObsidianNote(notePath)
      }
      case "run_lint":
        return await runLint(config.workspaceRoot)
      case "run_typecheck":
        return await runTypeCheck(config.workspaceRoot)
      case "git_branch": {
        const { action, branchName } = JSON.parse(argsStr)
        return await gitBranchAction(action, branchName, config.workspaceRoot)
      }
      case "orchestrate": {
        const { intent, intentType = "QUERY_INFO" } = JSON.parse(argsStr)
        const orchSessionId = config.sessionId || `voice_${Date.now()}`
        const orchRes = await apiPost("/api/tokidapp/orchestrator", { sessionId: orchSessionId, voiceMode: true })
        if (!orchRes.ok) return "Failed to create orchestrator session."
        const orchestrator = await orchRes.json()
        const orchestratorId = orchestrator.id

        const { nodes } = buildLifecycleDAG(intentType, intent, {})
        const dag: DAGDefinition = {
          id: `dag_${Date.now()}`,
          nodes,
          createdAt: new Date().toISOString(),
        }

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
              onApprovalRequired: async () => "approved" as const,
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
              onNodeStart: () => {},
              onNodeComplete: () => {},
              onNodeFail: () => {},
              onApprovalRequired: async () => "approved" as const,
              onBroadcast: () => {},
              onLog: () => {},
              onCausalGraphUpdate: () => {},
            }

        const result = await executeDAG(orchestratorId, dag, callbacks)

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
        const sessionId = config.sessionId || `voice_${Date.now()}`
        const context: Record<string, unknown> = {}
        if (contextDescription) context.contextDescription = contextDescription
        context.source = "concierge-deepgram"
        context.sessionId = sessionId

        const result = await bridge.createTaskFile({
          intent,
          agentType,
          context,
          complexity,
          sessionId,
        })

        try {
          const userId = sessionId ? sessionId.replace(/^voice_/, "") : null
          if (userId) {
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
              bridge.watchTask(result.taskId, (msg) => socket.send(msg))
            }
          }
        } catch { /* non-critical */ }

        return `NomadWorks task created: ${result.taskId} (${agentType}, ${complexity}). Task file: ${result.taskFilePath}.`
      }
      case "create_task": {
        const params = JSON.parse(argsStr)
        const repoRoot = findRepoRoot(config.workspaceRoot)
        const result = await createTask(params, repoRoot)
        return JSON.stringify(result)
      }
      case "check_task_status": {
        const { taskId } = JSON.parse(argsStr)
        const repoRoot = findRepoRoot(config.workspaceRoot)
        const result = await checkTaskStatus(taskId, repoRoot)
        return JSON.stringify(result)
      }
      case "ask_user_pick_one": {
        const params = JSON.parse(argsStr)
        if (!config.sendFn) return JSON.stringify({ status: "error", message: "No send function available" })
        return await voiceAskUserPickOne(params, config.sendFn)
      }
      case "ask_user_confirm": {
        const params = JSON.parse(argsStr)
        if (!config.sendFn) return JSON.stringify({ status: "error", message: "No send function available" })
        return await voiceAskUserConfirm(params, config.sendFn)
      }
      case "delegate_to_agent": {
        const params = JSON.parse(argsStr)
        const repoRoot = findRepoRoot(config.workspaceRoot)
        const result = await delegateToAgent(params, repoRoot, config.starguardBase)
        return JSON.stringify(result)
      }
      case "create_linear_chain": {
        const { intent } = JSON.parse(argsStr)
        const result = createLinearChain({ intent })
        return JSON.stringify(result)
      }
      case "request_approval": {
        const params = JSON.parse(argsStr)
        if (!config.sendFn) return JSON.stringify({ status: "error", message: "No send function available" })
        const result = await requestApproval(params, config.sendFn)
        return JSON.stringify(result)
      }
      default:
        return `Unknown tool: ${name}`
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}

// ── LLM Orchestrator — Fallback Chain ──────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  tool_call_id?: string
  name?: string
}

interface ToolCall {
  id: string
  name: string
  arguments: string
}

interface LLMResponse {
  content: string
  toolCalls: ToolCall[]
  model: string
  latencyMs: number
  /** Provider-reported token counts, when the provider reported any. */
  usage?: ResolvedUsage | null
}

interface LLMProvider {
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs: number
}

/**
 * Build the LLM provider chain: Ollama primary → Ollama fast → Cloud GPT-4o mini.
 */
function buildProviderChain(): LLMProvider[] {
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

  // Only add cloud fallback if API key is available
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

/**
 * Call a single LLM provider with OpenAI-compatible chat/completions API.
 */
async function callLLMProvider(
  provider: LLMProvider,
  messages: ChatMessage[],
  toolDefs: typeof tools,
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

    const data = await res.json() as any
    const choice = data.choices?.[0]
    if (!choice) throw new Error("No choices in response")

    const message = choice.message
    const content = typeof message?.content === "string" ? message.content : ""

    // Parse tool calls from the response
    const toolCalls: ToolCall[] = []
    if (Array.isArray(message?.tool_calls)) {
      for (const tc of message.tool_calls) {
        if (tc.type === "function" && tc.function?.name) {
          toolCalls.push({
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: tc.function.name,
            arguments: typeof tc.function.arguments === "string"
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
      usage: openAiUsage(data),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Call LLM with automatic fallback chain. Tries each provider in order;
 * on timeout or connection error, falls through to the next.
 */
async function callLLMWithFallback(
  messages: ChatMessage[],
  toolDefs: typeof tools,
): Promise<LLMResponse> {
  const chain = buildProviderChain()
  let lastError: Error | null = null

  for (const provider of chain) {
    try {
      console.log(`[deepgram-realtime] Trying LLM provider: ${provider.name} (${provider.model})`)
      const response = await callLLMProvider(provider, messages, toolDefs)
      console.log(
        `[deepgram-realtime] LLM response from ${provider.name}:`,
        `latency=${response.latencyMs}ms, content=${response.content.length} chars, toolCalls=${response.toolCalls.length}`
      )
      return response
    } catch (err) {
      const error = err as Error
      const isAbort = error.name === "AbortError"
      console.warn(
        `[deepgram-realtime] LLM provider ${provider.name} failed:`,
        isAbort ? `timeout after ${provider.timeoutMs}ms` : error.message
      )
      lastError = error
      // Continue to next provider
    }
  }

  // All providers failed — return a graceful error response
  const errorMsg = lastError
    ? `All LLM providers failed. Last error: ${lastError.message}`
    : "No LLM providers available"
  console.error(`[deepgram-realtime] ${errorMsg}`)
  return {
    content: "I'm having trouble connecting to my language model right now. Please try again in a moment.",
    toolCalls: [],
    model: "none",
    latencyMs: 0,
  }
}

// ── Handover Detection ─────────────────────────────────────────

/** Patterns that indicate the user wants to hand off to another agent. */
const HANDOVER_PATTERNS = [
  /hand\s+(?:over|off|to)\s+(?:the\s+)?(.+?)(?:\s+agent)?$/i,
  /(?:transfer|delegate)\s+(?:to|the)\s+(.+?)(?:\s+agent)?$/i,
  /(?:speak|talk)\s+with\s+(?:the\s+)?(.+?)(?:\s+agent)?$/i,
  /(?:connect|route)\s+(?:me\s+)?(?:to\s+)?(?:the\s+)?(.+?)(?:\s+agent)?$/i,
]

interface HandoverDetection {
  isHandover: boolean
  targetAgent?: string
  originalText: string
}

function detectHandover(text: string): HandoverDetection {
  const trimmed = text.trim()
  for (const pattern of HANDOVER_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match?.[1]) {
      return {
        isHandover: true,
        targetAgent: match[1].trim(),
        originalText: trimmed,
      }
    }
  }
  return { isHandover: false, originalText: trimmed }
}

// ── Session Types ──────────────────────────────────────────────

/** System message role for conversation context. */
type MessageRole = "system" | "user" | "assistant"

interface ConversationMessage {
  role: MessageRole
  content: string
  timestamp: number
}

export interface DeepgramSession {
  /** Unique session identifier (e.g. "voice_<userId>"). */
  sessionId: string
  /** Timestamp when the session was created. */
  createdAt: number
  /** Whether the session is currently active. */
  connected: boolean
  /** Deepgram STT connection. */
  stt: DeepgramSTTConnection
  /** Deepgram TTS connection. */
  tts: DeepgramTTSConnection
  /** Audio buffer for incoming STT audio. */
  audioBuffer: AudioBuffer
  /** Full conversation history for LLM context. */
  conversation: ConversationMessage[]
  /** Transcript lines for post-session wiki update. */
  transcript: string[]
  /** TTS voice. */
  voice: DeepgramVoiceId
  /** Whether a response is currently being generated. */
  responseInProgress: boolean
  /** Pending text injections from voice-chat union. */
  pendingTextInjections: string[]
  /** Total LLM calls made in this session. */
  llmCallCount: number
  /** Which LLM provider was last used. */
  lastModelUsed: string
  /** Send a message to the frontend client WebSocket. */
  sendToClient?: (msg: string) => void
  /** StarWorld / chat-html DB session ID. */
  chatSessionId?: string
  /** Optional enriched instructions appended to system prompt. */
  enrichedInstructions?: string
  /** TokiDAPPAgentSession row opened at connect, closed at teardown. */
  agentSessionId?: string
}

const sessions = new Map<string, DeepgramSession>()

/** TokiDAPP chat sessions that already received the opening voice greeting. */
const voiceGreetingPlayedForChatSession = new Set<string>()

// ── System Prompt Builder ──────────────────────────────────────

/**
 * Build the system prompt for the LLM. Mirrors VOICE_INSTRUCTIONS from
 * speech-sanitize.ts but adapted for chat/completions format.
 */
function buildSystemPrompt(enrichedInstructions?: string): string {
  const base = enrichedInstructions
    ? VOICE_INSTRUCTIONS + "\n\n" + enrichedInstructions
    : VOICE_INSTRUCTIONS

  return base + "\n\n# Tool Call Format\n" +
    "When you need to use a tool, respond with a JSON tool_call in your message. " +
    'Format: [{"name": "tool_name", "arguments": {"param": "value"}}]. ' +
    "Only call one tool at a time. After receiving the tool result, continue your response."
}

/**
 * Build the greeting message for a new session.
 */
function buildGreeting(enrichedInstructions?: string, chatSessionId?: string): string {
  const digest = enrichedInstructions || ""
  const hasContext = digest.length > 100

  return hasContext
    ? `You are Star World Assistant, the voice and chat assistant for the StarWORLD ecosystem. You have deep knowledge of the entire project loaded into your context — including smart contracts, data models, architecture entities, deployment addresses, and ecosystem components.

Greet the user warmly and briefly (under 120 characters). Mention that you have full knowledge of the StarWORLD ecosystem and are ready to help. Do NOT list capabilities — just greet and ask what they need. Never read URLs, file paths, wallet addresses, or UUIDs aloud.`
    : `You are Star World Assistant. Greet the user briefly — under 100 characters, no capability listing. If you know their name or role from context, use it. Just ask what they need. Do NOT call any tools — this is just a greeting. Never read URLs, file paths, wallet addresses, or UUIDs aloud — instead say the destination name and that a link is provided.`
}

// ── Session Factory ────────────────────────────────────────────

export interface CreateDeepgramSessionParams {
  /** Session ID (typically "voice_<userId>"). */
  sessionId: string
  /** Callback for TTS audio deltas (base64 PCM chunks). */
  onAudioDelta: (base64: string) => void
  /** Callback for text deltas (assistant text or user transcript). */
  onTextDelta: (text: string) => void
  /** Callback for errors. */
  onError: (error: string) => void
  /** Callback when session is ready for audio input. */
  onReady?: () => void
  /** Callback for user speech transcript (ASR output). */
  onUserTranscript?: (text: string) => void
  /** Callback when a response generation is complete. */
  onResponseDone?: () => void
  /** TTS voice override. */
  voice?: DeepgramVoiceId
  /** User ID for safety tracking. */
  userId?: string
  /** Enriched instructions (architecture digest, etc.). */
  enrichedInstructions?: string
  /** StarWorld chat session ID for greeting dedup. */
  chatSessionId?: string
  /** Send messages to the frontend client WebSocket. */
  sendToClient?: (msg: string) => void
}

/**
 * Create a new Deepgram voice session.
 *
 * Initializes STT + TTS connections via S1 modules, sets up the LLM
 * orchestrator with fallback chain, and returns a session handle.
 *
 * @param params - Session configuration
 * @returns DeepgramSession handle with sendAudio(), sendMessage(), destroy()
 */
export async function createDeepgramSession(
  params: CreateDeepgramSessionParams,
): Promise<DeepgramSession> {
  const {
    sessionId,
    onAudioDelta,
    onTextDelta,
    onError,
    onReady,
    onUserTranscript,
    onResponseDone,
    voice = DEFAULT_VOICE,
    userId,
    enrichedInstructions,
    chatSessionId,
    sendToClient,
  } = params

  if (!isDeepgramEnabled()) {
    const msg = "Deepgram is not enabled. Set DEEPGRAM_ENABLED=true and DEEPGRAM_API_KEY in .env."
    console.error("[deepgram-realtime]", msg)
    onError(msg)
    // Return a stub session that never connects
    const stubSTT = createDeepgramSTTConnection({})
    const stubTTS = createDeepgramTTSConnection(voice)
    const session: DeepgramSession = {
      sessionId,
      connected: false,
      stt: stubSTT,
      tts: stubTTS,
      audioBuffer: new AudioBuffer({ label: `dg-stub-${sessionId}` }),
      conversation: [],
      transcript: [],
      voice,
      responseInProgress: false,
      pendingTextInjections: [],
      llmCallCount: 0,
      lastModelUsed: "none",
      createdAt: Date.now(),
    }
    return session
  }

  // Build system prompt
  const systemPrompt = buildSystemPrompt(enrichedInstructions)

  // Initialize conversation with system message
  // Load previous conversation for cross-session continuity
  let previousMessages: Array<{ role: string; content: string }> = []
  if (chatSessionId) {
    try {
      const dbMessages = await findMessagesBySession(sessionId)
      previousMessages = dbMessages
        .filter(m => m.role === "user" || m.role === "assistant")
        .slice(-50) // Last 50 messages for LLM context
        .map(m => ({ role: m.role, content: m.content }))
      console.log(`[deepgram-realtime] Loaded ${previousMessages.length} previous messages for session ${sessionId}`)
    } catch (err) {
      console.error("[deepgram-realtime] Failed to load previous messages:", err)
    }
  }

  // Initialize conversation with system message + previous context
  const conversation: ConversationMessage[] = [
    { role: "system", content: systemPrompt, timestamp: Date.now() },
    ...previousMessages.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content,
      timestamp: Date.now(), // Approximate timestamp for historical messages
    })),
  ]

  // Create audio buffer
  const audioBuffer = new AudioBuffer({
    label: `dg-stt-${sessionId}`,
    minBytes: 4800, // 100ms minimum
  })

  // Track whether greeting has been sent for this chat session
  const greetKey = (chatSessionId || "").trim() || sessionId

  // Create Deepgram STT connection
  const stt = createDeepgramSTTConnection({
    onTranscript: (text, isFinal) => {
      if (!isFinal) return // Only process final transcripts

      const sanitized = sanitizeAsrText(text)
      if (!sanitized.trim()) return

      console.log("[deepgram-realtime] User transcript:", sanitized.slice(0, 120))

      // Notify callbacks
      onUserTranscript?.(sanitized)
      session.transcript.push(`[user] ${sanitized}`)

      // Add to conversation context
      session.conversation.push({
        role: "user",
        content: sanitized,
        timestamp: Date.now(),
      })

      // Persist user message to DB (fire-and-forget)
      if (session.chatSessionId) {
        const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        createMessage({ id: msgId, sessionId: session.chatSessionId!, role: "user", content: sanitized }).catch((err) => {
          console.error("[deepgram-realtime] Failed to persist user transcript:", err.message)
        })
      }

      // Process through LLM (non-blocking)
      processUserMessage(session, sanitized, onAudioDelta, onTextDelta, onError, onResponseDone)
    },
    onUtteranceEnd: () => {
      console.log("[deepgram-realtime] Utterance end for session:", sessionId)
    },
    onError: (err) => {
      console.error("[deepgram-realtime] STT error:", err.message)
      onError(`STT error: ${err.message}`)
    },
    onClose: (code) => {
      console.log("[deepgram-realtime] STT closed, code:", code)
      if (code !== 1000) {
        // Abnormal close — try to reconnect
        console.warn("[deepgram-realtime] STT abnormal close, session may need recreation")
      }
    },
  })

  // Create Deepgram TTS connection
  const tts = createDeepgramTTSConnection(voice, {
    onAudio: (base64Chunk) => {
      onAudioDelta(base64Chunk)
    },
    onFlushed: () => {
      // Audio flush complete
    },
    onError: (err) => {
      console.error("[deepgram-realtime] TTS error:", err.message)
      onError(`TTS error: ${err.message}`)
    },
    onClose: (code) => {
      console.log("[deepgram-realtime] TTS closed, code:", code)
    },
  })

  // Build session object
  const session: DeepgramSession = {
    sessionId,
    connected: true,
    stt,
    tts,
    audioBuffer,
    conversation,
    transcript: [],
    voice,
    responseInProgress: false,
    pendingTextInjections: [],
    llmCallCount: 0,
    lastModelUsed: "none",
    sendToClient,
    chatSessionId,
    enrichedInstructions,
    createdAt: Date.now(),
  }

  sessions.set(sessionId, session)
  console.log("[deepgram-realtime] Session created:", sessionId, "voice:", voice)

  // Open the accounting row alongside the session. Fire-and-forget.
  // model stays null: this engine resolves its LLM per turn through a fallback
  // chain, so there is no single model to name at connect.
  void openVoiceAgentSession({
    chatSessionId,
    engine: "deepgram",
  }).then((agentSessionId) => {
    if (agentSessionId) session.agentSessionId = agentSessionId
  })

  // Play greeting
  if (!voiceGreetingPlayedForChatSession.has(greetKey)) {
    voiceGreetingPlayedForChatSession.add(greetKey)

    const greetingText = buildGreeting(enrichedInstructions, chatSessionId)
    // Add greeting to conversation and synthesize via TTS
    session.conversation.push({
      role: "assistant",
      content: greetingText,
      timestamp: Date.now(),
    })
    session.transcript.push(`[assistant] ${sanitizeSpeechText(greetingText)}`)

    // Send greeting text to client
    onTextDelta(greetingText)
    // Synthesize greeting audio
    tts.speak(greetingText)
    tts.flush()

    // Signal ready after greeting audio is sent
    setTimeout(() => onReady?.(), 200)
  } else {
    // No greeting needed — signal ready immediately
    onReady?.()
  }

  // Expose session methods via the object
  const sessionWithMethods = session as DeepgramSession & {
    sendAudio: (base64Chunk: string) => void
    sendMessage: (text: string) => void
    destroy: () => void
    injectText: (text: string) => void
  }

  /**
   * Send an audio chunk to Deepgram STT for transcription.
   */
  sessionWithMethods.sendAudio = (base64Chunk: string) => {
    if (!session.connected) {
      console.warn("[deepgram-realtime] sendAudio dropped — session not connected")
      return
    }
    audioBuffer.addChunk(base64Chunk)
    stt.sendAudio(base64Chunk)
  }

  /**
   * Send a text message directly to the LLM (voice-chat union).
   * Bypasses STT — text is injected as a user message.
   */
  sessionWithMethods.sendMessage = (text: string) => {
    if (!session.connected) {
      console.warn("[deepgram-realtime] sendMessage dropped — session not connected")
      return
    }

    const sanitized = text.trim()
    if (!sanitized) return

    console.log("[deepgram-realtime] Text injection:", sanitized.slice(0, 120))

    // Add to conversation context
    session.conversation.push({
      role: "user",
      content: sanitized,
      timestamp: Date.now(),
    })
    session.transcript.push(`[user:text] ${sanitized}`)

    // Process through LLM
    processUserMessage(session, sanitized, onAudioDelta, onTextDelta, onError, onResponseDone)
  }

  /**
   * Inject text into the conversation context without triggering LLM processing.
   * Used for text typed during voice sessions that should be visible in context
   * but not immediately responded to.
   */
  sessionWithMethods.injectText = (text: string) => {
    const sanitized = text.trim()
    if (!sanitized) return
    session.pendingTextInjections.push(sanitized)
  }

  /**
   * Destroy the session — close STT/TTS connections, clean up state.
   */
  sessionWithMethods.destroy = (reason: VoiceSessionEndReason = "complete") => {
    finishDeepgramSession(sessionId, reason, userId)
  }

  return sessionWithMethods as DeepgramSession
}

// ── LLM Processing Pipeline ────────────────────────────────────

/**
 * Process a user message through the full LLM pipeline:
 * 1. Build conversation context
 * 2. Call LLM with fallback chain
 * 3. Parse tool calls if any
 * 4. Execute tools and feed results back
 * 5. Synthesize final response via TTS
 */
async function processUserMessage(
  session: DeepgramSession,
  userText: string,
  onAudioDelta: (base64: string) => void,
  onTextDelta: (text: string) => void,
  onError: (error: string) => void,
  onResponseDone?: () => void,
): Promise<void> {
  if (session.responseInProgress) {
    console.log("[deepgram-realtime] Response already in progress, queuing for session:", session.sessionId)
    session.pendingTextInjections.push(userText)
    return
  }

  session.responseInProgress = true

  try {
    // Inject any pending text injections into context
    while (session.pendingTextInjections.length > 0) {
      const injection = session.pendingTextInjections.shift()!
      session.conversation.push({
        role: "user",
        content: injection,
        timestamp: Date.now(),
      })
    }

    // Check for handover request
    const handover = detectHandover(userText)
    if (handover.isHandover && handover.targetAgent) {
      console.log("[deepgram-realtime] Handover detected to:", handover.targetAgent)
      const handoverResult = await handleHandover(session, handover.targetAgent)
      session.conversation.push({
        role: "assistant",
        content: handoverResult,
        timestamp: Date.now(),
      })
      session.transcript.push(`[assistant] ${sanitizeSpeechText(handoverResult)}`)
      onTextDelta(handoverResult)
      session.tts.speak(handoverResult)
      session.tts.flush()
      session.responseInProgress = false
      onResponseDone?.()
      return
    }

    // Build messages for LLM (include only recent context to avoid token limits)
    const maxContextMessages = 30
    const recentConversation = session.conversation.slice(-maxContextMessages)
    const llmMessages: ChatMessage[] = recentConversation.map((m) => ({
      role: m.role,
      content: m.content,
    }))

    // Call LLM with fallback
    const llmResponse = await callLLMWithFallback(llmMessages, tools)
    session.llmCallCount++
    session.lastModelUsed = llmResponse.model

    // Model comes off the response, not the session — the fallback chain may
    // have landed on a different provider than the previous turn did.
    // No requestId — deliberately. See resolveRequestId in lib/ai-usage: a
    // fetch reply has no redelivery path, and this chain's primary provider
    // numbers responses `chatcmpl-<0..999>`, which as a key would collide
    // within tens of turns and read as "already recorded".
    meterVoiceTurn({
      ctx: session,
      modelId: llmResponse.model,
      provider: "deepgram",
      usage: llmResponse.usage,
      promptText: llmMessages.map((m) => m.content).join("\n"),
      completionText: llmResponse.content,
    })

    // Process tool calls if any
    if (llmResponse.toolCalls.length > 0) {
      // Add assistant message with tool calls to conversation
      const assistantContent = llmResponse.content || ""
      if (assistantContent) {
        session.conversation.push({
          role: "assistant",
          content: assistantContent,
          timestamp: Date.now(),
        })

        // Persist assistant response to DB (fire-and-forget)
        if (session.chatSessionId) {
          const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          createMessage({ id: msgId, sessionId: session.chatSessionId!, role: "assistant", content: assistantContent }).catch((err) => {
            console.error("[deepgram-realtime] Failed to persist assistant response:", err.message)
          })
        }

        session.transcript.push(`[assistant] ${sanitizeSpeechText(assistantContent)}`)
        onTextDelta(assistantContent)
      }

      // Execute each tool call
      for (const toolCall of llmResponse.toolCalls) {
        console.log("[deepgram-realtime] Tool call:", toolCall.name)

        const toolResult = await Promise.race([
          executeTool(toolCall.name, toolCall.arguments, {
            workspaceRoot: WORKSPACE_ROOT,
            starguardBase: STARGUARD_BASE,
            sessionId: session.sessionId,
            sendFn: (msg: string) => session.sendToClient?.(msg),
          }),
          new Promise<string>((resolve) =>
            setTimeout(
              () => resolve(JSON.stringify({
                error: true,
                type: "timeout",
                message: `Tool "${toolCall.name}" timed out after ${TOOL_TIMEOUT_MS / 1000}s.`,
              })),
              TOOL_TIMEOUT_MS,
            ),
          ),
        ])

        // Add tool result to conversation context
        session.conversation.push({
          role: "assistant" as MessageRole,
          content: `[Tool Result: ${toolCall.name}]\n${toolResult.slice(0, 2000)}`,
          timestamp: Date.now(),
        })

        // Persist tool result to DB (fire-and-forget)
        if (session.chatSessionId) {
          const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          createMessage({ id: msgId, sessionId: session.chatSessionId!, role: "tool", content: `[Tool Result: ${toolCall.name}]\n${toolResult.slice(0, 500)}` }).catch((err) => {
            console.error("[deepgram-realtime] Failed to persist tool result:", err.message)
          })
        }

        // Send tool result to client for UI rendering
        try {
          const parsedResult = JSON.parse(toolResult)
          if (parsedResult.type === "builder" && parsedResult.content) {
            session.sendToClient?.(JSON.stringify({
              type: "tool_result",
              id: toolCall.id,
              tool: toolCall.name,
              status: "complete",
              summary: parsedResult.title || "Generated UI",
              uiResource: {
                type: "builder",
                content: JSON.stringify(parsedResult.content),
                title: parsedResult.title,
              },
            }))
          } else if (parsedResult.type === "generate_file_result") {
            session.sendToClient?.(JSON.stringify({
              type: "tool_result",
              id: toolCall.id,
              tool: toolCall.name,
              status: "complete",
              summary: `Generated file: ${parsedResult.fileName}`,
              generatedFiles: [{
                url: parsedResult.url,
                fileName: parsedResult.fileName,
                fileSize: parsedResult.fileSize || 0,
                mimeType: parsedResult.mimeType || "text/plain",
              }],
            }))
          }
        } catch {
          // Not a structured result — continue
        }
      }

      // After tool execution, call LLM again to generate final response
      const followUpMessages: ChatMessage[] = session.conversation.slice(-maxContextMessages).map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      }))

      const followUpResponse = await callLLMWithFallback(followUpMessages, tools)
      session.llmCallCount++

      // The post-tool synthesis is a second billable generation, not part of the first.
      meterVoiceTurn({
        ctx: session,
        modelId: followUpResponse.model,
        provider: "deepgram",
        eventType: "TOOL_CALL",
        usage: followUpResponse.usage,
        promptText: followUpMessages.map((m) => m.content).join("\n"),
        completionText: followUpResponse.content,
      })

      if (followUpResponse.content) {
        session.conversation.push({
          role: "assistant",
          content: followUpResponse.content,
          timestamp: Date.now(),
        })
        session.transcript.push(`[assistant] ${sanitizeSpeechText(followUpResponse.content)}`)
        onTextDelta(followUpResponse.content)

        // Synthesize speech
        session.tts.speak(followUpResponse.content)
        session.tts.flush()
      }
    } else if (llmResponse.content) {
      // No tool calls — just text response
      session.conversation.push({
        role: "assistant",
        content: llmResponse.content,
        timestamp: Date.now(),
      })

      // Persist assistant response to DB (fire-and-forget)
      if (session.chatSessionId) {
        const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        createMessage({ id: msgId, sessionId: session.chatSessionId!, role: "assistant", content: llmResponse.content }).catch((err) => {
          console.error("[deepgram-realtime] Failed to persist assistant text response:", err.message)
        })
      }

      session.transcript.push(`[assistant] ${sanitizeSpeechText(llmResponse.content)}`)
      onTextDelta(llmResponse.content)

      // Synthesize speech
      session.tts.speak(llmResponse.content)
      session.tts.flush()
    }
  } catch (err) {
    const errorMsg = `Error processing message: ${(err as Error).message}`
    console.error("[deepgram-realtime]", errorMsg)
    onError(errorMsg)

    // Try to speak the error
    try {
      session.tts.speak("I encountered an error processing that. Please try again.")
      session.tts.flush()
    } catch { /* non-critical */ }
  } finally {
    session.responseInProgress = false
    onResponseDone?.()
  }
}

// ── Agent Handover ─────────────────────────────────────────────

/**
 * Handle agent handover request. Creates a NomadWorks task and preserves
 * conversation context for the target agent.
 */
async function handleHandover(
  session: DeepgramSession,
  targetAgent: string,
): Promise<string> {
  console.log("[deepgram-realtime] Handing over to agent:", targetAgent)

  // Build context from conversation
  const conversationSummary = session.conversation
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(-2000)

  // Create NomadWorks task for the handover
  try {
    const result = await bridge.createTaskFile({
      intent: `Voice handover from Deepgram session ${session.sessionId} to ${targetAgent}`,
      agentType: targetAgent.toLowerCase().replace(/\s+/g, "_"),
      context: {
        conversationHistory: conversationSummary,
        source: "deepgram-voice-handover",
        sessionId: session.sessionId,
      },
      complexity: "standard",
      sessionId: session.sessionId,
    })

    return `I've handed this conversation over to the ${targetAgent}. ` +
      `They have the full conversation context. ` +
      `Task ${result.taskId} has been created. ` +
      `Is there anything else you'd like me to help with while they work?`
  } catch (err) {
    console.error("[deepgram-realtime] Handover failed:", err)
    return `I tried to hand over to the ${targetAgent}, but encountered an issue. ` +
      `Let me continue helping you directly. What do you need?`
  }
}

// ── Session Management ─────────────────────────────────────────

export function getDeepgramSession(sessionId: string): DeepgramSession | undefined {
  return sessions.get(sessionId)
}

function finishDeepgramSession(
  sessionId: string,
  reason: VoiceSessionEndReason = "complete",
  userId?: string,
): void {
  const session = sessions.get(sessionId)
  if (!session) return

  onVoiceSessionEnd({
    sessionId,
    engine: "deepgram",
    transcript: session.transcript,
    chatSessionId: session.chatSessionId,
    userId,
    agentSessionId: session.agentSessionId,
    durationMs: Date.now() - session.createdAt,
    reason,
  })

  session.connected = false
  try {
    session.stt.close()
  } catch {
    /* ignore */
  }
  try {
    session.tts.close()
  } catch {
    /* ignore */
  }
  session.audioBuffer.reset()
  sessions.delete(sessionId)
}

export function endDeepgramSession(
  sessionId: string,
  reason: VoiceSessionEndReason = "complete",
): void {
  const session = sessions.get(sessionId) as
    | (DeepgramSession & { destroy?: (r?: VoiceSessionEndReason) => void })
    | undefined
  if (session?.destroy) {
    session.destroy(reason)
    return
  }
  finishDeepgramSession(sessionId, reason)
}

export function hasActiveDeepgramSession(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  return !!session?.connected
}

/** Get count of active Deepgram sessions. */
export function getActiveDeepgramSessionCount(): number {
  let count = 0
  for (const session of sessions.values()) {
    if (session.connected) count++
  }
  return count
}

// ── Pre-session Audio Manager (exported for WS handler) ────────

export const preSessionAudio = new PreSessionAudioManager(256)
