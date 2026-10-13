/**
 * Client helpers for CodeNomad ↔ playground/rust (Claude Code Rust engine).
 */

export type PlaygroundRustStatus = {
  ok: boolean
  bridge: string | null
  claudeCodePlayground: string | null
  starworld: string | null
  openCodeConfig: string | null
  nomadAgents: string
  persist: boolean
  hint?: string
}

export type PlaygroundRustRunRequest = {
  prompt: string
  cwd?: string
  agent?: string
  jsonl?: boolean
  persist?: boolean
}

export type PlaygroundRustEvent = {
  type: string
  line?: string
  text?: string
  code?: number
  error?: string
  [key: string]: unknown
}

export type PlaygroundRustRunResult = {
  finalText: string
  exitCode: number
  events: PlaygroundRustEvent[]
  stderrLines: string[]
}

export async function parsePlaygroundRustNdjsonStream(
  response: Response,
  onEvent?: (ev: PlaygroundRustEvent) => void,
): Promise<PlaygroundRustRunResult> {
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(text || `playground rust run failed (${response.status})`)
  }
  if (!response.body) {
    throw new Error("playground rust run returned empty body")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events: PlaygroundRustEvent[] = []
  const stderrLines: string[] = []
  let finalText = ""
  let exitCode = 1

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let ev: PlaygroundRustEvent
      try {
        ev = JSON.parse(line) as PlaygroundRustEvent
      } catch {
        ev = { type: "parse_error", line }
      }
      events.push(ev)
      onEvent?.(ev)
      if (ev.type === "stderr" && typeof ev.line === "string") stderrLines.push(ev.line)
      if (ev.type === "bridge_stderr" && typeof ev.line === "string") stderrLines.push(ev.line)
      if (ev.type === "final" && typeof ev.text === "string") finalText = ev.text
      if (ev.type === "exit" && typeof ev.code === "number") exitCode = ev.code
      if (ev.type === "stdout" && typeof ev.line === "string" && !finalText) {
        // Accumulate until final arrives
        finalText = finalText ? `${finalText}\n${ev.line}` : ev.line
      }
    }
  }

  if (buffer.trim()) {
    try {
      const ev = JSON.parse(buffer) as PlaygroundRustEvent
      events.push(ev)
      onEvent?.(ev)
      if (ev.type === "final" && typeof ev.text === "string") finalText = ev.text
      if (ev.type === "exit" && typeof ev.code === "number") exitCode = ev.code
    } catch {
      /* ignore trailing garbage */
    }
  }

  return { finalText, exitCode, events, stderrLines }
}
