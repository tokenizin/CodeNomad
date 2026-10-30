/**
 * Builds a reply as ordered parts (text and tool calls) from engine events,
 * the same shape CodeNomad saves to history and shows as OpenCode-style
 * message parts. The UI builds the same thing live (lib/local-engine.ts).
 */

import type { EngineEvent } from "./rust-runner.js"

export type ReplyTextPart = { type: "text"; text: string }
export type ReplyToolPart = {
  type: "tool"
  id: string
  tool: string
  input: Record<string, unknown>
  status: "running" | "completed" | "error"
  output?: string
  startedAt: number
  endedAt?: number
}
export type ReplyPart = ReplyTextPart | ReplyToolPart

export class ReplyParts {
  readonly parts: ReplyPart[] = []
  private finalText: string | null = null
  private readonly stderr: string[] = []
  private readonly notes: string[] = []

  apply(event: EngineEvent | { type: string; [key: string]: unknown }): void {
    const ev = event as EngineEvent
    switch (ev.type) {
      case "delta": {
        const last = this.parts[this.parts.length - 1]
        if (last?.type === "text") last.text += ev.text
        else this.parts.push({ type: "text", text: ev.text })
        break
      }
      case "tool":
        this.parts.push({ type: "tool", id: ev.id || `tool_${this.parts.length}`, tool: ev.name, input: ev.input, status: "running", startedAt: Date.now() })
        break
      case "tool_result": {
        const part = [...this.parts].reverse().find((p): p is ReplyToolPart => p.type === "tool" && p.id === ev.id && p.status === "running")
        if (part) {
          part.status = ev.isError ? "error" : "completed"
          part.output = ev.output
          part.endedAt = Date.now()
        }
        break
      }
      case "meta":
        if (ev.note) this.notes.push(ev.note)
        break
      case "stderr":
        this.stderr.push(ev.line)
        break
      case "final":
        this.finalText = ev.text
        break
    }
  }

  /** Plain text of the reply (text parts only). */
  text(): string {
    return this.parts
      .filter((p): p is ReplyTextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n\n")
  }

  finish(options: { stopped: boolean; isError: boolean; fallbackError?: string }): { text: string; parts: ReplyPart[] } {
    // Tools still running when the run ended didn't finish.
    for (const part of this.parts) {
      if (part.type === "tool" && part.status === "running") {
        part.status = "error"
        part.output = options.stopped ? "Stopped" : "Did not finish"
        part.endedAt = Date.now()
      }
    }
    let text = this.text()
    if (!text.trim() && this.finalText && !options.isError) {
      this.parts.push({ type: "text", text: this.finalText })
      text = this.finalText
    }
    if (options.isError && !options.stopped) {
      const message = this.finalText || options.fallbackError || this.stderr.slice(-3).join("\n") || "Claude Code (Rust) failed"
      if (!text.includes(message)) {
        this.parts.push({ type: "text", text: message })
        text = text.trim() ? `${text}\n\n${message}` : message
      }
    }
    if (options.stopped) {
      this.parts.push({ type: "text", text: "_(stopped)_" })
      text = text.trim() ? `${text.trimEnd()}\n\n_(stopped)_` : "_(stopped)_"
    }
    if (!text.trim() && !this.parts.some((p) => p.type === "tool")) {
      this.parts.push({ type: "text", text: "(empty response)" })
      text = "(empty response)"
    }
    if (this.notes.length) {
      const note = this.notes.map((n) => `_${n}_`).join("\n")
      this.parts.unshift({ type: "text", text: note })
      text = `${note}\n\n${text}`
    }
    return { text, parts: this.parts }
  }
}
