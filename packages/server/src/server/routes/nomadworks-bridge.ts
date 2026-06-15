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
 *                          │      └── Returns status to caller
 *                          └── 3. watchTask — fs.watch for status changes
 *                                 └── Sends nomadworks_task_status updates
 */

import fs from "fs"
import path from "path"
import crypto from "crypto"
import YAML from "yaml"

// ── Constants ─────────────────────────────────────────────────

/** Root of the repository (set by environment or cwd). */
const REPO_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()
const TASKS_ROOT = path.join(REPO_ROOT, "tasks")
const TODO_DIR = path.join(TASKS_ROOT, "todo")
const CURRENT_FILE = path.join(TASKS_ROOT, "current.md")
const BRIDGE_SECTION = "## Bridge-Initiated Tasks"

// ── Idempotency Cache ─────────────────────────────────────────
// key = `${sessionId}::${intent}` — avoids duplicate task files
const taskCache = new Map<string, { taskId: string; taskFilePath: string }>()

// ── Active Watchers ───────────────────────────────────────────
// key = taskId — ensures at most one watcher per task
const activeWatchers = new Map<string, () => void>()

// ── Public Types ──────────────────────────────────────────────

export interface CreateTaskParams {
  intent: string
  agentType: string
  context: Record<string, unknown>
  sessionId: string
  complexity?: "tiny" | "standard" | "complex"
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
  [key: string]: unknown
}

export interface CreateTaskResult {
  taskId: string
  taskFilePath: string
}

export interface NomadworksBridge {
  createTaskFile(params: CreateTaskParams): Promise<CreateTaskResult>
  readTaskStatus(taskId: string): Promise<TaskStatus | null>
  watchTask(taskId: string, send: (msg: string) => void): () => void
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
  const { intent, agentType, context, sessionId, complexity = "standard" } = params

  // Check idempotency cache first
  const cacheKey = `${sessionId}::${intent}`
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
    `complexity: ${complexity}`,
    "track: implementation",
    "slice: core",
    `status: created`,
    `createdAt: ${timestamp}`,
    `updatedAt: ${timestamp}`,
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
 * Watch a task file for status changes and stream updates via WS.
 * Returns an unsubscribe function for cleanup.
 */
function watchTask(
  taskId: string,
  send: (msg: string) => void,
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

  // macOS fs.watch is reliable for single-file changes
  const watcher = fs.watch(filePath, (eventType) => {
    if (eventType !== "change") return

    try {
      if (!fs.existsSync(filePath)) {
        send(
          JSON.stringify({
            type: "nomadworks_task_status",
            taskId,
            status: "removed",
          }),
        )
        return
      }

      const content = fs.readFileSync(filePath, "utf-8")
      if (content === lastContent) return // deduplicate spurious events
      lastContent = content

      const status = parseTaskFile(content, taskId)
      if (status) {
        send(
          JSON.stringify({
            type: "nomadworks_task_status",
            ...status,
          }),
        )
      }
    } catch {
      // Ignore transient errors during rapid writes
    }
  })

  const unsubscribe = () => {
    try {
      watcher.close()
    } catch {
      // Already closed
    }
    activeWatchers.delete(taskId)
  }

  activeWatchers.set(taskId, unsubscribe)
  return unsubscribe
}

// ── Default Bridge Instance ───────────────────────────────────

export const bridge: NomadworksBridge = {
  createTaskFile,
  readTaskStatus,
  watchTask,
}
