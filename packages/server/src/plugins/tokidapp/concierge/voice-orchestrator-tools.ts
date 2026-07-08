/**
 * Voice Orchestrator Tools — Task creation, status checking, and ClickFlow
 * integration for the OpenAI Realtime voice agent.
 *
 * Phase 1a: ClickFlow tools (ask_user_pick_one, ask_user_confirm)
 * Phase 1b: Task tools (create_task, check_task_status)
 *
 * All tools follow the non-blocking pattern for ClickFlow:
 *   1. Tool sends interactive prompt to client via WS
 *   2. Tool returns immediately with structured result
 *   3. User responds via UI (taps ClickFlow prompt)
 *   4. Response routed back via existing interactive_response WS message
 *   5. Server resolves the prompt waiter
 *   6. Follow-up message injects response into Realtime session
 *
 * @module voice-orchestrator-tools
 */

import { randomUUID } from "crypto"
import { readFile, writeFile, mkdir } from "fs/promises"
import { join, dirname } from "path"
import {
  createPrompt,
  type InteractivePromptOption,
} from "./interactive-session"
import {
  askUserPickOne,
  askUserConfirm,
  type PickOneParams,
  type ConfirmParams,
} from "./interactive-tools"

// ── Types ─────────────────────────────────────────────────────

export interface CreateTaskParams {
  title: string
  description?: string
  complexity?: "tiny" | "standard" | "complex"
  track?: "implementation" | "investigation" | "spec"
  slice?: string
  assignee?: string
  priority?: number
  scrId?: string
}

export interface CreateTaskResult {
  taskId: string
  title: string
  complexity: string
  track: string
  slice: string
  status: "created"
  filePath: string
}

export interface CheckTaskStatusParams {
  taskId: string
}

export interface CheckTaskStatusResult {
  taskId: string
  title: string
  status: string
  complexity: string
  track: string
  slice: string
  assignee: string
  createdAt: string
}

// ── Helpers ───────────────────────────────────────────────────

/** Find the repo root by walking up from the working directory */
export function findRepoRoot(startDir: string): string {
  let dir = startDir
  while (dir !== "/") {
    try {
      const fs = require("fs")
      if (fs.existsSync(join(dir, "tasks")) && fs.existsSync(join(dir, ".git"))) {
        return dir
      }
    } catch {}
    dir = dirname(dir)
  }
  return startDir
}

/** Generate a task ID from title */
function generateTaskId(title: string): string {
  const date = new Date().toISOString().split("T")[0] // YYYY-MM-DD
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
  return `TASK-${date}-voice-${slug}`
}

/** Generate task file frontmatter */
function generateTaskFrontmatter(params: CreateTaskParams, taskId: string): string {
  const now = new Date().toISOString().split("T")[0]
  const lines = [
    "---",
    `id: ${taskId}`,
    `title: "${params.title}"`,
    `complexity: ${params.complexity || "standard"}`,
    `track: ${params.track || "implementation"}`,
    `slice: ${params.slice || "core"}`,
    `scr_id: ${params.scrId || "SCR-2026-07-08-001"}`,
    `created: ${now}`,
    `status: Active`,
    `created_by: voice`,
  ]
  if (params.assignee) lines.push(`assignee: ${params.assignee}`)
  if (params.priority) lines.push(`priority: ${params.priority}`)
  lines.push("---")
  return lines.join("\n")
}

// ── Tool: create_task ─────────────────────────────────────────

/**
 * Create a task file with structured parameters.
 * Writes to tasks/todo/<task-id>.md with proper frontmatter.
 */
export async function createTask(
  params: CreateTaskParams,
  repoRoot: string,
): Promise<CreateTaskResult> {
  const taskId = generateTaskId(params.title)
  const frontmatter = generateTaskFrontmatter(params, taskId)
  const filePath = join(repoRoot, "tasks", "todo", `${taskId}.md`)

  const content = `${frontmatter}

# ${params.title}

${params.description || `${params.title} — voice-created task`}

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
- [ ] Documentation updated
`

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, "utf-8")

  return {
    taskId,
    title: params.title,
    complexity: params.complexity || "standard",
    track: params.track || "implementation",
    slice: params.slice || "core",
    status: "created",
    filePath: `tasks/todo/${taskId}.md`,
  }
}

