/**
 * Client helpers for Claude Code (Rust), CodeNomad's local chat engine: the
 * Rust re-implementation of Claude Code from build-your-own-claude-code
 * (playground/rust), run by the CodeNomad server. Not the official Claude Code
 * app or CLI.
 */

/** Provider id for the agent's models in the model picker. */
export const RUST_PROVIDER_ID = "claude-code-rust"
export const RUST_PROVIDER_NAME = "Claude Code (Rust)"
/** Agent entry meaning "no --agent": the full agent with all tools and skills. */
export const RUST_DEFAULT_AGENT = "claude-code"

export type LocalEngineStatus = {
  ok: boolean
  engine?: string
  rust?: {
    ok: boolean
    /** playground/rust/your_program.sh in the build-your-own-claude-code checkout. */
    runner: string | null
    playgroundRoot: string | null
    error: string | null
  }
  opencodeConfig?: string | null
  workspaceRoots?: string[]
  activeRuns?: number
}

/** What the agent reports with --catalog. */
export type RustCatalog = {
  version: number
  model: string
  baseUrl?: string
  models: Array<{ id: string; name?: string }>
  modelsError?: string | null
  agents: Array<{ name: string; description?: string; model?: string | null }>
  commands: Array<{ name: string; description?: string; agent?: boolean }>
}

/** Server-side settings, stored in the server config under `localEngine`. */
export type LocalEngineServerSettings = {
  playgroundRoot?: string
  opencodeConfig?: string
  extraRoots?: string[]
}

export type LocalEngineUpload = { filename: string; mime?: string; data: string }

export type LocalEngineRunRequest = {
  prompt: string
  cwd?: string
  sessionKey?: string
  agent?: string
  model?: string
  persist?: boolean
  /** Pasted files (data: URLs), sent inline as base64. */
  uploads?: LocalEngineUpload[]
  /** Ids already on screen, so saved history matches them after a reload. */
  messageIds?: { user: string; assistant: string }
  /** The user's text as shown (without attachment lines). */
  displayText?: string
  attachmentNames?: string[]
}

export type HistoryPart =
  | { type: "text"; text: string }
  | {
      type: "tool"
      id: string
      tool: string
      input: Record<string, unknown>
      status: "running" | "completed" | "error"
      output?: string
      startedAt: number
      endedAt?: number
    }

/** A message saved by the server for a session. */
export type LocalHistoryMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  createdAt: number
  engine?: string
  agent?: string
  model?: string
  isError?: boolean
  attachments?: Array<{ filename: string; mime?: string; path?: string }>
  parts?: HistoryPart[]
}

/** A session kept by CodeNomad (no OpenCode). */
export type LocalSessionRecord = {
  id: string
  folder: string
  title: string
  agent: string
  model?: { providerId: string; modelId: string }
  createdAt: number
  updatedAt: number
  parentId?: string
}

export const LOCAL_SESSION_PREFIX = "ses_lcl_"

/** Runs this tab is streaming, keyed by instance + session (so Stop can cancel them). */
export const localEngineRuns = new Map<string, AbortController>()
export const localRunKey = (instanceId: string, sessionId: string) => `${instanceId}\u0000${sessionId}`

export function isLocalSessionId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === "string" && sessionId.startsWith(LOCAL_SESSION_PREFIX)
}

// ---------------------------------------------------------------- parts (OpenCode shape)

/** An OpenCode-style message part for a saved/live reply part. */
export function toOpencodePart(sessionId: string, messageId: string, part: HistoryPart, index: number): any {
  const id = `${messageId}_p${index}`
  if (part.type === "text") {
    return { id, sessionID: sessionId, messageID: messageId, type: "text", text: part.text }
  }
  const time = { start: part.startedAt, ...(part.endedAt ? { end: part.endedAt } : {}) }
  const state =
    part.status === "running"
      ? { status: "running", input: part.input, time }
      : part.status === "error"
        ? { status: "error", input: part.input, error: part.output ?? "Failed", time: { ...time, end: part.endedAt ?? part.startedAt } }
        : {
            status: "completed",
            input: part.input,
            output: part.output ?? "",
            title: part.tool,
            metadata: {},
            time: { ...time, end: part.endedAt ?? part.startedAt },
          }
  return { id, sessionID: sessionId, messageID: messageId, type: "tool", callID: part.id, tool: part.tool, state }
}

/** Shapes saved history like OpenCode's session.messages() so the normal loader can seed it. */
export function historyToApiMessages(sessionId: string, history: LocalHistoryMessage[]): any[] {
  return history.map((message) => {
    const attachmentNote = message.attachments?.length
      ? `\n\n${message.attachments.map((a) => `📎 ${a.filename}`).join("\n")}`
      : ""
    const parts: HistoryPart[] =
      message.role === "assistant" && message.parts?.length
        ? message.parts
        : [{ type: "text", text: message.role === "user" ? `${message.text}${attachmentNote}` : message.text }]
    return {
      info: {
        id: message.id,
        sessionID: sessionId,
        role: message.role,
        time: { created: message.createdAt, completed: message.createdAt },
        ...(message.agent ? { agent: message.agent, mode: message.agent } : {}),
        ...(message.model ? { providerID: RUST_PROVIDER_ID, modelID: message.model } : {}),
        ...(message.isError ? { error: { name: "LocalEngineError", data: { message: message.text } } } : {}),
      },
      parts: parts.map((part, index) => toOpencodePart(sessionId, message.id, part, index)),
    }
  })
}

