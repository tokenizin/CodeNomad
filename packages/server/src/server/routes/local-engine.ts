/**
 * Local chat engines: run a prompt through the local Claude Code CLI (default)
 * or the build-your-own-claude-code Rust agent instead of OpenCode.
 *
 *   GET    /api/local-engine/status
 *   POST   /api/local-engine/run       { engine, prompt, cwd, sessionKey, agent?, model?, uploads?, messageIds? }
 *   POST   /api/local-engine/abort     { sessionKey }
 *   POST   /api/local-engine/reset     { sessionKey }   forget the Claude conversation
 *   GET    /api/local-engine/history?sessionKey=        saved messages for a session
 *   GET    /api/local-engine/sessions?folder=           sessions created without OpenCode
 *   POST   /api/local-engine/sessions  { folder, title?, agent?, model? }
 *   PATCH  /api/local-engine/sessions/:id { title?, agent?, model? }
 *   DELETE /api/local-engine/sessions/:id
 *
 * /run streams NDJSON events (see local-engine/claude-stream.ts) and saves the
 * exchange to history when it ends, so replies survive a page reload. Runs are
 * limited to folders CodeNomad has open as workspaces, one run per session.
 *
 * Settings live in the server config under `localEngine`, with env fallbacks:
 *   claudeBinary     CLAUDE_CODE_BIN              path or name of the claude CLI
 *   permissionMode   CLAUDE_CODE_PERMISSION_MODE  e.g. acceptEdits, plan
 *   playgroundRoot   CLAUDE_CODE_PLAYGROUND       build-your-own-claude-code checkout
 *   opencodeConfig   OPENCODE_CONFIG              opencode.jsonc with NomadWorks agents
 *   extraRoots       (none)                       more folders runs may use
 *
 * The old /api/playground/rust/{run,status} paths still work.
 */

import { execFile, spawn, type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import type { SettingsService } from "../../settings/service.js"
import type { WorkspaceManager } from "../../workspaces/manager.js"
import { ClaudeStreamTranslator, type LocalEngineEvent } from "../../local-engine/claude-stream.js"
import { hasClaudeAgentFile, OPENCODE_BUILTIN_AGENTS, resolveNomadAgent } from "../../local-engine/agents.js"
import { ReplyText } from "../../local-engine/reply-text.js"
import {
  findRustRunner,
  recordRustTranscript,
  runRustAgent,
  rustPrompt,
  withConversationContext,
} from "../../local-engine/rust-runner.js"
import { LocalEngineStore, safeKey, type HistoryAttachment, type HistoryMessage } from "../../local-engine/store.js"

export type LocalEngineKind = "claude-cli" | "rust-playground"

type LocalEngineConfig = {
  claudeBinary?: string
  permissionMode?: string
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
    engine: z.enum(["claude-cli", "rust-playground"]).optional().default("claude-cli"),
    prompt: z.string().default(""),
    cwd: z.string().trim().min(1).optional(),
    /** CodeNomad session id; keys the Claude conversation and saved history. */
    sessionKey: z.string().trim().min(1).max(200).optional(),
    agent: z.string().trim().min(1).max(64).optional(),
    /** Claude model id (only used by the claude-cli engine). */
    model: z.string().trim().min(1).max(200).optional(),
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

const PERMISSION_MODE = /^[A-Za-z]{2,32}$/
const STATE_OWNER = "localEngine"
const KILL_GRACE_MS = 5000
/** Pasted screenshots are large once base64-encoded. */
const RUN_BODY_LIMIT = 40 * 1024 * 1024
const CLAUDE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

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
    claudeBinary: str(raw.claudeBinary) ?? str(process.env.CLAUDE_CODE_BIN),
    permissionMode: str(raw.permissionMode) ?? str(process.env.CLAUDE_CODE_PERMISSION_MODE),
    playgroundRoot: str(raw.playgroundRoot) ?? str(process.env.CLAUDE_CODE_PLAYGROUND),
    opencodeConfig: str(raw.opencodeConfig) ?? str(process.env.OPENCODE_CONFIG),
    extraRoots,
  }
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** launchd and desktop launches often have a short PATH, so also try the usual install spots. */
export function findClaudeBinary(configured?: string): string | null {
  if (configured) {
    const expanded = expandHome(configured)
    if (expanded.includes("/")) return isExecutable(expanded) ? path.resolve(expanded) : null
  }
  const name = configured || "claude"
  const home = os.homedir()
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
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

// ---------------------------------------------------------------- claude session memory

type SessionRecord = { claudeSessionId: string; cwd: string; updatedAt: number }

function readSessions(settings: SettingsService): Record<string, SessionRecord> {
  try {
    const doc = settings.getOwner("state", STATE_OWNER) as Record<string, unknown> | undefined
    const sessions = doc?.claudeSessions
    return sessions && typeof sessions === "object" ? (sessions as Record<string, SessionRecord>) : {}
  } catch {
    return {}
  }
}

function getClaudeSession(settings: SettingsService, sessionKey: string, cwd: string): string | undefined {
  const record = readSessions(settings)[sessionKey]
  // A Claude conversation is tied to its folder; a different folder starts fresh.
  return record && record.cwd === cwd && typeof record.claudeSessionId === "string" ? record.claudeSessionId : undefined
}

function setClaudeSession(settings: SettingsService, sessionKey: string, record: SessionRecord | null) {
  try {
    settings.mergePatchOwner("state", STATE_OWNER, { claudeSessions: { [sessionKey]: record } })
  } catch {
    /* best effort: the next send just starts a new conversation */
  }
}

// ---------------------------------------------------------------- process helpers

const activeRuns = new Map<string, ChildProcess>()

function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }, KILL_GRACE_MS)
  timer.unref?.()
}

