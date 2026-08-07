/**
 * PMA Proxy Module — NomadWorks Bridge for TokiDAPP
 *
 * Translates TokiDAPP WebSocket orchestration requests into NomadWorks
 * task files on disk, and streams execution status back to the frontend.
 *
 * Architecture:
 *   TokiDAPP UI ──WS──→ CodeNomad Server (:9940)
 *                          ├── 1. nomadworks_invoke handler
 *                          │      └── Creates tasks/todo/TASK-{slug}.md
 *                          │      └── Updates tasks/current.md
 *                          │      └── Returns task ID + status
 *                          ├── 2. nomadworks_status handler
 *                          │      └── Reads task file for latest status
 *                          ├── 3. watchTask — in-memory event bus + fs.watch fallback
 *                          │      └── Updates from updateTaskProgress arrive via event bus
 *                          │      └── fs.watch detects external edits (editor, agent file writes)
 *                          │      └── Sends nomadworks_task_status + agent_progress updates
 *                          └── 4. updateTaskProgress — write progress to frontmatter + emit
 *                                 └── PMA agent writes progress_stage, progress_message
 *                                 └── Emits directly to event bus → WS subscribers (no polling)
 *                                 └── fs.watch detects disk change as fallback
 *
 * Event Bus Architecture:
 *   updateTaskProgress() writes to disk (persistence) AND emits to in-memory
 *   ProgressEventBus. The watchTask() handler subscribes to the event bus for
 *   immediate delivery while keeping fs.watch as a fallback for external file
 *   changes (editor, git checkout, agent-side write from another process).
 */

import fs from "fs"
import path from "path"
import crypto from "crypto"
import YAML from "yaml"
import { apiPut } from "../../plugins/tokidapp/orchestrator/starguard-client"
import {
  createPrompt,
  cancelPrompt,
  type InteractivePromptOption,
  type InteractivePromptConfig,
} from "../../plugins/tokidapp/concierge/interactive-session"

// ── Constants ─────────────────────────────────────────────────

/** Root of the repository (set by environment or cwd). */
const REPO_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()
const TASKS_ROOT = path.join(REPO_ROOT, "tasks")
const TODO_DIR = path.join(TASKS_ROOT, "todo")
const BLOCKED_DIR = path.join(TASKS_ROOT, "blocked")
const DONE_DIR = path.join(TASKS_ROOT, "done")
const CURRENT_FILE = path.join(TASKS_ROOT, "current.md")
const BRIDGE_SECTION = "## Bridge-Initiated Tasks"
const EVIDENCES_ROOT = path.join(REPO_ROOT, "evidences")

/**
 * Task lanes, in resolution order. A task is a file in exactly one of these;
 * moving the file between them IS the lifecycle transition, so every lookup
 * has to consider all three or a moved task silently becomes unreadable.
 */
export type TaskLane = "todo" | "blocked" | "done"

const TASK_LANES: ReadonlyArray<{ lane: TaskLane; dir: string }> = [
  { lane: "todo", dir: TODO_DIR },
  { lane: "blocked", dir: BLOCKED_DIR },
  { lane: "done", dir: DONE_DIR },
]

/**
 * Canonical task states. Task files on disk carry ~11 different spellings
 * (`active`/`Active`/`todo`/`done`/`Done`/`completed`/`complete`/`pending`/
 * `created`/`review`/`ready-for-close`, plus free text), and the frontmatter
 * routinely disagrees with the directory. Everything the bridge reports is
 * normalized through `normalizeStatus` so subscribers see one vocabulary.
 */
export type CanonicalTaskStatus =
  | "created"
  | "queued"
  | "in_progress"
  | "blocked"
  | "review"
  | "completed"
  | "failed"
  | "cancelled"

const TERMINAL_STATUSES: ReadonlySet<CanonicalTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
])

/** Raw frontmatter spelling → canonical status. */
const STATUS_ALIASES: Readonly<Record<string, CanonicalTaskStatus>> = {
  created: "created",
  new: "created",
  todo: "queued",
  pending: "queued",
  queued: "queued",
  ready: "queued",
  active: "in_progress",
  "in progress": "in_progress",
  in_progress: "in_progress",
  inprogress: "in_progress",
  running: "in_progress",
  wip: "in_progress",
  blocked: "blocked",
  waiting: "blocked",
  "on hold": "blocked",
  review: "review",
  "in review": "review",
  "ready-for-close": "review",
  "ready for close": "review",
  done: "completed",
  complete: "completed",
  completed: "completed",
  closed: "completed",
  shipped: "completed",
  failed: "failed",
  error: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
  abandoned: "cancelled",
  superseded: "cancelled",
}

/**
 * Normalize a raw frontmatter `status:` value to the canonical vocabulary.
 * Free-text statuses like `Active (Batch 2 complete in bcd876e3; ...)` are
 * matched on their leading word. `lane` breaks ties when frontmatter is
 * missing or contradicts the file's directory — the directory wins for
 * `blocked`/`done`, because moving the file is the deliberate act.
 */
