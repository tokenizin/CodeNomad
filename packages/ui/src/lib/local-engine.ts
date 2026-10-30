/**
 * Client helpers for CodeNomad's local chat engines: the local Claude Code CLI
 * (default) or the build-your-own-claude-code Rust playground.
 */

export type LocalEngineKind = "claude-cli" | "rust-playground"

export type LocalEngineStatus = {
  ok: boolean
  claude?: {
    ok: boolean
    binary: string | null
    configuredBinary: string | null
    version: string | null
    error: string | null
    permissionMode: string | null
  }
  rustPlayground?: {
    ok: boolean
    bridge: string | null
    playgroundRoot: string | null
    error: string | null
  }
  opencodeConfig?: string | null
  workspaceRoots?: string[]
  activeRuns?: number
}

/** Server-side settings, stored in the server config under `localEngine`. */
export type LocalEngineServerSettings = {
  claudeBinary?: string
  permissionMode?: string
  playgroundRoot?: string
  opencodeConfig?: string
  extraRoots?: string[]
}

export type LocalEngineRunRequest = {
  engine: LocalEngineKind
  prompt: string
  cwd?: string
  sessionKey?: string
  agent?: string
  model?: string
  persist?: boolean
}

export type LocalEngineEvent = {
  type: string
  line?: string
  text?: string
  code?: number
  error?: string
  isError?: boolean
  name?: string
  summary?: string
  note?: string
  [key: string]: unknown
}

export type LocalEngineRunResult = {
  /** Text to show as the reply. */
  text: string
  exitCode: number
  isError: boolean
  events: LocalEngineEvent[]
  stderrLines: string[]
}

/**
 * Builds the reply text as events arrive. Handles both engines:
 * claude-cli sends `delta`/`tool`/`final`; the Rust bridge sends `stdout` lines and `final`.
 */
export class LocalEngineReply {
  text = ""
  finalText: string | null = null
  exitCode = 1
  sawExit = false
  isError = false
  readonly events: LocalEngineEvent[] = []
  readonly stderrLines: string[] = []
  readonly notes: string[] = []

  /** Returns true when the visible text changed. */
  apply(ev: LocalEngineEvent): boolean {
    this.events.push(ev)
    switch (ev.type) {
      case "delta":
        if (typeof ev.text !== "string" || !ev.text) return false
        this.text += ev.text
        return true
      case "stdout":
        if (typeof ev.line !== "string") return false
        this.text = this.text ? `${this.text}\n${ev.line}` : ev.line
        return true
      case "tool": {
        if (typeof ev.name !== "string") return false
        const summary = typeof ev.summary === "string" && ev.summary ? ` ${ev.summary}` : ""
        const line = `› ${ev.name}${summary}`
        this.text = this.text && !this.text.endsWith("\n") ? `${this.text}\n\n${line}\n\n` : `${this.text}${line}\n\n`
        return true
      }
      case "meta":
        if (typeof ev.note === "string" && ev.note) this.notes.push(ev.note)
        return false
      case "stderr":
      case "bridge_stderr":
        if (typeof ev.line === "string") this.stderrLines.push(ev.line)
        return false
      case "final":
        if (typeof ev.text === "string") this.finalText = ev.text
        if (ev.isError === true) this.isError = true
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

  /** What to show once the run ends. */
  result(): LocalEngineRunResult {
    const failed = this.isError || (this.sawExit && this.exitCode !== 0)
    let text = this.text.trim() ? this.text : this.finalText ?? ""
    if (failed && this.finalText && !text.includes(this.finalText)) {
      text = text.trim() ? `${text}\n\n${this.finalText}` : this.finalText
    }
    if (!text.trim()) {
      const tail = this.stderrLines.slice(-3).join("\n")
      text = failed ? tail || `Local engine failed (exit ${this.exitCode})` : "(empty response)"
    }
    if (this.notes.length) text = `${this.notes.map((n) => `_${n}_`).join("\n")}\n\n${text}`
    return { text, exitCode: this.exitCode, isError: failed, events: this.events, stderrLines: this.stderrLines }
  }
}

export async function readLocalEngineStream(
  response: Response,
  onEvent?: (ev: LocalEngineEvent, reply: LocalEngineReply, changed: boolean) => void,
): Promise<LocalEngineRunResult> {
  if (!response.body) {
    throw new Error("Local engine returned an empty body")
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

export type LocalEngineAttachment =
  | { type: "file"; url: string; filename?: string; mime?: string }
  | { type: "text"; text: string }

/** Builds the prompt for a local engine, including attachments OpenCode would get as parts. */
export function buildLocalEnginePrompt(prompt: string, attachments: LocalEngineAttachment[]): string {
  const sections: string[] = [prompt]
  for (const att of attachments) {
    if (att.type === "text") {
      if (att.text.trim()) sections.push(att.text)
      continue
    }
    const label = att.filename || att.url
    if (att.url.startsWith("file://")) {
      let filePath = att.url.slice("file://".length)
      try {
        filePath = decodeURIComponent(filePath)
      } catch {
        /* keep raw */
      }
      sections.push(`Attached file: ${filePath}`)
    } else if (att.url.startsWith("data:")) {
      // Inline data (pasted images etc.) can't be handed to the CLI as a path.
      sections.push(`[Attachment "${label}" (${att.mime ?? "data"}) was not sent: only file attachments reach the local engine.]`)
    } else {
      sections.push(`Attached: ${label} (${att.url})`)
    }
  }
  return sections.join("\n\n")
}

/** True for errors that mean the browser isn't signed in to CodeNomad. */
export function isUnauthorizedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /^\s*unauthori[sz]ed\s*$/i.test(message) || /\b401\b/.test(message)
}
