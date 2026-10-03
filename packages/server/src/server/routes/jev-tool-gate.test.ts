import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify, { type FastifyInstance } from "fastify"
import { registerPluginRoutes } from "./plugin.js"
import { parseJevConfig, type JevToolGate } from "../../lib/jev/index.js"
import { createJevToolGate } from "../../lib/jev/index.js"

function stubDeps(toolGate?: JevToolGate) {
  return {
    workspaceManager: { get: (id: string) => (id === "wrk_known" ? { id } : undefined) } as never,
    eventBus: { publish: () => {} } as never,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
    channel: {} as never,
    voiceModeManager: {} as never,
    jevToolGate: toolGate,
  }
}

function answers(destructive: number, untrusted: number) {
  return {
    model: "jev-1.13.0",
    answers: {
      destructive: { type: "noul", noul: destructive },
      untrustedInput: { type: "noul", noul: untrusted },
      scope: { type: "choice", choice: "external or networked", confidence: 0.88, probabilities: { "external or networked": 0.88 } },
    },
    usage: { input_tokens: 120 },
  }
}

async function withServer<T>(toolGate: JevToolGate | undefined, run: (app: FastifyInstance) => Promise<T>): Promise<T> {
  const app = Fastify()
  registerPluginRoutes(app, stubDeps(toolGate))
  try {
    return await run(app)
  } finally {
    await app.close()
  }
}

describe("POST /workspaces/:id/plugin/jev/tool-gate", () => {
  it("returns an enforced ask for a destructive bash action", async () => {
    const toolGate = createJevToolGate({
      config: parseJevConfig({ JEV_TOOL_GATE: "enforce", TYPESAFE_API_KEY: "ts-test" }),
      fetchImpl: async () => new Response(JSON.stringify(answers(0.82, 0.05)), { status: 200 }),
    })

    const response = await withServer(toolGate, async (app) =>
      app.inject({
        method: "POST",
        url: "/workspaces/wrk_known/plugin/jev/tool-gate",
        payload: { kind: "bash", target: "rm -rf data", sessionId: "ses_1" },
      }),
    )

    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.status, "ok")
    assert.equal(body.action, "ask")
    assert.equal(body.enforced, true)
    assert.equal(body.reason, "jev-destructive")
    assert.equal(body.degradedReason, null)
    assert.equal(body.scores.destructive, 0.82)
    assert.equal(body.scores.scope, "external or networked")
  })

  it("never widens a baseline the harness already set to ask", async () => {
    const toolGate = createJevToolGate({
      config: parseJevConfig({ JEV_TOOL_GATE: "enforce", TYPESAFE_API_KEY: "ts-test" }),
      fetchImpl: async () => new Response(JSON.stringify(answers(0.01, 0.01)), { status: 200 }),
    })

    const response = await withServer(toolGate, async (app) =>
      app.inject({
        method: "POST",
        url: "/workspaces/wrk_known/plugin/jev/tool-gate",
        payload: { kind: "bash", target: "git status", baseline: "ask" },
      }),
    )

    assert.equal(response.json().action, "ask")
    assert.equal(response.json().reason, "baseline-ask")
  })

  it("reports a degraded feed as degraded, not as a clear pass", async () => {
    const toolGate = createJevToolGate({
      config: parseJevConfig({ JEV_TOOL_GATE: "enforce", TYPESAFE_API_KEY: "ts-test", JEV_DEGRADED_ACTION: "ask" }),
      fetchImpl: async () => {
        throw Object.assign(new Error("socket hang up"), { name: "TypeError" })
      },
    })

    const response = await withServer(toolGate, async (app) =>
      app.inject({
        method: "POST",
        url: "/workspaces/wrk_known/plugin/jev/tool-gate",
        payload: { kind: "bash", target: "npm publish" },
      }),
    )

    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.status, "degraded")
    assert.equal(body.degradedReason, "network")
    assert.equal(body.action, "ask", "declared degradedAction applies")
    assert.equal(body.enforced, false)
    assert.equal(body.scores.destructive, undefined)
  })

  it("is inert when the gate is off", async () => {
    const response = await withServer(undefined, async (app) =>
      app.inject({
        method: "POST",
        url: "/workspaces/wrk_known/plugin/jev/tool-gate",
        payload: { kind: "bash", target: "npm publish" },
      }),
    )

    assert.equal(response.json().status, "disabled")
    assert.equal(response.json().enforced, false)
    assert.equal(response.json().action, "allow")
  })

  it("rejects an unknown workspace and a malformed body", async () => {
    await withServer(undefined, async (app) => {
      const unknown = await app.inject({
        method: "POST",
        url: "/workspaces/wrk_missing/plugin/jev/tool-gate",
        payload: { kind: "bash" },
      })
      assert.equal(unknown.statusCode, 404)

      const malformed = await app.inject({
        method: "POST",
        url: "/workspaces/wrk_known/plugin/jev/tool-gate",
        payload: { target: "no kind" },
      })
      assert.equal(malformed.statusCode, 400)
    })
  })

  it("serves shadow-mode counters so a dry run can be audited", async () => {
    const toolGate = createJevToolGate({
      config: parseJevConfig({ JEV_TOOL_GATE: "shadow", TYPESAFE_API_KEY: "ts-test" }),
      fetchImpl: async () => new Response(JSON.stringify(answers(0.99, 0.01)), { status: 200 }),
    })

    await withServer(toolGate, async (app) => {
      await app.inject({
        method: "POST",
        url: "/workspaces/wrk_known/plugin/jev/tool-gate",
        payload: { kind: "bash", target: "git reset --hard origin/main" },
      })
      const metrics = await app.inject({ method: "GET", url: "/workspaces/wrk_known/plugin/jev/metrics" })
      const body = metrics.json()
      assert.equal(body.mode, "shadow")
      assert.equal(body.enabled, true)
      assert.equal(body.metrics.ok, 1)
      assert.equal(body.metrics.wouldDeny, 1)
    })
  })
})