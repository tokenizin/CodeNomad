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
 *
 * Protocol 2 (the agent runs with NOMAD_PROTOCOL=2): events of a delegated task
 * arrive stamped with `task_id` (+ `parent_call_id`, `parent_task_id`), plus
 * `task.start` / `task.end`. They are never forwarded as plain events — a subagent's
 * text must not land in the parent's reply — but as `task_start` / `task_event` /
 * `task_end` envelopes, which a reader that doesn't know them ignores.
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

export function extractPartialEventText(tail: string): { type: "delta" | "final"; text: string } | undefined {
  const trimmed = tail.trim()
  if (!trimmed.includes('"type"')) return undefined
  const isDelta = trimmed.includes('"delta"')
  const isFinal = trimmed.includes('"final"')
  if (!isDelta && !isFinal) return undefined
  const marker = '"text":"'
  const idx = trimmed.lastIndexOf(marker)
  if (idx < 0) return undefined
  let text = trimmed.slice(idx + marker.length)
  text = text
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  return { type: isDelta ? "delta" : "final", text }
}

/** Tokens one model call used. `input` excludes cached prompt tokens (OpenCode's convention, so the meter adds them once). */
export type TokenUsage = { input: number; output: number; reasoning: number; cacheRead: number }

const tokenCount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

/** One question of the `question` tool, as the agent asks it (OpenCode's shape). */
export type AskedQuestion = { question: string; header: string; options: Array<{ label: string; description: string }>; multiple?: boolean }

/** The events a delegated task shares with the top-level run. */
export type PlainEvent =
  /** The agent asks leave to run the tool call `callId` (a permission rule says `ask`); `POST /api/local-engine/permission` answers. */
  | { type: "permission"; id: string; callId: string; permission: string; patterns: string[]; always: string[] }
  /** The agent asks the user something and waits (`POST /api/local-engine/question` answers). `callId` is the tool call it belongs to. */
  | { type: "question"; id: string; callId: string; questions: AskedQuestion[] }
  /** Usage of the latest model call: the context in use after it. */
  | { type: "usage"; usage: TokenUsage; model?: string }
  | { type: "delta"; text: string }
  | { type: "tool"; id: string; name: string; input: Record<string, unknown>; summary?: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }

export type TaskStatus = "completed" | "failed" | "aborted"

/** Where a delegated task hangs: the parent's Task card, and the task that delegated it (if any). */
export type TaskRef = { taskId: string; parentCallId: string; parentTaskId?: string }

/** Events CodeNomad's UI reads (one NDJSON line each). */
export type EngineEvent =
  | { type: "meta"; engine: "rust"; model?: string; agent?: string | null; note?: string; protocol?: number }
  | PlainEvent
  | { type: "stderr"; line: string }
  | { type: "final"; text: string; isError: boolean; model?: string }
  | { type: "exit"; code: number; error?: string }
  // Protocol 2 — delegated tasks.
  | ({
      type: "task_start"
      agent: string
      description: string
      model?: string
      mode: "subagent" | "orchestrator"
      resumed: boolean
      // Filled in by CodeNomad (task-sessions.ts) before the event goes to the browser, so the
      // live view uses the very ids the saved history will have.
      sessionId?: string
      parentSessionId?: string
      prompt?: string
      userMessageId?: string
      assistantMessageId?: string
    } & TaskRef)
  | ({ type: "task_event"; event: PlainEvent } & TaskRef)
  | ({ type: "task_end"; status: TaskStatus; summary?: string; error?: string } & TaskRef)
  // Asynchronous workflows (the agent runs with NOMAD_WORKFLOW_MODE=async) — see workflows.ts.
  | WorkflowStartEvent
  | WorkflowPromptEvent
  | WorkflowDoneEvent

export const TASK_EVENT_TYPES = ["task_start", "task_event", "task_end"] as const

