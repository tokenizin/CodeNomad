export type ModelKey = `${string}/${string}`

export type ModelThrottleConfig = {
  enabled: boolean
  maxInFlight: number
  requestsPerMinute: number
  queueLimit: number
  maxRetries: number
  backoffBaseMs: number
  backoffMaxMs: number
  jitterRatio: number
  queueWaitTimeoutMs: number
  budgets?: Record<string, Partial<Omit<ModelThrottleConfig, "budgets">>>
}

export type ModelThrottleMetrics = {
  key: ModelKey
  logicalRequests: number
  attempts: number
  retries: number
  rateLimitResponses: number
  queueRejected: number
  cancelled: number
  timedOut: number
  completed: number
  admitted: number
  maxRollingMinuteAdmissions: number
  peakInFlight: number
  queueWaitMs: number[]
  latencyMs: number[]
  latencyP50Ms: number
  latencyP95Ms: number
  latencyP99Ms: number
}

export class ModelBackpressureError extends Error {
  readonly code = "MODEL_BACKPRESSURE_QUEUE_FULL"
  constructor(message = "Model request queue is full") {
    super(message)
    this.name = "ModelBackpressureError"
  }
}

export class ModelThrottleTimeoutError extends Error {
  readonly code = "MODEL_BACKPRESSURE_QUEUE_TIMEOUT"
  constructor() {
    super("Model request exceeded the queue wait timeout")
    this.name = "ModelThrottleTimeoutError"
  }
}

export class ModelThrottleCancelledError extends Error {
  readonly code = "MODEL_BACKPRESSURE_CANCELLED"
  constructor() {
    super("Model request was cancelled while queued")
    this.name = "ModelThrottleCancelledError"
  }
}

type Clock = () => number
type Sleep = (ms: number) => Promise<void>
type Schedule = (callback: () => void, ms: number) => ReturnType<typeof setTimeout>

const DEFAULTS: ModelThrottleConfig = {
  enabled: true,
  maxInFlight: 1,
  requestsPerMinute: 20,
  queueLimit: 50,
  maxRetries: 2,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  jitterRatio: 0.25,
  queueWaitTimeoutMs: 120_000,
}

const asPositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

const asRatio = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback
}

export function loadModelThrottleConfig(env: NodeJS.ProcessEnv = process.env): ModelThrottleConfig {
  const config: ModelThrottleConfig = {
    enabled: env.MODEL_THROTTLE_ENABLED !== "false",
    maxInFlight: Math.max(1, asPositiveInt(env.MODEL_THROTTLE_DEFAULT_MAX_IN_FLIGHT, DEFAULTS.maxInFlight)),
    requestsPerMinute: Math.max(1, asPositiveInt(env.MODEL_THROTTLE_DEFAULT_REQUESTS_PER_MINUTE, DEFAULTS.requestsPerMinute)),
    queueLimit: asPositiveInt(env.MODEL_THROTTLE_DEFAULT_QUEUE_LIMIT, DEFAULTS.queueLimit),
    maxRetries: asPositiveInt(env.MODEL_THROTTLE_MAX_RETRIES, DEFAULTS.maxRetries),
    backoffBaseMs: asPositiveInt(env.MODEL_THROTTLE_BACKOFF_BASE_MS, DEFAULTS.backoffBaseMs),
    backoffMaxMs: Math.max(1, asPositiveInt(env.MODEL_THROTTLE_BACKOFF_MAX_MS, DEFAULTS.backoffMaxMs)),
    jitterRatio: asRatio(env.MODEL_THROTTLE_JITTER_RATIO, DEFAULTS.jitterRatio),
    queueWaitTimeoutMs: asPositiveInt(env.MODEL_THROTTLE_QUEUE_WAIT_TIMEOUT_MS, DEFAULTS.queueWaitTimeoutMs),
  }
  if (env.MODEL_THROTTLE_BUDGETS) {
    try { config.budgets = JSON.parse(env.MODEL_THROTTLE_BUDGETS) as ModelThrottleConfig["budgets"] } catch { /* retain safe defaults */ }
  }
  return config
}

type QueueItem<T> = {
  key: ModelKey
  startedAt: number
  signal?: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  cancelled: boolean
  run: () => Promise<T>
}

type Bucket = { active: number; starts: number[]; admissionHistory: number[]; queue: QueueItem<unknown>[]; metrics: ModelThrottleMetrics }

export class ModelThrottle {
  private readonly buckets = new Map<ModelKey, Bucket>()
  private readonly config: ModelThrottleConfig
  private readonly now: Clock
  private readonly sleep: Sleep
  private readonly random: () => number
  private readonly schedule: Schedule

