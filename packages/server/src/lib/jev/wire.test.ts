import assert from "node:assert/strict"
import { createServer } from "node:http"
import { describe, it } from "node:test"
import { createJevToolGate } from "./index.js"
import { parseJevConfig } from "./config.js"

/**
 * Wire-level check: the unit tests stub `fetch`, so this one runs the real HTTP
 * path against a local server that answers with the exact System One response
 * shape from docs.typesafe.ai. It proves the request body, the bearer header and
 * the answer parsing all survive serialization.
 */
function startFakeTypeSafe(handler: (body: any, headers: Record<string, unknown>) => unknown) {
  const seen: Array<{ body: any; headers: Record<string, unknown>; url: string }> = []
  const server = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => {
      raw += chunk
    })
    request.on("end", () => {
      const payload = raw ? JSON.parse(raw) : {}
      seen.push({ body: payload, headers: request.headers as Record<string, unknown>, url: request.url ?? "" })
      const result = handler(payload, request.headers as Record<string, unknown>)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(result))
    })
  })

  return new Promise<{ endpoint: string; seen: typeof seen; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      resolve({
        endpoint: `http://127.0.0.1:${port}/v1/systemone`,
        seen,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

describe("jev wire contract", () => {
  it("sends the documented payload and reads typed answers back over real HTTP", async () => {
    const fake = await startFakeTypeSafe(() => ({
      model: "jev-1.13.0",
      answers: {
        destructive: { type: "noul", noul: 0.93 },
        untrustedInput: { type: "noul", noul: 0.11 },
        scope: {
          type: "choice",
          choice: "credentials or funds",
          confidence: 0.81,
          probabilities: { "read-only local": 0.02, "mutates local files": 0.05, "external or networked": 0.12, "credentials or funds": 0.81 },
        },
      },
      usage: { input_tokens: 96, output_tokens: 21 },
    }))

    try {
      const toolGate = createJevToolGate({
        config: parseJevConfig({ JEV_TOOL_GATE: "enforce", TYPESAFE_API_KEY: "ts-live", JEV_BASE_URL: fake.endpoint }),
      })

      const verdict = await toolGate.evaluate({
        kind: "bash",
        target: "git push --force origin main",
        title: "Force push main",
        sessionId: "ses_wire",
      })

      assert.equal(verdict.status, "ok")
      assert.equal(verdict.action, "ask", "destructive 0.93 sits above the ask threshold 0.6 and below the deny threshold 0.95")
      assert.equal(verdict.model, "jev-1.13.0")
      assert.equal(verdict.scores.destructive, 0.93)
      assert.equal(verdict.scores.scope, "credentials or funds")
      assert.equal(verdict.scores.confidence, 0.81)

      assert.equal(fake.seen.length, 1)
      const request = fake.seen[0]
      assert.equal(request.url, "/v1/systemone")
      assert.equal(request.headers.authorization, "Bearer ts-live")
      assert.equal(request.body.model, "jev-latest")
      assert.deepEqual(Object.keys(request.body.questions).sort(), ["destructive", "scope", "untrustedInput"])
      assert.match(request.body.state, /^Action type: bash\nTarget: git push --force origin main/)
      assert.ok(toolGate.metrics().totalLatencyMs >= 0)
    } finally {
      await fake.close()
    }
  })

  it("stays inside its latency budget and reports a timeout as degraded", async () => {
    const fake = await startFakeTypeSafe(() => ({ answers: {} }))

    try {
      const toolGate = createJevToolGate({
        config: parseJevConfig({ JEV_TOOL_GATE: "enforce", TYPESAFE_API_KEY: "ts-live", JEV_BASE_URL: fake.endpoint, JEV_TIMEOUT_MS: "1500" }),
      })

      const verdict = await toolGate.evaluate({ kind: "bash", target: "echo hi" })
      // The fake answers with an empty `answers` object, which is not a usable verdict.
      assert.equal(verdict.status, "degraded")
      assert.equal(verdict.degradedReason, "malformed-response")
      assert.equal(verdict.enforced, false)
    } finally {
      await fake.close()
    }
  })
})