/**
 * Env for child engines. If CodeNomad itself was started from a Claude Code
 * terminal, these would make the child think it is nested in, or is, that session.
 */
const INHERITED_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT"]

function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const name of INHERITED_SESSION_VARS) delete env[name]
  return env
}

let versionCache: { bin: string; at: number; version: string | null; error?: string } | null = null

function claudeVersion(bin: string): Promise<{ version: string | null; error?: string }> {
  if (versionCache && versionCache.bin === bin && Date.now() - versionCache.at < 60_000) {
    return Promise.resolve(versionCache)
  }
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 10_000, env: childEnv() }, (error, stdout) => {
      const result = error ? { version: null, error: error.message } : { version: stdout.toString().trim() || null }
      versionCache = { bin, at: Date.now(), ...result }
      resolve(result)
    })
  })
}

/** False once the client is gone; runs keep going and are saved to history. */
function canWrite(reply: FastifyReply): boolean {
  return !reply.raw.writableEnded && !reply.raw.destroyed
}

function startStream(reply: FastifyReply, contentType: string, extraHeaders: Record<string, string> = {}) {
  reply.raw.setHeader("Content-Type", contentType)
  reply.raw.setHeader("Cache-Control", "no-cache")
  reply.raw.setHeader("X-Accel-Buffering", "no")
  for (const [key, value] of Object.entries(extraHeaders)) reply.raw.setHeader(key, value)
  reply.raw.flushHeaders?.()
  reply.hijack()
  return (event: LocalEngineEvent | Record<string, unknown>) => {
    if (canWrite(reply)) reply.raw.write(JSON.stringify(event) + "\n")
  }
}

// ---------------------------------------------------------------- claude-cli engine

type ImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } }

type ClaudeRunPlan = {
  bin: string
  cwd: string
  prompt: string
  images: ImageBlock[]
  addDirs: string[]
  resumeId?: string
  permissionMode?: string
  model?: string
  agentArgs: string[]
  agentNote?: string
  agentLabel?: string
}

