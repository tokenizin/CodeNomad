/**
 * Local chat engines: run a prompt through the local Claude Code CLI (default)
 * or the build-your-own-claude-code Rust playground bridge instead of OpenCode.
 *
 *   GET  /api/local-engine/status
 *   POST /api/local-engine/run    { engine, prompt, cwd, sessionKey, agent?, model?, persist? }
 *   POST /api/local-engine/abort  { sessionKey }
 *   POST /api/local-engine/reset  { sessionKey }   forget the Claude conversation
 *
 * /run streams NDJSON events (see local-engine/claude-stream.ts). Runs are
 * limited to folders CodeNomad has open as workspaces, one run per session.
 *
 * Settings live in the server config under `localEngine`, with env fallbacks:
 *   claudeBinary     CLAUDE_CODE_BIN           path or name of the claude CLI
 *   permissionMode   CLAUDE_CODE_PERMISSION_MODE  e.g. acceptEdits, plan
 *   playgroundRoot   CLAUDE_CODE_PLAYGROUND    build-your-own-claude-code checkout
 *   opencodeConfig   OPENCODE_CONFIG           opencode.jsonc with NomadWorks agents
 *   extraRoots       (none)                    more folders runs may use
 *
 * The old /api/playground/rust/{run,status} paths still work.
 */

import { execFile, spawn, type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import type { SettingsService } from "../../settings/service.js"
import type { WorkspaceManager } from "../../workspaces/manager.js"
import { ClaudeStreamTranslator, type LocalEngineEvent } from "../../local-engine/claude-stream.js"
import { hasClaudeAgentFile, OPENCODE_BUILTIN_AGENTS, resolveNomadAgent } from "../../local-engine/agents.js"

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
}

const RunSchema = z.object({
  engine: z.enum(["claude-cli", "rust-playground"]).optional().default("claude-cli"),
  prompt: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
  /** CodeNomad session id; used to continue the same Claude conversation. */
  sessionKey: z.string().trim().min(1).max(200).optional(),
  agent: z.string().trim().min(1).max(64).optional(),
  /** Claude model id (only used by the claude-cli engine). */
  model: z.string().trim().min(1).max(200).optional(),
  jsonl: z.boolean().optional().default(true),
  persist: z.boolean().optional().default(false),
})

const SessionKeySchema = z.object({ sessionKey: z.string().trim().min(1).max(200) })

const PERMISSION_MODE = /^[A-Za-z]{2,32}$/
const STATE_OWNER = "localEngine"
const KILL_GRACE_MS = 5000

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

export function resolveBridgeScript(config: LocalEngineConfig): string | null {
  const candidates: string[] = []
  if (config.playgroundRoot) {
    const root = expandHome(config.playgroundRoot)
    candidates.push(path.join(root, "scripts", "codenomad-rust-bridge.py"))
  }
  // Course repo checked out next to the starworld repo.
  const relative = path.join("0-claudecode", "build-your-own-claude-code", "scripts", "codenomad-rust-bridge.py")
  let dir = process.cwd()
  for (let i = 0; i < 5; i += 1) {
    dir = path.dirname(dir)
    candidates.push(path.join(dir, relative))
  }
  candidates.push(path.join(os.homedir(), relative))
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
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

export function allowedRoots(deps: Deps, config: LocalEngineConfig): string[] {
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
      const result = error
        ? { version: null, error: error.message }
        : { version: stdout.toString().trim() || null }
      versionCache = { bin, at: Date.now(), ...result }
      resolve(result)
    })
  })
}

function startStream(reply: FastifyReply, contentType: string, extraHeaders: Record<string, string> = {}) {
  reply.raw.setHeader("Content-Type", contentType)
  reply.raw.setHeader("Cache-Control", "no-cache")
  reply.raw.setHeader("X-Accel-Buffering", "no")
  for (const [key, value] of Object.entries(extraHeaders)) reply.raw.setHeader(key, value)
  reply.raw.flushHeaders?.()
  reply.hijack()
  return (event: LocalEngineEvent | Record<string, unknown>) => {
    if (!reply.raw.writableEnded) reply.raw.write(JSON.stringify(event) + "\n")
  }
}

// ---------------------------------------------------------------- claude-cli engine