// ── Tool: check_task_status ───────────────────────────────────

/**
 * Check the status of a task by reading its frontmatter.
 */
export async function checkTaskStatus(
  taskId: string,
  repoRoot: string,
): Promise<CheckTaskStatusResult> {
  // Search in todo, done, and blocked directories
  const dirs = ["todo", "done", "blocked"]
  for (const dir of dirs) {
    const filePath = join(repoRoot, "tasks", dir, `${taskId}.md`)
    try {
      const content = await readFile(filePath, "utf-8")
      return parseTaskFrontmatter(content, taskId)
    } catch {
      // Not in this directory, try next
    }
  }

  // Try partial match — find any file containing the taskId
  const { readdirSync } = require("fs")
  for (const dir of dirs) {
    const dirPath = join(repoRoot, "tasks", dir)
    try {
      const files = readdirSync(dirPath)
      for (const file of files) {
        if (file.includes(taskId) || file.includes(taskId.replace("TASK-", ""))) {
          const content = await readFile(join(dirPath, file), "utf-8")
          return parseTaskFrontmatter(content, file.replace(".md", ""))
        }
      }
    } catch {
      // Directory doesn't exist, continue
    }
  }

  return {
    taskId,
    title: "Unknown",
    status: "not_found",
    complexity: "unknown",
    track: "unknown",
    slice: "unknown",
    assignee: "unassigned",
    createdAt: "unknown",
  }
}

