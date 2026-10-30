/**
 * Runs the Claude Code (Rust) agent from build-your-own-claude-code
 * (playground/rust/your_program.sh), CodeNomad's chat engine.
 *
 * Uses the agent's CodeNomad interface (see docs/patches/byocc-codenomad-engine.patch
 * in the starworld repo):
 *   --catalog                      agents, slash commands and models as JSON
 *   -p <prompt> --output-format stream-json
 *   --model <id> --agent <name> --image <path>… --history <file>
 *
 * stream-json events: meta | delta | tool | tool_result | final | error.
 */

import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import path from "path"

export function rustRunnerPath(playgroundRoot: string): string {
  return path.join(playgroundRoot, "playground", "rust", "your_program.sh")
}

export function findRustRunner(playgroundRoot: string | null): string | null {
  if (!playgroundRoot) return null
  const runner = rustRunnerPath(playgroundRoot)
  return fs.existsSync(runner) ? runner : null
}

function ensureExecutable(runner: string) {
  try {
    fs.chmodSync(runner, fs.statSync(runner).mode | 0o111)
  } catch {
    /* not ours to fix; spawn will report it */
  }
}

// ---------------------------------------------------------------- events

/** Events CodeNomad's UI reads (one NDJSON line each). */
export type EngineEvent =
  | { type: "meta"; engine: "rust"; model?: string; agent?: string | null; note?: string }
  | { type: "delta"; text: string }
  | { type: "tool"; id: string; name: string; input: Record<string, unknown>; summary?: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "stderr"; line: string }
  | { type: "final"; text: string; isError: boolean; model?: string }
  | { type: "exit"; code: number; error?: string }

/**
 * Rust tool names → the OpenCode tool names CodeNomad's tool cards know,
 * with inputs renamed to what those cards read.
 */
export function toOpencodeTool(name: string, input: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
  const filePath = typeof input.file_path === "string" ? input.file_path : undefined
  switch (name) {
    case "Read":
      return { tool: "read", input: { ...input, ...(filePath ? { filePath } : {}) } }
    case "Write":
      return { tool: "write", input: { ...input, ...(filePath ? { filePath } : {}) } }
    case "Bash":
      return { tool: "bash", input }
    case "Skill":
      return { tool: "skill", input }
    // Subagent delegation: same card as OpenCode's task tool ([subagent] description).
    case "Task":
      return { tool: "task", input }
    default:
      return { tool: name, input }
  }
}

