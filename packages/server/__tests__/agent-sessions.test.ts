import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { randomBytes, scryptSync } from "node:crypto"
import Fastify from "fastify"
import { AgentSessionDispatcher, AgentSessionRegistry, OpenCodeAgentAdapter, type OpenCodeAdapter } from "../src/lib/agent-session-dispatch.js"
import { registerAgentSessionRoutes } from "../src/server/routes/agent-sessions.js"

const salt = randomBytes(16)
const key = { id: "k1", label: "test", hashedKey: `scrypt$${salt.toString("base64url")}$${scryptSync("sk_agent_test", salt, 64).toString("base64url")}`, scopes: ["session:create", "session:read"], allowedAgents: ["product_manager"], revokedAt: null as Date | null }
const apps: ReturnType<typeof Fastify>[] = []

function build(adapter: OpenCodeAdapter = { async start() { return { sessionId: "oc-1", status: "done" as const, summary: "ok" } } }) {
  const app = Fastify()
  const events: unknown[] = []
  const lookup = async () => key.revokedAt ? [] : [key]
  const logger = { info(event: unknown) { events.push(event) }, warn(event: unknown) { events.push(event) } } as any
  const dispatcher = new AgentSessionDispatcher(adapter, undefined, logger)
  registerAgentSessionRoutes(app, { dispatcher, logger, lookup })
  apps.push(app)
  return { app, dispatcher, events }
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })
beforeEach(() => {
  key.scopes = ["session:create", "session:read"]
  key.revokedAt = null
})