export function planClaudeAgent(
  agent: string | undefined,
  cwd: string,
  opencodeConfig: string | null,
): { args: string[]; permissionMode?: string; label?: string; note?: string } {
  if (!agent) return { args: [] }
  if (agent === "plan") return { args: [], permissionMode: "plan", label: "plan" }
  if (OPENCODE_BUILTIN_AGENTS.has(agent)) return { args: [] }
  if (hasClaudeAgentFile(agent, cwd)) return { args: ["--agent", agent], label: agent }
  const resolved = resolveNomadAgent(agent, cwd, opencodeConfig ? [opencodeConfig] : [])
  if (!resolved) {
    return { args: [], note: `Agent "${agent}" was not found for Claude Code; using the default agent.` }
  }
  const definition = JSON.stringify({ [agent]: { description: resolved.description, prompt: resolved.prompt } })
  return { args: ["--agents", definition, "--agent", agent], label: agent }
}

export function claudeArgs(plan: ClaudeRunPlan, resume: boolean): string[] {
  // stream-json input carries pasted images as real image blocks.
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
  // New conversations get an id we choose, so each CodeNomad session maps to its own transcript.
  if (resume && plan.resumeId) args.push("--resume", plan.resumeId)
  else args.push("--session-id", randomUUID())
  if (plan.permissionMode) args.push("--permission-mode", plan.permissionMode)
  if (plan.model) args.push("--model", plan.model)
  for (const dir of plan.addDirs) args.push("--add-dir", dir)
  args.push(...plan.agentArgs)
  return args
}

/** The single user message sent on stdin. */
export function claudeInput(plan: Pick<ClaudeRunPlan, "prompt" | "images">): string {
  const content: Array<{ type: "text"; text: string } | ImageBlock> = []
  if (plan.prompt.trim()) content.push({ type: "text", text: plan.prompt })
  content.push(...plan.images)
  if (content.length === 0) content.push({ type: "text", text: "(no text)" })
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n"
}

type ClaudeAttempt = { code: number; translator: ClaudeStreamTranslator; held: LocalEngineEvent[]; committed: boolean; stderr: string }

function runClaudeOnce(
  plan: ClaudeRunPlan,
  resume: boolean,
  write: (event: LocalEngineEvent) => void,
  register: (child: ChildProcess) => void,
): Promise<ClaudeAttempt> {
  return new Promise((resolve) => {
    const translator = new ClaudeStreamTranslator()
    const held: LocalEngineEvent[] = []
    let committed = false
    let stderr = ""
    let buffer = ""

    // Hold events until real output arrives, so a failed --resume can be
    // retried as a new conversation without the client seeing the error.
    const emit = (event: LocalEngineEvent) => {
      if (committed) return write(event)
      if (event.type === "delta" || event.type === "tool") {
        committed = true
        for (const h of held.splice(0)) write(h)
        write(event)
      } else {
        held.push(event)
      }
    }

    const child = spawn(plan.bin, claudeArgs(plan, resume), {
      cwd: plan.cwd,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })
    register(child)
    // Prompt goes on stdin: no argv length limit, not visible in `ps`.
    child.stdin?.on("error", () => {})
    child.stdin?.end(claudeInput(plan))

    child.stdout?.on("data", (buf: Buffer) => {
      buffer += buf.toString("utf8")
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""
      for (const line of lines) for (const event of translator.feed(line)) emit(event)
    })
    child.stderr?.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8")
      stderr += text
      for (const line of text.split(/\r?\n/)) if (line.trim()) emit({ type: "stderr", line })
    })

    let settled = false
    const finish = (code: number, error?: string) => {
      if (settled) return
      settled = true
      if (buffer.trim()) for (const event of translator.feed(buffer)) emit(event)
      if (error) stderr += `\n${error}`
      resolve({ code, translator, held, committed, stderr })
    }
    child.on("error", (err) => finish(127, err.message))
    child.on("close", (code, signal) => finish(code ?? (signal ? 130 : 1)))
  })
}

const MISSING_SESSION = /No conversation found|session .*not found/i