export function normalizeStatus(raw: unknown, lane?: TaskLane): CanonicalTaskStatus {
  if (lane === "blocked") return "blocked"

  const text = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  if (text) {
    const exact = STATUS_ALIASES[text]
    if (exact) return lane === "done" && !TERMINAL_STATUSES.has(exact) ? "completed" : exact

    // Free text — match the leading word (e.g. "Active (implementation ...)").
    const lead = text.split(/[\s(—–:,;]/)[0]
    const byLead = STATUS_ALIASES[lead]
    if (byLead) return lane === "done" && !TERMINAL_STATUSES.has(byLead) ? "completed" : byLead
  }

  if (lane === "done") return "completed"
  if (lane === "todo") return "queued"
  return "created"
}

/** True when a status means no further updates are expected. */
export function isTerminalStatus(status: CanonicalTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** Stage the agent reports → the task status it implies. */
const STAGE_TO_STATUS: Readonly<Record<AgentProgressStage, CanonicalTaskStatus>> = {
  thinking: "in_progress",
  tool_call: "in_progress",
  tool_result: "in_progress",
  executing: "in_progress",
  reviewing: "review",
  blocked: "blocked",
  complete: "completed",
  error: "failed",
}

const VALID_STAGES: ReadonlySet<string> = new Set(Object.keys(STAGE_TO_STATUS))

/**
 * Resolve a taskId to its file and lane, searching todo → blocked → done.
 * Returns null when the task has no file in any lane.
 */
export function resolveTaskFile(
  taskId: string,
): { filePath: string; lane: TaskLane } | null {
  for (const { lane, dir } of TASK_LANES) {
    const candidate = path.join(dir, `${taskId}.md`)
    if (fs.existsSync(candidate)) return { filePath: candidate, lane }
  }
  return null
}

// ── Event Bus (In-Memory Progress Notifications) ─────────────
// Replaces the fs.watch polling round-trip for progress updates.
// updateTaskProgress() writes to disk (persistence) AND emits to this bus.
// watchTask() subscribes for immediate delivery; keeps fs.watch as fallback.

/** Progress event payload emitted by the bus. */
export interface ProgressEvent {
  taskId: string
  type: "agent_progress" | "nomadworks_task_status"
  stage?: string
  message?: string
  pct?: number
  status?: string
  /** Pre-serialized WS message for immediate send (avoids redundant JSON.stringify). */
  rawPayload: string
}

type ProgressCallback = (event: ProgressEvent) => void

/**
 * Lightweight in-memory event bus for NomadWorks progress notifications.
 *
 * Subscribers are registered per-taskId by watchTask(). When
 * updateTaskProgress() writes its change to disk, it also emits to
 * this bus so subscribers receive the event immediately — no
 * fs.watch polling round-trip needed.
 *
 * fs.watch is kept as a fallback for changes that bypass
 * updateTaskProgress() (external editor, git operations, agent writes
 * from another OpenCode instance).
 */
export class ProgressEventBus {
  private subscribers = new Map<string, Set<ProgressCallback>>()
  private allSubscribers = new Set<ProgressCallback>()

  /**
   * Emit a progress event to all subscribers of this taskId,
   * plus any catch-all subscribers.
   */
  emit(event: ProgressEvent): void {
    const taskSubs = this.subscribers.get(event.taskId)
    if (taskSubs) {
      for (const cb of taskSubs) {
        try { cb(event) } catch { /* subscriber failed — skip */ }
      }
    }
    for (const cb of this.allSubscribers) {
      try { cb(event) } catch { /* subscriber failed — skip */ }
    }
  }

  /**
   * Subscribe to events for a specific taskId.
   * Returns an unsubscribe function.
   */
  subscribe(taskId: string, callback: ProgressCallback): () => void {
    if (!this.subscribers.has(taskId)) {
      this.subscribers.set(taskId, new Set())
    }
    this.subscribers.get(taskId)!.add(callback)
    return () => {
      this.subscribers.get(taskId)?.delete(callback)
      if (this.subscribers.get(taskId)?.size === 0) {
        this.subscribers.delete(taskId)
      }
    }
  }

  /**
   * Subscribe to ALL progress events (for catch-all listeners).
   */
  subscribeAll(callback: ProgressCallback): () => void {
    this.allSubscribers.add(callback)
    return () => { this.allSubscribers.delete(callback) }
  }

  /** Remove all subscribers for a task (cleanup on task completion). */
  unsubscribeAll(taskId: string): void {
    this.subscribers.delete(taskId)
  }

  /** Remove all subscribers globally. */
  clear(): void {
    this.subscribers.clear()
    this.allSubscribers.clear()
  }
}

// ── Idempotency Cache ─────────────────────────────────────────
// key = `${sessionId}::${intent}` — avoids duplicate task files
const taskCache = new Map<string, { taskId: string; taskFilePath: string }>()

// ── Active Watchers ───────────────────────────────────────────
// key = taskId — ensures at most one watcher per task
const activeWatchers = new Map<string, () => void>()

// ── Last Known Progress ───────────────────────────────────────
// key = taskId — tracks last progress_stage + progress_message to avoid duplicate events
interface LastProgress {
  stage?: string
  message?: string
}
const lastProgressMap = new Map<string, LastProgress>()

// ── ClickFlow Idempotency ─────────────────────────────────────
// key = `${taskId}::${promptId}` — prevents re-processing the same prompt
const processedClickflowPrompts = new Set<string>()

// ── Public Types ──────────────────────────────────────────────

export type AgentProgressStage =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'executing'
  | 'reviewing'
  | 'blocked'
  | 'complete'
  | 'error'

export interface CreateTaskParams {
  intent: string
  agentType: string
  context: Record<string, unknown>
  sessionId: string
  complexity?: "tiny" | "standard" | "complex"
  initialStage?: AgentProgressStage
  initialMessage?: string
  /** Extra YAML frontmatter fields to embed (e.g. executionNodeId, executionId) */
  extraFrontmatter?: Record<string, string>
  /** Override the idempotency cache key. Use `${executionId}::${nodeId}` for execution nodes. */
  cacheKeyOverride?: string
}

export interface TaskStatus {
  taskId: string
  /** Canonical status — see `normalizeStatus`. */
  status: CanonicalTaskStatus
  /** Raw frontmatter `status:` value, preserved for display/debugging. */
  rawStatus?: string
  /** Which directory the task file currently lives in. */
  lane?: TaskLane
  /** True when no further updates are expected. */
  terminal?: boolean
  complexity?: string
  track?: string
  slice?: string
  title?: string
  createdAt?: string
  updatedAt?: string
  hasEvidence?: boolean
  evidenceSummary?: string
  progressStage?: string
  progressMessage?: string
  progressPct?: number
  [key: string]: unknown
}

export interface CreateTaskResult {
  taskId: string
  taskFilePath: string
}

export interface NomadworksBridge {
  createTaskFile(params: CreateTaskParams): Promise<CreateTaskResult>
  readTaskStatus(taskId: string): Promise<TaskStatus | null>
  watchTask(taskId: string, send: (msg: string) => void, onStatus?: (status: TaskStatus) => void): () => void
  listTasks(sessionId?: string): Promise<TaskStatus[]>
  updateTaskProgress(taskId: string, stage: AgentProgressStage, message: string, pct?: number): void
  /** In-memory event bus for real-time progress notifications. */
  eventBus: ProgressEventBus
}

// ── Helpers ───────────────────────────────────────────────────

/** Generate a stable slug from sessionId + random hash. */
function generateSlug(sessionId: string): string {
  const prefix = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "task"
  const hash = crypto.randomUUID().slice(0, 4)
  return `${prefix}-${hash}`
}

/** Ensure a directory exists (recursive). */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/** Parse YAML frontmatter from a task file. */
function parseTaskFile(content: string, taskId: string, lane?: TaskLane): TaskStatus | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null

  try {
    const frontmatter = YAML.parse(match[1])
    if (!frontmatter || typeof frontmatter !== "object") return null

    const rawStatus = frontmatter.status as string | undefined
    const status = normalizeStatus(rawStatus, lane)

    return {
      // Spread first so the normalized fields below always win — otherwise the
      // raw frontmatter `status` would overwrite the canonical one.
      ...frontmatter,
      taskId: (frontmatter.task_id as string) || taskId,
      status,
      rawStatus,
      lane,
      terminal: isTerminalStatus(status),
      complexity: frontmatter.complexity as string | undefined,
      track: frontmatter.track as string | undefined,
      slice: frontmatter.slice as string | undefined,
      title: frontmatter.title as string | undefined,
      createdAt: frontmatter.createdAt as string | undefined,
      updatedAt: frontmatter.updatedAt as string | undefined,
      // Frontmatter is snake_case; TaskStatus is camelCase. Without this
      // mapping progressStage/Message/Pct were always undefined, which silently
      // disabled the fs.watch progress-detection fallback in watchTask().
      progressStage: frontmatter.progress_stage as string | undefined,
      progressMessage: frontmatter.progress_message as string | undefined,
      progressPct:
        typeof frontmatter.progress_pct === "number" ? frontmatter.progress_pct : undefined,
    }
  } catch {
    return null
  }
}

// ── Core Functions ────────────────────────────────────────────

/**
 * Create a NomadWorks task file from a WS orchestration request.
 * Idempotent: same intent+sessionId returns existing result.
 */
async function createTaskFile(params: CreateTaskParams): Promise<CreateTaskResult> {
  const { intent, agentType, context, sessionId, complexity = "standard", initialStage, initialMessage, extraFrontmatter, cacheKeyOverride } = params

  // Check idempotency cache first
  const cacheKey = cacheKeyOverride || `${sessionId}::${intent}`
  const cached = taskCache.get(cacheKey)
  if (cached) return cached

  ensureDir(TODO_DIR)

  const slug = generateSlug(sessionId)
  const taskId = `TASK-${slug}`
  const filename = `${taskId}.md`
  const taskFilePath = path.join(TODO_DIR, filename)
  const timestamp = new Date().toISOString()

  // Derive acceptance criteria from context
  const contextEntries = Object.entries(context)
  const acLines =
    contextEntries.length > 0
      ? contextEntries.map(([key, val], i) => `- AC-${i + 1}: ${key}: ${String(val)}`)
      : ["- AC-1: Implement the requested functionality"]

    // Build the task file content
  const taskContent = [
    "---",
    `task_id: ${taskId}`,
    `sessionId: ${sessionId}`,
    // agentType + title live in frontmatter (not only prose) so progress
    // events can name the specialist and the work without re-reading the body.
    `agentType: ${agentType}`,
    `title: ${JSON.stringify(intent.slice(0, 120))}`,
    `complexity: ${complexity}`,
    "track: implementation",
    "slice: core",
    `status: created`,
    `createdAt: ${timestamp}`,
    `updatedAt: ${timestamp}`,
    ...(initialStage ? [`progress_stage: ${initialStage}`, `progress_message: ${initialMessage || ""}`, `progress_pct: 0`] : []),
    // Extra frontmatter from caller (e.g. executionNodeId, executionId)
    ...(extraFrontmatter ? Object.entries(extraFrontmatter).map(([k, v]) => `${k}: ${String(v)}`) : []),
    "---",
    "",
    `# ${intent.slice(0, 80)}`,
    "",
    "## Context",
    "",
    `Bridge-invoked task from TokiDAPP session ${sessionId}.`,
    "",
    `**Original intent:** ${intent}`,
    `**Assigned agent:** ${agentType}`,
    `**Created at:** ${timestamp}`,
    "",
    "## Requirements",
    "",
    ...contextEntries.map(([key, val]) => `- **${key}**: ${String(val)}`),
    "",
    "## Acceptance Criteria",
    "",
    ...acLines,
    "",
  ].join("\n")

  fs.writeFileSync(taskFilePath, taskContent, "utf-8")

  // Update tasks/current.md
  if (fs.existsSync(CURRENT_FILE)) {
    try {
      let currentContent = fs.readFileSync(CURRENT_FILE, "utf-8")
      const entry = `- **${taskId}**: ${intent.slice(0, 60)} — Created from TokiDAPP. Assigned to: ${agentType}. See \`tasks/todo/${filename}\``

      if (currentContent.includes(BRIDGE_SECTION)) {
        // Insert after the section header
        currentContent = currentContent.replace(
          `${BRIDGE_SECTION}\n`,
          `${BRIDGE_SECTION}\n${entry}\n`,
        )
      } else {
        // Append new section
        const trimmed = currentContent.endsWith("\n") ? currentContent : currentContent + "\n"
        currentContent = `${trimmed}\n${BRIDGE_SECTION}\n\n${entry}\n`
      }

      fs.writeFileSync(CURRENT_FILE, currentContent, "utf-8")
    } catch (err) {
      console.error("[nomadworks-bridge] Failed to update current.md:", err)
    }
  }

  const result: CreateTaskResult = { taskId, taskFilePath }
  taskCache.set(cacheKey, result)
  console.log(`[nomadworks-bridge] Created task ${taskId} at ${taskFilePath}`)
  return result
}

/**
 * Read current task status from its task file.
 * Searches tasks/todo/ first, then common locations.
 */
async function readTaskStatus(taskId: string): Promise<TaskStatus | null> {
  const resolved = resolveTaskFile(taskId)
  if (!resolved) return null

  try {
    const content = fs.readFileSync(resolved.filePath, "utf-8")
    return parseTaskFile(content, taskId, resolved.lane)
  } catch {
    return null
  }
}

/**
 * Collect evidence from the evidence directory for a completed/failed task.
 */
async function collectEvidence(
  taskId: string,
  sessionId: string,
  send: (msg: string) => void,
): Promise<void> {
  const evidenceDir = path.join(EVIDENCES_ROOT, taskId)
  const summaryPath = path.join(evidenceDir, "SUMMARY.md")

  if (!fs.existsSync(summaryPath)) {
    console.warn(`[nomadworks-bridge] No evidence found for ${taskId} at ${summaryPath}`)
    return
  }

  try {
    const summaryContent = fs.readFileSync(summaryPath, "utf-8")
    const hasLogs = fs.existsSync(path.join(evidenceDir, "logs"))
    const hasScreenshots = fs.existsSync(path.join(evidenceDir, "screenshots"))

    send(
      JSON.stringify({
        type: "nomadworks_evidence",
        taskId,
        evidenceSummary: summaryContent,
        evidencePath: summaryPath,
        hasLogs,
        hasScreenshots,
      }),
    )

    // Link evidence to execution node if this is an execution-scoped task
    try {
      const taskFilePath = path.join(TODO_DIR, `${taskId}.md`)
      if (fs.existsSync(taskFilePath)) {
        const frontmatterRaw = fs.readFileSync(taskFilePath, 'utf-8').match(/^---\n([\s\S]*?)\n---/)?.[1] || ''
        const frontmatter = YAML.parse(frontmatterRaw) || {}
        const executionNodeId = frontmatter.executionNodeId as string | undefined
        const executionId = frontmatter.executionId as string | undefined
        if (executionNodeId && executionId) {
          const evidenceSummaryPath = path.join(EVIDENCES_ROOT, taskId, 'SUMMARY.md')
          const hasSummary = fs.existsSync(evidenceSummaryPath)
          await apiPut(`/api/tokidapp/executions/${executionId}/nodes/${executionNodeId}`, {
            output: {
              evidencePath: `evidences/${taskId}/SUMMARY.md`,
              evidenceTaskId: taskId,
              evidenceCount: (() => {
                const logsDir = path.join(EVIDENCES_ROOT, taskId, 'logs')
                const screenshotsDir = path.join(EVIDENCES_ROOT, taskId, 'screenshots')
                let count = 0
                if (fs.existsSync(logsDir)) count += fs.readdirSync(logsDir).length
                if (fs.existsSync(screenshotsDir)) count += fs.readdirSync(screenshotsDir).length
                return count
              })(),
              completedAt: new Date().toISOString(),
              ...(hasSummary ? { summaryPath: evidenceSummaryPath } : {}),
            },
            status: 'COMPLETED',
            completedAt: new Date().toISOString(),
          })
        }
      }
    } catch (err) {
      // Non-critical — evidence is still collected, just the backlink failed
      console.error('Failed to link evidence to execution node:', err)
    }

    console.log(`[nomadworks-bridge] Evidence sent for ${taskId}`)
  } catch (err) {
    console.error(`[nomadworks-bridge] Failed to read evidence for ${taskId}:`, err)
  }
}

/**
 * Invoke a PMA delegate node through the NomadWorks bridge.
 * Creates a task file with execution context in frontmatter, watches for
 * completion, and links evidence back to the execution node.
 */
export async function invokePmaNode(params: {
  intent: string
  agentType: string
  executionNodeId: string
  executionId: string
  context?: Record<string, unknown>
  send: (msg: string) => void
}): Promise<{ taskId: string; evidence?: any }> {
  const { intent, agentType, executionNodeId, executionId, context = {}, send } = params

  // Create task file with execution context in frontmatter
  const { taskId, taskFilePath } = await createTaskFile({
    intent,
    agentType,
    sessionId: executionId, // Use executionId as sessionId for tracking
    complexity: 'standard',
    context,
    cacheKeyOverride: `${executionId}::${executionNodeId}`,
    extraFrontmatter: { executionNodeId, executionId },
  })

  // Watch for completion — return a promise
  return new Promise((resolve, reject) => {
    const unwatch = watchTask(taskId, send, (status: TaskStatus) => {
      if (status.status === 'completed') {
        unwatch()
        // Collect evidence and link to execution node
        collectEvidence(taskId, executionId, send).catch(() => {})
        resolve({ taskId, evidence: status })
      } else if (status.status === 'failed' || status.status === 'cancelled') {
        // 'cancelled' previously fell through and left this promise pending
        // forever — a cancelled node would hang its whole DAG execution.
        unwatch()
        const errorMessage =
          typeof status.errorMessage === "string" && status.errorMessage.trim().length > 0
            ? status.errorMessage
            : status.status === 'cancelled'
              ? "Task cancelled"
              : "Task failed"
        reject(new Error(errorMessage))
      }
    })
  })
}

/**
 * Create a causal graph update from a task's status and its dependencies.
 */
async function streamCausalUpdate(
  taskId: string,
  sessionId: string,
  send: (msg: string) => void,
): Promise<void> {
  const filePath = path.join(TODO_DIR, `${taskId}.md`)

  if (!fs.existsSync(filePath)) {
    console.warn(`[nomadworks-bridge] Cannot stream causal update for ${taskId}: file not found`)
    return
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const status = parseTaskFile(content, taskId)
    if (!status) {
      console.warn(`[nomadworks-bridge] Cannot parse task file for ${taskId}`)
      return
    }

    const node = {
      id: `nomadworks-${taskId}`,
      nodeType: "Evidence" as const,
      label: status.title || taskId,
      description: `Status: ${status.status}`,
      status: status.status,
      sourceStepId: sessionId,
    }

    const edges: Array<{ sourceId: string; targetId: string; label: string; description?: string }> = []
    const dependsOn = (status as any).dependsOn as string[] | undefined
    if (Array.isArray(dependsOn)) {
      for (const dep of dependsOn) {
        edges.push({
          sourceId: dep,
          targetId: `nomadworks-${taskId}`,
          label: "REQUIRES",
          description: `${taskId} depends on ${dep}`,
        })
      }
    }

    send(
      JSON.stringify({
        type: "nomadworks_causal_update",
        causalNodes: [node],
        causalEdges: edges,
      }),
    )

    console.log(`[nomadworks-bridge] Causal update sent for ${taskId}`)
  } catch (err) {
    console.error(`[nomadworks-bridge] Failed to stream causal update for ${taskId}:`, err)
  }
}

/**
 * Update the progress fields in a task file's YAML frontmatter.
 * This is called by the PMA agent as it progresses through task stages.
 *
 * After writing to disk for persistence, emits an event to the in-memory
 * ProgressEventBus so WebSocket subscribers receive the update immediately
 * without waiting for the fs.watch polling round-trip.
 *
 * fs.watch remains as a fallback for file changes that bypass this function
 * (external editor, git operations, agent writes from another instance).
 */
function updateTaskProgress(
  taskId: string,
  stage: AgentProgressStage,
  message: string,
  pct?: number,
): void {
  if (!VALID_STAGES.has(stage)) {
    console.warn(
      `[nomadworks-bridge] Rejected unknown stage "${stage}" for ${taskId}. ` +
        `Valid stages: ${[...VALID_STAGES].join(", ")}`,
    )
    return
  }

  const resolved = resolveTaskFile(taskId)
  if (!resolved) {
    console.warn(`[nomadworks-bridge] Cannot update progress for ${taskId}: file not found`)
    return
  }
  const { filePath, lane } = resolved

  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const match = content.match(/^---\n([\s\S]*?)\n---/)

    if (!match) {
      console.warn(`[nomadworks-bridge] Cannot parse frontmatter for ${taskId}`)
      return
    }

    const frontmatter = YAML.parse(match[1])
    if (!frontmatter || typeof frontmatter !== "object") return

    // The stage the agent reports IS the state transition — record it as
    // `status` too, or the task stays "created" forever at 100% and no
    // subscriber can ever tell that it finished.
    const nextStatus = STAGE_TO_STATUS[stage]
    const prevStatus = normalizeStatus(frontmatter.status, lane)

    frontmatter.progress_stage = stage
    frontmatter.progress_message = message
    frontmatter.progress_pct =
      pct ?? (stage === "complete" ? 100 : (frontmatter.progress_pct ?? 0))
    frontmatter.status = nextStatus
    frontmatter.updatedAt = new Date().toISOString()
    if (isTerminalStatus(nextStatus)) {
      frontmatter.completedAt = frontmatter.completedAt || frontmatter.updatedAt
    }

    // Rebuild the file with updated frontmatter
    const newFrontmatter = YAML.stringify(frontmatter, {
      lineWidth: 0,
      indent: 2,
    })

    const bodyAfterFrontmatter = content.slice(match[0].length)
    const newContent = `---\n${newFrontmatter}---${bodyAfterFrontmatter}`
    fs.writeFileSync(filePath, newContent, "utf-8")

    console.log(`[nomadworks-bridge] Progress update for ${taskId}: ${stage} — ${message}`)

    // ── Emit to in-memory event bus ──
    // Subscribers (watchTask handlers) receive this directly, bypassing fs.watch.
    // The rawPayload is pre-serialized so WS sends are zero-cost.
    const rawPayload = JSON.stringify({
      type: "agent_progress",
      taskId,
      agentType: (frontmatter.agentType as string) || "developer",
      sessionId: (frontmatter.sessionId as string) || "",
      title: (frontmatter.title as string) || "",
      stepId: `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      stage,
      content: message,
      pct: frontmatter.progress_pct,
      status: nextStatus,
      previousStatus: prevStatus,
      statusChanged: prevStatus !== nextStatus,
      terminal: isTerminalStatus(nextStatus),
      lane,
      timestamp: frontmatter.updatedAt,
    })
    progressBus.emit({
      taskId,
      type: "agent_progress",
      stage,
      message,
      pct: frontmatter.progress_pct,
      rawPayload,
    })

    // Also emit a nomadworks_task_status event for status-polling subscribers
    const taskStatusPayload = JSON.stringify({
      type: "nomadworks_task_status",
      taskId,
      status: nextStatus,
      previousStatus: prevStatus,
      statusChanged: prevStatus !== nextStatus,
      terminal: isTerminalStatus(nextStatus),
      lane,
      title: (frontmatter.title as string) || "",
      agentType: (frontmatter.agentType as string) || "developer",
      sessionId: (frontmatter.sessionId as string) || "",
      complexity: frontmatter.complexity,
      progress_stage: stage,
      progress_message: message,
      progress_pct: frontmatter.progress_pct,
      updatedAt: frontmatter.updatedAt,
    })
    progressBus.emit({
      taskId,
      type: "nomadworks_task_status",
      stage,
      status: nextStatus,
      rawPayload: taskStatusPayload,
    })
  } catch (err) {
    console.error(`[nomadworks-bridge] Failed to update progress for ${taskId}:`, err)
  }
}

/**
 * Process a ClickFlow prompt from a task file frontmatter.
 *
 * Detects the `clickflow_prompt` field in task file frontmatter, creates an
 * interactive prompt via the Interactive Session Manager (T3), waits for the
 * user response, and writes the `clickflow_result` back to the task file.
 *
 * Idempotency: tracked by taskId + promptId combo so the same prompt is never
 * processed twice.
 *
 * @param taskId - The NomadWorks task ID
 * @param frontmatter - Parsed YAML frontmatter containing clickflow_prompt
 * @param sendFn - WebSocket send function to deliver the prompt to the client
 */
async function processClickflowPrompt(
  taskId: string,
  frontmatter: Record<string, unknown>,
  sendFn: (message: string) => void,
): Promise<void> {
  const promptConfig = frontmatter.clickflow_prompt as Record<string, unknown> | undefined
  if (!promptConfig || typeof promptConfig !== 'object') return

  const type = promptConfig.type as string | undefined
  const question = promptConfig.question as string | undefined
  if (!type || !question) {
    console.warn(`[nomadworks-bridge] clickflow_prompt in ${taskId} missing type or question`)
    return
  }

  // Validate prompt type
  const validTypes = ['pick_one', 'pick_many', 'confirm', 'ask_text', 'slider']
  if (!validTypes.includes(type)) {
    console.warn(`[nomadworks-bridge] clickflow_prompt in ${taskId} has invalid type: ${type}`)
    return
  }

  // Generate a unique promptId
  const promptId = `cf_${taskId}_${Date.now()}`

  // Check idempotency
  const idempotencyKey = `${taskId}::${promptId}`
  if (processedClickflowPrompts.has(idempotencyKey)) {
    console.log(`[nomadworks-bridge] Skipping already-processed clickflow_prompt ${promptId} in ${taskId}`)
    return
  }
  processedClickflowPrompts.add(idempotencyKey)

  const options: InteractivePromptOption[] | undefined = promptConfig.options as InteractivePromptOption[] | undefined
  const config: InteractivePromptConfig | undefined = promptConfig.config as InteractivePromptConfig | undefined
  const timeoutMs = (promptConfig.timeoutMs as number) || 300000

  console.log(`[nomadworks-bridge] Processing clickflow_prompt ${promptId} (${type}) in ${taskId}`)

  try {
    const resp = await createPrompt(
      promptId,
      type as any,
      question,
      sendFn,
      options,
      config,
      timeoutMs,
    )

    // Build the clickflow_result based on response status and type
    let result: Record<string, unknown> = {}

    if (resp.status === 'answered') {
      const response = resp.response || {}
      switch (type) {
        case 'pick_one':
          result = { selected: response.selected as string ?? null, status: 'answered' }
          break
        case 'pick_many':
          result = { selected: (response.selected as string[]) ?? [], status: 'answered' }
          break
        case 'confirm':
          result = { choice: (response.choice as string) ?? 'cancel', status: 'answered' }
          break
        case 'ask_text':
          result = { text: (response.text as string) ?? null, status: 'answered' }
          break
        case 'slider':
          result = { value: (response.value as number) ?? null, status: 'answered' }
          break
      }
    } else if (resp.status === 'timeout') {
      result = { status: 'timeout' }
    } else if (resp.status === 'cancelled') {
      result = { status: 'cancelled' }
    }

    // Write clickflow_result back to the task file
    await writeClickflowResult(taskId, frontmatter, result)

    // Emit progress event for the agent to detect
    const rawPayload = JSON.stringify({
      type: 'agent_progress',
      taskId,
      agentType: 'system',
      stepId: `${taskId}-clickflow-${Date.now()}`,
      stage: 'clickflow_answered',
      content: `ClickFlow prompt '${question}' resolved: ${JSON.stringify(result)}`,
      pct: 100,
      timestamp: new Date().toISOString(),
    })
    progressBus.emit({
      taskId,
      type: 'agent_progress',
      stage: 'clickflow_answered',
      message: `ClickFlow prompt resolved: ${JSON.stringify(result)}`,
      pct: 100,
      rawPayload,
    })

    console.log(`[nomadworks-bridge] clickflow_prompt ${promptId} resolved: ${resp.status}`)
  } catch (err) {
    console.error(`[nomadworks-bridge] clickflow_prompt ${promptId} failed:`, err)
  }
}

/**
 * Write the clickflow_result back into the task file frontmatter.
 * Also sets progress_stage to 'clickflow_answered' so agents can detect the state change.
 */
async function writeClickflowResult(
  taskId: string,
  frontmatter: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const resolved = resolveTaskFile(taskId)
  if (!resolved) {
    console.warn(`[nomadworks-bridge] Cannot write clickflow_result for ${taskId}: file not found`)
    return
  }
  const filePath = resolved.filePath

  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (!match) return

    // Merge results into frontmatter (preserve existing fields)
    const updatedFrontmatter = { ...frontmatter }
    updatedFrontmatter.clickflow_result = result
    updatedFrontmatter.progress_stage = 'clickflow_answered'
    updatedFrontmatter.updatedAt = new Date().toISOString()

    // Remove clickflow_prompt to avoid re-processing (optional — keep for audit trail)
    // We keep it so agents can see what was asked, but idempotency prevents re-processing.

    const newFrontmatter = YAML.stringify(updatedFrontmatter, {
      lineWidth: 0,
      indent: 2,
    })

    const bodyAfterFrontmatter = content.slice(match[0].length)
    const newContent = `---\n${newFrontmatter}---${bodyAfterFrontmatter}`
    fs.writeFileSync(filePath, newContent, 'utf-8')

    console.log(`[nomadworks-bridge] clickflow_result written to ${taskId}`)
  } catch (err) {
    console.error(`[nomadworks-bridge] Failed to write clickflow_result for ${taskId}:`, err)
  }
}

/**
 * Check frontmatter for a clickflow_prompt field and process it if present.
 * Idempotent — only processes prompts that haven't been seen before.
 */
async function detectAndProcessClickflow(
  taskId: string,
  frontmatter: Record<string, unknown>,
  send: (msg: string) => void,
): Promise<void> {
  if (!frontmatter.clickflow_prompt) return

  // Build a unique key from the prompt content to detect new/updated prompts
  const promptConfig = frontmatter.clickflow_prompt as Record<string, unknown>
  const promptKey = `${taskId}::${JSON.stringify(promptConfig)}`

  if (processedClickflowPrompts.has(promptKey)) return
  processedClickflowPrompts.add(promptKey)

  await processClickflowPrompt(taskId, frontmatter, send)
}

/**
 * Watch a task file for status changes and stream updates via WS.
 *
 * Uses a dual-path strategy:
 *   PRIMARY: In-memory ProgressEventBus — updateTaskProgress() emits directly,
 *            subscribers receive the event in the same tick (no polling delay).
 *   FALLBACK: fs.watch — detects changes from external editors, git operations,
 *             or agent writes that bypass updateTaskProgress().
 *
 * De-duplication: the bus records the content it just wrote, and fs.watch
 * skips any change whose content matches. A plain boolean cannot do this —
 * two rapid bus emits leave the flag set for only one of the two fs.watch
 * callbacks, so the second was delivered twice.
 *
 * Returns an unsubscribe function for cleanup.
 */
function watchTask(
  taskId: string,
  send: (msg: string) => void,
  onStatus?: (status: TaskStatus) => void,
): () => void {
  // If already watching, return existing unsubscribe
  const existing = activeWatchers.get(taskId)
  if (existing) return existing

  const resolved = resolveTaskFile(taskId)
  if (!resolved) {
    console.warn(`[nomadworks-bridge] Cannot watch ${taskId}: file not found in any lane`)
    return () => { /* no-op */ }
  }
  const filePath = resolved.filePath
  let currentLane: TaskLane = resolved.lane

  let lastContent = fs.readFileSync(filePath, "utf-8")
  /** Content hashes already delivered via the bus — fs.watch skips these. */
  const emittedContent = new Set<string>()

  const rememberEmitted = () => {
    try {
      const now = fs.readFileSync(filePath, "utf-8")
      emittedContent.add(now)
      // Bound the set — only the most recent writes can race with fs.watch.
      if (emittedContent.size > 8) {
        emittedContent.delete(emittedContent.values().next().value as string)
      }
    } catch { /* file may have moved lanes */ }
  }

  // ══════════════════════════════════════════════════════════════
  // PRIMARY PATH: subscribe to in-memory event bus
  // ══════════════════════════════════════════════════════════════
  const busUnsub = progressBus.subscribe(taskId, (event) => {
    rememberEmitted()
    send(event.rawPayload)

    if (event.stage === "complete") {
      const sid = extractSessionIdFromFile(taskId)
      collectEvidence(taskId, sid, send).catch(() => {})
      streamCausalUpdate(taskId, sid, send).catch(() => {})
    }

    if (
      event.type === "nomadworks_task_status" &&
      event.status &&
      isTerminalStatus(event.status as CanonicalTaskStatus)
    ) {
      const sid = extractSessionIdFromFile(taskId)
      collectEvidence(taskId, sid, send).catch(() => {})
      streamCausalUpdate(taskId, sid, send).catch(() => {})
      unsubscribe()
    }
  })

  // ══════════════════════════════════════════════════════════════
  // FALLBACK PATH: fs.watch for external edits
  // ══════════════════════════════════════════════════════════════
  const watcher = fs.watch(filePath, (eventType) => {
    try {
      let content: string
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, "utf-8")
      } else {
        // The file is gone from this lane. That is almost always a lane MOVE
        // (todo → blocked / done), which is a state transition, not a deletion —
        // reporting "removed" here dropped every completion that closed by
        // moving the file. Re-resolve before concluding anything.
        const moved = resolveTaskFile(taskId)
        if (!moved) {
          send(JSON.stringify({
            type: "nomadworks_task_status",
            taskId,
            status: "cancelled",
            terminal: true,
            reason: "task file removed from all lanes",
          }))
          unsubscribe()
          return
        }
        currentLane = moved.lane
        content = fs.readFileSync(moved.filePath, "utf-8")
        const movedStatus = parseTaskFile(content, taskId, currentLane)
        if (movedStatus) {
          send(JSON.stringify({ type: "nomadworks_task_status", ...movedStatus, laneChanged: true }))
          if (onStatus) onStatus(movedStatus)
          if (movedStatus.terminal) {
            collectEvidence(taskId, (movedStatus.sessionId as string) || "", send).catch(() => {})
            streamCausalUpdate(taskId, (movedStatus.sessionId as string) || "", send).catch(() => {})
            unsubscribe()
          }
        }
        return
      }

      if (eventType !== "change") return
      // Already delivered through the event bus — skip the fs.watch round-trip.
      if (emittedContent.has(content)) return
      if (content === lastContent) return
      lastContent = content

      const status = parseTaskFile(content, taskId, currentLane)
      if (!status) return

      send(JSON.stringify({ type: "nomadworks_task_status", ...status }))
      if (onStatus) onStatus(status)

      // ── Agent Progress Detection (fs.watch fallback) ────
      const currentStage = status.progressStage
      const currentMessage = status.progressMessage
      const lastKnown = lastProgressMap.get(taskId)

      if (currentStage && (currentStage !== lastKnown?.stage || currentMessage !== lastKnown?.message)) {
        lastProgressMap.set(taskId, { stage: currentStage, message: currentMessage })

        const stepId = `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const rawSessionId = (status.sessionId as string) || ""
        const rawAgentType = (status as any).agentType as string | undefined
        const agentType = rawSessionId.startsWith("ses_") ? rawAgentType || "developer" : "developer"

        send(JSON.stringify({
          type: "agent_progress", taskId, agentType,
          sessionId: status.sessionId || "", stepId,
          stage: currentStage, content: currentMessage || "",
          pct: status.progressPct, timestamp: new Date().toISOString(),
        }))

        if (currentStage === "complete") {
          collectEvidence(taskId, status.sessionId as string || "", send).catch(() => {})
          streamCausalUpdate(taskId, status.sessionId as string || "", send).catch(() => {})
        }
      }
      // ── End Agent Progress Detection ─────────────────────

      // ── ClickFlow Prompt Detection ─────────────────────────────
      // Check if the task file has a clickflow_prompt field that hasn't
      // been processed yet. This allows agents to ask interactive questions
      // by writing to the task file frontmatter.
      if (status.clickflow_prompt && !status.clickflow_result) {
        // Re-parse the full frontmatter object
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
        if (fmMatch) {
          try {
            const fullFm = YAML.parse(fmMatch[1])
            if (fullFm && typeof fullFm === 'object' && fullFm.clickflow_prompt) {
              // Process asynchronously — don't block the fs.watch handler
              detectAndProcessClickflow(taskId, fullFm, send).catch((err) => {
                console.error(`[nomadworks-bridge] ClickFlow detection error for ${taskId}:`, err)
              })
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
      // ── End ClickFlow Prompt Detection ──────────────────────

      if (status.terminal) {
        const sid = (status.sessionId as string) || (status.sourceStepId as string) || ""
        collectEvidence(taskId, sid, send).catch(() => {})
        streamCausalUpdate(taskId, sid, send).catch(() => {})
        unsubscribe()
      }
    } catch {
      // Ignore transient errors during rapid writes
    }
  })

  const unsubscribe = () => {
    try { watcher.close() } catch { /* already closed */ }
    busUnsub()
    activeWatchers.delete(taskId)
    progressBus.unsubscribeAll(taskId)
  }

  activeWatchers.set(taskId, unsubscribe)
  return unsubscribe
}

/** Read a taskId's sessionId from disk (best-effort, for evidence collection). */
function extractSessionIdFromFile(taskId: string): string {
  try {
    const resolved = resolveTaskFile(taskId)
    if (!resolved) return ""
    const content = fs.readFileSync(resolved.filePath, "utf-8")
    const fm = content.match(/^---\n([\s\S]*?)\n---/)
    if (!fm) return ""
    const parsed = YAML.parse(fm[1])
    return (parsed?.sessionId as string) || (parsed?.sourceStepId as string) || ""
  } catch {
    return ""
  }
}

/**
 * List all NomadWorks task files from disk.
 * Scans tasks/todo/ and tasks/done/ directories for .md files with
 * YAML frontmatter, and checks whether evidence exists for each task.
 */
async function listTasks(sessionId?: string): Promise<TaskStatus[]> {
  const results: TaskStatus[] = []
  const seen = new Set<string>()

  // All three lanes — omitting `blocked` made blocked work invisible to every
  // caller that lists tasks, including the concierge's own status reporting.
  for (const { lane, dir } of TASK_LANES) {
    if (!fs.existsSync(dir)) continue

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue

      const filePath = path.join(dir, entry.name)
      try {
        const content = fs.readFileSync(filePath, "utf-8")
        const status = parseTaskFile(content, entry.name.replace(".md", ""), lane)

        if (status && status.taskId && !seen.has(status.taskId)) {
          // When sessionId is provided, only include tasks whose frontmatter sessionId matches
          if (sessionId && status.sessionId !== sessionId) continue

          seen.add(status.taskId)

          // Check for evidence directory
          const evidenceDir = path.join(EVIDENCES_ROOT, status.taskId)
          const hasEvidence = fs.existsSync(path.join(evidenceDir, "SUMMARY.md"))
          if (hasEvidence) {
            status.hasEvidence = true
            try {
              status.evidenceSummary = fs.readFileSync(
                path.join(evidenceDir, "SUMMARY.md"),
                "utf-8",
              )
            } catch {
              // ignore read errors on evidence
            }
          }

          results.push(status)
        }
      } catch {
        // Skip unparseable files
      }
    }
  }

  // Sort newest-first by updatedAt, then createdAt
  return results.sort((a, b) => {
    const aTime = a.updatedAt || a.createdAt || ""
    const bTime = b.updatedAt || b.createdAt || ""
    return bTime.localeCompare(aTime)
  })
}

// ── Default Bridge Instance ───────────────────────────────────

/** Global ProgressEventBus instance shared by updateTaskProgress and watchTask. */
const progressBus = new ProgressEventBus()

export const bridge: NomadworksBridge = {
  createTaskFile,
  readTaskStatus,
  watchTask,
  listTasks,
  updateTaskProgress,
  eventBus: progressBus,
}

/** Directories the bridge treats as task lanes (exported for diagnostics/tests). */
export const TASK_LANE_DIRS = { todo: TODO_DIR, blocked: BLOCKED_DIR, done: DONE_DIR }
