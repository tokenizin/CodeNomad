/**
 * Claude Code (Rust): CodeNomad's local chat engine, the Rust re-implementation
 * of Claude Code from build-your-own-claude-code (playground/rust). It runs on
 * this machine against the configured OpenAI-compatible endpoint (Ollama by
 * default) — not the official Claude Code app or CLI.
 *
 *   GET    /api/local-engine/status
 *   GET    /api/local-engine/catalog?folder=&fresh=1   agents, slash commands, models (from the agent)
 *   POST   /api/local-engine/run       { prompt, cwd, sessionKey, agent?, model?, uploads?, messageIds? }
 *   GET    /api/local-engine/attach?sessionKey=&wait=1   follow the session's current run live (see below)
 *   POST   /api/local-engine/abort     { sessionKey }
 *   GET    /api/local-engine/history?sessionKey=        saved messages for a session
 *   POST   /api/local-engine/history/:key/truncate      { messageId }  revert from a message
 *   DELETE /api/local-engine/history/:key/messages/:id                 delete one message
 *   POST   /api/local-engine/history/:key/copy          { to, beforeMessageId? }  (after an OpenCode fork)
 *   GET    /api/local-engine/sessions?folder=           sessions kept by CodeNomad
 *   POST   /api/local-engine/sessions  { folder, title?, agent?, model? }
 *   POST   /api/local-engine/sessions/:id/fork { messageId?, folder? }
 *   PATCH  /api/local-engine/sessions/:id { title?, agent?, model? }
 *   DELETE /api/local-engine/sessions/:id
 *
 * /run streams NDJSON events (meta | delta | tool | tool_result | final | exit)
 * and saves the exchange to history when it ends, so replies survive a reload.
 * Runs are limited to folders CodeNomad has open as workspaces, one per session.
 *
 * Settings live in the server config under `localEngine`, with env fallbacks:
 *   playgroundRoot   CLAUDE_CODE_PLAYGROUND   build-your-own-claude-code checkout
 *   opencodeConfig   OPENCODE_CONFIG          opencode.jsonc with NomadWorks agents
 *   extraRoots       (none)                   more folders runs may use
 *
 * The old /api/playground/rust/{run,status} paths still work.
 */

import { type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import type { SettingsService } from "../../settings/service.js"
import { enrichRustCatalog } from "../../local-engine/catalog-enrich.js"
import { getCachedSyncResults } from "../../model-sync/service.js"
import { fetchOllamaModels } from "../../model-sync/providers/ollama.js"
import type { WorkspaceManager } from "../../workspaces/manager.js"
import { ReplyParts } from "../../local-engine/reply-parts.js"
import { TaskSessions } from "../../local-engine/task-sessions.js"
import { RunBus } from "../../local-engine/run-bus.js"
import { WorkflowSupervisor, type Manager } from "../../local-engine/workflows.js"
import {
  failureText,
  fetchRustCatalog,
  findRustRunner,
  recordRustTranscript,
  runRustAgent,
  type EngineEvent,
  type WorkflowDoneEvent,
} from "../../local-engine/rust-runner.js"
import { thinkingEnv } from "../../local-engine/thinking.js"
import { LocalEngineStore, safeKey, type HistoryAttachment, type HistoryMessage } from "../../local-engine/store.js"

type LocalEngineConfig = {
  playgroundRoot?: string
  opencodeConfig?: string
  extraRoots: string[]
}

type Deps = {
  settings: SettingsService
  workspaceManager: WorkspaceManager
  /** Defaults to a store in the settings data folder. */
  store?: LocalEngineStore
}

const UploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  mime: z.string().trim().max(100).optional(),
  /** base64 file contents (no data: prefix). */
  data: z.string().min(1),
})

const ModelSchema = z.object({ providerId: z.string(), modelId: z.string() })

const RunSchema = z
  .object({
    /** Ignored: Claude Code (Rust) is the only engine. Accepted for older UIs. */
    engine: z.string().optional(),
    prompt: z.string().default(""),
    cwd: z.string().trim().min(1).optional(),
    /** CodeNomad session id; keys the saved history. */
    sessionKey: z.string().trim().min(1).max(200).optional(),
    agent: z.string().trim().min(1).max(64).optional(),
    /** Model id from the agent's catalog. */
    model: z.string().trim().min(1).max(200).optional(),
    /** The "Thinking" option picked for the model (off, on, low, medium, high); nothing = the model's default. */
    variant: z.string().trim().min(1).max(32).optional(),
    /** Pasted files (images, etc.) sent inline. */
    uploads: z.array(UploadSchema).max(20).optional().default([]),
    /** Ids the UI already shows, so saved history lines up with them on reload. */
    messageIds: z.object({ user: z.string().max(100), assistant: z.string().max(100) }).optional(),
    /** What to show for the user message in history (defaults to prompt). */
    displayText: z.string().optional(),
    /** Names of attachments the user added (for history). */
    attachmentNames: z.array(z.string().max(200)).max(50).optional(),
    jsonl: z.boolean().optional().default(true),
    persist: z.boolean().optional().default(false),
  })
  .refine((body) => body.prompt.trim().length > 0 || body.uploads.length > 0, { message: "prompt is required" })

