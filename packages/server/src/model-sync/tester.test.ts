import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, describe, it } from "node:test"

// tester imports the service, which reads ~/.config/codenomad and opencode.json
// on load; keep it away from the real ones.
const home = mkdtempSync(join(tmpdir(), "model-sync-tester-"))
process.env.HOME = home
process.env.XDG_DATA_HOME = join(home, "data")
process.chdir(home)

let tester: typeof import("./tester")
before(async () => {
  tester = await import("./tester")
})

describe("classifyError", () => {
  // Real messages from a batch run with no keys configured.
  const cases: Array<[string, string]> = [
    ["No cookie auth credentials found", "unknown"],
    ["x-api-key header is required", "unknown"],
    ["API key not valid. Please pass a valid API key.", "unknown"],
    ["HTTP 401: Unauthorized", "unknown"],
    ["The operation was aborted.", "unknown"],
    ["Unable to connect. Is the computer able to access the url?", "unknown"],
    ["HTTP 429: Too Many Requests", "unknown"],
    ["HTTP 503: Service Unavailable", "unknown"],
    ["HTTP 402: Payment Required", "insufficient_funds"],
    ["usage credits auto reload payment failed, update your payment method", "insufficient_funds"],
    ["HTTP 410: Gone", "error"],
    ["HTTP 404: Not Found", "error"],
  ]
  for (const [message, status] of cases) {
    it(`${message} -> ${status}`, () => {
      assert.equal(tester.classifyError(new Error(message)).status, status)
    })
  }

  it("labels timeouts and auth failures so the UI can tell them apart", () => {
    assert.match(tester.classifyError(new Error("The operation was aborted.")).details, /^Timeout/)
    assert.match(tester.classifyError(new Error("No cookie auth credentials found")).details, /^Authentication error/)
  })
})

describe("testModel without a key", () => {
  it("returns 'unknown' with a hint, without calling the provider", async () => {
    for (const name of ["OPENROUTER_API_KEY"]) delete process.env[name]
    const realFetch = globalThis.fetch
    let called = false
    globalThis.fetch = (async () => {
      called = true
      throw new Error("should not be called")
    }) as typeof fetch
    try {
      const result = await tester.testModel({ providerId: "openrouter", modelId: "openai/gpt-5" })
      assert.equal(called, false)
      assert.equal(result.status, "unknown")
      assert.match(result.errorDetails ?? "", /^No API key: set OPENROUTER_API_KEY/)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