describe("agent session routes", () => {
  it("rejects missing and malformed credentials", async () => {
    const { app } = build()
    expect((await app.inject({ method: "POST", url: "/api/agent-sessions", payload: {} })).statusCode).toBe(401)
    expect((await app.inject({ method: "POST", url: "/api/agent-sessions", headers: { authorization: "Basic nope" }, payload: {} })).statusCode).toBe(401)
  })
  it("creates allowed sessions and rejects disallowed agents", async () => {
    const { app, events } = build()
    const allowed = await app.inject({ method: "POST", url: "/api/agent-sessions", headers: { authorization: "Bearer sk_agent_test" }, payload: { agent: "product_manager", prompt: "brief", metadata: { threadId: "t1" } } })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().status).toBe("queued")
    expect(events.at(-1)).toMatchObject({ outcome: "accepted", threadId: "t1" })
    const denied = await app.inject({ method: "POST", url: "/api/agent-sessions", headers: { authorization: "Bearer sk_agent_test" }, payload: { agent: "developer", prompt: "brief" } })
    expect(denied.statusCode).toBe(403)
  })
  it("enforces scopes and revocation", async () => {
    const { app, events } = build()
    key.scopes = ["session:read"]
    expect((await app.inject({ method: "POST", url: "/api/agent-sessions", headers: { authorization: "Bearer sk_agent_test" }, payload: { agent: "product_manager", prompt: "brief", metadata: { threadId: "scope-thread", requestedBy: "scope-requester" } } })).statusCode).toBe(403)
    expect(events.at(-1)).toMatchObject({ outcome: "insufficient_scope", threadId: "scope-thread", requestedBy: "scope-requester" })
    key.scopes = ["session:create", "session:read"]
    key.revokedAt = new Date()
    expect((await app.inject({ method: "GET", url: "/api/agent-sessions/nope", headers: { authorization: "Bearer sk_agent_test" } })).statusCode).toBe(401)
    key.revokedAt = null
  })
  it("polls queued, running, and done in order without waiting for adapter", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const { app, dispatcher } = build({ async start() { await pending; return { sessionId: "oc-1", status: "done" as const, summary: "finished" } } })
    const record = dispatcher.create("product_manager", "brief", {})
    expect(dispatcher.get(record.sessionId)?.status).toBe("queued")
    dispatcher.enqueue(record, "product_manager", "brief")
    await new Promise((resolve) => setImmediate(resolve))
    expect(dispatcher.get(record.sessionId)?.status).toBe("running")
    release()
    for (let i = 0; i < 20; i++) {
      if (dispatcher.get(record.sessionId)?.status === "done") return
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw new Error("session did not reach done")
  })

  it("returns queued promptly while the adapter remains blocked", async () => {
    const pending = new Promise<never>(() => {})
    const { app } = build({ async start() { return pending } })
    const started = performance.now()
    const response = await app.inject({ method: "POST", url: "/api/agent-sessions", headers: { authorization: "Bearer sk_agent_test" }, payload: { agent: "product_manager", prompt: "brief" } })
    expect(performance.now() - started).toBeLessThan(100)
    expect(response.json().status).toBe("queued")
  })
  it("returns 404 for unknown sessions", async () => {
    const { app } = build()
    expect((await app.inject({ method: "GET", url: "/api/agent-sessions/unknown", headers: { authorization: "Bearer sk_agent_test" } })).statusCode).toBe(404)
  })
  it("exposes adapter errors without leaking prompt material", async () => {
    const failing = build({ async start() { throw new Error("provider unavailable") } })
    const created = await failing.app.inject({ method: "POST", url: "/api/agent-sessions", headers: { authorization: "Bearer sk_agent_test" }, payload: { agent: "product_manager", prompt: "SECRET_PROMPT" } })
    expect(created.statusCode).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 1))
    const result = await failing.app.inject({ method: "GET", url: `/api/agent-sessions/${created.json().sessionId}`, headers: { authorization: "Bearer sk_agent_test" } })
    expect(result.json().status).toBe("error")
    expect(JSON.stringify(failing.events)).not.toContain("SECRET_PROMPT")
    expect(JSON.stringify(failing.events)).not.toContain("sk_agent_test")
  })

  it("audits rejected requests and does not accept a human cookie alone", async () => {
    const { app, events } = build()
    const response = await app.inject({ method: "POST", url: "/api/agent-sessions", headers: { cookie: "codenomad_session=human" }, payload: { metadata: { threadId: "unauth-thread", requestedBy: "unauth-requester", secret: "never-log" } } })
    expect(response.statusCode).toBe(401)
    expect(events).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ action: "create", outcome: "unauthorized", keyId: null, keyLabel: null, threadId: "unauth-thread", requestedBy: "unauth-requester" })
    expect(JSON.stringify(events)).not.toContain("never-log")
  })

  it("emits one audit event for body, allowlist, queue, and read outcomes", async () => {
    const malformed = build()
    await malformed.app.inject({ method: "POST", url: "/api/agent-sessions", headers: { authorization: "Bearer sk_agent_test" }, payload: { metadata: { threadId: "body-thread", requestedBy: "body-requester" } } })
    expect(malformed.events).toHaveLength(1)
    expect(malformed.events[0]).toMatchObject({ outcome: "invalid_body", keyLabel: "test", threadId: "body-thread", requestedBy: "body-requester" })

    const disallowed = build()
    await disallowed.app.inject({ method: "POST", url: "/api/agent-sessions", headers: { authorization: "Bearer sk_agent_test" }, payload: { agent: "developer", prompt: "brief", metadata: { threadId: "deny-thread", requestedBy: "deny-requester" } } })
    expect(disallowed.events).toHaveLength(1)
    expect(disallowed.events[0]).toMatchObject({ outcome: "agent_not_allowed", threadId: "deny-thread", requestedBy: "deny-requester" })

    const queueFailure = build()
    await queueFailure.app.inject({ method: "POST", url: "/api/agent-sessions", headers: { authorization: "Bearer sk_agent_test" }, payload: { agent: "product_manager", prompt: "x".repeat(20_001) } })
    expect(queueFailure.events).toHaveLength(1)
    expect(queueFailure.events[0]).toMatchObject({ outcome: "queue_failure" })

    const found = build()
    const created = await found.app.inject({ method: "POST", url: "/api/agent-sessions", headers: { authorization: "Bearer sk_agent_test" }, payload: { agent: "product_manager", prompt: "brief", metadata: { threadId: "thread-1", requestedBy: "requester-1" } } })
    await found.app.inject({ method: "GET", url: `/api/agent-sessions/${created.json().sessionId}`, headers: { authorization: "Bearer sk_agent_test" } })
    expect(found.events).toHaveLength(2)
    expect(found.events[1]).toMatchObject({ outcome: "found", keyLabel: "test", threadId: "thread-1", requestedBy: "requester-1" })
  })

  it("represents approval and terminal adapter states", async () => {
    const waiting = build({ async start() { return { sessionId: "oc-2", status: "waiting_for_approval" as const, summary: "approval" } } })
    const waitingResponse = await waiting.app.inject({ method: "POST", url: "/api/agent-sessions", headers: { authorization: "Bearer sk_agent_test" }, payload: { agent: "product_manager", prompt: "brief" } })
    await new Promise((resolve) => setTimeout(resolve, 1))
    const waitingPoll = await waiting.app.inject({ method: "GET", url: `/api/agent-sessions/${waitingResponse.json().sessionId}`, headers: { authorization: "Bearer sk_agent_test" } })
    expect(waitingPoll.json().status).toBe("waiting_for_approval")
  })

  it("reconciles OpenCode prompt acceptance through busy to idle", async () => {
    const responses = [
      new Response(JSON.stringify({ id: "oc-real" }), { status: 200 }),
      new Response("", { status: 202 }),
      new Response(JSON.stringify({ "oc-real": { type: "idle" } }), { status: 200 }),
      new Response(JSON.stringify({ "oc-real": { type: "busy" } }), { status: 200 }),
      new Response(JSON.stringify({ "oc-real": { type: "idle" } }), { status: 200 }),
    ]
    const workspace = { list: () => [{ id: "w1", status: "ready", port: 9999 }], getInstanceAuthorizationHeader: () => undefined } as any
    const adapter = new OpenCodeAgentAdapter(workspace, { fetchImpl: async () => responses.shift()!, pollIntervalMs: 0, sleep: async () => {} })
    const result = await adapter.start("product_manager", "brief")
    expect(result).toMatchObject({ sessionId: "oc-real", status: "done" })
  })

  it("returns running rather than falsely claiming done on reconciliation timeout", async () => {
    const responses = [
      new Response(JSON.stringify({ id: "oc-timeout" }), { status: 200 }),
      new Response("", { status: 202 }),
      new Response(JSON.stringify({ "oc-timeout": { type: "idle" } }), { status: 200 }),
    ]
    const workspace = { list: () => [{ id: "w1", status: "ready", port: 9999 }], getInstanceAuthorizationHeader: () => undefined } as any
    const adapter = new OpenCodeAgentAdapter(workspace, { fetchImpl: async () => responses.shift() ?? new Response(JSON.stringify({}), { status: 200 }), pollIntervalMs: 0, timeoutMs: 0, sleep: async () => {} })
    const result = await adapter.start("product_manager", "brief")
    expect(result.status).toBe("running")
  })
  it("bounds registry size and evicts terminal records", () => {
    let now = 0
    const registry = new AgentSessionRegistry(() => now)
    for (let i = 0; i < 105; i++) registry.create({ threadId: String(i) })
    expect(registry.size()).toBe(100)
    const old = registry.create({})
    registry.update(old.sessionId, "done")
    now += 60 * 60 * 1000 + 1
    expect(registry.get(old.sessionId)).toBeNull()
  })
})