const QuestionReplySchema = z.object({
  sessionKey: z.string().trim().min(1).max(200),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  answers: z.array(z.array(z.string().max(2000)).max(50)).max(50).optional(),
  dismissed: z.boolean().optional(),
})
const PermissionReplySchema = z.object({
  sessionKey: z.string().trim().min(1).max(200),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  reply: z.enum(["once", "always", "reject"]),
})
const SessionKeySchema = z.object({ sessionKey: z.string().trim().min(1).max(200) })
const CreateSessionSchema = z.object({
  folder: z.string().trim().min(1),
  title: z.string().max(200).optional(),
  agent: z.string().max(64).optional(),
  model: ModelSchema.optional(),
})
const PatchSessionSchema = z.object({
  title: z.string().max(200).optional(),
  agent: z.string().max(64).optional(),
  model: ModelSchema.optional(),
})
const ForkSchema = z.object({ messageId: z.string().max(200).optional(), folder: z.string().trim().min(1).optional() })
const MessageIdSchema = z.object({ messageId: z.string().min(1).max(200) })
const CopySchema = z.object({ to: z.string().min(1).max(200), beforeMessageId: z.string().max(200).optional() })

const KILL_GRACE_MS = 5000
/** The agent picker's entry for the full agent; it means "no --agent". */
const FULL_AGENT = "claude-code"
/**
 * Status for "the Rust agent isn't set up or failed". Not 502/503: CodeNomad's
 * UI reads those as a tunnel outage and pauses all API calls.
 */
const AGENT_FAILED = 424
/** Pasted screenshots are large once base64-encoded. */
const RUN_BODY_LIMIT = 40 * 1024 * 1024
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
/** Earlier turns passed to the agent (newest kept). */
const HISTORY_CHARS = 48_000

// ---------------------------------------------------------------- config

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function readLocalEngineConfig(settings: SettingsService): LocalEngineConfig {
  let raw: Record<string, unknown> = {}
  try {
    const server = settings.getOwner("config", "server") as Record<string, unknown> | undefined
    const value = server?.localEngine
    if (value && typeof value === "object" && !Array.isArray(value)) raw = value as Record<string, unknown>
  } catch {
    /* fall back to env */
  }
  const extraRoots = Array.isArray(raw.extraRoots) ? raw.extraRoots.map(str).filter((v): v is string => Boolean(v)) : []
  return {
    playgroundRoot: str(raw.playgroundRoot) ?? str(process.env.CLAUDE_CODE_PLAYGROUND),
    // CLAUDE_CODE_ROSTER names the agent roster for this engine alone. OPENCODE_CONFIG is what OpenCode itself is
    // started with, and on the tunnel hosts that is a profile with no agents in it: used as the roster it left
    // Claude Code (Rust) without the Product Manager and every subagent.
    opencodeConfig: str(raw.opencodeConfig) ?? str(process.env.CLAUDE_CODE_ROSTER) ?? str(process.env.OPENCODE_CONFIG),
    extraRoots,
  }
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p
}

function findUpward(start: string, relative: string, levels = 6): string | null {
  let dir = path.resolve(start)
  for (let i = 0; i <= levels; i += 1) {
    const candidate = path.join(dir, relative)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** The NomadWorks agent catalog CodeNomad ships (CodeNomad/.opencode/opencode.jsonc). */
export function resolveOpencodeConfigPath(config: LocalEngineConfig): string | null {
  const explicit = config.opencodeConfig ? expandHome(config.opencodeConfig) : null
  if (explicit) return fs.existsSync(explicit) ? explicit : null
  const starworld = str(process.env.STARWORLD)
  if (starworld) {
    const candidate = path.join(starworld, "CodeNomad", ".opencode", "opencode.jsonc")
    if (fs.existsSync(candidate)) return candidate
  }
  return findUpward(process.cwd(), path.join(".opencode", "opencode.jsonc"))
}

/** build-your-own-claude-code checkout: configured, or next to the starworld repo, or in $HOME. */
export function resolvePlaygroundRoot(config: LocalEngineConfig): string | null {
  if (config.playgroundRoot) {
    const root = path.resolve(expandHome(config.playgroundRoot))
    return findRustRunner(root) ? root : null
  }
  const relative = path.join("0-claudecode", "build-your-own-claude-code")
  const candidates: string[] = []
  let dir = process.cwd()
  for (let i = 0; i < 5; i += 1) {
    dir = path.dirname(dir)
    candidates.push(path.join(dir, relative))
  }
  candidates.push(path.join(os.homedir(), relative))
  return candidates.find((candidate) => findRustRunner(candidate)) ?? null
}

// ---------------------------------------------------------------- workspace guard

function realpath(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function allowedRoots(deps: Pick<Deps, "workspaceManager">, config: LocalEngineConfig): string[] {
  const roots = [
    ...deps.workspaceManager.list().map((workspace) => workspace.path),
    ...(str(process.env.CLI_WORKSPACE_ROOT) ? [process.env.CLI_WORKSPACE_ROOT as string] : []),
    ...config.extraRoots.map(expandHome),
  ]
  return [...new Set(roots.map((root) => realpath(root)).filter((root): root is string => Boolean(root)))]
}

/** Returns the real path of cwd if it is inside an open workspace, else null. */
export function checkCwd(cwd: string, roots: string[]): string | null {
  const real = realpath(cwd)
  if (!real || !fs.statSync(real).isDirectory()) return null
  return roots.some((root) => isInside(root, real)) ? real : null
}

// ---------------------------------------------------------------- process helpers

const activeRuns = new Map<string, ChildProcess>()
/** Per running session: the directory the agent watches for `stop-<task_id>` markers (stopping one delegated task). */
const controlDirs = new Map<string, string>()

function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }, KILL_GRACE_MS)
  timer.unref?.()
}

