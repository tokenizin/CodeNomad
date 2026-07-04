/**
 * PMA Proxy Module — NomadWorks Bridge for TokiDAPP
 *
 * Translates TokiDAPP WebSocket orchestration requests into NomadWorks
 * task files on disk, and streams execution status back to the frontend.
 *
 * Architecture:
 *   TokiDAPP UI ──WS──→ CodeNomad Server (:9899)
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

// ── Constants ─────────────────────────────────────────────────

/** Root of the repository (set by environment or cwd). */
const REPO_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()
const TASKS_ROOT = path.join(REPO_ROOT, "tasks")
const TODO_DIR = path.join(TASKS_ROOT, "todo")
const CURRENT_FILE = path.join(TASKS_ROOT, "current.md")
const BRIDGE_SECTION = "## Bridge-Initiated Tasks"
const EVIDENCES_ROOT = path.join(REPO_ROOT, "evidences")

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

// ── Public Types ──────────────────────────────────────────────

export type AgentProgressStage =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'executing'
  | 'reviewing'
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
  status: string
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
function parseTaskFile(content: string, taskId: string): TaskStatus | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null

  try {
    const frontmatter = YAML.parse(match[1])
    if (!frontmatter || typeof frontmatter !== "object") return null

    return {
      taskId: (frontmatter.task_id as string) || taskId,
      status: (frontmatter.status as string) || "unknown",
      complexity: frontmatter.complexity as string | undefined,
      track: frontmatter.track as string | undefined,
      slice: frontmatter.slice as string | undefined,
      title: frontmatter.title as string | undefined,
      createdAt: frontmatter.createdAt as string | undefined,
      updatedAt: frontmatter.updatedAt as string | undefined,
      ...frontmatter,
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
  const candidates = [
    path.join(TODO_DIR, `${taskId}.md`),
    path.join(TASKS_ROOT, "done", `${taskId}.md`),
  ]

  let filePath: string | null = null
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      filePath = p
      break
    }
  }

  if (!filePath) return null

  try {
    const content = fs.readFileSync(filePath, "utf-8")
    return parseTaskFile(content, taskId)
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
      if (status.status === 'completed' || status.status === 'done') {
        unwatch()
        // Collect evidence and link to execution node
        collectEvidence(taskId, executionId, send).catch(() => {})
        resolve({ taskId, evidence: status })
      } else if (status.status === 'failed') {
        unwatch()
        const errorMessage =
          typeof status.errorMessage === "string" && status.errorMessage.trim().length > 0
            ? status.errorMessage
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
  const candidates = [
    path.join(TODO_DIR, `${taskId}.md`),
    path.join(TASKS_ROOT, "done", `${taskId}.md`),
  ]

  let filePath: string | null = null
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      filePath = p
      break
    }
  }

  if (!filePath) {
    console.warn(`[nomadworks-bridge] Cannot update progress for ${taskId}: file not found`)
    return
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const match = content.match(/^---\n([\s\S]*?)\n---/)

    if (!match) {
      console.warn(`[nomadworks-bridge] Cannot parse frontmatter for ${taskId}`)
      return
    }

    const frontmatter = YAML.parse(match[1])
    if (!frontmatter || typeof frontmatter !== "object") return

    frontmatter.progress_stage = stage
    frontmatter.progress_message = message
    frontmatter.progress_pct = pct ?? frontmatter.progress_pct ?? 0
    frontmatter.updatedAt = new Date().toISOString()

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
      stepId: `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      stage,
      content: message,
      pct: pct ?? frontmatter.progress_pct ?? 0,
      timestamp: new Date().toISOString(),
    })
    progressBus.emit({
      taskId,
      type: "agent_progress",
      stage,
      message,
      pct: pct ?? frontmatter.progress_pct ?? 0,
      rawPayload,
    })

    // Also emit a nomadworks_task_status event for status-polling subscribers
    const taskStatusPayload = JSON.stringify({
      type: "nomadworks_task_status",
      taskId,
      status: frontmatter.status || "in_progress",
      complexity: frontmatter.complexity,
      progress_stage: stage,
      progress_message: message,
      progress_pct: pct ?? frontmatter.progress_pct ?? 0,
      updatedAt: frontmatter.updatedAt,
    })
    progressBus.emit({
      taskId,
      type: "nomadworks_task_status",
      stage,
      status: frontmatter.status as string | undefined,
      rawPayload: taskStatusPayload,
    })
  } catch (err) {
    console.error(`[nomadworks-bridge] Failed to update progress for ${taskId}:`, err)
  }
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
 * The hasDirectEmit flag prevents double-delivery when the event bus fires
 * first and fs.watch fires shortly after.
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

  const filePath = path.join(TODO_DIR, `${taskId}.md`)

  if (!fs.existsSync(filePath)) {
    console.warn(`[nomadworks-bridge] Cannot watch ${taskId}: file not found`)
    return () => { /* no-op */ }
  }

  let lastContent = fs.readFileSync(filePath, "utf-8")
  let hasDirectEmit = false // bus fired; fs.watch should skip the next change

  // ══════════════════════════════════════════════════════════════
  // PRIMARY PATH: subscribe to in-memory event bus
  // ══════════════════════════════════════════════════════════════
  const busUnsub = progressBus.subscribe(taskId, (event) => {
    hasDirectEmit = true
    send(event.rawPayload)

    if (event.stage === "complete") {
      const sid = extractSessionIdFromFile(taskId)
      collectEvidence(taskId, sid, send).catch(() => {})
      streamCausalUpdate(taskId, sid, send).catch(() => {})
    }

    if (event.type === "nomadworks_task_status" && (event.status === "completed" || event.status === "failed")) {
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
    if (eventType !== "change") return
    // If the event bus already handled this update, skip the fs.watch round-trip
    if (hasDirectEmit) {
      hasDirectEmit = false
      return
    }

    try {
      if (!fs.existsSync(filePath)) {
        send(JSON.stringify({ type: "nomadworks_task_status", taskId, status: "removed" }))
        return
      }

      const content = fs.readFileSync(filePath, "utf-8")
      if (content === lastContent) return
      lastContent = content

      const status = parseTaskFile(content, taskId)
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

      if (status.status === "completed" || status.status === "failed") {
        collectEvidence(taskId, status.sourceStepId as string || "", send).catch(() => {})
        streamCausalUpdate(taskId, status.sourceStepId as string || "", send).catch(() => {})
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
    const p = path.join(TODO_DIR, `${taskId}.md`)
    if (!fs.existsSync(p)) return ""
    const content = fs.readFileSync(p, "utf-8")
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

  const directories = [
    { dir: TODO_DIR, prefix: "todo" },
    { dir: path.join(TASKS_ROOT, "done"), prefix: "done" },
  ]

  for (const { dir } of directories) {
    if (!fs.existsSync(dir)) continue

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue

      const filePath = path.join(dir, entry.name)
      try {
        const content = fs.readFileSync(filePath, "utf-8")
        const status = parseTaskFile(content, entry.name.replace(".md", ""))

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