/** The Product Manager started a workflow: a Workflow Runner is to work on it in a session of its own. */
export type WorkflowStartEvent = {
  type: "workflow_start"
  /** `wf_…`; the session is `ses_lcl_` + this. */
  workflowId: string
  sessionId: string
  title: string
  taskPath: string
  track: string
  /** What the runner is told to do (the Product Manager's instructions). */
  instructions: string
  /** The first message the runner's session shows. */
  prompt: string
  /** The Product Manager's tool call that started it. */
  callId: string
}

/** The Product Manager sent text to a workflow's runner (`active`: it is still working, so the text is queued). */
export type WorkflowPromptEvent = {
  type: "workflow_prompt"
  workflowId: string
  sessionId: string
  text: string
  active: boolean
  callId: string
}

/** A runner's process ended its session: how, and the handover it filed. */
export type WorkflowHandover = { outcome: string; path: string; revision: number; verification: string; openIssues: number; markdown: string }
export type WorkflowDoneEvent = {
  type: "workflow_done"
  workflowId: string
  sessionId: string
  taskPath: string
  status: "completed" | "failed"
  handover?: WorkflowHandover
  error?: string
}

/**
 * Rust tool names → the OpenCode tool names CodeNomad's tool cards know,
 * with inputs renamed to what those cards read.
 */
export function toOpencodeTool(
  name: string,
  input: Record<string, unknown>,
  options: { asyncWorkflows?: boolean } = {},
): { tool: string; input: Record<string, unknown> } {
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
    // OpenCode's own tools: same names and input shapes, so the existing cards draw them. An Edit's
    // output is a unified diff (the edit card renders it); a TodoWrite's list is shown as the plan.
    case "Edit": {
      const input_ = input as Record<string, unknown>
      return {
        tool: "edit",
        input: {
          ...(filePath ? { filePath } : {}),
          oldString: input_.old_string,
          newString: input_.new_string,
          ...(input_.replace_all === true ? { replaceAll: true } : {}),
        },
      }
    }
    case "Grep":
      return { tool: "grep", input }
    case "Glob":
      return { tool: "glob", input }
    case "WebFetch":
      return { tool: "webfetch", input }
    case "TodoWrite":
      return { tool: "todowrite", input }
    case "TodoRead":
      return { tool: "todoread", input }
    // A workflow that runs inside the call (synchronous mode) opens its session from the same card as a Task.
    // A background one is a plain tool call, as in OpenCode: it only starts the workflow.
    case "nomadflow_run_workflow":
    case "nomadflow_prompt_workflow": {
      if (options.asyncWorkflows) return { tool: name, input }
      const taskPath = typeof input.task_path === "string" ? input.task_path : ""
      const stem = taskPath ? taskPath.split("/").pop()!.replace(/\.[^.]+$/, "") : ""
      const sessionId = typeof input.session_id === "string" ? input.session_id : ""
      const prompt = input.instructions ?? input.text
      return {
        tool: "task",
        input: {
          ...input,
          subagent_type: "workflow_runner",
          description: stem ? `Workflow ${stem}` : sessionId ? `Workflow follow-up ${sessionId}` : "Workflow",
          prompt: typeof prompt === "string" ? prompt : "",
        },
      }
    }
    default:
      return { tool: name, input }
  }
}