type ClaudeRunPlan = {
  bin: string
  cwd: string
  prompt: string
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

function claudeArgs(plan: ClaudeRunPlan, resume: boolean): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
  // New conversations get an id we choose, so each CodeNomad session maps to its own transcript.
  if (resume && plan.resumeId) args.push("--resume", plan.resumeId)
  else args.push("--session-id", randomUUID())
  if (plan.permissionMode) args.push("--permission-mode", plan.permissionMode)
  if (plan.model) args.push("--model", plan.model)
  args.push(...plan.agentArgs)
  return args
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
    child.stdin?.end(plan.prompt)

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
  deps: Deps,
  plan: ClaudeRunPlan,
  sessionKey: string | undefined,
  write: (event: LocalEngineEvent) => void,
  register: (child: ChildProcess) => void,
): Promise<number> {
  write({ type: "meta", engine: "claude-cli", agent: plan.agentLabel, note: plan.agentNote })

  let attempt = await runClaudeOnce(plan, true, write, register)
  const heldText = attempt.held.map((e) => ("text" in e ? e.text : "line" in e ? e.line : "")).join("\n")
  if (plan.resumeId && !attempt.committed && MISSING_SESSION.test(`${heldText}\n${attempt.stderr}`)) {
    // Claude no longer has that transcript: forget it and start a new conversation.
    if (sessionKey) setClaudeSession(deps.settings, sessionKey, null)
    attempt = await runClaudeOnce(plan, false, write, register)
  }
  for (const event of attempt.held.splice(0)) write(event)

  const { translator } = attempt
  if (!translator.sawResult) {
    const reason = attempt.stderr.trim().split(/\r?\n/).slice(-3).join("\n")
    write({
      type: "final",
      text: translator.streamedText || reason || `Claude Code exited with code ${attempt.code}`,
      sessionId: translator.sessionId,
      isError: attempt.code !== 0,
    })
  }
  if (sessionKey && translator.sessionId) {
    setClaudeSession(deps.settings, sessionKey, { claudeSessionId: translator.sessionId, cwd: plan.cwd, updatedAt: Date.now() })
  }
  return attempt.code
}

// ---------------------------------------------------------------- rust-playground engine

function runRustBridge(
  bridge: string,
  config: LocalEngineConfig,
  body: { prompt: string; cwd: string; agent?: string; jsonl: boolean; persist: boolean },
  writeRaw: (chunk: Buffer | string) => void,
  register: (child: ChildProcess) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const args = [bridge, "--prompt", body.prompt, "--cwd", body.cwd]
    if (body.agent) args.push("--agent", body.agent)
    if (body.jsonl) args.push("--jsonl")
    if (body.persist || process.env.PLAYGROUND_PERSIST === "1") args.push("--persist")

    const opencodeConfig = resolveOpencodeConfigPath(config)
    const starworld = str(process.env.STARWORLD) ?? str(process.env.CLI_WORKSPACE_ROOT)
    const child = spawn("python3", args, {
      cwd: body.cwd,
      env: childEnv({
        ...(starworld ? { STARWORLD: starworld } : {}),
        CLAUDE_CODE_PLAYGROUND: path.dirname(path.dirname(bridge)),
        ...(opencodeConfig ? { OPENCODE_CONFIG: opencodeConfig } : {}),
        NOMAD_AGENTS: process.env.NOMAD_AGENTS || "opencode",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    })
    register(child)

    child.stdout?.on("data", (buf: Buffer) => writeRaw(buf))
    child.stderr?.on("data", (buf: Buffer) => {
      if (!body.jsonl) return writeRaw(buf)
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) writeRaw(JSON.stringify({ type: "bridge_stderr", line }) + "\n")
      }
    })
    let settled = false
    const finish = (code: number, error?: string) => {
      if (settled) return
      settled = true
      if (error && body.jsonl) writeRaw(JSON.stringify({ type: "exit", code, error }) + "\n")
      resolve(code)
    }
    child.on("error", (err) => finish(127, err.message))
    child.on("close", (code, signal) => finish(code ?? (signal ? 130 : 1)))
  })
}

// ---------------------------------------------------------------- routes

