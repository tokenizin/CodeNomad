/**
 * Translates `claude -p --output-format stream-json --verbose` output into the
 * small NDJSON protocol the CodeNomad UI reads:
 *
 *   { type: "meta",  engine, sessionId? }
 *   { type: "delta", text }            text to append to the reply
 *   { type: "tool",  name, summary? }  a tool call started
 *   { type: "final", text, sessionId?, isError, costUsd? }
 *   { type: "exit",  code, error? }    written by the route, not here
 */

export type LocalEngineEvent =
  | { type: "meta"; engine: string; sessionId?: string; agent?: string; note?: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; summary?: string }
  | { type: "stderr"; line: string }
  | { type: "final"; text: string; sessionId?: string; isError: boolean; costUsd?: number }
  | { type: "exit"; code: number; error?: string }

type Json = Record<string, any>

function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const value = input as Json
  const pick =
    value.command ?? value.file_path ?? value.path ?? value.pattern ?? value.url ?? value.description ?? value.prompt
  if (typeof pick !== "string" || !pick.trim()) return undefined
  const oneLine = pick.replace(/\s+/g, " ").trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine
}

export class ClaudeStreamTranslator {
  sessionId: string | undefined
  finalText = ""
  isError = false
  sawResult = false
  /** Reply text streamed so far (used when no result event arrives). */
  streamedText = ""
  private readonly streamedMessageIds = new Set<string>()
  private readonly seenToolIds = new Set<string>()
  private currentMessageId: string | undefined
  /** Set when a new assistant message starts, so its text begins a new paragraph. */
  private pendingBreak = false

  /** Feed one stdout line; returns the UI events it produces. */
  feed(line: string): LocalEngineEvent[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    let msg: Json
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return [{ type: "stderr", line: trimmed }]
    }
    if (!msg || typeof msg !== "object") return []

    if (typeof msg.session_id === "string" && msg.session_id) {
      this.sessionId = msg.session_id
    }

    // Only the top-level conversation goes into the reply; sub-agent chatter
    // (parent_tool_use_id set) would interleave with the main answer.
    if (msg.parent_tool_use_id) return []

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          return [{ type: "meta", engine: "claude-cli", sessionId: this.sessionId }]
        }
        return []

      case "stream_event": {
        const ev = msg.event as Json | undefined
        if (!ev) return []
        if (ev.type === "message_start" && typeof ev.message?.id === "string") {
          this.currentMessageId = ev.message.id
          this.pendingBreak = true
          return []
        }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          if (this.currentMessageId) this.streamedMessageIds.add(this.currentMessageId)
          return this.appendText(ev.delta.text)
        }
        return []
      }

      case "assistant": {
        const message = msg.message as Json | undefined
        const content = Array.isArray(message?.content) ? (message!.content as Json[]) : []
        const events: LocalEngineEvent[] = []
        // Without --include-partial-messages (older CLIs) the text only arrives here.
        const alreadyStreamed = typeof message?.id === "string" && this.streamedMessageIds.has(message.id)
        if (!alreadyStreamed) this.pendingBreak = true
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string" && !alreadyStreamed) {
            events.push(...this.appendText(block.text))
          } else if (block?.type === "tool_use" && typeof block.name === "string") {
            const id = typeof block.id === "string" ? block.id : undefined
            if (id && this.seenToolIds.has(id)) continue
            if (id) this.seenToolIds.add(id)
            events.push({ type: "tool", name: block.name, summary: summarizeToolInput(block.input) })
          }
        }
        return events
      }

      case "result": {
        this.sawResult = true
        this.isError = Boolean(msg.is_error) || (typeof msg.subtype === "string" && msg.subtype !== "success")
        const resultText = typeof msg.result === "string" ? msg.result : ""
        this.finalText = resultText || this.streamedText
        if (this.isError && !this.finalText) {
          const errors = Array.isArray(msg.errors) ? msg.errors.filter((e: unknown) => typeof e === "string") : []
          this.finalText = errors.join("\n") || `Claude Code stopped (${msg.subtype ?? "error"})`
        }
        return [
          {
            type: "final",
            text: this.finalText,
            sessionId: this.sessionId,
            isError: this.isError,
            costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
          },
        ]
      }

      default:
        return []
    }
  }

  private appendText(text: string): LocalEngineEvent[] {
    if (!text) return []
    // Separate consecutive assistant turns (text → tool call → more text).
    const needsBreak = this.pendingBreak && this.streamedText.length > 0 && !this.streamedText.endsWith("\n")
    this.pendingBreak = false
    const chunk = needsBreak ? `\n\n${text}` : text
    this.streamedText += chunk
    return [{ type: "delta", text: chunk }]
  }
}