function summarize(input: Record<string, unknown>): string | undefined {
  const pick =
    input.command ?? input.filePath ?? input.file_path ?? input.name ?? input.path ?? input.task_path ??
    (typeof input.subagent_type === "string" ? `${input.subagent_type}: ${input.description ?? ""}` : undefined)
  if (typeof pick !== "string" || !pick.trim()) return undefined
  const line = pick.replace(/\s+/g, " ").trim()
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

/** Translates one line of the agent's stream-json stdout. */
export class RustStreamTranslator {
  sawFinal = false
  isError = false
  finalText = ""
  model: string | undefined

  feed(line: string): EngineEvent[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    let ev: any
    try {
      ev = JSON.parse(trimmed)
    } catch {
      // Not JSON: an agent build without stream-json support, or stray output.
      return [{ type: "stderr", line: trimmed }]
    }
    if (!ev || typeof ev !== "object") return []
    switch (ev.type) {
      case "meta":
        if (typeof ev.model === "string") this.model = ev.model
        return [{ type: "meta", engine: "rust", model: this.model, agent: typeof ev.agent === "string" ? ev.agent : null }]
      case "delta":
        return typeof ev.text === "string" && ev.text ? [{ type: "delta", text: ev.text }] : []
      case "tool": {
        const raw = ev.input && typeof ev.input === "object" ? (ev.input as Record<string, unknown>) : {}
        const mapped = toOpencodeTool(String(ev.name ?? "tool"), raw)
        return [{ type: "tool", id: String(ev.id ?? ""), name: mapped.tool, input: mapped.input, summary: summarize(mapped.input) }]
      }
      case "tool_result": {
        const mapped = toOpencodeTool(String(ev.name ?? "tool"), {})
        return [
          {
            type: "tool_result",
            id: String(ev.id ?? ""),
            name: mapped.tool,
            output: typeof ev.output === "string" ? ev.output : JSON.stringify(ev.output ?? ""),
            isError: ev.isError === true,
          },
        ]
      }
      case "final":
        this.sawFinal = true
        this.finalText = typeof ev.text === "string" ? ev.text : ""
        if (typeof ev.model === "string") this.model = ev.model
        return [{ type: "final", text: this.finalText, isError: false, model: this.model }]
      case "error":
        this.sawFinal = true
        this.isError = true
        this.finalText = typeof ev.message === "string" ? ev.message : "Claude Code (Rust) failed"
        return [{ type: "final", text: this.finalText, isError: true, model: this.model }]
      default:
        return []
    }
  }
}

// ---------------------------------------------------------------- run

export type RustRunOptions = {
  runner: string
  cwd: string
  env: NodeJS.ProcessEnv
  prompt: string
  agent?: string
  model?: string
  /** Image files attached to this message. */
  images?: string[]
  /** JSON file of earlier turns: [{ role, content }]. */
  historyFile?: string
}

export function rustRunArgs(options: Omit<RustRunOptions, "runner" | "cwd" | "env">): string[] {
  const args = ["-p", options.prompt, "--output-format", "stream-json"]
  if (options.model) args.push("--model", options.model)
  if (options.agent) args.push("--agent", options.agent)
  for (const image of options.images ?? []) args.push("--image", image)
  if (options.historyFile) args.push("--history", options.historyFile)
  return args
}

/** clap's message when the checkout predates the CodeNomad interface. */
const OLD_AGENT = /unexpected argument '--(output-format|catalog|history|image|agent|model)'/

export const OUTDATED_AGENT_MESSAGE =
  "Your build-your-own-claude-code checkout doesn't support CodeNomad yet. Apply docs/patches/byocc-codenomad-engine.patch from the starworld repo to it."

export function runRustAgent(
  options: RustRunOptions,
  onEvent: (event: EngineEvent) => void,
  register: (child: ChildProcess) => void,
): Promise<{ code: number; translator: RustStreamTranslator; stderr: string[] }> {
  return new Promise((resolve) => {
    ensureExecutable(options.runner)
    const translator = new RustStreamTranslator()
    const stderr: string[] = []
    const child = spawn(options.runner, rustRunArgs(options), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    register(child)

    let out = ""
    child.stdout?.on("data", (buf: Buffer) => {
      out += buf.toString("utf8")
      const lines = out.split(/\r?\n/)
      out = lines.pop() ?? ""
      for (const line of lines) for (const event of translator.feed(line)) onEvent(event)
    })
    let err = ""
    child.stderr?.on("data", (buf: Buffer) => {
      err += buf.toString("utf8")
      const lines = err.split(/\r?\n/)
      err = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        stderr.push(line)
        onEvent({ type: "stderr", line })
      }
    })

    let settled = false
    const finish = (code: number, error?: string) => {
      if (settled) return
      settled = true
      if (out.trim()) for (const event of translator.feed(out)) onEvent(event)
      if (err.trim()) stderr.push(err.trim())
      if (error) stderr.push(error)
      resolve({ code, translator, stderr })
    }
    child.on("error", (e) => finish(127, e.message))
    child.on("close", (code, signal) => finish(code ?? (signal ? 130 : 1)))
  })
}

/** Text for a run that ended without a final/error event. */
export function failureText(code: number, stderr: string[]): string {
  const all = stderr.join("\n")
  if (OLD_AGENT.test(all)) return OUTDATED_AGENT_MESSAGE
  const tail = stderr.filter((line) => !/^\s*(Compiling|Finished|Running|warning:)/.test(line)).slice(-4).join("\n")
  return tail || `Claude Code (Rust) exited with code ${code}`
}

// ---------------------------------------------------------------- catalog

export type RustCatalog = {
  version: number
  model: string
  baseUrl?: string
  models: Array<{ id: string; name?: string }>
  modelsError?: string | null
  agents: Array<{ name: string; description?: string; model?: string | null }>
  commands: Array<{ name: string; description?: string; agent?: boolean }>
}

/** Finds the catalog object in stdout (ignores anything before it). */
export function parseCatalog(stdout: string): RustCatalog | null {
  const start = stdout.indexOf("{")
  if (start < 0) return null
  try {
    const parsed = JSON.parse(stdout.slice(start))
    if (!parsed || !Array.isArray(parsed.models) || !Array.isArray(parsed.agents) || !Array.isArray(parsed.commands)) return null
    return parsed as RustCatalog
  } catch {
    return null
  }
}

const CATALOG_TTL_MS = 60_000
/** A failed catalog is remembered this long, so page loads don't re-run cargo build each time. */
const CATALOG_FAILURE_TTL_MS = 30_000
/** The first call may compile the agent (cargo build --release), so allow time. */
const CATALOG_TIMEOUT_MS = 10 * 60_000
const catalogCache = new Map<string, { at: number; value: Promise<RustCatalog> }>()

export function fetchRustCatalog(runner: string, cwd: string, env: NodeJS.ProcessEnv, options?: { fresh?: boolean }): Promise<RustCatalog> {
  const key = `${runner}\u0000${cwd}`
  const cached = catalogCache.get(key)
  if (cached && !options?.fresh && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value
  const value = new Promise<RustCatalog>((resolve, reject) => {
    ensureExecutable(runner)
    const child = spawn(runner, ["--catalog"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), CATALOG_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")))
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")))
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const catalog = parseCatalog(stdout)
      if (catalog) return resolve(catalog)
      const lines = stderr.split(/\r?\n/)
      reject(new Error(OLD_AGENT.test(stderr) ? OUTDATED_AGENT_MESSAGE : failureText(code ?? 1, lines)))
    })
  })
  catalogCache.set(key, { at: Date.now(), value })
  value.catch(() => {
    // Keep the failure briefly (same error, no new process), then let it retry.
    const entry = catalogCache.get(key)
    if (entry?.value === value) entry.at = Date.now() - CATALOG_TTL_MS + CATALOG_FAILURE_TTL_MS
  })
  return value
}

/** Records the run in local Neon + MinIO via playground/persistence (best effort). */
export function recordRustTranscript(playgroundRoot: string, transcript: object[], env: NodeJS.ProcessEnv): Promise<string | null> {
  const dir = path.join(playgroundRoot, "playground", "persistence")
  const recorder = path.join(dir, "src", "record-cli.ts")
  if (!fs.existsSync(recorder)) return Promise.resolve(`persistence recorder missing: ${recorder}`)
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", recorder, "--kind", "bridge"], { cwd: dir, env, stdio: ["pipe", "ignore", "pipe"] })
    let err = ""
    child.stderr?.on("data", (buf: Buffer) => (err += buf.toString("utf8")))
    child.on("error", (e) => resolve(`persistence skipped: ${e.message}`))
    child.on("close", (code) => resolve(code === 0 ? null : `persistence failed (${code}): ${err.trim().slice(-300)}`))
    child.stdin?.on("error", () => {})
    child.stdin?.end(transcript.map((line) => JSON.stringify(line)).join("\n") + "\n")
  })
}