function summarize(input: Record<string, unknown>): string | undefined {
  const pick =
    input.command ?? input.filePath ?? input.file_path ?? input.name ?? input.path ?? input.task_path ?? input.pattern ?? input.url ??
    (typeof input.subagent_type === "string" ? `${input.subagent_type}: ${input.description ?? ""}` : undefined)
  if (typeof pick !== "string" || !pick.trim()) return undefined
  const line = pick.replace(/\s+/g, " ").trim()
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

/** delta / tool / tool_result → the event the UI reads; anything else is not shared with tasks. */
function translatePlain(ev: any, options: { asyncWorkflows?: boolean } = {}): PlainEvent | undefined {
  switch (ev.type) {
    case "delta":
      return typeof ev.text === "string" && ev.text ? { type: "delta", text: ev.text } : undefined
    case "tool": {
      const raw = ev.input && typeof ev.input === "object" ? (ev.input as Record<string, unknown>) : {}
      const mapped = toOpencodeTool(String(ev.name ?? "tool"), raw, options)
      return { type: "tool", id: String(ev.id ?? ""), name: mapped.tool, input: mapped.input, summary: summarize(mapped.input) }
    }
    case "tool_result": {
      const mapped = toOpencodeTool(String(ev.name ?? "tool"), {}, options)
      return {
        type: "tool_result",
        id: String(ev.id ?? ""),
        name: mapped.tool,
        output: typeof ev.output === "string" ? ev.output : JSON.stringify(ev.output ?? ""),
        isError: ev.isError === true,
      }
    }
    case "permission": {
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
      if (typeof ev.id !== "string" || !ev.id || typeof ev.permission !== "string" || !ev.permission) return undefined
      return { type: "permission", id: ev.id, callId: typeof ev.call_id === "string" ? ev.call_id : "", permission: ev.permission, patterns: strings(ev.patterns), always: strings(ev.always) }
    }
    case "question": {
      const questions = Array.isArray(ev.questions)
        ? (ev.questions as any[])
            .filter((q) => q && typeof q.question === "string")
            .map((q) => ({
              question: String(q.question),
              header: typeof q.header === "string" ? q.header : String(q.question).slice(0, 30),
              options: Array.isArray(q.options)
                ? q.options.filter((o: any) => o && typeof o.label === "string").map((o: any) => ({ label: String(o.label), description: typeof o.description === "string" ? o.description : "" }))
                : [],
              ...(q.multiple === true ? { multiple: true } : {}),
            }))
        : []
      if (typeof ev.id !== "string" || !ev.id || questions.length === 0) return undefined
      return { type: "question", id: ev.id, callId: typeof ev.call_id === "string" ? ev.call_id : "", questions }
    }
    case "usage": {
      const usage: TokenUsage = { input: tokenCount(ev.input), output: tokenCount(ev.output), reasoning: tokenCount(ev.reasoning), cacheRead: tokenCount(ev.cacheRead) }
      if (usage.input + usage.output + usage.cacheRead === 0) return undefined
      return { type: "usage", usage, ...(typeof ev.model === "string" ? { model: ev.model } : {}) }
    }
    default:
      return undefined
  }
}

const TASK_STATUSES: readonly TaskStatus[] = ["completed", "failed", "aborted"]

/** Translates one line of the agent's stream-json stdout. */
export class RustStreamTranslator {
  sawFinal = false
  isError = false
  finalText = ""
  model: string | undefined
  /** Usage of the run's latest own model call (a delegated task's usage goes to its task). */
  usage: TokenUsage | undefined
  /** Wire protocol the agent announced in `meta` (1 when it didn't). */
  protocol = 1

  constructor(private readonly options: { asyncWorkflows?: boolean } = {}) {}

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
    // A delegated task's event: never part of the top-level reply.
    if (typeof ev.task_id === "string" && ev.task_id) return this.feedTask(ev)
    switch (ev.type) {
      case "meta":
        if (typeof ev.model === "string") this.model = ev.model
        if (typeof ev.protocol === "number") this.protocol = ev.protocol
        return [
          {
            type: "meta",
            engine: "rust",
            model: this.model,
            agent: typeof ev.agent === "string" ? ev.agent : null,
            ...(this.protocol > 1 ? { protocol: this.protocol } : {}),
          },
        ]
      case "delta":
      case "tool":
      case "tool_result":
      case "question":
      case "permission":
      case "usage": {
        const plain = translatePlain(ev, this.options)
        if (plain?.type === "usage") this.usage = plain.usage
        return plain ? [plain] : []
      }
      case "workflow.start":
        return this.workflowStart(ev)
      case "workflow.prompt":
        return this.workflowPrompt(ev)
      case "workflow.done":
        return this.workflowDone(ev)
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

  /** Protocol 2: events stamped with `task_id`. Unknown kinds are dropped. */
  private feedTask(ev: any): EngineEvent[] {
    const ref: TaskRef = {
      taskId: ev.task_id,
      parentCallId: typeof ev.parent_call_id === "string" ? ev.parent_call_id : "",
      ...(typeof ev.parent_task_id === "string" && ev.parent_task_id ? { parentTaskId: ev.parent_task_id } : {}),
    }
    switch (ev.type) {
      case "task.start":
        return [
          {
            type: "task_start",
            ...ref,
            agent: typeof ev.agent === "string" ? ev.agent : "",
            description: typeof ev.description === "string" ? ev.description : "",
            ...(typeof ev.model === "string" ? { model: ev.model } : {}),
            mode: ev.mode === "orchestrator" ? "orchestrator" : "subagent",
            resumed: ev.resumed === true,
          },
        ]
      case "task.end": {
        const status = TASK_STATUSES.includes(ev.status) ? (ev.status as TaskStatus) : "failed"
        return [
          {
            type: "task_end",
            ...ref,
            status,
            ...(typeof ev.summary === "string" ? { summary: ev.summary } : {}),
            ...(typeof ev.error === "string" ? { error: ev.error } : {}),
          },
        ]
      }
      default: {
        const plain = translatePlain(ev, this.options)
        return plain ? [{ type: "task_event", ...ref, event: plain }] : []
      }
    }
  }

  private workflowStart(ev: any): EngineEvent[] {
    const str = (v: unknown) => (typeof v === "string" ? v : "")
    if (!str(ev.workflow_id) || !str(ev.session_id)) return []
    return [
      {
        type: "workflow_start",
        workflowId: ev.workflow_id,
        sessionId: ev.session_id,
        title: str(ev.title) || "Workflow Run",
        taskPath: str(ev.task_path),
        track: str(ev.track) || "implementation",
        instructions: str(ev.instructions),
        prompt: str(ev.prompt) || str(ev.instructions),
        callId: str(ev.call_id),
      },
    ]
  }

  private workflowPrompt(ev: any): EngineEvent[] {
    if (typeof ev.session_id !== "string" || typeof ev.text !== "string" || !ev.text.trim()) return []
    return [
      {
        type: "workflow_prompt",
        workflowId: typeof ev.workflow_id === "string" ? ev.workflow_id : "",
        sessionId: ev.session_id,
        text: ev.text,
        active: ev.active === true,
        callId: typeof ev.call_id === "string" ? ev.call_id : "",
      },
    ]
  }

  private workflowDone(ev: any): EngineEvent[] {
    if (typeof ev.session_id !== "string") return []
    const h = ev.handover && typeof ev.handover === "object" ? ev.handover : undefined
    return [
      {
        type: "workflow_done",
        workflowId: typeof ev.workflow_id === "string" ? ev.workflow_id : "",
        sessionId: ev.session_id,
        taskPath: typeof ev.task_path === "string" ? ev.task_path : "",
        status: ev.status === "completed" ? "completed" : "failed",
        ...(h
          ? {
              handover: {
                outcome: String(h.outcome ?? ""),
                path: String(h.path ?? ""),
                revision: Number(h.revision ?? 0),
                verification: String(h.verification ?? ""),
                openIssues: Array.isArray(h.open_issues) ? h.open_issues.length : Number(h.open_issues ?? 0),
                markdown: String(h.markdown ?? ""),
              },
            }
          : {}),
        ...(typeof ev.error === "string" && ev.error ? { error: ev.error } : {}),
      },
    ]
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
  /** The agent starts workflows in the background (NOMAD_WORKFLOW_MODE=async): their tool cards are plain tool calls. */
  asyncWorkflows?: boolean
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
    const translator = new RustStreamTranslator({ asyncWorkflows: options.asyncWorkflows })
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
      if (out.trim()) {
        const events = translator.feed(out)
        for (const event of events) onEvent(event)
        const partial = extractPartialEventText(out)
        if (partial) onEvent({ type: partial.type, text: partial.text, isError: false })
      }
      if (err.trim()) {
        const partial = extractPartialEventText(err)
        if (partial) onEvent({ type: partial.type, text: partial.text, isError: true })
      }
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