async function runClaude(
  settings: SettingsService,
  plan: ClaudeRunPlan,
  sessionKey: string | undefined,
  write: (event: LocalEngineEvent) => void,
  register: (child: ChildProcess) => void,
): Promise<{ code: number; isError: boolean }> {
  write({ type: "meta", engine: "claude-cli", agent: plan.agentLabel, note: plan.agentNote })

  let attempt = await runClaudeOnce(plan, true, write, register)
  const heldText = attempt.held.map((e) => ("text" in e ? e.text : "line" in e ? e.line : "")).join("\n")
  if (plan.resumeId && !attempt.committed && MISSING_SESSION.test(`${heldText}\n${attempt.stderr}`)) {
    // Claude no longer has that transcript: forget it and start a new conversation.
    if (sessionKey) setClaudeSession(settings, sessionKey, null)
    attempt = await runClaudeOnce(plan, false, write, register)
  }
  for (const event of attempt.held.splice(0)) write(event)

  const { translator } = attempt
  let isError = translator.isError
  if (!translator.sawResult) {
    const reason = attempt.stderr.trim().split(/\r?\n/).slice(-3).join("\n")
    isError = attempt.code !== 0
    write({
      type: "final",
      text: translator.streamedText || reason || `Claude Code exited with code ${attempt.code}`,
      sessionId: translator.sessionId,
      isError,
    })
  }
  if (sessionKey && translator.sessionId) {
    setClaudeSession(settings, sessionKey, { claudeSessionId: translator.sessionId, cwd: plan.cwd, updatedAt: Date.now() })
  }
  return { code: attempt.code, isError }
}

// ---------------------------------------------------------------- rust-playground engine

async function runRust(
  options: {
    root: string
    runner: string
    prompt: string
    cwd: string
    agent?: string
    persist: boolean
  },
  write: (event: LocalEngineEvent | Record<string, unknown>) => void,
  register: (child: ChildProcess) => void,
  opencodeConfig: string | null,
): Promise<{ code: number; isError: boolean }> {
  const prompt = rustPrompt(options.prompt, options.agent)
  const meta = { type: "meta", engine: "rust-playground", runner: options.runner, agent: options.agent ?? null }
  write(meta)
  const starworld = str(process.env.STARWORLD) ?? str(process.env.CLI_WORKSPACE_ROOT)
  const env = childEnv({
    ...(starworld ? { STARWORLD: starworld } : {}),
    CLAUDE_CODE_PLAYGROUND: options.root,
    ...(opencodeConfig ? { OPENCODE_CONFIG: opencodeConfig } : {}),
    NOMAD_AGENTS: process.env.NOMAD_AGENTS || "opencode",
  })
  const result = await runRustAgent({ runner: options.runner, prompt, cwd: options.cwd, env, onEvent: write, register })
  const final = result.stdout.join("\n").replace(/\n+$/, "")
  write({ type: "final", text: final, isError: result.code !== 0 })

  if (options.persist || process.env.PLAYGROUND_PERSIST === "1") {
    const transcript = [
      { ...meta, cwd: options.cwd, prompt },
      ...result.stderr.map((line) => ({ type: "stderr", line })),
      ...result.stdout.map((line) => ({ type: "stdout", line })),
      { type: "final", text: final },
      { type: "exit", code: result.code },
    ]
    const warning = await recordRustTranscript(options.root, transcript, env)
    if (warning) write({ type: "stderr", line: `WARN: ${warning}` })
  }
  return { code: result.code, isError: result.code !== 0 }
}

// ---------------------------------------------------------------- uploads

type SavedUploads = { images: ImageBlock[]; promptLines: string[]; attachments: HistoryAttachment[]; dirs: string[] }

