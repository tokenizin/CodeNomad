import { randomUUID } from "node:crypto"
import type { Logger } from "../logger.js"
import type { WorkspaceManager } from "../workspaces/manager.js"

export type AgentSessionStatus = "queued" | "running" | "waiting_for_approval" | "done" | "error"
export interface AgentSessionMetadata { source?: string; threadId?: string; requestedBy?: string }
export interface AgentSessionRecord {
  sessionId: string
  status: AgentSessionStatus
  summary: string | null
  updatedAt: string
  metadata: AgentSessionMetadata
  /** Internal OpenCode session id; never exposed to the machine API. */
  upstreamSessionId?: string
}

export interface OpenCodeAdapter {
  start(agent: string, prompt: string): Promise<{ sessionId: string; status?: AgentSessionStatus; summary?: string | null }>
}

export interface OpenCodeAgentAdapterOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  pollIntervalMs?: number
  timeoutMs?: number
}

const MAX_RECORDS = 100
const TERMINAL_TTL_MS = 60 * 60 * 1000
const MAX_PROMPT_LENGTH = 20_000
const MAX_METADATA_LENGTH = 2_000

function boundedMetadata(metadata: unknown): AgentSessionMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {}
  const value = metadata as Record<string, unknown>
  const result: AgentSessionMetadata = {}
  for (const key of ["source", "threadId", "requestedBy"] as const) {
    if (typeof value[key] === "string") result[key] = value[key].slice(0, 500)
  }
  return JSON.stringify(result).length <= MAX_METADATA_LENGTH ? result : {}
}

export class AgentSessionRegistry {
  private readonly records = new Map<string, AgentSessionRecord>()

  constructor(private readonly now: () => number = Date.now) {}

  create(metadata: unknown): AgentSessionRecord {
    this.evict()
    while (this.records.size >= MAX_RECORDS) this.records.delete(this.records.keys().next().value!)
    const record: AgentSessionRecord = {
      sessionId: `agent_${randomUUID()}`,
      status: "queued",
      summary: null,
      updatedAt: new Date(this.now()).toISOString(),
      metadata: boundedMetadata(metadata),
    }
    this.records.set(record.sessionId, record)
    return record
  }

  get(sessionId: string): AgentSessionRecord | null {
    this.evict()
    return this.records.get(sessionId) ?? null
  }

  update(sessionId: string, status: AgentSessionStatus, summary?: string | null, upstreamSessionId?: string): AgentSessionRecord | null {
    const record = this.records.get(sessionId)
    if (!record) return null
    record.status = status
    record.summary = summary === undefined ? record.summary : summary?.slice(0, 2_000) ?? null
    record.updatedAt = new Date(this.now()).toISOString()
    if (upstreamSessionId) record.upstreamSessionId = upstreamSessionId
    return record
  }

  size(): number { return this.records.size }

  private evict() {
    const cutoff = this.now() - TERMINAL_TTL_MS
    for (const [id, record] of this.records) {
      if ((record.status === "done" || record.status === "error") && Date.parse(record.updatedAt) < cutoff) this.records.delete(id)
    }
  }
}

export class OpenCodeAgentAdapter implements OpenCodeAdapter {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number

  constructor(private readonly workspaceManager: WorkspaceManager, options: OpenCodeAgentAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.pollIntervalMs = options.pollIntervalMs ?? 500
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  }

  async start(agent: string, prompt: string): Promise<{ sessionId: string; status?: AgentSessionStatus; summary?: string | null }> {
    const workspace = this.workspaceManager.list().find((item) => item.status === "ready")
    if (!workspace?.port) throw new Error("No ready OpenCode workspace")
    const base = `http://127.0.0.1:${workspace.port}`
    const headers: Record<string, string> = { "content-type": "application/json" }
    const authorization = this.workspaceManager.getInstanceAuthorizationHeader(workspace.id)
    if (authorization) headers.authorization = authorization
    const created = await this.fetchImpl(`${base}/session`, {
      method: "POST", headers, body: JSON.stringify({ title: `Hyperagent ${agent}`, agent }),
    })
    if (!created.ok) throw new Error(`OpenCode session creation failed (${created.status})`)
    const session = await created.json() as { id?: string }
    if (!session.id) throw new Error("OpenCode returned no session id")
    const prompted = await this.fetchImpl(`${base}/session/${encodeURIComponent(session.id)}/prompt_async`, {
      method: "POST", headers,
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }], agent }),
    })
    if (!prompted.ok) throw new Error(`OpenCode prompt failed (${prompted.status})`)

    // prompt_async acknowledges enqueueing, not completion. Require an
    // observed busy/retry state before treating a later idle state as done so
    // an initial idle response cannot produce a false terminal result.
    let observedBusy = false
    const deadline = this.now() + this.timeoutMs
    while (this.now() < deadline) {
      await this.sleep(this.pollIntervalMs)
      const statusResponse = await this.fetchImpl(`${base}/session/status`, { headers })
      if (!statusResponse.ok) throw new Error(`OpenCode status failed (${statusResponse.status})`)
      const statuses = await statusResponse.json() as Record<string, unknown>
      const raw = statuses[session.id] as Record<string, unknown> | undefined
      const type = typeof raw?.type === "string" ? raw.type : ""
      if (["permission", "question", "waiting_for_approval", "approval"].includes(type) || raw?.waitingForApproval === true) {
        return { sessionId: session.id, status: "waiting_for_approval", summary: "OpenCode is waiting for approval" }
      }
      if (["busy", "working", "retry", "compacting"].includes(type)) {
        observedBusy = true
        continue
      }
      if (type === "error" || raw?.error === true) {
        throw new Error("OpenCode reported a session error")
      }
      if (type === "idle" && observedBusy) {
        return { sessionId: session.id, status: "done", summary: "OpenCode run completed" }
      }
    }

    // The installed API exposes status polling but no durable completion
    // event tied to this external dispatch. Preserve truth: callers see the
    // run as running and can retry reconciliation with a later poll.
    return { sessionId: session.id, status: "running", summary: "OpenCode run remains active; status reconciliation timed out" }
  }
}

export class AgentSessionDispatcher {
  constructor(
    private readonly adapter: OpenCodeAdapter,
    private readonly registry = new AgentSessionRegistry(),
    private readonly logger?: Logger,
  ) {}

  create(agent: string, prompt: string, metadata: unknown): AgentSessionRecord {
    if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`prompt must be at most ${MAX_PROMPT_LENGTH} characters`)
    return this.registry.create(metadata)
  }

  /** Start work on the next event turn, leaving the queued state observable. */
  enqueue(record: AgentSessionRecord, agent: string, prompt: string): void {
    setImmediate(() => { void this.run(record.sessionId, agent, prompt) })
  }

  get(sessionId: string): AgentSessionRecord | null { return this.registry.get(sessionId) }
  get size(): number { return this.registry.size() }

  private async run(sessionId: string, agent: string, prompt: string) {
    this.registry.update(sessionId, "running")
    try {
      const result = await this.adapter.start(agent, prompt)
      this.registry.update(sessionId, result.status ?? "done", result.summary, result.sessionId)
    } catch (error) {
      this.registry.update(sessionId, "error", "Agent session failed")
      this.logger?.warn({ action: "run", sessionId, agent, status: "error", outcome: "error" }, "agent session failed")
    }
  }
}

export const agentSessionLimits = { MAX_RECORDS, TERMINAL_TTL_MS, MAX_PROMPT_LENGTH, MAX_METADATA_LENGTH }