/** Parse task frontmatter from markdown content */
function parseTaskFrontmatter(content: string, fallbackId: string): CheckTaskStatusResult {
  const lines = content.split("\n")
  const meta: Record<string, string> = {}

  for (const line of lines) {
    if (line === "---") continue
    if (line.startsWith("---")) break
    const match = line.match(/^(\w+):\s*(.+)$/)
    if (match) {
      meta[match[1]] = match[2].replace(/^["']|["']$/g, "")
    }
  }

  return {
    taskId: meta.id || fallbackId,
    title: meta.title || "Untitled",
    status: meta.status || "unknown",
    complexity: meta.complexity || "standard",
    track: meta.track || "implementation",
    slice: meta.slice || "core",
    assignee: meta.assignee || "unassigned",
    createdAt: meta.created || "unknown",
  }
}

// ── Tool: ask_user_pick_one (non-blocking) ────────────────────

/**
 * Ask the user to pick one option from a list.
 * Non-blocking: sends prompt to client, returns immediately.
 * Response arrives via interactive_response WS message.
 */
export async function voiceAskUserPickOne(
  params: PickOneParams,
  sendFn: (message: string) => void,
): Promise<string> {
  const result = await askUserPickOne(params, sendFn)

  if (result.timeout) {
    return JSON.stringify({
      status: "timeout",
      message: "User did not respond in time. You may continue without their selection.",
    })
  }
  if (result.cancelled) {
    return JSON.stringify({
      status: "cancelled",
      message: "User cancelled the prompt. You may continue.",
    })
  }
  return JSON.stringify({
    status: "answered",
    selected: result.selected,
    message: `User selected: ${result.selected}`,
  })
}

// ── Tool: ask_user_confirm (non-blocking) ─────────────────────

/**
 * Ask the user to confirm an action (yes/no/cancel).
 * Non-blocking: sends prompt to client, returns immediately.
 */
export async function voiceAskUserConfirm(
  params: ConfirmParams,
  sendFn: (message: string) => void,
): Promise<string> {
  const result = await askUserConfirm(params, sendFn)

  if (result.timeout) {
    return JSON.stringify({
      status: "timeout",
      choice: "cancel",
      message: "User did not respond in time. The action was not confirmed.",
    })
  }
  if (result.cancelled) {
    return JSON.stringify({
      status: "cancelled",
      choice: "cancel",
      message: "User cancelled the prompt.",
    })
  }
  return JSON.stringify({
    status: "answered",
    choice: result.choice,
    message: `User responded: ${result.choice}`,
  })
}

// ── Phase 2: Delegation Handler ──────────────────────────────

/** Agent registry for delegation validation */
interface AgentRegistryEntry {
  name: string
  aliases: string[]
  role: string
  isPrimary: boolean
  canDelegateTo?: string[]
}

const AGENT_REGISTRY: AgentRegistryEntry[] = [
  { name: "ceo", aliases: ["chief", "executive"], role: "Ecosystem vision", isPrimary: true, canDelegateTo: ["cto", "cfo", "cmo", "cso"] },
  { name: "cto", aliases: ["tech", "technology"], role: "Technology strategy", isPrimary: true, canDelegateTo: ["technical_architect", "solidity-architect", "infra_sme"] },
  { name: "cmo", aliases: ["marketing", "brand"], role: "Brand strategy", isPrimary: true },
  { name: "product_manager", aliases: ["pm", "pma", "manager", "orchestrator"], role: "Central orchestrator", isPrimary: true, canDelegateTo: ["business_analyst", "tech_lead", "technical_architect", "developer", "qa_engineer", "ui_ux_designer", "mui_engineer", "workflow_runner", "delivery_manager"] },
  { name: "business_analyst", aliases: ["ba", "analyst"], role: "Requirements analysis", isPrimary: false },
  { name: "tech_lead", aliases: ["tl", "lead"], role: "Code quality, review", isPrimary: false },
  { name: "technical_architect", aliases: ["architect", "ta"], role: "Architecture, interfaces", isPrimary: false },
  { name: "developer", aliases: ["dev", "coder"], role: "Implementation", isPrimary: false },
  { name: "qa_engineer", aliases: ["qa", "tester"], role: "Testing, verification", isPrimary: false },
  { name: "ui_ux_designer", aliases: ["designer", "ui", "ux"], role: "UI/UX design", isPrimary: false },
  { name: "mui_engineer", aliases: ["mui", "material"], role: "MUI components", isPrimary: false },
  { name: "workflow_runner", aliases: ["runner", "executor"], role: "Workflow execution", isPrimary: false },
  { name: "solidity-architect", aliases: ["solidity", "evm", "contracts"], role: "Smart contracts", isPrimary: true, canDelegateTo: ["contract_security_auditor", "evm_optimization_engineer", "upgrade_specialist"] },
  { name: "contract_security_auditor", aliases: ["auditor"], role: "Security audit", isPrimary: false },
  { name: "evm_optimization_engineer", aliases: ["optimizer", "gas"], role: "Gas optimization", isPrimary: false },
  { name: "upgrade_specialist", aliases: ["upgrader"], role: "Proxy upgrades", isPrimary: false },
]

/** Resolve agent name from alias or canonical name */
function resolveAgentName(input: string): AgentRegistryEntry | null {
  const normalized = input.toLowerCase().trim().replace(/[- ]/g, "_")
  return AGENT_REGISTRY.find(
    (a) => a.name === normalized || a.aliases.includes(normalized),
  ) || null
}

/** Concurrency tracker for delegations */
const activeDelegations = new Map<string, { agentRole: string; startedAt: number; taskId: string }>()
const MAX_CONCURRENT_DELEGATIONS = 3

export interface DelegateAgentParams {
  agentRole: string
  prompt: string
  context?: string
  complexity?: "tiny" | "standard" | "complex"
}

export interface DelegateAgentResult {
  status: "delegated" | "error" | "concurrency_limit" | "invalid_agent"
  taskId?: string
  agentRole: string
  message: string
}

/**
 * Delegate a task to a specialist agent.
 * Validates agent role, creates task file, tracks concurrency.
 */
export async function delegateToAgent(
  params: DelegateAgentParams,
  repoRoot: string,
  starguardBase: string,
): Promise<DelegateAgentResult> {
  // 1. Validate agent role
  const agent = resolveAgentName(params.agentRole)
  if (!agent) {
    const validRoles = AGENT_REGISTRY.map((a) => a.name).join(", ")
    return {
      status: "invalid_agent",
      agentRole: params.agentRole,
      message: `Unknown agent role "${params.agentRole}". Valid roles: ${validRoles}`,
    }
  }

  // 2. Check concurrency limit
  if (activeDelegations.size >= MAX_CONCURRENT_DELEGATIONS) {
    return {
      status: "concurrency_limit",
      agentRole: agent.name,
      message: `Too many active delegations (${activeDelegations.size}/${MAX_CONCURRENT_DELEGATIONS}). Please wait for one to complete before delegating new work.`,
    }
  }

  // 3. Create task file
  const taskId = generateTaskId(params.prompt)
  const taskResult = await createTask(
    {
      title: params.prompt.slice(0, 120),
      description: params.context
        ? `Context: ${params.context}\n\nTask: ${params.prompt}`
        : params.prompt,
      complexity: params.complexity || "standard",
      track: "implementation",
      slice: "core",
      assignee: agent.name,
    },
    repoRoot,
  )

  // 4. Track delegation
  activeDelegations.set(taskId, {
    agentRole: agent.name,
    startedAt: Date.now(),
    taskId: taskResult.taskId,
  })

  // 5. Auto-cleanup after 5 minutes (safety net)
  setTimeout(() => {
    activeDelegations.delete(taskId)
  }, 5 * 60 * 1000)

  // 6. Push initial status to voice session
  sendStatusToVoiceSession(`voice_${Date.now()}`, {
    type: "task_status_update",
    taskId: taskResult.taskId,
    status: "created",
    progress: 0,
  })

  return {
    status: "delegated",
    taskId: taskResult.taskId,
    agentRole: agent.name,
    message: `Task ${taskResult.taskId} delegated to ${agent.name} (${agent.role}). Task file: ${taskResult.filePath}`,
  }
}

/** Get count of active delegations */
export function getActiveDelegationCount(): number {
  return activeDelegations.size
}

/** Remove a delegation from tracking (called on completion) */
export function completeDelegation(taskId: string): void {
  activeDelegations.delete(taskId)
}

/** Send a status update to the active voice session via WS */
export function sendStatusToVoiceSession(
  sessionId: string,
  message: Record<string, unknown>,
): void {
  try {
    // Dynamic import to avoid circular deps
    const { getTokidappSocket, tokidappSessionId } = require("../../../server/ws-socket-registry")
    const userId = sessionId ? sessionId.replace(/^voice_/, "") : null
    if (userId) {
      const socket = getTokidappSocket(tokidappSessionId(userId))
      if (socket) {
        socket.send(JSON.stringify(message))
      }
    }
  } catch {
    // Non-critical — status push is best-effort
  }
}

// ── Phase 4: Linear Chain Builder ─────────────────────────────

import {
  buildLinearChain as buildChain,
  parseVoiceIntentToSteps,
  formatChainForDisplay,
  type LinearChain,
  type ChainStep,
} from "../orchestrator/chain-builder"

export interface CreateChainParams {
  /** Voice description of the workflow steps */
  intent: string
  /** Whether to execute immediately or just build for confirmation */
  autoExecute?: boolean
}

export interface CreateChainResult {
  status: "built" | "executing" | "error" | "invalid_steps"
  chainId?: string
  stepCount: number
  steps: string[]
  message: string
}

/**
 * Build a linear execution chain from voice intent.
 * Parses the intent into steps and constructs a DAG.
 */
export function createLinearChain(params: CreateChainParams): CreateChainResult {
  const steps = parseVoiceIntentToSteps(params.intent)
  const result = buildChain(steps, params.intent)

  if (result.status !== "built" || !result.chain) {
    return {
      status: result.status as "error" | "invalid_steps",
      stepCount: 0,
      steps: [],
      message: result.message,
    }
  }

  return {
    status: "built",
    chainId: result.chain.id,
    stepCount: result.chain.steps.length,
    steps: result.chain.steps.map((s) => s.title),
    message: `${formatChainForDisplay(result.chain)}\n\nShall I proceed with this workflow?`,
  }
}

// ── Phase 5: Approval Flow ────────────────────────────────────

/** Active approval requests awaiting user decision */
const pendingApprovals = new Map<string, {
  title: string
  context: string
  riskLevel: string
  proposedAction: string
  createdAt: number
  resolve: (approved: boolean) => void
}>()

export interface ApprovalRequestParams {
  title: string
  context: string
  riskLevel: "low" | "medium" | "high" | "critical"
  proposedAction: string
}

export interface ApprovalResult {
  status: "requested" | "timeout" | "error"
  approvalId: string
  message: string
}

/**
 * Request user approval for a high-risk action.
 * Creates an approval request and waits for user decision.
 */
export async function requestApproval(
  params: ApprovalRequestParams,
  sendFn: (message: string) => void,
  timeoutMs: number = 60000,
): Promise<ApprovalResult> {
  const approvalId = `approval_${Date.now()}`

  // Send the approval prompt to the client
  const promptMessage = JSON.stringify({
    type: "interactive_prompt",
    promptId: approvalId,
    promptType: "confirm",
    question: `⚠️ **${params.riskLevel.toUpperCase()} Risk Action**\n\n${params.title}\n\n${params.context}\n\nProposed action: ${params.proposedAction}`,
    config: {
      yesLabel: "Approve",
      noLabel: "Reject",
    },
    timeout: timeoutMs,
  })

  sendFn(promptMessage)

  // Create a promise that resolves when the user responds
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(approvalId)
      resolve({
        status: "timeout",
        approvalId,
        message: `Approval request timed out after ${timeoutMs / 1000}s. The action was not performed.`,
      })
    }, timeoutMs)

    pendingApprovals.set(approvalId, {
      title: params.title,
      context: params.context,
      riskLevel: params.riskLevel,
      proposedAction: params.proposedAction,
      createdAt: Date.now(),
      resolve: (approved: boolean) => {
        clearTimeout(timer)
        pendingApprovals.delete(approvalId)
        resolve({
          status: "requested",
          approvalId,
          message: approved
            ? `Approved: ${params.title}`
            : `Rejected: ${params.title}. The action was not performed.`,
        })
      },
    })
  })
}

