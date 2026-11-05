/**
 * On-disk store for local-engine chats, under <CodeNomad data dir>/local-engine:
 *
 *   sessions.json              sessions created without OpenCode (id → LocalSession)
 *   history/<key>.jsonl        one line per message, for any session key
 *                              (local sessions and OpenCode sessions alike)
 *   attachments/<key>/<file>   pasted files saved so the engine can read them
 *
 * Writes are synchronous and small; one CodeNomad server owns the folder.
 */

import { randomBytes } from "crypto"
import fs from "fs"
import path from "path"
import type { ReplyPart } from "./reply-parts.js"

export const LOCAL_SESSION_PREFIX = "ses_lcl_"

/** The session that holds a delegated task's own transcript (protocol 2). Same id every time the task is resumed. */
export function taskSessionId(taskId: string): string {
  return `${LOCAL_SESSION_PREFIX}t_${taskId}`
}

export type TaskRunStatus = "running" | "completed" | "failed" | "aborted"

export type LocalSession = {
  id: string
  folder: string
  title: string
  agent: string
  model?: { providerId: string; modelId: string }
  createdAt: number
  updatedAt: number
  /** Task sessions only: the session (or task session) that delegated to it. */
  parentId?: string
  /** "task" = a delegated subagent's transcript. Left out of the default session list. */
  kind?: "task"
  taskId?: string
  /** The parent's Task tool-call id (the card this session belongs to). */
  parentCallId?: string
  taskStatus?: TaskRunStatus
}

export type HistoryAttachment = { filename: string; mime?: string; path?: string }

export type HistoryMessage = {
  id: string
  role: "user" | "assistant"
  /** Plain text (what the agent gets as context in later turns). */
  text: string
  createdAt: number
  engine?: string
  agent?: string
  model?: string
  isError?: boolean
  attachments?: HistoryAttachment[]
  /** Assistant replies: text and tool-call parts in order, for display. */
  parts?: ReplyPart[]
  /** Assistant replies: token usage of the last model call (context in use). */
  usage?: { input: number; output: number; reasoning: number; cacheRead: number }
}

const KEY = /^[A-Za-z0-9_.:-]{1,200}$/

/** Keys come from clients; keep them to safe file names. */
export function safeKey(key: string): string | null {
  return KEY.test(key) && !key.includes("..") ? key : null
}

function withoutTaskLinks(message: HistoryMessage): HistoryMessage {
  if (!message.parts?.some((p) => p.type === "tool" && p.childSessionId)) return message
  return {
    ...message,
    parts: message.parts.map((p) => {
      if (p.type !== "tool" || !p.childSessionId) return p
      const { childSessionId: _dropped, ...rest } = p
      return rest
    }),
  }
}

function safeFileName(name: string): string {
  const base = path.basename(name || "attachment").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  return base.slice(0, 120) || "attachment"
}

export class LocalEngineStore {
  private readonly root: string
  private sessionsCache: Record<string, LocalSession> | null = null

  constructor(baseDir: string) {
    this.root = path.join(baseDir, "local-engine")
  }

  // ------------------------------------------------------------ sessions

  private get sessionsFile() {
    return path.join(this.root, "sessions.json")
  }

