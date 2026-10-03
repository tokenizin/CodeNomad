import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createJevToolGate } from "./index.js"
import { createJevClient, JevClientError } from "./client.js"
import { evaluateGate, GATE_QUESTIONS } from "./gate.js"
import { DEFAULT_ENDPOINT, parseJevConfig } from "./config.js"

const baseEnv: Record<string, string> = {
  JEV_TOOL_GATE: "enforce",
  TYPESAFE_API_KEY: "ts-test",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function answers(overrides: Record<string, unknown> = {}) {
  return {
    model: "jev-1.13.0",
    answers: {
      destructive: { type: "noul", noul: 0.01 },
      untrustedInput: { type: "noul", noul: 0.02 },
      scope: {
        type: "choice",
        choice: "read-only local",
        confidence: 0.9,
        probabilities: { "read-only local": 0.95, "mutates local files": 0.05, "external or networked": 0, "credentials or funds": 0 },
      },
      ...overrides,
    },
    usage: { input_tokens: 180, output_tokens: 40 },
  }
}

describe("jev config", () => {
  it("defaults to off so the gate can never surprise a running install", () => {
    const config = parseJevConfig({} as NodeJS.ProcessEnv)
    assert.equal(config.mode, "off")
    assert.equal(config.endpoint, DEFAULT_ENDPOINT)
    assert.equal(config.model, "jev-latest")
    assert.equal(config.degradedAction, "allow")
  })

  it("rejects invalid modes and thresholds instead of silently coercing them", () => {
    assert.throws(() => parseJevConfig({ JEV_TOOL_GATE: "enabled" } as NodeJS.ProcessEnv), /expected one of/)
    assert.throws(() => parseJevConfig({ JEV_TOOL_GATE: "shadow", JEV_DESTRUCTIVE_THRESHOLD: "1.4" } as NodeJS.ProcessEnv), /expected 0\.\.1/)
  })

  it("normalizes the permission type list", () => {
    const config = parseJevConfig({ JEV_TOOL_GATE: "shadow", JEV_PERMISSION_TYPES: " Bash , EDIT " } as NodeJS.ProcessEnv)
    assert.deepEqual(config.permissionTypes, ["bash", "edit"])
  })
})

describe("jev client", () => {
  it("posts the documented System One request shape", async () => {
    let seenUrl = ""
    let seenInit: RequestInit | undefined
    const client = createJevClient({
      config: parseJevConfig(baseEnv),
      fetchImpl: async (url, init) => {
        seenUrl = url
        seenInit = init
        return jsonResponse(answers())
      },
    })

    const response = await client.decide({ state: "Action type: bash\nTarget: rm -rf /", questions: GATE_QUESTIONS })

    assert.equal(seenUrl, DEFAULT_ENDPOINT)
    assert.equal(seenInit?.method, "POST")
    assert.equal((seenInit?.headers as Record<string, string>).authorization, "Bearer ts-test")
    const body = JSON.parse(String(seenInit?.body))
    assert.deepEqual(Object.keys(body.questions).sort(), ["destructive", "scope", "untrustedInput"])
    assert.equal(body.model, "jev-latest")
    assert.equal(body.state, "Action type: bash\nTarget: rm -rf /")
    assert.equal(response.answers.destructive?.type === "noul" && response.answers.destructive.noul, 0.01)
    assert.equal(response.inputTokens, 180)
  })

  it("refuses to run without a key rather than sending an unauthenticated request", async () => {
    let called = false
    const client = createJevClient({
      config: parseJevConfig({ JEV_TOOL_GATE: "shadow" } as NodeJS.ProcessEnv),
      fetchImpl: async () => {
        called = true
        return jsonResponse(answers())
      },
    })
    await assert.rejects(() => client.decide({ state: "x", questions: GATE_QUESTIONS }), (error: JevClientError) => {
      assert.equal(error.code, "not-configured")
      return true
    })
    assert.equal(called, false)
  })

  it("reports a timeout as its own code, not a generic network error", async () => {
    const client = createJevClient({
      config: parseJevConfig({ ...baseEnv, JEV_TIMEOUT_MS: "120" }),
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
        }),
    })
    await assert.rejects(() => client.decide({ state: "x", questions: GATE_QUESTIONS }), (error: JevClientError) => {
      assert.equal(error.code, "timeout")
      return true
    })
  })

  it("rejects a response whose answers are unusable rather than defaulting them to zero", async () => {
    const client = createJevClient({
      config: parseJevConfig(baseEnv),
      fetchImpl: async () => jsonResponse({ model: "jev-1.13.0", answers: { destructive: { type: "noul" } } }),
    })
    await assert.rejects(() => client.decide({ state: "x", questions: GATE_QUESTIONS }), (error: JevClientError) => {
      assert.equal(error.code, "malformed-response")
      return true
    })
  })
})