function saveUploads(
  store: LocalEngineStore,
  sessionKey: string | undefined,
  uploads: Array<{ filename: string; mime?: string; data: string }>,
  engine: LocalEngineKind,
): SavedUploads {
  const result: SavedUploads = { images: [], promptLines: [], attachments: [], dirs: [] }
  for (const upload of uploads) {
    const data = Buffer.from(upload.data, "base64")
    if (data.length === 0) continue
    const mime = upload.mime?.toLowerCase()
    const file = store.saveAttachment(sessionKey ?? "_unsorted", upload.filename, data)
    result.attachments.push({ filename: upload.filename, mime, path: file })
    if (engine === "claude-cli" && mime && CLAUDE_IMAGE_TYPES.has(mime)) {
      result.images.push({ type: "image", source: { type: "base64", media_type: mime, data: upload.data } })
    } else {
      result.promptLines.push(`Attached file: ${file}`)
    }
  }
  if (result.attachments.length > 0) result.dirs.push(store.attachmentsDir(sessionKey ?? "_unsorted"))
  return result
}

// ---------------------------------------------------------------- routes

export function registerLocalEngineRoutes(app: FastifyInstance, deps: Deps) {
  const store = deps.store ?? new LocalEngineStore(deps.settings.getDataDir())
  /** Lets /abort tell a run it was stopped on purpose (for the saved "(stopped)" note). */
  const abortListeners = new Map<string, () => void>()

  const status = async () => {
    const config = readLocalEngineConfig(deps.settings)
    const bin = findClaudeBinary(config.claudeBinary)
    const version = bin ? await claudeVersion(bin) : { version: null, error: undefined }
    const playgroundRoot = resolvePlaygroundRoot(config)
    const runner = playgroundRoot ? findRustRunner(playgroundRoot) : null
    const opencodeConfig = resolveOpencodeConfigPath(config)
    return {
      ok: Boolean(bin && version.version),
      claude: {
        ok: Boolean(bin && version.version),
        binary: bin,
        configuredBinary: config.claudeBinary ?? null,
        version: version.version,
        error: bin
          ? version.error ?? null
          : "Claude Code CLI not found. Install it, or set its full path under Engine setup → Claude binary.",
        permissionMode: config.permissionMode ?? null,
      },
      rustPlayground: {
        ok: Boolean(runner),
        runner,
        playgroundRoot: playgroundRoot ?? config.playgroundRoot ?? null,
        error: runner
          ? null
          : config.playgroundRoot
            ? `playground/rust/your_program.sh not found under ${config.playgroundRoot}`
            : "Set Engine setup → Playground root to your build-your-own-claude-code checkout.",
      },
      opencodeConfig,
      workspaceRoots: allowedRoots(deps, config),
      activeRuns: activeRuns.size,
      // Legacy fields read by older UIs.
      bridge: runner,
      claudeCodePlayground: playgroundRoot,
      persist: process.env.PLAYGROUND_PERSIST === "1",
    }
  }

  const run = async (request: FastifyRequest, reply: FastifyReply, forcedEngine?: "rust-playground") => {
    const parsed = RunSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid body", details: parsed.error.flatten() }
    }
    const body = parsed.data
    const engine: LocalEngineKind = forcedEngine ?? body.engine
    const config = readLocalEngineConfig(deps.settings)

    const sessionKey = body.sessionKey && safeKey(body.sessionKey) ? body.sessionKey : undefined
    if (body.sessionKey && !sessionKey) {
      reply.code(400)
      return { error: "Invalid sessionKey" }
    }

    const roots = allowedRoots(deps, config)
    const localSession = sessionKey ? store.getSession(sessionKey) : undefined
    const requestedCwd = body.cwd ?? localSession?.folder ?? str(process.env.CLI_WORKSPACE_ROOT)
    const cwd = requestedCwd ? checkCwd(requestedCwd, roots) : null
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

    const opencodeConfig = resolveOpencodeConfigPath(config)
    let claudeBin: string | null = null
    let playgroundRoot: string | null = null
    let runner: string | null = null
    if (engine === "claude-cli") {
      claudeBin = findClaudeBinary(config.claudeBinary)
      if (!claudeBin) {
        reply.code(503)
        return { error: "Claude Code CLI not found", hint: "Install Claude Code or set Engine setup → Claude binary." }
      }
    } else {
      playgroundRoot = resolvePlaygroundRoot(config)
      runner = playgroundRoot ? findRustRunner(playgroundRoot) : null
      if (!playgroundRoot || !runner) {
        reply.code(503)
        return {
          error: "Rust playground not found",
          hint: "Set Engine setup → Playground root to your build-your-own-claude-code checkout.",
        }
      }
    }

    // Earlier turns, read before this run adds to them.
    const history = sessionKey ? store.readHistory(sessionKey) : []
    const uploads = saveUploads(store, sessionKey, body.uploads, engine)
    const prompt = [body.prompt, ...uploads.promptLines].filter((part) => part.trim()).join("\n\n")
    const agent = body.agent ?? (localSession?.agent || undefined)

    const register = (child: ChildProcess) => {
      if (sessionKey) activeRuns.set(sessionKey, child)
    }
    // A closed page (reload, sleep, network blip) does not stop the run: it
    // finishes and is saved to history. Only Stop (/abort) ends it early.
    reply.raw.on("error", () => {})
    let aborted = false
    const onAbort = () => {
      aborted = true
    }

    const jsonl = engine === "claude-cli" ? true : body.jsonl
    const send = startStream(reply, jsonl ? "application/x-ndjson; charset=utf-8" : "text/plain; charset=utf-8", {
      "X-Local-Engine": engine,
    })
    const replyText = new ReplyText()
    const write = (event: LocalEngineEvent | Record<string, unknown>) => {
      replyText.apply(event as LocalEngineEvent)
      if (jsonl) send(event)
      else if (event.type === "stdout" || event.type === "stderr") {
        if (canWrite(reply)) reply.raw.write(`${(event as { line: string }).line}\n`)
      }
    }
    if (sessionKey) abortListeners.set(sessionKey, onAbort)

    const startedAt = Date.now()
    let outcome = { code: 1, isError: true }
    try {
      if (engine === "claude-cli") {
        const permissionMode =
          config.permissionMode && PERMISSION_MODE.test(config.permissionMode) ? config.permissionMode : undefined
        const agentPlan = planClaudeAgent(agent, cwd, opencodeConfig)
        outcome = await runClaude(
          deps.settings,
          {
            bin: claudeBin!,
            cwd,
            prompt,
            images: uploads.images,
            addDirs: uploads.dirs,
            resumeId: sessionKey ? getClaudeSession(deps.settings, sessionKey, cwd) : undefined,
            permissionMode: agentPlan.permissionMode ?? permissionMode,
            model: body.model,
            agentArgs: agentPlan.args,
            agentLabel: agentPlan.label,
            agentNote: agentPlan.note,
          },
          sessionKey,
          write,
          register,
        )
      } else {
        outcome = await runRust(
          {
            root: playgroundRoot!,
            runner: runner!,
            prompt: withConversationContext(prompt, history),
            cwd,
            agent,
            persist: body.persist,
          },
          write,
          register,
          opencodeConfig,
        )
      }
      if (jsonl) send({ type: "exit", code: outcome.code })
    } catch (error) {
      if (jsonl) send({ type: "exit", code: 1, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (sessionKey) {
        activeRuns.delete(sessionKey)
        abortListeners.delete(sessionKey)
        const stopped = aborted
        const userText = body.displayText ?? body.prompt
        const names = body.attachmentNames ?? []
        const attachments: HistoryAttachment[] = [
          ...names.filter((name) => !uploads.attachments.some((a) => a.filename === name)).map((filename) => ({ filename })),
          ...uploads.attachments,
        ]
        const messages: HistoryMessage[] = [
          {
            id: body.messageIds?.user ?? `msg_lu_${startedAt.toString(36)}`,
            role: "user",
            text: userText,
            createdAt: startedAt,
            ...(attachments.length ? { attachments } : {}),
          },
          {
            id: body.messageIds?.assistant ?? `msg_la_${startedAt.toString(36)}`,
            role: "assistant",
            text: replyText.finish({ stopped, isError: outcome.isError }),
            createdAt: Date.now(),
            engine,
            ...(agent ? { agent } : {}),
            ...(outcome.isError && !stopped ? { isError: true } : {}),
          },
        ]
        try {
          store.appendHistory(sessionKey, messages)
        } catch (error) {
          request.log?.warn?.({ error }, "local engine: could not save history")
        }
      }
      if (canWrite(reply)) reply.raw.end()
    }
  }

  app.get("/api/local-engine/status", status)
  app.post("/api/local-engine/run", { bodyLimit: RUN_BODY_LIMIT }, (request, reply) => run(request, reply))

  app.post("/api/local-engine/abort", async (request, reply) => {
    const parsed = SessionKeySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: "sessionKey is required" }
    }
    const child = activeRuns.get(parsed.data.sessionKey)
    if (!child) return { aborted: false }
    abortListeners.get(parsed.data.sessionKey)?.()
    stopChild(child)
    return { aborted: true }
  })

  app.post("/api/local-engine/reset", async (request, reply) => {
    const parsed = SessionKeySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: "sessionKey is required" }
    }
    setClaudeSession(deps.settings, parsed.data.sessionKey, null)
    return { reset: true }
  })

  app.get("/api/local-engine/history", async (request, reply) => {
    const parsed = SessionKeySchema.safeParse(request.query ?? {})
    if (!parsed.success || !safeKey(parsed.data.sessionKey)) {
      reply.code(400)
      return { error: "sessionKey is required" }
    }
    // running: a run for this session is still going (e.g. the page was reloaded mid-run).
    return { messages: store.readHistory(parsed.data.sessionKey), running: activeRuns.has(parsed.data.sessionKey) }
  })

  app.get("/api/local-engine/sessions", async (request) => {
    const folder = str((request.query as Record<string, unknown> | undefined)?.folder)
    const real = folder ? realpath(folder) ?? folder : undefined
    // Match on both the given and the real path (symlinked workspace folders).
    const sessions = folder
      ? [...new Map([...store.listSessions(folder), ...(real ? store.listSessions(real) : [])].map((s) => [s.id, s])).values()]
      : store.listSessions()
    return { sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt) }
  })

  app.post("/api/local-engine/sessions", async (request, reply) => {
    const parsed = CreateSessionSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid body", details: parsed.error.flatten() }
    }
    const config = readLocalEngineConfig(deps.settings)
    const folder = checkCwd(parsed.data.folder, allowedRoots(deps, config))
    if (!folder) {
      reply.code(403)
      return { error: `Folder is not an open CodeNomad workspace: ${parsed.data.folder}` }
    }
    // Keep the folder as the UI knows it, so listing by workspace path matches.
    return store.createSession({ ...parsed.data, folder: path.resolve(parsed.data.folder) })
  })

  app.patch("/api/local-engine/sessions/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id
    const parsed = PatchSessionSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid body", details: parsed.error.flatten() }
    }
    const updated = store.updateSession(id, parsed.data)
    if (!updated) {
      reply.code(404)
      return { error: "Session not found" }
    }
    return updated
  })

  app.delete("/api/local-engine/sessions/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id
    if (!safeKey(id)) {
      reply.code(400)
      return { error: "Invalid id" }
    }
    const child = activeRuns.get(id)
    if (child) stopChild(child)
    const existed = store.deleteSession(id)
    setClaudeSession(deps.settings, id, null)
    return { deleted: existed }
  })

  // Legacy paths (P4 bridge).
  app.get("/api/playground/rust/status", status)
  app.post("/api/playground/rust/run", { bodyLimit: RUN_BODY_LIMIT }, (request, reply) => run(request, reply, "rust-playground"))
}