// ---------------------------------------------------------------- catalog → pickers

/** Agents for the agent picker. The first entry is the full agent (no --agent). */
export function catalogAgents(catalog: RustCatalog) {
  const agentModel = (model?: string | null) => (model ? { providerId: RUST_PROVIDER_ID, modelId: model } : undefined)
  return [
    {
      name: RUST_DEFAULT_AGENT,
      description: "Claude Code (Rust) with all tools and skills",
      mode: "primary" as const,
      hidden: false,
      model: undefined,
    },
    ...catalog.agents.map((agent) => ({
      name: agent.name,
      description: agent.description || "",
      mode: "primary" as const,
      hidden: false,
      model: agentModel(agent.model),
    })),
  ]
}

/** The agent's endpoint as one provider in the model picker. */
export function catalogProvider(catalog: RustCatalog) {
  const seen = new Set<string>()
  const models = [{ id: catalog.model }, ...catalog.models].filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
  return {
    id: RUST_PROVIDER_ID,
    name: RUST_PROVIDER_NAME,
    defaultModelId: catalog.model,
    models: models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      providerId: RUST_PROVIDER_ID,
      limit: undefined,
      cost: undefined,
      variantKeys: [] as string[],
    })),
  }
}

/** Slash commands (the agent's skills; agents are slash commands too). */
export function catalogCommands(catalog: RustCatalog) {
  return catalog.commands.map((command) => ({
    name: command.name,
    description: command.description || (command.agent ? `Run as the ${command.name} agent` : ""),
    template: "",
    ...(command.agent ? { agent: command.name } : {}),
  }))
}

// ---------------------------------------------------------------- live reply

/**
 * Builds the reply as events arrive: ordered text and tool parts, like the
 * server saves (local-engine/reply-parts.ts).
 */
export class LocalEngineReply {
  parts: HistoryPart[] = []
  finalText: string | null = null
  exitCode = 1
  sawExit = false
  isError = false
  model: string | undefined
  readonly events: LocalEngineEvent[] = []
  readonly stderrLines: string[] = []
  readonly notes: string[] = []