describe("jev gate policy", () => {
  const gate = (overrides: Record<string, string> = {}) => parseJevConfig({ ...baseEnv, ...overrides } as NodeJS.ProcessEnv)

  it("allows a low-risk action in enforce mode", () => {
    const verdict = evaluateGate({ config: gate(), status: "ok", answers: answers().answers as never })
    assert.equal(verdict.action, "allow")
    assert.equal(verdict.enforced, true)
    assert.equal(verdict.status, "ok")
  })

  it("escalates a destructive action to a human at the destructive threshold", () => {
    const verdict = evaluateGate({
      config: gate(),
      status: "ok",
      answers: answers({ destructive: { type: "noul", noul: 0.7 } }).answers as never,
    })
    assert.equal(verdict.action, "ask")
    assert.equal(verdict.reason, "jev-destructive")
  })

  it("denies only at the deny threshold", () => {
    const verdict = evaluateGate({
      config: gate(),
      status: "ok",
      answers: answers({ destructive: { type: "noul", noul: 0.99 } }).answers as never,
    })
    assert.equal(verdict.action, "deny")
    assert.equal(verdict.enforced, true)
  })

  it("treats untrusted-input provenance as a separate escalation reason", () => {
    const verdict = evaluateGate({
      config: gate(),
      status: "ok",
      answers: answers({ untrustedInput: { type: "noul", noul: 0.8 } }).answers as never,
    })
    assert.equal(verdict.action, "ask")
    assert.equal(verdict.reason, "jev-untrusted-input")
  })

  it("never relaxes a baseline the harness already restricted", () => {
    const asking = evaluateGate({ config: gate(), status: "ok", answers: answers().answers as never, baseline: "ask" })
    assert.equal(asking.action, "ask")
    assert.equal(asking.reason, "baseline-ask")

    const denying = evaluateGate({
      config: gate(),
      status: "ok",
      answers: answers({ untrustedInput: { type: "noul", noul: 0.99 } }).answers as never,
      baseline: "deny",
    })
    assert.equal(denying.action, "deny")
  })

  it("keeps a degraded verdict visibly degraded and un-enforced", () => {
    const verdict = evaluateGate({ config: gate(), status: "degraded", degradedReason: "timeout", baseline: "ask" })
    assert.equal(verdict.status, "degraded")
    assert.equal(verdict.degradedReason, "timeout")
    assert.equal(verdict.enforced, false)
    // baseline survived the degraded feed, so the reason reports the baseline override
    assert.equal(verdict.reason, "baseline-ask")
    assert.equal(verdict.degradedReason, "timeout")
    // baseline survives a degraded feed
    assert.equal(verdict.action, "ask")
  })

  it("never denies from a degraded feed", () => {
    const verdict = evaluateGate({ config: gate({ JEV_DEGRADED_ACTION: "deny" }), status: "degraded", degradedReason: "network" })
    assert.equal(verdict.action, "deny")
    assert.equal(verdict.enforced, false)
    assert.equal(verdict.status, "degraded")
  })

  it("reports shadow-mode verdicts as advisory only", () => {
    const verdict = evaluateGate({
      config: gate({ JEV_TOOL_GATE: "shadow" }),
      status: "ok",
      answers: answers({ destructive: { type: "noul", noul: 0.99 } }).answers as never,
    })
    assert.equal(verdict.action, "deny")
    assert.equal(verdict.enforced, false)
  })
})