/**
 * Env for the agent. Session markers of an enclosing Claude Code terminal
 * (if CodeNomad was started from one) are not passed on.
 */
const INHERITED_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"]

/**
 * launchd and desktop launches give CodeNomad a minimal PATH (/usr/bin:/bin:…),
 * so your_program.sh can't find cargo. Add the usual tool folders that exist.
 */
export function withToolPaths(currentPath: string | undefined, home = os.homedir()): string {
  const parts = (currentPath ?? "").split(path.delimiter).filter(Boolean)
  const extra = [
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
  ].filter((dir) => !parts.includes(dir) && fs.existsSync(dir))
  return [...parts, ...extra].join(path.delimiter)
}

function agentEnv(root: string, opencodeConfig: string | null): NodeJS.ProcessEnv {
  const starworld = str(process.env.STARWORLD) ?? str(process.env.CLI_WORKSPACE_ROOT)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: withToolPaths(process.env.PATH),
    ...(starworld ? { STARWORLD: starworld } : {}),
    CLAUDE_CODE_PLAYGROUND: root,
    ...(opencodeConfig ? { OPENCODE_CONFIG: opencodeConfig } : {}),
    NOMAD_AGENTS: process.env.NOMAD_AGENTS || "opencode",
  }
  for (const name of INHERITED_SESSION_VARS) delete env[name]
  return env
}

/** False once the client is gone; runs keep going and are saved to history. */
function canWrite(reply: FastifyReply): boolean {
  return !reply.raw.writableEnded && !reply.raw.destroyed
}

function startStream(reply: FastifyReply) {
  reply.raw.setHeader("Content-Type", "application/x-ndjson; charset=utf-8")
  reply.raw.setHeader("Cache-Control", "no-cache")
  reply.raw.setHeader("X-Accel-Buffering", "no")
  reply.raw.setHeader("X-Local-Engine", "claude-code-rust")
  reply.raw.flushHeaders?.()
  reply.hijack()
  return (event: EngineEvent | Record<string, unknown>) => {
    if (canWrite(reply)) reply.raw.write(JSON.stringify(event) + "\n")
  }
}

// ---------------------------------------------------------------- history → agent

/**
 * Earlier turns for `--history`, oldest first, newest kept within the budget.
 * Failed replies are left out; attachments are noted by name.
 */
export function historyForAgent(history: HistoryMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const turns: Array<{ role: "user" | "assistant"; content: string }> = []
  let size = 0
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]
    if (message.isError) continue
    let content = message.text.replace(/\n*_\(stopped\)_\s*$/, "").trim()
    if (message.role === "user" && message.attachments?.length) {
      content += `\n\n[attached: ${message.attachments.map((a) => a.filename).join(", ")}]`
    }
    if (!content.trim()) continue
    if (size + content.length > HISTORY_CHARS) break
    turns.unshift({ role: message.role, content })
    size += content.length
  }
  return turns
}

// ---------------------------------------------------------------- uploads

type SavedUploads = { images: string[]; promptLines: string[]; attachments: HistoryAttachment[] }

function saveUploads(
  store: LocalEngineStore,
  sessionKey: string | undefined,
  uploads: Array<{ filename: string; mime?: string; data: string }>,
): SavedUploads {
  const result: SavedUploads = { images: [], promptLines: [], attachments: [] }
  for (const upload of uploads) {
    const data = Buffer.from(upload.data, "base64")
    if (data.length === 0) continue
    const mime = upload.mime?.toLowerCase()
    const file = store.saveAttachment(sessionKey ?? "_unsorted", upload.filename, data)
    result.attachments.push({ filename: upload.filename, mime, path: file })
    // Images go to the model as images (--image); other files by path.
    if (mime && IMAGE_TYPES.has(mime)) result.images.push(file)
    else result.promptLines.push(`Attached file: ${file}`)
  }
  return result
}

// ---------------------------------------------------------------- routes

