import { ModelThrottle, loadModelThrottleConfig } from "./model-throttle.js"

const total = Number(process.env.MODEL_THROTTLE_HARNESS_REQUESTS ?? 21)
const key = "vercel/openai/gpt-5.6-luna" as const

async function fakeUpstream(state: { active: number; peak: number }) {
  state.active += 1
  state.peak = Math.max(state.peak, state.active)
  await new Promise((resolve) => setTimeout(resolve, 2))
  state.active -= 1
}

async function run() {
  const beforeState = { active: 0, peak: 0 }
  const beforeStart = performance.now()
  await Promise.all(Array.from({ length: total }, () => fakeUpstream(beforeState)))
  const beforeMs = performance.now() - beforeStart

  const afterState = { active: 0, peak: 0 }
  const throttle = new ModelThrottle({ config: loadModelThrottleConfig() })
  const afterStart = performance.now()
  await Promise.all(Array.from({ length: total }, () => throttle.execute(key, () => fakeUpstream(afterState))))
  const afterMs = performance.now() - afterStart

  const metrics = throttle.getMetrics()[0]
  console.log(JSON.stringify({ model: key, totalRequests: total, defaults: loadModelThrottleConfig(), before: { elapsedMs: Math.round(beforeMs), peakInFlight: beforeState.peak, unthrottledObservedRequestsInWindow: total }, after: { elapsedMs: Math.round(afterMs), peakInFlight: afterState.peak, measuredWindowRequestsPerMinute: metrics?.maxRollingMinuteAdmissions ?? 0, admitted: metrics?.admitted ?? 0, completed: metrics?.completed ?? 0, latencyPercentilesMs: { p50: metrics?.latencyP50Ms ?? 0, p95: metrics?.latencyP95Ms ?? 0, p99: metrics?.latencyP99Ms ?? 0 } }, metrics }, null, 2))
}

void run()