  private readSessions(): Record<string, LocalSession> {
    if (this.sessionsCache) return this.sessionsCache
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionsFile, "utf8"))
      this.sessionsCache = parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      this.sessionsCache = {}
    }
    return this.sessionsCache!
  }

  private writeSessions(sessions: Record<string, LocalSession>) {
    fs.mkdirSync(this.root, { recursive: true })
    const tmp = `${this.sessionsFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2))
    fs.renameSync(tmp, this.sessionsFile)
    this.sessionsCache = sessions
  }

  /** Task sessions (delegated subagents) are only listed when asked for: the session list stays as it was. */
  listSessions(folder?: string, options?: { includeTasks?: boolean }): LocalSession[] {
    const all = Object.values(this.readSessions())
    const wanted = folder ? path.resolve(folder) : null
    return all
      .filter((session) => options?.includeTasks || session.kind !== "task")
      .filter((session) => !wanted || path.resolve(session.folder) === wanted)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Sessions delegated by `parentId` (direct children only). */
  listChildren(parentId: string): LocalSession[] {
    return Object.values(this.readSessions()).filter((session) => session.parentId === parentId)
  }

  /**
   * The session for a delegated task: created on first sight, reused when the
   * same task_id is resumed (its later turns are appended to the same transcript).
   */
  upsertTaskSession(input: {
    taskId: string
    parentId: string
    parentCallId: string
    folder: string
    title: string
    agent: string
    model?: string
  }): { session: LocalSession; created: boolean } {
    const id = taskSessionId(input.taskId)
    if (!safeKey(id)) throw new Error(`Invalid task id: ${input.taskId}`)
    const sessions = this.readSessions()
    const now = Date.now()
    const existing = sessions[id]
    const session: LocalSession = {
      id,
      folder: input.folder,
      title: input.title.trim().slice(0, 200) || "Task",
      agent: input.agent,
      ...(input.model ? { model: { providerId: "claude-code-rust", modelId: input.model } } : existing?.model ? { model: existing.model } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      parentId: input.parentId,
      kind: "task",
      taskId: input.taskId,
      parentCallId: input.parentCallId,
      taskStatus: "running",
    }
    this.writeSessions({ ...sessions, [id]: session })
    return { session, created: !existing }
  }

  /**
   * Task sessions still marked running when the server starts did not finish: the server that was
   * running them stopped first. Marks them failed. Returns how many it changed.
   */
  reconcileInterruptedTasks(): number {
    const sessions = this.readSessions()
    const next = { ...sessions }
    let changed = 0
    for (const session of Object.values(sessions)) {
      if (session.kind !== "task" || session.taskStatus !== "running") continue
      next[session.id] = { ...session, taskStatus: "failed", updatedAt: Date.now() }
      changed += 1
    }
    if (changed > 0) this.writeSessions(next)
    return changed
  }

  setTaskStatus(id: string, status: TaskRunStatus): void {
    const current = this.readSessions()[id]
    if (!current || current.kind !== "task") return
    this.writeSessions({ ...this.readSessions(), [id]: { ...current, taskStatus: status, updatedAt: Date.now() } })
  }

  getSession(id: string): LocalSession | undefined {
    return this.readSessions()[id]
  }

  createSession(input: { folder: string; title?: string; agent?: string; model?: LocalSession["model"] }): LocalSession {
    const now = Date.now()
    const id = `${LOCAL_SESSION_PREFIX}${now.toString(36)}${randomBytes(6).toString("hex")}`
    const session: LocalSession = {
      id,
      folder: input.folder,
      title: input.title?.trim() || "New Session",
      agent: input.agent?.trim() || "",
      ...(input.model ? { model: input.model } : {}),
      createdAt: now,
      updatedAt: now,
    }
    this.writeSessions({ ...this.readSessions(), [id]: session })
    return session
  }

  updateSession(id: string, patch: Partial<Pick<LocalSession, "title" | "agent" | "model">>): LocalSession | undefined {
    const sessions = this.readSessions()
    const current = sessions[id]
    if (!current) return undefined
    const next: LocalSession = { ...current, updatedAt: Date.now() }
    if (typeof patch.title === "string" && patch.title.trim()) next.title = patch.title.trim().slice(0, 200)
    if (typeof patch.agent === "string") next.agent = patch.agent.trim()
    if (patch.model && typeof patch.model.providerId === "string" && typeof patch.model.modelId === "string") {
      next.model = { providerId: patch.model.providerId, modelId: patch.model.modelId }
    }
    this.writeSessions({ ...sessions, [id]: next })
    return next
  }

  /** Deleting a session deletes the task sessions it delegated (and theirs), and nothing else. */
  deleteSession(id: string): boolean {
    for (const child of this.listChildren(id)) if (child.kind === "task") this.deleteSession(child.id)
    const sessions = { ...this.readSessions() }
    const existed = Boolean(sessions[id])
    delete sessions[id]
    if (existed) this.writeSessions(sessions)
    this.deleteHistory(id)
    return existed
  }

  /**
   * Task sessions linked from the removed messages' Task cards go with them,
   * unless a message that stays still links to the same one (a resumed task
   * keeps its session across turns).
   */
  private dropTaskSessionsOf(removed: HistoryMessage[], kept: HistoryMessage[]) {
    const links = (messages: HistoryMessage[]) =>
      messages.flatMap((m) => (m.parts ?? []).flatMap((p) => (p.type === "tool" && p.childSessionId ? [p.childSessionId] : [])))
    const stillLinked = new Set(links(kept))
    for (const id of new Set(links(removed))) if (!stillLinked.has(id)) this.deleteSession(id)
  }

  // ------------------------------------------------------------ history

  private historyFile(key: string) {
    return path.join(this.root, "history", `${key}.jsonl`)
  }

  readHistory(key: string): HistoryMessage[] {
    const safe = safeKey(key)
    if (!safe) return []
    let text: string
    try {
      text = fs.readFileSync(this.historyFile(safe), "utf8")
    } catch {
      return []
    }
    const messages: HistoryMessage[] = []
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed.id === "string" && (parsed.role === "user" || parsed.role === "assistant")) {
          messages.push(parsed)
        }
      } catch {
        /* skip a torn line */
      }
    }
    return messages
  }

  appendHistory(key: string, messages: HistoryMessage[]) {
    const safe = safeKey(key)
    if (!safe || messages.length === 0) return
    const file = this.historyFile(safe)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, messages.map((m) => JSON.stringify(m)).join("\n") + "\n")
    const session = this.readSessions()[safe]
    if (session) {
      // First prompt names an untitled local session.
      const firstUser = messages.find((m) => m.role === "user")
      const title =
        session.title === "New Session" && firstUser?.text.trim()
          ? firstUser.text.trim().replace(/\s+/g, " ").slice(0, 60)
          : undefined
      this.updateSession(safe, title ? { title } : {})
    }
  }

  /** Replaces a session's history (atomic write). */
  writeHistory(key: string, messages: HistoryMessage[]) {
    const safe = safeKey(key)
    if (!safe) return
    const file = this.historyFile(safe)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length ? "\n" : ""))
    fs.renameSync(tmp, file)
  }

  /** Messages before `messageId` (all of them when it's not given or not found). */
  historyBefore(key: string, messageId?: string): HistoryMessage[] {
    const messages = this.readHistory(key)
    if (!messageId) return messages
    const index = messages.findIndex((m) => m.id === messageId)
    return index < 0 ? messages : messages.slice(0, index)
  }

  /** Revert: drops `messageId` and everything after it. Returns how many were removed. */
  truncateHistory(key: string, messageId: string): number {
    const messages = this.readHistory(key)
    const index = messages.findIndex((m) => m.id === messageId)
    if (index < 0) return 0
    this.dropTaskSessionsOf(messages.slice(index), messages.slice(0, index))
    this.writeHistory(key, messages.slice(0, index))
    return messages.length - index
  }

  deleteHistoryMessage(key: string, messageId: string): boolean {
    const messages = this.readHistory(key)
    const next = messages.filter((m) => m.id !== messageId)
    if (next.length === messages.length) return false
    this.dropTaskSessionsOf(messages.filter((m) => m.id === messageId), next)
    this.writeHistory(key, next)
    return true
  }

  /** Compact: replaces older messages with a single summary, keeping the most recent `keepCount`. */
  compactHistory(key: string, keepCount = 20): { compacted: boolean; total: number; kept: number } {
    const safe = safeKey(key)
    if (!safe) return { compacted: false, total: 0, kept: 0 }
    const history = this.readHistory(key)
    if (history.length <= keepCount) return { compacted: false, total: history.length, kept: history.length }

    const removed = history.slice(0, history.length - keepCount)
    const keep = history.slice(history.length - keepCount)

    const parts: string[] = []
    for (const msg of removed) {
      const text = msg.text.trim().replace(/\n+/g, " ").slice(0, 160)
      if (msg.role === "user") {
        parts.push(`User: ${text}${text.length >= 160 ? "…" : ""}`)
      } else if (msg.role === "assistant" && !msg.isError) {
        parts.push(`Assistant: ${text}${text.length >= 160 ? "…" : ""}`)
      }
    }

    const summary: HistoryMessage = {
      id: `msg_summary_${Date.now().toString(36)}`,
      role: "assistant",
      text: `[Summarized ${removed.length} earlier messages]\n\n${parts.join("\n")}`,
      createdAt: Date.now(),
      engine: "local-engine-compact",
      isError: false,
    }

    this.writeHistory(safe, [summary, ...keep])
    return { compacted: true, total: history.length, kept: keep.length }
  }

  /** Fork: copies history before `messageId` from one session key to another. */
  copyHistory(from: string, to: string, beforeMessageId?: string): number {
    // A fork gets its own copy of the turns, not the original's task sessions: those
    // belong to (and are deleted with) the original, so the copied Task cards lose their link.
    const messages = this.historyBefore(from, beforeMessageId).map(withoutTaskLinks)
    if (messages.length) this.writeHistory(to, messages)
    // Subagents named in the copied turns can be resumed from the fork too.
    const tasks = this.tasksDir(from)
    if (messages.length && fs.existsSync(tasks)) fs.cpSync(tasks, this.tasksDir(to), { recursive: true })
    return messages.length
  }

  deleteHistory(key: string) {
    const safe = safeKey(key)
    if (!safe) return
    fs.rmSync(this.historyFile(safe), { force: true })
    fs.rmSync(path.join(this.root, "attachments", safe), { recursive: true, force: true })
    fs.rmSync(this.tasksDir(safe), { recursive: true, force: true })
  }

  /** Where the Rust agent keeps this session's subagent (Task) conversations. */
  tasksDir(key: string): string {
    return path.join(this.root, "tasks", safeKey(key) ?? "_unsorted")
  }

  // ------------------------------------------------------------ attachments

  /** Saves a pasted file and returns its absolute path. */
  saveAttachment(key: string, filename: string, data: Buffer): string {
    const safe = safeKey(key) ?? "_unsorted"
    const dir = path.join(this.root, "attachments", safe)
    fs.mkdirSync(dir, { recursive: true })
    const name = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}-${safeFileName(filename)}`
    const file = path.join(dir, name)
    fs.writeFileSync(file, data)
    return file
  }

  attachmentsDir(key: string): string {
    return path.join(this.root, "attachments", safeKey(key) ?? "_unsorted")
  }
}