/**
 * Resolve a pending approval request.
 * Called when the user responds to an approval prompt.
 */
export function resolveApproval(approvalId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(approvalId)
  if (!pending) return false
  pending.resolve(approved)
  return true
}

// ── Tool Definitions (for registration in Realtime session) ───

export const voiceOrchestratorToolDefinitions = [
  {
    type: "function",
    name: "create_task",
    description:
      "Create a task for the NomadWorks development pipeline. Use this when the user asks to create, file, or track a work item. Writes a task file to the project's tasks directory with structured metadata.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short descriptive title for the task",
        },
        description: {
          type: "string",
          description: "Optional longer description of what needs to be done",
        },
        complexity: {
          type: "string",
          enum: ["tiny", "standard", "complex"],
          description: "Task complexity: tiny (trivial fix), standard (bounded delivery), complex (multi-slice decomposition)",
        },
        track: {
          type: "string",
          enum: ["implementation", "investigation", "spec"],
          description: "Work track: implementation (code/tests), investigation (research/debug), spec (requirements)",
        },
        slice: {
          type: "string",
          enum: ["foundation", "core", "logic", "ui", "polish", "qa", "docs"],
          description: "Primary work slice",
        },
        assignee: {
          type: "string",
          description: "Agent role to assign (e.g., developer, tech_lead, qa_engineer)",
        },
        priority: {
          type: "number",
          description: "Priority level (1=highest, 5=lowest)",
        },
      },
      required: ["title"],
    },
  },
  {
    type: "function",
    name: "check_task_status",
    description:
      "Check the status of an existing task. Returns the task's metadata including status, complexity, track, and assignee. Use when the user asks about a specific task's progress.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task ID to check (e.g., TASK-2026-07-08-voice-fix-bridge)",
        },
      },
      required: ["taskId"],
    },
  },
  {
    type: "function",
    name: "ask_user_pick_one",
    description:
      "Present the user with a single-select question with multiple options. The user can tap an option in the UI. Use this when you need the user to choose between alternatives. Returns immediately — the user responds via the interactive prompt in the chat panel.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user",
        },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              value: { type: "string", description: "Option value identifier" },
              label: { type: "string", description: "Display label for the option" },
              description: { type: "string", description: "Optional description" },
            },
            required: ["value", "label"],
          },
          description: "List of options for the user to choose from",
        },
      },
      required: ["question", "options"],
    },
  },
  {
    type: "function",
    name: "ask_user_confirm",
    description:
      "Ask the user to confirm or deny an action (yes/no/cancel). Use this before performing irreversible actions like deployments, deletions, or task creation. Returns immediately — the user responds via the interactive prompt.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The confirmation question to ask",
        },
        yesLabel: {
          type: "string",
          description: "Custom label for the yes button (default: 'Yes')",
        },
        noLabel: {
          type: "string",
          description: "Custom label for the no button (default: 'No')",
        },
      },
      required: ["question"],
    },
  },
  // ── Phase 2: Delegation Tool ───────────────────────────────
  {
    type: "function",
    name: "delegate_to_agent",
    description:
      "Delegate a task to a specific NomadWorks agent specialist. Creates a task file, validates the agent role, and optionally spawns a workspace. Use this when the user asks to have a specific specialist (developer, QA, architect, etc.) work on something. Max 3 concurrent delegations.",
    parameters: {
      type: "object",
      properties: {
        agentRole: {
          type: "string",
          description: "The specialist agent role to delegate to (e.g., developer, tech_lead, qa_engineer, technical_architect, ui_ux_designer, business_analyst, workflow_runner)",
        },
        prompt: {
          type: "string",
          description: "The task instruction or question to delegate to the agent",
        },
        context: {
          type: "string",
          description: "Optional additional context about the current state or what's been done so far",
        },
        complexity: {
          type: "string",
          enum: ["tiny", "standard", "complex"],
          description: "Task complexity (default: standard)",
        },
      },
      required: ["agentRole", "prompt"],
    },
  },
  // ── Phase 4: Linear Chain Tool ──────────────────────────────
  {
    type: "function",
    name: "create_linear_chain",
    description:
      "Build a linear execution workflow from a voice description. Parses steps like 'investigate, fix, then deploy' into an ordered chain. Returns the chain for user confirmation before execution. Maximum 10 steps.",
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: "The voice description of the workflow steps (e.g., 'investigate the bug, fix it, then deploy')",
        },
      },
      required: ["intent"],
    },
  },
  // ── Phase 5: Approval Gate Tool ─────────────────────────────
  {
    type: "function",
    name: "request_approval",
    description:
      "Request user approval before performing a high-risk action. Shows a confirmation prompt with risk level and proposed action. Use before deployments, deletions, or any irreversible operation. Waits up to 60 seconds for a decision.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title for the action requiring approval",
        },
        context: {
          type: "string",
          description: "Explanation of why this action needs approval and what it does",
        },
        riskLevel: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description: "Risk level of the action",
        },
        proposedAction: {
          type: "string",
          description: "Description of the specific action to be taken if approved",
        },
      },
      required: ["title", "context", "riskLevel", "proposedAction"],
    },
  },
]
