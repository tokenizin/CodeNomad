import assert from "node:assert/strict"
import { createServer } from "node:http"
import { describe, it } from "node:test"
import { ModelBackpressureError, ModelThrottle, ModelThrottleCancelledError, ModelThrottleTimeoutError, percentile } from "./model-throttle.js"
import { parseRetryAfter, proxyModelRequest } from "./server/model-throttle-proxy.js"

const key = "vercel/openai/gpt-5.6-luna" as const
const config = (overrides: Record<string, number> = {}) => ({ enabled: true, maxInFlight: 1, requestsPerMinute: 20, queueLimit: 50, maxRetries: 2, backoffBaseMs: 1, backoffMaxMs: 10, jitterRatio: 0, queueWaitTimeoutMs: 100, ...overrides })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }

describe("model throttle gateway", () => {
  it("shares one concurrency budget across parallel callers and preserves FIFO", async () => {
    const gate = deferred<string>()
    const order: number[] = []
    const throttle = new ModelThrottle({ config: config() })
    const first = throttle.execute(key, async () => { order.push(1); return gate.promise })
    const second = throttle.execute(key, async () => { order.push(2); return "two" })
    const third = throttle.execute(key, async () => { order.push(3); return "three" })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(order, [1])
    gate.resolve("one")
    assert.deepEqual(await Promise.all([first, second, third]), ["one", "two", "three"])
    assert.deepEqual(order, [1, 2, 3])
    assert.equal(throttle.getMetrics()[0]?.peakInFlight, 1)
  })

  it("rejects overflow instead of growing the queue", async () => {
    const gate = deferred<void>()
    const throttle = new ModelThrottle({ config: config({ queueLimit: 1 }) })
    const first = throttle.execute(key, () => gate.promise)
    const queued = throttle.execute(key, async () => undefined)
    await assert.rejects(throttle.execute(key, async () => undefined), ModelBackpressureError)
    gate.resolve()
    await Promise.all([first, queued])
  })

  it("supports cancellation and queue timeout with explicit errors", async () => {
    const gate = deferred<void>()
    const controller = new AbortController()
    const throttle = new ModelThrottle({ config: config({ queueWaitTimeoutMs: 5 }) })
    const first = throttle.execute(key, () => gate.promise)
    const cancelled = throttle.execute(key, async () => undefined, { signal: controller.signal })
    controller.abort()
    await assert.rejects(cancelled, ModelThrottleCancelledError)
    const timedOut = throttle.execute(key, async () => undefined)
    await assert.rejects(timedOut, ModelThrottleTimeoutError)
    gate.resolve()
    await first
    const metrics = throttle.getMetrics()[0]!
    assert.equal(metrics.cancelled, 1)
    assert.equal(metrics.timedOut, 1)
  })

  it("retries rate-limited attempts with bounded backoff and counts physical attempts", async () => {
    let calls = 0
    const sleeps: number[] = []
    const throttle = new ModelThrottle({ config: config({ maxRetries: 2, backoffBaseMs: 4, backoffMaxMs: 5 }), sleep: async (ms) => { sleeps.push(ms) }, random: () => 0.5 })
    const result = await throttle.execute(key, async () => ({ status: ++calls === 3 ? 200 : 429 }), { isRateLimited: (response) => response.status === 429 })
    assert.equal(result.status, 200)
    assert.deepEqual(sleeps, [4, 5])
    const metrics = throttle.getMetrics()[0]!
    assert.equal(metrics.logicalRequests, 1)
    assert.equal(metrics.attempts, 3)
    assert.equal(metrics.retries, 2)
    assert.equal(metrics.rateLimitResponses, 2)
  })

  it("re-admits every retry and never exceeds a one-per-minute rate window", async () => {
    let now = 0
    let calls = 0
    let scheduled = 0
    const throttle = new ModelThrottle({
      config: config({ requestsPerMinute: 1, maxRetries: 2 }),
      now: () => now,
      sleep: async () => undefined,
      schedule: (callback) => { scheduled += 1; now += 60_001; callback(); return 0 as any },
    })
    const result = await throttle.execute(key, async () => ({ status: ++calls < 3 ? 429 : 200 }), { isRateLimited: (response) => response.status === 429 })
    assert.equal(result.status, 200)
    assert.equal(calls, 3)
    assert.equal(scheduled, 2)
    const metrics = throttle.getMetrics()[0]!
    assert.equal(metrics.attempts, 3)
    assert.equal(metrics.retries, 2)
    assert.equal(metrics.peakInFlight, 1)
  })

  it("honors and bounds Retry-After through the proxy gateway", async () => {
    let calls = 0
    const upstream = createServer((_request, response) => {
      calls += 1
      if (calls === 1) {
        response.writeHead(429, { "retry-after": "2" })
        response.end("rate limited")
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    assert.ok(address && typeof address === "object")
    const sleeps: number[] = []
    const throttle = new ModelThrottle({ config: config({ maxRetries: 1, backoffMaxMs: 5_000 }), sleep: async (ms) => { sleeps.push(ms) } })
    const sent: { status?: number; body?: Buffer } = {}
    await proxyModelRequest({
      request: { method: "POST" } as any,
      reply: { header: () => undefined, code: (status: number) => { sent.status = status; return sent }, send: (body?: Buffer) => { sent.body = body } } as any,
      targetUrl: `http://127.0.0.1:${address.port}/session/s/prompt_async`,
      body: Buffer.from('{"parts":[]}'),
      contentType: "application/json",
      throttle,
      logger: {} as any,
    })
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    assert.equal(sent.status, 200)
    assert.deepEqual(sleeps, [2_000])
    assert.equal(throttle.getMetrics()[0]?.attempts, 2)
    assert.equal(throttle.getMetrics()[0]?.rateLimitResponses, 1)
    assert.equal(parseRetryAfter("999"), 30_000)
    assert.equal(parseRetryAfter("invalid"), undefined)
  })

  it("keeps provider/model budgets independent", async () => {
    const other = "ollama/qwen3.6:latest" as const
    const gate = deferred<void>()
    const throttle = new ModelThrottle({ config: { ...config({ maxInFlight: 1 }), budgets: { [other]: { maxInFlight: 2 } } } })
    const first = throttle.execute(key, () => gate.promise)
    const second = throttle.execute(key, async () => "queued")
    const parallel = await Promise.all([throttle.execute(other, async () => "a"), throttle.execute(other, async () => "b")])
    assert.deepEqual(parallel, ["a", "b"])
    gate.resolve()
    assert.deepEqual(await Promise.all([first, second]), [undefined, "queued"])
  })

  it("calculates latency percentile deterministically", () => {
    assert.equal(percentile([30, 10, 20], 50), 20)
    assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 50), 50)
    assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95), 100)
    assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 99), 100)
    assert.equal(percentile([], 99), 0)
  })

  it("publishes p50, p95, and p99 latency fields in the metrics snapshot", async () => {
    let now = 0
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const throttle = new ModelThrottle({ config: config({ requestsPerMinute: 100 }), now: () => now })
    await Promise.all(durations.map((duration) => throttle.execute(key, async () => { now += duration; return undefined })))
    const metrics = throttle.getMetrics()[0]!
    assert.equal(metrics.latencyP50Ms, 50)
    assert.equal(metrics.latencyP95Ms, 100)
    assert.equal(metrics.latencyP99Ms, 100)
  })
})