export function registerLocalEngineRoutes(app: FastifyInstance, deps: Deps) {
  const store = deps.store ?? new LocalEngineStore(deps.settings.getDataDir())
  // No run is alive yet, so a task session still marked running was cut off by the last shutdown.
  const interrupted = store.reconcileInterruptedTasks()
  if (interrupted > 0) app.log?.warn?.({ interrupted }, "local engine: marked task sessions left running by the last shutdown as failed")
  /** Lets /abort tell a run it was stopped on purpose (for the saved "(stopped)" note). */
  const abortListeners = new Map<string, () => void>()
  /** The runs going now, for pages that did not start them (GET /attach). */
  const runBus = new RunBus()

  /** Runs workflows in the background and tells the Product Manager when they are done (workflows.ts). */
  const supervisor: WorkflowSupervisor = new WorkflowSupervisor({
    store,
    isBusy: (key) => activeRuns.has(key),
    warn: (message, detail) => app.log?.warn?.({ detail }, `local engine: ${message}`),
    execute: async (job) => {
      const { playgroundRoot, runner, opencodeConfig } = engineSetup()
      if (!playgroundRoot || !runner) throw new Error("Claude Code (Rust) not found")
      const outcome = await executeRun({
        sessionKey: job.sessionKey,
        cwd: job.folder,
        prompt: job.prompt,
        displayText: job.displayText,
        agent: job.agent && job.agent !== FULL_AGENT ? job.agent : undefined,
        model: job.model,
        uploads: { images: [], promptLines: [], attachments: [] },
        attachmentNames: [],
        persist: false,
        history: job.history,
        extraEnv: job.env,
        assistantAgent: job.assistantAgent,
        playgroundRoot,
        runner,
        opencodeConfig,
        send: () => {},
      })
      return { stopped: outcome.stopped, isError: outcome.isError, finalText: outcome.finalText, workflowDone: outcome.workflowDone }
    },
  })

  const engineSetup = () => {
    const config = readLocalEngineConfig(deps.settings)
    const playgroundRoot = resolvePlaygroundRoot(config)
    const runner = playgroundRoot ? findRustRunner(playgroundRoot) : null
    const opencodeConfig = resolveOpencodeConfigPath(config)
    return { config, playgroundRoot, runner, opencodeConfig }
  }

  const status = async () => {
    const { config, playgroundRoot, runner, opencodeConfig } = engineSetup()
    const rust = {
      ok: Boolean(runner),
      runner,
      playgroundRoot: playgroundRoot ?? config.playgroundRoot ?? null,
      error: runner
        ? null
        : config.playgroundRoot
          ? `playground/rust/your_program.sh not found under ${config.playgroundRoot}`
          : "Set Engine setup → Playground root to your build-your-own-claude-code checkout.",
    }
    return {
      ok: rust.ok,
      engine: "claude-code-rust",
      rust,
      // Older UIs read rustPlayground.
      rustPlayground: rust,
      opencodeConfig,
      workspaceRoots: allowedRoots(deps, config),
      activeRuns: activeRuns.size,
      bridge: runner,
      claudeCodePlayground: playgroundRoot,
      persist: process.env.PLAYGROUND_PERSIST === "1",
      // 2 = delegated tasks stream their own events and get their own sessions (NOMAD_PROTOCOL=2).
      taskProtocol: process.env.NOMAD_PROTOCOL?.trim() === "2" ? 2 : 1,
    }
  }

  const resolveFolder = (folder: string | undefined): string | null => {
    const { config } = engineSetup()
    const target = folder ?? str(process.env.CLI_WORKSPACE_ROOT)
    return target ? checkCwd(target, allowedRoots(deps, config)) : null
  }

  /** What one agent run needs, whoever asked for it (a person's message, a background workflow, a notification). */
  type RunParams = {
    sessionKey?: string
    cwd: string
    /** What the agent is given (the message plus any uploaded files' paths). */
    prompt: string
    /** What the history shows as the user message. */
    displayText: string
    agent?: string
    model?: string
    uploads: SavedUploads
    attachmentNames: string[]
    messageIds?: { user: string; assistant: string }
    persist: boolean
    /** Earlier turns of the session go to the agent. */
    history: boolean
    extraEnv?: Record<string, string>
    /** Agent name saved on the reply when the process is not started with `--agent`. */
    assistantAgent?: string
    playgroundRoot: string
    runner: string
    opencodeConfig: string | null
    send: (event: EngineEvent | Record<string, unknown>) => void
  }

  type RunOutcome = { code: number; isError: boolean; stopped: boolean; finalText: string; workflowDone?: WorkflowDoneEvent }

  /** Runs the agent for a session to the end, streams its events to `send`, and saves the exchange to history. */
  const executeRun = async (params: RunParams): Promise<RunOutcome> => {
    const { sessionKey, cwd, uploads, playgroundRoot, runner, opencodeConfig } = params
    const agent = params.agent
    const model = params.model

    // Earlier turns, read before this run adds to them.
    const history = sessionKey && params.history ? historyForAgent(store.readHistory(sessionKey)) : []
    let historyFile: string | undefined
    if (history.length) {
      historyFile = path.join(os.tmpdir(), `codenomad-history-${randomUUID()}.json`)
      fs.writeFileSync(historyFile, JSON.stringify(history))
    }

    const register = (child: ChildProcess) => {
      if (sessionKey) activeRuns.set(sessionKey, child)
    }
    let aborted = false
    if (sessionKey) abortListeners.set(sessionKey, () => (aborted = true))

    // The ids the saved history will use, known now so a page that attaches to this run draws the very messages that get saved.
    const startedAt = Date.now()
    const userMessageId = params.messageIds?.user ?? `msg_lu_${startedAt.toString(36)}`
    const assistantMessageId = params.messageIds?.assistant ?? `msg_la_${startedAt.toString(36)}`
    // Every event goes to the caller and to any page watching this session (run-bus.ts).
    const send = (event: EngineEvent | Record<string, unknown>) => {
      params.send(event)
      if (sessionKey) runBus.publish(sessionKey, event)
    }
    if (sessionKey) {
      runBus.start({
        type: "attach",
        sessionKey,
        startedAt,
        user: { id: userMessageId, text: params.displayText, createdAt: startedAt },
        assistantId: assistantMessageId,
        ...(params.agent ?? params.assistantAgent ? { agent: params.agent ?? params.assistantAgent } : {}),
        ...(params.model ? { model: params.model } : {}),
      })
    }

    const replyParts = new ReplyParts()
    const transcript: object[] = []
    // Protocol 2 (the agent runs with NOMAD_PROTOCOL=2): each delegated task gets
    // its own session. Needs a session to hang them on.
    const taskSessions = sessionKey ? new TaskSessions({ store, parentSessionId: sessionKey, folder: cwd, parentParts: replyParts }) : undefined
    const manager: Manager | undefined = sessionKey ? { key: sessionKey, folder: cwd, agent, model } : undefined
    let workflowDone: WorkflowDoneEvent | undefined
    const write = (incoming: EngineEvent) => {
      replyParts.apply(incoming)
      // A task_start goes on to the browser with its session and message ids.
      const event = taskSessions ? taskSessions.apply(incoming) : incoming
      transcript.push(event)
      send(event)
      // A workflow the Product Manager started or wrote to runs in the background; its runner's process ends with workflow_done.
      if (incoming.type === "workflow_start" && manager) supervisor.start(manager, incoming)
      else if (incoming.type === "workflow_prompt" && manager) supervisor.prompt(manager, incoming)
      else if (incoming.type === "workflow_done") workflowDone = incoming
    }

    const env = agentEnv(playgroundRoot, opencodeConfig)
    // Workflows start in the background unless the host says otherwise (NOMAD_WORKFLOW_MODE=sync).
    env.NOMAD_WORKFLOW_MODE = process.env.NOMAD_WORKFLOW_MODE?.trim() || "async"
    // Subagents the agent delegates to (Task tool) keep their conversations per
    // session, so "resume task_id …" works on later messages.
    let controlDir: string | undefined
    if (sessionKey) {
      env.CODENOMAD_TASK_STORE = store.tasksDir(sessionKey)
      env.CODENOMAD_SESSION_KEY = sessionKey
      // The agent looks here for a marker that asks it to stop one task of the run (POST /abort for a task session).
      controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-control-"))
      controlDirs.set(sessionKey, controlDir)
      env.NOMAD_CONTROL_DIR = controlDir
    }
    Object.assign(env, params.extraEnv)
    let code = 1
    let isError = true
    let usedModel = model
    let usage: HistoryMessage["usage"]
    let fallbackError: string | undefined
    let finalText = ""
    try {
      const result = await runRustAgent(
        { runner, cwd, env, prompt: params.prompt, agent, model, images: uploads.images, historyFile, asyncWorkflows: env.NOMAD_WORKFLOW_MODE?.toLowerCase() === "async" },
        write,
        register,
      )
      code = result.code
      usedModel = result.translator.model ?? model
      usage = result.translator.usage
      isError = result.translator.isError || code !== 0
      if (!result.translator.sawFinal) {
        fallbackError = failureText(code, result.stderr)
        write({ type: "final", text: isError ? fallbackError : replyParts.text(), isError })
      }
      finalText = result.translator.sawFinal ? result.translator.finalText : (fallbackError ?? replyParts.text())
      if (params.persist || process.env.PLAYGROUND_PERSIST === "1") {
        const warning = await recordRustTranscript(
          playgroundRoot,
          [{ type: "meta", cwd, prompt: params.prompt, agent: agent ?? null }, ...transcript, { type: "exit", code }],
          env,
        )
        if (warning) send({ type: "stderr", line: `WARN: ${warning}` })
      }
      send({ type: "exit", code })
    } catch (error) {
      finalText = error instanceof Error ? error.message : String(error)
      send({ type: "exit", code: 1, error: finalText })
    } finally {
      if (historyFile) fs.rmSync(historyFile, { force: true })
      if (controlDir) {
        controlDirs.delete(sessionKey!)
        fs.rmSync(controlDir, { recursive: true, force: true })
      }
      if (sessionKey) {
        activeRuns.delete(sessionKey)
        abortListeners.delete(sessionKey)
        const stopped = aborted
        const names = params.attachmentNames
        const attachments: HistoryAttachment[] = [
          ...names.filter((name) => !uploads.attachments.some((a) => a.filename === name)).map((filename) => ({ filename })),
          ...uploads.attachments,
        ]
        // Tasks still open when the run ended keep what they did.
        taskSessions?.finish({ stopped })
        const saved = replyParts.finish({ stopped, isError, fallbackError })
        const label = agent ?? params.assistantAgent
        const messages: HistoryMessage[] = [
          {
            id: userMessageId,
            role: "user",
            text: params.displayText,
            createdAt: startedAt,
            ...(attachments.length ? { attachments } : {}),
          },
          {
            id: assistantMessageId,
            role: "assistant",
            text: saved.text,
            parts: saved.parts,
            createdAt: Date.now(),
            engine: "claude-code-rust",
            ...(label ? { agent: label } : {}),
            ...(usedModel ? { model: usedModel } : {}),
            ...(usage ? { usage } : {}),
            ...(isError && !stopped ? { isError: true } : {}),
          },
        ]
        try {
          store.appendHistory(sessionKey, messages)
        } catch (error) {
          app.log?.warn?.({ error }, "local engine: could not save history")
        }
        // Pages watching the run are told it is over once its history is saved, so what they reload is complete.
        runBus.end(sessionKey)
        // Whatever was waiting for this session to be free (a runner's notification) can go in now.
        supervisor.sessionIdle(sessionKey)
      }
    }
    return { code, isError, stopped: aborted, finalText, workflowDone }
  }

  const run = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = RunSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid body", details: parsed.error.flatten() }
    }
    const body = parsed.data

    const sessionKey = body.sessionKey && safeKey(body.sessionKey) ? body.sessionKey : undefined
    if (body.sessionKey && !sessionKey) {
      reply.code(400)
      return { error: "Invalid sessionKey" }
    }

    const localSession = sessionKey ? store.getSession(sessionKey) : undefined
    const requestedCwd = body.cwd ?? localSession?.folder
    const cwd = resolveFolder(requestedCwd)
    if (!cwd) {
      reply.code(403)
      return {
        error: requestedCwd ? `Folder is not an open CodeNomad workspace: ${requestedCwd}` : "No folder given for the run",
        hint: "Open the folder as a workspace in CodeNomad, or add it under Engine setup → Extra folders.",
      }
    }

    if (sessionKey && activeRuns.has(sessionKey)) {
      reply.code(409)
      return { error: "This session already has a run in progress. Stop it first." }
    }

    const { playgroundRoot, runner, opencodeConfig } = engineSetup()
    if (!playgroundRoot || !runner) {
      reply.code(AGENT_FAILED)
      return {
        error: "Claude Code (Rust) not found",
        hint: "Set Engine setup → Playground root to your build-your-own-claude-code checkout.",
      }
    }

    const uploads = saveUploads(store, sessionKey, body.uploads)
    const prompt = [body.prompt, ...uploads.promptLines].filter((part) => part.trim()).join("\n\n") || "(see attached image)"
    // "claude-code" is the UI's name for the full agent (no --agent).
    const requestedAgent = body.agent ?? (localSession?.agent || undefined)
    const agent = requestedAgent && requestedAgent !== FULL_AGENT ? requestedAgent : undefined
    const model = body.model ?? (localSession?.model?.modelId || undefined)

    // A closed page (reload, sleep, network blip) does not stop the run: it
    // finishes and is saved to history. Only Stop (/abort) ends it early.
    reply.raw.on("error", () => {})
    const send = startStream(reply)
    try {
      await executeRun({
        sessionKey,
        cwd,
        prompt,
        displayText: body.displayText ?? body.prompt,
        agent,
        model,
        uploads,
        attachmentNames: body.attachmentNames ?? [],
        messageIds: body.messageIds,
        persist: body.persist,
        history: true,
        extraEnv: thinkingEnv(body.variant),
        playgroundRoot,
        runner,
        opencodeConfig,
        send,
      })
    } finally {
      if (canWrite(reply)) reply.raw.end()
    }
  }

  // (After executeRun exists: the notification is a run.) A runner that was working when the server stopped is gone: release the worktree it held, and tell the manager that was waiting for it.
  supervisor.restoreInbox()
  supervisor.recoverInterrupted(store.reconcileInterruptedWorkflows())

  const bad = (reply: FastifyReply, error: string, code = 400) => {
    reply.code(code)
    return { error }
  }

  app.get("/api/local-engine/status", status)

  app.get("/api/local-engine/catalog", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>
    const cwd = resolveFolder(str(query.folder))
    if (!cwd) return bad(reply, "Folder is not an open CodeNomad workspace", 403)
    const { playgroundRoot, runner, opencodeConfig } = engineSetup()
    if (!playgroundRoot || !runner) return bad(reply, "Claude Code (Rust) not found. Set Engine setup → Playground root.", AGENT_FAILED)
    try {
      const catalog = await fetchRustCatalog(runner, cwd, agentEnv(playgroundRoot, opencodeConfig), { fresh: query.fresh === "1" })
      // The agent only lists ids; add context, cost and capabilities for the model picker.
      return await enrichRustCatalog(catalog, { syncResults: getCachedSyncResults, fetchOllamaModels })
    } catch (error) {
      return bad(reply, error instanceof Error ? error.message : String(error), AGENT_FAILED)
    }
  })

  app.post("/api/local-engine/run", { bodyLimit: RUN_BODY_LIMIT }, (request, reply) => run(request, reply))

  /**
   * Follows the session's run live. A run going now is replayed from its start and followed to its end
   * (`{type:"attach",…}` first, then the run's own events, ending with `exit`). With `wait=1` and nothing running but a
   * workflow's notification pending, the call is held open until that run starts. Otherwise `{type:"idle"}` and the
   * stream ends. Reconnect after each end while the session is `watching`.
   */
  app.get("/api/local-engine/attach", async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>
    const sessionKey = str(query.sessionKey)
    if (!sessionKey || !safeKey(sessionKey)) return bad(reply, "sessionKey is required")
    const wait = str(query.wait) === "1"
    const send = startStream(reply)
    let stop: (() => void) | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      stop?.()
      if (timer) clearInterval(timer)
      if (canWrite(reply)) reply.raw.end()
    }
    reply.raw.on("close", finish)
    reply.raw.on("error", () => {})
    const follow = (): boolean => {
      const header = runBus.current(sessionKey)
      if (!header) return false
      send(header)
      stop = runBus.follow(sessionKey, (event) => {
        if (event === null) return finish()
        send(event as EngineEvent)
      })
      return true
    }
    if (follow()) return
    if (!wait || !supervisor.watching(sessionKey)) {
      send({ type: "idle" })
      return finish()
    }
    // Hold the connection until the pending run starts (or there is nothing pending any more).
    let beats = 0
    timer = setInterval(() => {
      if (finished) return
      if (follow()) {
        clearInterval(timer)
        timer = undefined
      } else if (!supervisor.watching(sessionKey)) {
        send({ type: "idle" })
        finish()
      } else if (++beats % 30 === 0) {
        send({ type: "ping" })
      }
    }, 250)
    timer.unref?.()
  })

  app.post("/api/local-engine/abort", async (request, reply) => {
    const parsed = SessionKeySchema.safeParse(request.body ?? {})
    if (!parsed.success) return bad(reply, "sessionKey is required")
    const child = activeRuns.get(parsed.data.sessionKey)
    if (!child) {
      // A delegated task's own session: Stop ends that task only; the run it belongs to goes on.
      const stopped = stopTask(parsed.data.sessionKey)
      return stopped ? { aborted: true, task: true } : { aborted: false }
    }
    abortListeners.get(parsed.data.sessionKey)?.()
    stopChild(child)
    return { aborted: true }
  })

  /**
   * Asks the run a task belongs to to stop just that task. The task's session is a child of the session that
   * dispatched it (or of another task); the run is the nearest ancestor that is going. False when the session
   * is not a running task, or none of its ancestors has a run.
   */
  const stopTask = (sessionId: string): boolean => {
    const session = store.getSession(sessionId)
    if (!session || session.kind !== "task" || session.taskStatus !== "running" || !session.taskId) return false
    const dir = runControlDir(sessionId)
    if (!dir) return false
    fs.writeFileSync(path.join(dir, `stop-${session.taskId}`), "")
    return true
  }

  /** The control directory of the run a session belongs to: its own, or that of the nearest ancestor that is going. */
  const runControlDir = (sessionId: string): string | undefined => {
    let id: string | undefined = sessionId
    for (let depth = 0; id && depth < 16; depth += 1) {
      const dir = controlDirs.get(id)
      if (dir && activeRuns.has(id)) return dir
      id = store.getSession(id)?.parentId
    }
    return undefined
  }

  /**
   * The user's answer to a question the agent asked (the `question` tool), or their dismissal. `sessionKey` is the session
   * the question was shown in (a task's own session for a task's question). Written where the waiting agent looks.
   */
  app.post("/api/local-engine/question", async (request, reply) => {
    const parsed = QuestionReplySchema.safeParse(request.body ?? {})
    if (!parsed.success || !safeKey(parsed.data.sessionKey)) return bad(reply, "sessionKey and requestId are required")
    const doc = parsed.data.dismissed ? { dismissed: true } : { answers: parsed.data.answers ?? [] }
    return answerWaitingAgent(reply, parsed.data.sessionKey, parsed.data.requestId, doc)
  })

  /** The user's reply to a permission the agent asked for (a rule says `ask`): once, always, or reject. */
  app.post("/api/local-engine/permission", async (request, reply) => {
    const parsed = PermissionReplySchema.safeParse(request.body ?? {})
    if (!parsed.success || !safeKey(parsed.data.sessionKey)) return bad(reply, "sessionKey, requestId and reply are required")
    return answerWaitingAgent(reply, parsed.data.sessionKey, parsed.data.requestId, { reply: parsed.data.reply })
  })

  /** Puts the user's answer where the waiting agent looks (the control directory of the run the session belongs to). */
  const answerWaitingAgent = (reply: FastifyReply, sessionKey: string, requestId: string, doc: object) => {
    const dir = runControlDir(sessionKey)
    if (!dir) return bad(reply, "Nothing is waiting for an answer in this session", 409)
    const target = path.join(dir, `answer-${requestId}.json`)
    const temp = `${target}.tmp`
    fs.writeFileSync(temp, JSON.stringify(doc))
    fs.renameSync(temp, target)
    return { answered: true }
  }

  app.get("/api/local-engine/history", async (request, reply) => {
    const parsed = SessionKeySchema.safeParse(request.query ?? {})
    if (!parsed.success || !safeKey(parsed.data.sessionKey)) return bad(reply, "sessionKey is required")
    // running: a run for this session is still going (e.g. the page was reloaded mid-run).
    // watching: a background workflow of this session is still working, or its notification has not been delivered yet.
    return {
      messages: store.readHistory(parsed.data.sessionKey),
      running: activeRuns.has(parsed.data.sessionKey),
      watching: supervisor.watching(parsed.data.sessionKey),
    }
  })

  app.post("/api/local-engine/history/:key/truncate", async (request, reply) => {
    const key = (request.params as { key: string }).key
    const parsed = MessageIdSchema.safeParse(request.body ?? {})
    if (!safeKey(key) || !parsed.success) return bad(reply, "messageId is required")
    if (activeRuns.has(key)) return bad(reply, "Stop the run first", 409)
    return { removed: store.truncateHistory(key, parsed.data.messageId) }
  })

  app.delete("/api/local-engine/history/:key/messages/:id", async (request, reply) => {
    const { key, id } = request.params as { key: string; id: string }
    if (!safeKey(key)) return bad(reply, "Invalid key")
    return { deleted: store.deleteHistoryMessage(key, id) }
  })

  app.post("/api/local-engine/history/:key/copy", async (request, reply) => {
    const key = (request.params as { key: string }).key
    const parsed = CopySchema.safeParse(request.body ?? {})
    if (!safeKey(key) || !parsed.success || !safeKey(parsed.data.to)) return bad(reply, "Invalid body")
    return { copied: store.copyHistory(key, parsed.data.to, parsed.data.beforeMessageId) }
  })

  app.get("/api/local-engine/sessions", async (request) => {
    const folder = str((request.query as Record<string, unknown> | undefined)?.folder)
    const real = folder ? realpath(folder) ?? folder : undefined
    // Match on both the given and the real path (symlinked workspace folders).
    // Delegated task sessions are listed only on request (?tasks=1), so clients that don't know them see what they always did.
    const includeTasks = str((request.query as Record<string, unknown> | undefined)?.tasks) === "1"
    const listed = { includeTasks }
    const sessions = folder
      ? [...new Map([...store.listSessions(folder, listed), ...(real ? store.listSessions(real, listed) : [])].map((s) => [s.id, s])).values()]
      : store.listSessions(undefined, listed)
    // `running`: a turn is going in this session now; `watching`: a background workflow of it is still working or its
    // notification is undelivered. A page that has just (re)loaded uses them to show what is busy and to follow it.
    const listedSessions = sessions
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ ...s, running: activeRuns.has(s.id), watching: supervisor.watching(s.id) }))
    return { sessions: listedSessions }
  })

  app.post("/api/local-engine/sessions", async (request, reply) => {
    const parsed = CreateSessionSchema.safeParse(request.body ?? {})
    if (!parsed.success) return bad(reply, "Invalid body")
    if (!resolveFolder(parsed.data.folder)) return bad(reply, `Folder is not an open CodeNomad workspace: ${parsed.data.folder}`, 403)
    // Keep the folder as the UI knows it, so listing by workspace path matches.
    return store.createSession({ ...parsed.data, folder: path.resolve(parsed.data.folder) })
  })

  app.post("/api/local-engine/sessions/:id/fork", async (request, reply) => {
    const id = (request.params as { id: string }).id
    const parsed = ForkSchema.safeParse(request.body ?? {})
    if (!safeKey(id) || !parsed.success) return bad(reply, "Invalid body")
    const source = store.getSession(id)
    // An OpenCode session can be forked into a local one too (its local-engine turns come along).
    const folder = source?.folder ?? parsed.data.folder
    if (!folder || !resolveFolder(folder)) return bad(reply, "Folder is not an open CodeNomad workspace", 403)
    const forked = store.createSession({
      folder: path.resolve(folder),
      title: `Fork: ${source?.title ?? "session"}`,
      agent: source?.agent,
      model: source?.model,
    })
    store.copyHistory(id, forked.id, parsed.data.messageId)
    return { ...forked, parentId: id }
  })

  app.patch("/api/local-engine/sessions/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id
    const parsed = PatchSessionSchema.safeParse(request.body ?? {})
    if (!parsed.success) return bad(reply, "Invalid body")
    const updated = store.updateSession(id, parsed.data)
    if (!updated) return bad(reply, "Session not found", 404)
    return updated
  })

  app.delete("/api/local-engine/sessions/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id
    if (!safeKey(id)) return bad(reply, "Invalid id")
    const child = activeRuns.get(id)
    if (child) stopChild(child)
    supervisor.forget(id)
    return { deleted: store.deleteSession(id) }
  })

  app.post("/api/local-engine/sessions/:id/compact", async (request, reply) => {
    const id = (request.params as { id: string }).id
    if (!safeKey(id)) return bad(reply, "Invalid id")
    const body = (request.body ?? {}) as Record<string, unknown>
    const keepCount = typeof body.keepCount === "number" && body.keepCount > 0 ? Math.min(Math.floor(body.keepCount), 200) : 20
    const result = store.compactHistory(id, keepCount)
    return { ...result, sessionId: id }
  })

  // Legacy paths (P4 bridge).
  app.get("/api/playground/rust/status", status)
  app.post("/api/playground/rust/run", { bodyLimit: RUN_BODY_LIMIT }, (request, reply) => run(request, reply))
}