  get text(): string {
    return this.parts
      .filter((p): p is Extract<HistoryPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n\n")
  }

  /** Returns true when the visible reply changed. */
  apply(ev: LocalEngineEvent): boolean {
    this.events.push(ev)
    switch (ev.type) {
      case "delta":
      case "stdout": {
        const text = ev.type === "delta" ? ev.text : typeof ev.line === "string" ? `${ev.line}\n` : undefined
        if (typeof text !== "string" || !text) return false
        const last = this.parts[this.parts.length - 1]
        if (last?.type === "text") last.text += text
        else this.parts.push({ type: "text", text })
        return true
      }
      case "tool":
        if (typeof ev.name !== "string") return false
        this.parts.push({
          type: "tool",
          id: typeof ev.id === "string" && ev.id ? ev.id : `tool_${this.parts.length}`,
          tool: ev.name,
          input: ev.input && typeof ev.input === "object" ? (ev.input as Record<string, unknown>) : {},
          status: "running",
          startedAt: Date.now(),
        })
        return true
      case "tool_result": {
        const part = [...this.parts]
          .reverse()
          .find((p): p is Extract<HistoryPart, { type: "tool" }> => p.type === "tool" && p.id === ev.id && p.status === "running")
        if (!part) return false
        part.status = ev.isError === true ? "error" : "completed"
        part.output = typeof ev.output === "string" ? ev.output : ""
        part.endedAt = Date.now()
        return true
      }
      case "meta":
        if (typeof ev.model === "string") this.model = ev.model
        if (typeof ev.note === "string" && ev.note) this.notes.push(ev.note)
        return false
      case "stderr":
      case "bridge_stderr":
        if (typeof ev.line === "string") this.stderrLines.push(ev.line)
        return false
      case "final":
        if (typeof ev.text === "string") this.finalText = ev.text
        if (ev.isError === true) this.isError = true
        if (typeof ev.model === "string") this.model = ev.model
        return false
      case "exit":
        this.sawExit = true
        if (typeof ev.code === "number") this.exitCode = ev.code
        if (typeof ev.error === "string" && ev.error) this.stderrLines.push(ev.error)
        return false
      default:
        return false
    }
  }

  /** The reply once the run ends. */
  result(): LocalEngineRunResult {
    const failed = this.isError || (this.sawExit && this.exitCode !== 0)
    const parts: HistoryPart[] = this.parts.map((p) =>
      p.type === "tool" && p.status === "running" ? { ...p, status: "error", output: "Did not finish", endedAt: Date.now() } : { ...p },
    )
    let text = this.text
    if (!text.trim() && this.finalText && !failed) {
      parts.push({ type: "text", text: this.finalText })
      text = this.finalText
    }
    if (failed) {
      const message = this.finalText || this.stderrLines.slice(-3).join("\n") || `Claude Code (Rust) failed (exit ${this.exitCode})`
      if (!text.includes(message)) {
        parts.push({ type: "text", text: message })
        text = text.trim() ? `${text}\n\n${message}` : message
      }
    }
    if (!text.trim() && !parts.some((p) => p.type === "tool")) {
      parts.push({ type: "text", text: "(empty response)" })
      text = "(empty response)"
    }
    if (this.notes.length) {
      const note = this.notes.map((n) => `_${n}_`).join("\n")
      parts.unshift({ type: "text", text: note })
      text = `${note}\n\n${text}`
    }
    return { text, parts, exitCode: this.exitCode, isError: failed, model: this.model, events: this.events, stderrLines: this.stderrLines }
  }
}

export type LocalEngineEvent = {
  type: string
  line?: string
  text?: string
  code?: number
  error?: string
  isError?: boolean
  id?: string
  name?: string
  input?: unknown
  output?: unknown
  summary?: string
  note?: string
  model?: string
  [key: string]: unknown
}

export type LocalEngineRunResult = {
  text: string
  parts: HistoryPart[]
  exitCode: number
  isError: boolean
  model?: string
  events: LocalEngineEvent[]
  stderrLines: string[]
}

export async function readLocalEngineStream(
  response: Response,
  onEvent?: (ev: LocalEngineEvent, reply: LocalEngineReply, changed: boolean) => void,
): Promise<LocalEngineRunResult> {
  if (!response.body) {
    throw new Error("Claude Code (Rust) returned an empty body")
  }
  const reply = new LocalEngineReply()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  const handle = (line: string) => {
    if (!line.trim()) return
    let ev: LocalEngineEvent
    try {
      ev = JSON.parse(line) as LocalEngineEvent
    } catch {
      ev = { type: "stdout", line }
    }
    const changed = reply.apply(ev)
    onEvent?.(ev, reply, changed)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    for (const line of lines) handle(line)
  }
  buffer += decoder.decode()
  handle(buffer)

  return reply.result()
}

// ---------------------------------------------------------------- prompt + attachments

export type LocalEngineAttachment =
  | { type: "file"; url: string; filename?: string; mime?: string }
  | { type: "text"; text: string }

export type LocalEnginePrompt = {
  prompt: string
  uploads: LocalEngineUpload[]
  attachmentNames: string[]
}

/** Splits a "data:<mime>;base64,<data>" URL. Non-base64 data is encoded here. */
function parseDataUrl(url: string): { mime?: string; data: string } | null {
  const match = url.match(/^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s)
  if (!match) return null
  const mime = match[1] || undefined
  const isBase64 = /;base64/i.test(match[2])
  if (isBase64) return { mime, data: match[3] }
  try {
    const bytes = new TextEncoder().encode(decodeURIComponent(match[3]))
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { mime, data: btoa(binary) }
  } catch {
    return null
  }
}

/**
 * Builds what a run needs from the prompt and attachments: file paths go in
 * the prompt, pasted data (images, etc.) is uploaded. Images reach the model
 * as images (the server passes them to the agent with --image).
 */
export function buildLocalEnginePrompt(prompt: string, attachments: LocalEngineAttachment[]): LocalEnginePrompt {
  const sections: string[] = [prompt]
  const uploads: LocalEngineUpload[] = []
  const attachmentNames: string[] = []
  for (const att of attachments) {
    if (att.type === "text") {
      if (att.text.trim()) sections.push(att.text)
      continue
    }
    const label = att.filename || att.url
    if (att.url.startsWith("data:")) {
      const parsed = parseDataUrl(att.url)
      if (parsed) {
        uploads.push({ filename: att.filename || "pasted", mime: att.mime || parsed.mime, data: parsed.data })
        attachmentNames.push(att.filename || "pasted")
      }
      continue
    }
    attachmentNames.push(label)
    if (att.url.startsWith("file://")) {
      let filePath = att.url.slice("file://".length)
      try {
        filePath = decodeURIComponent(filePath)
      } catch {
        /* keep raw */
      }
      sections.push(`Attached file: ${filePath}`)
    } else {
      sections.push(`Attached: ${label} (${att.url})`)
    }
  }
  return { prompt: sections.join("\n\n"), uploads, attachmentNames }
}

/** True for errors that mean the browser isn't signed in to CodeNomad. */
export function isUnauthorizedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /^\s*unauthori[sz]ed\s*$/i.test(message) || /\b401\b/.test(message)
}
