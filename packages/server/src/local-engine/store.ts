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

export type LocalSession = {
  id: string
  folder: string
  title: string
  agent: string
  model?: { providerId: string; modelId: string }
  createdAt: number
  updatedAt: number
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
}

const KEY = /^[A-Za-z0-9_.:-]{1,200}$/

/** Keys come from clients; keep them to safe file names. */
export function safeKey(key: string): string | null {
  return KEY.test(key) && !key.includes("..") ? key : null
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

  listSessions(folder?: string): LocalSession[] {
    const all = Object.values(this.readSessions())
    const wanted = folder ? path.resolve(folder) : null
    return all
      .filter((session) => !wanted || path.resolve(session.folder) === wanted)
      .sort((a, b) => b.updatedAt - a.updatedAt)
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

  deleteSession(id: string): boolean {
    const sessions = { ...this.readSessions() }
    const existed = Boolean(sessions[id])
    delete sessions[id]
    if (existed) this.writeSessions(sessions)
    this.deleteHistory(id)
    return existed
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
    this.writeHistory(key, messages.slice(0, index))
    return messages.length - index
  }

  deleteHistoryMessage(key: string, messageId: string): boolean {
    const messages = this.readHistory(key)
    const next = messages.filter((m) => m.id !== messageId)
    if (next.length === messages.length) return false
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
    const messages = this.historyBefore(from, beforeMessageId)
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