describe("jev tool gate", () => {
  it("skips permission types that are not gated without calling the API", async () => {
    let called = false
    const toolGate = createJevToolGate({
      config: parseJevConfig({ ...baseEnv, JEV_PERMISSION_TYPES: "bash" } as NodeJS.ProcessEnv),
      fetchImpl: async () => {
        called = true
        return jsonResponse(answers())
      },
    })
    const verdict = await toolGate.evaluate({ kind: "webfetch", target: "https://example.com" })
    assert.equal(called, false)
    assert.equal(verdict.status, "disabled")
    assert.equal(toolGate.metrics().skipped, 1)
  })

  it("degrades with a named reason when the key is missing, and says so", async () => {
    const toolGate = createJevToolGate({ config: parseJevConfig({ JEV_TOOL_GATE: "enforce" } as NodeJS.ProcessEnv) })
    const verdict = await toolGate.evaluate({ kind: "bash", target: "rm -rf /" })
    assert.equal(verdict.status, "disabled")
    assert.equal(verdict.degradedReason, "typesafe-api-key-missing")
    assert.equal(toolGate.metrics().lastDegradedReason, "typesafe-api-key-missing")
    assert.equal(toolGate.isEnabled(), false)
  })

  it("degrades with a named reason on an upstream failure instead of passing it as clear", async () => {
    const toolGate = createJevToolGate({
      config: parseJevConfig(baseEnv),
      fetchImpl: async () => new Response("upstream boom", { status: 503 }),
    })
    const verdict = await toolGate.evaluate({ kind: "bash", target: "git push --force" })
    assert.equal(verdict.status, "degraded")
    assert.equal(verdict.degradedReason, "http-error")
    assert.equal(verdict.action, "allow", "declared degradedAction is fail-open by default")
    assert.equal(toolGate.metrics().degraded, 1)
  })

  it("caches answers for repeated identical actions and still applies fresh policy", async () => {
    let calls = 0
    const toolGate = createJevToolGate({
      config: parseJevConfig({ ...baseEnv, JEV_CACHE_TTL_MS: "30000" } as NodeJS.ProcessEnv),
      fetchImpl: async () => {
        calls += 1
        return jsonResponse(answers({ destructive: { type: "noul", noul: 0.7 } }))
      },
    })
    const first = await toolGate.evaluate({ kind: "bash", target: "rm -rf build" })
    const second = await toolGate.evaluate({ kind: "bash", target: "rm -rf build" })
    assert.equal(calls, 1)
    assert.equal(first.action, "ask")
    assert.equal(second.action, "ask")
    assert.equal(second.cached, true)
    assert.equal(toolGate.metrics().cacheHits, 1)
  })

  it("counts what shadow mode would have done", async () => {
    const toolGate = createJevToolGate({
      config: parseJevConfig({ ...baseEnv, JEV_TOOL_GATE: "shadow" } as NodeJS.ProcessEnv),
      fetchImpl: async () => jsonResponse(answers({ destructive: { type: "noul", noul: 0.99 } })),
    })
    const verdict = await toolGate.evaluate({ kind: "bash", target: "git reset --hard origin/main" })
    assert.equal(verdict.action, "deny")
    assert.equal(verdict.enforced, false)
    assert.equal(toolGate.metrics().wouldDeny, 1)
    assert.equal(toolGate.metrics().wouldAsk, 0)
  })

  it("keeps the state compact and labels truncation", async () => {
    let body = ""
    const toolGate = createJevToolGate({
      config: parseJevConfig({ ...baseEnv, JEV_MAX_STATE_CHARS: "300" } as NodeJS.ProcessEnv),
      fetchImpl: async (_url, init) => {
        body = String(init.body)
        return jsonResponse(answers())
      },
    })
    await toolGate.evaluate({ kind: "bash", target: "echo ".repeat(500) })
    const state = JSON.parse(body).state as string
    assert.ok(state.includes("[truncated"), state.slice(0, 80))
    assert.ok(state.length < 400, `state was ${state.length} chars`)
  })
})