export function registerLocalEngineRoutes(app: FastifyInstance, deps: Deps) {
  const status = async () => {
    const config = readLocalEngineConfig(deps.settings)
    const bin = findClaudeBinary(config.claudeBinary)
    const version = bin ? await claudeVersion(bin) : { version: null, error: undefined }
    const bridge = resolveBridgeScript(config)
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
          : "Claude Code CLI not found. Install it, or set its full path under Local engine → Claude binary.",
        permissionMode: config.permissionMode ?? null,
      },
      rustPlayground: {
        ok: Boolean(bridge),
        bridge,
        playgroundRoot: config.playgroundRoot ?? null,
        error: bridge ? null : "Bridge script not found. Set the build-your-own-claude-code folder under Playground root.",
      },
      opencodeConfig,
      workspaceRoots: allowedRoots(deps, config),
      activeRuns: activeRuns.size,
      // Legacy fields read by older UIs.
      bridge,
      claudeCodePlayground: config.playgroundRoot ?? null,
      persist: process.env.PLAYGROUND_PERSIST === "1",
    }
  }

  const run = async (request: any, reply: FastifyReply, forcedEngine?: "rust-playground") => {
    const parsed = RunSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: "Invalid body", details: parsed.error.flatten() }
    }
    const body = parsed.data
    const engine = forcedEngine ?? body.engine
    const config = readLocalEngineConfig(deps.settings)

    const roots = allowedRoots(deps, config)
    const requestedCwd = body.cwd ?? str(process.env.CLI_WORKSPACE_ROOT)
    const cwd = requestedCwd ? checkCwd(requestedCwd, roots) : null
    if (!cwd) {
      reply.code(403)
      return {
        error: requestedCwd
          ? `Folder is not an open CodeNomad workspace: ${requestedCwd}`
          : "No folder given for the run",
        hint: "Open the folder as a workspace in CodeNomad, or add it under Local engine → Extra folders.",
      }
    }

    const sessionKey = body.sessionKey
    if (sessionKey && activeRuns.has(sessionKey)) {
      reply.code(409)
      return { error: "This session already has a run in progress. Stop it first." }
    }

    let plan: ClaudeRunPlan | null = null
    let bridge: string | null = null
    if (engine === "claude-cli") {
      const bin = findClaudeBinary(config.claudeBinary)
      if (!bin) {
        reply.code(503)
        return { error: "Claude Code CLI not found", hint: "Install Claude Code or set Local engine → Claude binary." }
      }
      const permissionMode = config.permissionMode && PERMISSION_MODE.test(config.permissionMode) ? config.permissionMode : undefined
      const agentPlan = planClaudeAgent(body.agent, cwd, resolveOpencodeConfigPath(config))
      plan = {
        bin,
        cwd,
        prompt: body.prompt,
        resumeId: sessionKey ? getClaudeSession(deps.settings, sessionKey, cwd) : undefined,
        permissionMode: agentPlan.permissionMode ?? permissionMode,
        model: body.model,
        agentArgs: agentPlan.args,
        agentLabel: agentPlan.label,
        agentNote: agentPlan.note,
      }
    } else {
      bridge = resolveBridgeScript(config)
      if (!bridge) {
        reply.code(503)
        return {
          error: "Rust playground bridge not found",
          hint: "Set Local engine → Playground root to your build-your-own-claude-code folder.",
        }
      }
    }

    const children = new Set<ChildProcess>()
    const register = (child: ChildProcess) => {
      children.add(child)
      if (sessionKey) activeRuns.set(sessionKey, child)
    }
    // reply.raw (not request.raw) closes when the client goes away: request.raw
    // has already finished once Fastify read the POST body.
    reply.raw.on("close", () => {
      for (const child of children) stopChild(child)
    })

    const jsonl = engine === "claude-cli" ? true : body.jsonl
    const write = startStream(reply, jsonl ? "application/x-ndjson; charset=utf-8" : "text/plain; charset=utf-8", {
      "X-Local-Engine": engine,
    })

    let code = 1
    try {
      if (plan) {
        code = await runClaude(deps, plan, sessionKey, write, register)
      } else {
        code = await runRustBridge(
          bridge!,
          config,
          { prompt: body.prompt, cwd, agent: body.agent, jsonl, persist: body.persist },
          (chunk) => {
            if (!reply.raw.writableEnded) reply.raw.write(chunk)
          },
          register,
        )
      }
      if (jsonl) write({ type: "exit", code })
    } catch (error) {
      if (jsonl) write({ type: "exit", code: 1, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (sessionKey) activeRuns.delete(sessionKey)
      if (!reply.raw.writableEnded) reply.raw.end()
    }
  }

  app.get("/api/local-engine/status", status)
  app.post("/api/local-engine/run", (request, reply) => run(request, reply))

  app.post("/api/local-engine/abort", async (request, reply) => {
    const parsed = SessionKeySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400)
      return { error: "sessionKey is required" }
    }
    const child = activeRuns.get(parsed.data.sessionKey)
    if (!child) return { aborted: false }
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

  // Legacy paths (P4 bridge).
  app.get("/api/playground/rust/status", status)
  app.post("/api/playground/rust/run", (request, reply) => run(request, reply, "rust-playground"))
}
