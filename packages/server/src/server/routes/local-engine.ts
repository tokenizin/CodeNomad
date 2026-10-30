/**
 * Claude Code (Rust): CodeNomad's local chat engine, the Rust re-implementation
 * of Claude Code from build-your-own-claude-code (playground/rust). It runs on
 * this machine against the configured OpenAI-compatible endpoint (Ollama by
 * default) — not the official Claude Code app or CLI.
 *
 *   GET    /api/local-engine/status
 *   GET    /api/local-engine/catalog?folder=&fresh=1   agents, slash commands, models (from the agent)
 *   POST   /api/local-engine/run       { prompt, cwd, sessionKey, agent?, model?, uploads?, messageIds? }
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
import type { WorkspaceManager } from "../../workspaces/manager.js"
import { ReplyParts } from "../../local-engine/reply-parts.js"
import {
  failureText,
  fetchRustCatalog,
  findRustRunner,
  recordRustTranscript,
  runRustAgent,
  type EngineEvent,
} from "../../local-engine/rust-runner.js"
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
const ForkSchema = z.object({ messageId: z.string().max(200).optional(), folder: z.string().trim().min(1).optional() })
const MessageIdSchema = z.object({ messageId: z.string().min(1).max(200) })
const CopySchema = z.object({ to: z.string().min(1).max(200), beforeMessageId: z.string().max(200).optional() })

const KILL_GRACE_MS = 5000
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
    opencodeConfig: str(raw.opencodeConfig) ?? str(process.env.OPENCODE_CONFIG),
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

function agentEnv(root: string, opencodeConfig: string | null): NodeJS.ProcessEnv {
  const starworld = str(process.env.STARWORLD) ?? str(process.env.CLI_WORKSPACE_ROOT)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
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
  /** Lets /abort tell a run it was stopped on purpose (for the saved "(stopped)" note). */
  const abortListeners = new Map<string, () => void>()

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
    }
  }

  const resolveFolder = (folder: string | undefined): string | null => {
    const { config } = engineSetup()
    const target = folder ?? str(process.env.CLI_WORKSPACE_ROOT)
    return target ? checkCwd(target, allowedRoots(deps, config)) : null
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
      reply.code(503)
      return {
        error: "Claude Code (Rust) not found",
        hint: "Set Engine setup → Playground root to your build-your-own-claude-code checkout.",
      }
    }

    // Earlier turns, read before this run adds to them.
    const history = sessionKey ? historyForAgent(store.readHistory(sessionKey)) : []
    const uploads = saveUploads(store, sessionKey, body.uploads)
    const prompt = [body.prompt, ...uploads.promptLines].filter((part) => part.trim()).join("\n\n") || "(see attached image)"
    const agent = body.agent ?? (localSession?.agent || undefined)
    const model = body.model ?? (localSession?.model?.modelId || undefined)
    let historyFile: string | undefined
    if (history.length) {
      historyFile = path.join(os.tmpdir(), `codenomad-history-${randomUUID()}.json`)
      fs.writeFileSync(historyFile, JSON.stringify(history))
    }

    const register = (child: ChildProcess) => {
      if (sessionKey) activeRuns.set(sessionKey, child)
    }
    // A closed page (reload, sleep, network blip) does not stop the run: it
    // finishes and is saved to history. Only Stop (/abort) ends it early.
    reply.raw.on("error", () => {})
    let aborted = false
    if (sessionKey) abortListeners.set(sessionKey, () => (aborted = true))

    const send = startStream(reply)
    const replyParts = new ReplyParts()
    const transcript: object[] = []
    const write = (event: EngineEvent) => {
      replyParts.apply(event)
      transcript.push(event)
      send(event)
    }

    const env = agentEnv(playgroundRoot, opencodeConfig)
    const startedAt = Date.now()
    let code = 1
    let isError = true
    let usedModel = model
    let fallbackError: string | undefined
    try {
      const result = await runRustAgent(
        { runner, cwd, env, prompt, agent, model, images: uploads.images, historyFile },
        write,
        register,
      )
      code = result.code
      usedModel = result.translator.model ?? model
      isError = result.translator.isError || code !== 0
      if (!result.translator.sawFinal) {
        fallbackError = failureText(code, result.stderr)
        write({ type: "final", text: isError ? fallbackError : replyParts.text(), isError })
      }
      if (body.persist || process.env.PLAYGROUND_PERSIST === "1") {
        const warning = await recordRustTranscript(
          playgroundRoot,
          [{ type: "meta", cwd, prompt, agent: agent ?? null }, ...transcript, { type: "exit", code }],
          env,
        )
        if (warning) send({ type: "stderr", line: `WARN: ${warning}` })
      }
      send({ type: "exit", code })
    } catch (error) {
      send({ type: "exit", code: 1, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (historyFile) fs.rmSync(historyFile, { force: true })
      if (sessionKey) {
        activeRuns.delete(sessionKey)
        abortListeners.delete(sessionKey)
        const stopped = aborted
        const names = body.attachmentNames ?? []
        const attachments: HistoryAttachment[] = [
          ...names.filter((name) => !uploads.attachments.some((a) => a.filename === name)).map((filename) => ({ filename })),
          ...uploads.attachments,
        ]
        const saved = replyParts.finish({ stopped, isError, fallbackError })
        const messages: HistoryMessage[] = [
          {
            id: body.messageIds?.user ?? `msg_lu_${startedAt.toString(36)}`,
            role: "user",
            text: body.displayText ?? body.prompt,
            createdAt: startedAt,
            ...(attachments.length ? { attachments } : {}),
          },
          {
            id: body.messageIds?.assistant ?? `msg_la_${startedAt.toString(36)}`,
            role: "assistant",
            text: saved.text,
            parts: saved.parts,
            createdAt: Date.now(),
            engine: "claude-code-rust",
            ...(agent ? { agent } : {}),
            ...(usedModel ? { model: usedModel } : {}),
            ...(isError && !stopped ? { isError: true } : {}),
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
    if (!playgroundRoot || !runner) return bad(reply, "Claude Code (Rust) not found. Set Engine setup → Playground root.", 503)
    try {
      return await fetchRustCatalog(runner, cwd, agentEnv(playgroundRoot, opencodeConfig), { fresh: query.fresh === "1" })
    } catch (error) {
      return bad(reply, error instanceof Error ? error.message : String(error), 502)
    }
  })

  app.post("/api/local-engine/run", { bodyLimit: RUN_BODY_LIMIT }, (request, reply) => run(request, reply))

  app.post("/api/local-engine/abort", async (request, reply) => {
    const parsed = SessionKeySchema.safeParse(request.body ?? {})
    if (!parsed.success) return bad(reply, "sessionKey is required")
    const child = activeRuns.get(parsed.data.sessionKey)
    if (!child) return { aborted: false }
    abortListeners.get(parsed.data.sessionKey)?.()
    stopChild(child)
    return { aborted: true }
  })

  app.get("/api/local-engine/history", async (request, reply) => {
    const parsed = SessionKeySchema.safeParse(request.query ?? {})
    if (!parsed.success || !safeKey(parsed.data.sessionKey)) return bad(reply, "sessionKey is required")
    // running: a run for this session is still going (e.g. the page was reloaded mid-run).
    return { messages: store.readHistory(parsed.data.sessionKey), running: activeRuns.has(parsed.data.sessionKey) }
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
    const sessions = folder
      ? [...new Map([...store.listSessions(folder), ...(real ? store.listSessions(real) : [])].map((s) => [s.id, s])).values()]
      : store.listSessions()
    return { sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt) }
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
    return { deleted: store.deleteSession(id) }
  })

  // Legacy paths (P4 bridge).
  app.get("/api/playground/rust/status", status)
  app.post("/api/playground/rust/run", { bodyLimit: RUN_BODY_LIMIT }, (request, reply) => run(request, reply))
}