  constructor(options: { config?: ModelThrottleConfig; now?: Clock; sleep?: Sleep; random?: () => number; schedule?: Schedule } = {}) {
    this.config = options.config ?? loadModelThrottleConfig()
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
    this.schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms))
  }

  getConfig(): ModelThrottleConfig { return { ...this.config } }

  getMetrics(): ModelThrottleMetrics[] {
    return [...this.buckets.values()].map(({ metrics }) => ({
      ...metrics,
      latencyP50Ms: percentile(metrics.latencyMs, 50),
      latencyP95Ms: percentile(metrics.latencyMs, 95),
      latencyP99Ms: percentile(metrics.latencyMs, 99),
      queueWaitMs: [...metrics.queueWaitMs],
      latencyMs: [...metrics.latencyMs],
    }))
  }

  async execute<T>(key: ModelKey, run: () => Promise<T>, options: { signal?: AbortSignal; isRateLimited?: (value: T) => boolean; retryAfterMs?: (value: T) => number | undefined } = {}): Promise<T> {
    if (!this.config.enabled) return run()
    const bucket = this.getBucket(key)
    const config = this.configFor(key)
    bucket.metrics.logicalRequests += 1
    let attempt = 0
    try {
      while (true) {
        // Every physical attempt gets its own admission. The slot and rate
        // token are released before backoff so queued logical requests cannot
        // be starved by a retry that is sleeping.
        await this.acquire(bucket, key, options.signal)
        bucket.metrics.attempts += 1
        const started = this.now()
        let value: T
        try {
          value = await run()
        } finally {
          bucket.metrics.latencyMs.push(Math.max(0, this.now() - started))
          this.release(bucket)
        }
        if (!options.isRateLimited?.(value) || attempt >= config.maxRetries) {
          if (options.isRateLimited?.(value)) bucket.metrics.rateLimitResponses += 1
          bucket.metrics.completed += 1
          return value
        }
        bucket.metrics.rateLimitResponses += 1
        bucket.metrics.retries += 1
        const retryAfter = Math.min(config.backoffMaxMs, options.retryAfterMs?.(value) ?? 0)
        await this.sleep(retryAfter || this.backoff(attempt, config))
        attempt += 1
      }
    } finally { /* admission is released per physical attempt */ }
  }

  private getBucket(key: ModelKey): Bucket {
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { active: 0, starts: [], admissionHistory: [], queue: [], metrics: { key, logicalRequests: 0, attempts: 0, retries: 0, rateLimitResponses: 0, queueRejected: 0, cancelled: 0, timedOut: 0, completed: 0, admitted: 0, maxRollingMinuteAdmissions: 0, peakInFlight: 0, queueWaitMs: [], latencyMs: [], latencyP50Ms: 0, latencyP95Ms: 0, latencyP99Ms: 0 } }
      this.buckets.set(key, bucket)
    }
    return bucket
  }

  private async acquire(bucket: Bucket, key: ModelKey, signal?: AbortSignal): Promise<void> {
    const config = this.configFor(key)
    this.prune(bucket)
    if (bucket.active < config.maxInFlight && bucket.starts.length < config.requestsPerMinute) {
      bucket.active += 1
      bucket.starts.push(this.now())
      this.recordAdmission(bucket)
      bucket.metrics.peakInFlight = Math.max(bucket.metrics.peakInFlight, bucket.active)
      return
    }
    if (bucket.queue.length >= config.queueLimit) {
      bucket.metrics.queueRejected += 1
      throw new ModelBackpressureError(`Queue full for ${key}`)
    }
    await new Promise<void>((resolve, reject) => {
      const item: QueueItem<void> = { key, startedAt: this.now(), signal, resolve: () => resolve(), reject, cancelled: false, run: async () => undefined }
      item.timer = setTimeout(() => { item.cancelled = true; bucket.metrics.timedOut += 1; reject(new ModelThrottleTimeoutError()) }, config.queueWaitTimeoutMs)
      const onAbort = () => { item.cancelled = true; bucket.metrics.cancelled += 1; clearTimeout(item.timer); reject(new ModelThrottleCancelledError()) }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener("abort", onAbort, { once: true })
      bucket.queue.push(item as QueueItem<unknown>)
      this.drain(bucket)
    })
  }

  private release(bucket: Bucket) { bucket.active = Math.max(0, bucket.active - 1); this.drain(bucket) }

  private drain(bucket: Bucket) {
    const config = this.configFor(bucket.metrics.key)
    this.prune(bucket)
    while (bucket.active < config.maxInFlight && bucket.starts.length < config.requestsPerMinute && bucket.queue.length) {
      const item = bucket.queue.shift()!
      if (item.cancelled || item.signal?.aborted) continue
      clearTimeout(item.timer)
      bucket.active += 1
      bucket.starts.push(this.now())
      this.recordAdmission(bucket)
      bucket.metrics.queueWaitMs.push(Math.max(0, this.now() - item.startedAt))
      bucket.metrics.peakInFlight = Math.max(bucket.metrics.peakInFlight, bucket.active)
      item.resolve(() => this.release(bucket))
    }
    if (bucket.queue.length && bucket.starts.length >= this.config.requestsPerMinute) {
      this.schedule(() => this.drain(bucket), Math.max(1, 60_000 - (this.now() - bucket.starts[0]!)))
    }
  }

  private prune(bucket: Bucket) {
    const cutoff = this.now() - 60_000
    bucket.starts = bucket.starts.filter((start) => start > cutoff)
    bucket.admissionHistory = bucket.admissionHistory.filter((start) => start > cutoff)
  }
  private recordAdmission(bucket: Bucket) {
    this.prune(bucket)
    const admittedAt = this.now()
    bucket.admissionHistory.push(admittedAt)
    bucket.metrics.admitted += 1
    bucket.metrics.maxRollingMinuteAdmissions = Math.max(bucket.metrics.maxRollingMinuteAdmissions, bucket.admissionHistory.length)
  }
  private configFor(key: ModelKey): ModelThrottleConfig {
    const override = this.config.budgets?.[key]
    return override ? { ...this.config, ...override, budgets: undefined } : this.config
  }
  private backoff(attempt: number, config: ModelThrottleConfig) { const capped = Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** attempt); return Math.round(capped * (1 - config.jitterRatio + this.random() * 2 * config.jitterRatio)) }
}

export function percentile(values: number[], percent: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)] ?? 0
}
