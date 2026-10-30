/**
 * Builds the reply text saved to history from the events a run streams.
 * Matches what the UI shows live (lib/local-engine.ts → LocalEngineReply).
 */

import type { LocalEngineEvent } from "./claude-stream.js"

type AnyEvent = LocalEngineEvent | { type: "stdout"; line: string } | { type: string; [key: string]: unknown }

export class ReplyText {
  private text = ""
  private finalText: string | null = null
  private stderr: string[] = []
  private notes: string[] = []

  apply(event: AnyEvent): void {
    const ev = event as Record<string, unknown>
    switch (ev.type) {
      case "delta":
        if (typeof ev.text === "string") this.text += ev.text
        break
      case "stdout":
        if (typeof ev.line === "string") this.text = this.text ? `${this.text}\n${ev.line}` : ev.line
        break
      case "tool": {
        if (typeof ev.name !== "string") break
        const line = `› ${ev.name}${typeof ev.summary === "string" && ev.summary ? ` ${ev.summary}` : ""}`
        this.text = this.text && !this.text.endsWith("\n") ? `${this.text}\n\n${line}\n\n` : `${this.text}${line}\n\n`
        break
      }
      case "meta":
        if (typeof ev.note === "string" && ev.note) this.notes.push(ev.note)
        break
      case "stderr":
        if (typeof ev.line === "string") this.stderr.push(ev.line)
        break
      case "final":
        if (typeof ev.text === "string") this.finalText = ev.text
        break
    }
  }

  finish(options: { stopped: boolean; isError: boolean }): string {
    let text = this.text.trim() ? this.text : this.finalText ?? ""
    if (options.isError && !options.stopped && this.finalText && !text.includes(this.finalText)) {
      text = text.trim() ? `${text}\n\n${this.finalText}` : this.finalText
    }
    if (!text.trim() && options.isError && !options.stopped) text = this.stderr.slice(-3).join("\n") || "Local engine failed"
    if (options.stopped) text = text.trim() ? `${text.trimEnd()}\n\n_(stopped)_` : "_(stopped)_"
    if (!text.trim()) text = "(empty response)"
    if (this.notes.length) text = `${this.notes.map((n) => `_${n}_`).join("\n")}\n\n${text}`
    return text
  }
}
