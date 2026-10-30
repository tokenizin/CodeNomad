import type { ModelStatus } from "../../../ui/src/types/session"
import { readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { findOpencodeJson } from "./service"

export interface ModelTestResult {
  providerId: string
  modelId: string
  status: ModelStatus
  latencyMs: number
  errorDetails?: string
  testedAt: number
  /** Provider answered 404/410 for this model (not found / retired) */
  gone?: boolean
  /** Set by the server when a gone model was removed from the list */
  removed?: boolean
}

export interface TestModelOptions {
  providerId: string
  modelId: string
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
}

const TEST_PROMPT = "Say 'OK' if you can receive this message."
const DEFAULT_TIMEOUT = 15_000

function classifyError(error: unknown): { status: ModelStatus; details: string } {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  
  // Insufficient funds / billing errors
  if (
    lower.includes("insufficient") ||
    lower.includes("billing") ||
    lower.includes("quota exceeded") ||
    lower.includes("credit") ||
    lower.includes("balance") ||
    lower.includes("payment") ||
    lower.includes("402") ||
    lower.includes("insufficient_funds")
  ) {
    return { status: "insufficient_funds", details: message }
  }
  
  // Rate limited
  if (
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("throttle")
  ) {
    return { status: "error", details: `Rate limited: ${message}` }
  }
  
  // Model retired by the provider
  if (lower.includes("410") || lower.includes("gone")) {
    return { status: "error", details: `Model retired: ${message}` }
  }

  // Model not found
  if (
    lower.includes("not found") ||
    lower.includes("does not exist") ||
    lower.includes("404") ||
    lower.includes("model_not_found") ||
    lower.includes("invalid model")
  ) {
    return { status: "error", details: `Model not found: ${message}` }
  }
  
  // Auth errors
  if (
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("invalid key") ||
    lower.includes("authentication") ||
    lower.includes("api key")
  ) {
    return { status: "error", details: `Authentication error: ${message}` }
  }
  
  // Timeout
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("ETIMEDOUT")
  ) {
    return { status: "error", details: `Timeout: ${message}` }
  }
  
  // Server errors
  if (
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("server error") ||
    lower.includes("internal error")
  ) {
    return { status: "error", details: `Server error: ${message}` }
  }
  
  // Network errors
  if (
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed")
  ) {
    return { status: "error", details: `Network error: ${message}` }
  }
  
  // Unknown error
  return { status: "error", details: message }
}

async function testModelViaOpenAICompatible(options: TestModelOptions): Promise<ModelTestResult> {
  const { providerId, modelId, apiKey, baseUrl, timeoutMs = DEFAULT_TIMEOUT } = options
  const startTime = Date.now()
  
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: TEST_PROMPT }],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: controller.signal,
    })
    
    clearTimeout(timeoutId)
    const latencyMs = Date.now() - startTime
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`
      const { status, details } = classifyError(new Error(errorMessage))
      return {
        providerId,
        modelId,
        status,
        latencyMs,
        errorDetails: details,
        testedAt: Date.now(),
        gone: response.status === 404 || response.status === 410,
      }
    }
    
    // Success
    return {
      providerId,
      modelId,
      status: "available",
      latencyMs,
      testedAt: Date.now(),
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const { status, details } = classifyError(error)
    return {
      providerId,
      modelId,
      status,
      latencyMs,
      errorDetails: details,
      testedAt: Date.now(),
    }
  }
}

async function testModelViaAnthropic(options: TestModelOptions): Promise<ModelTestResult> {
  const { providerId, modelId, apiKey, baseUrl = "https://api.anthropic.com/v1", timeoutMs = DEFAULT_TIMEOUT } = options
  const startTime = Date.now()
  
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey || "",
        // OpenCode Go accepts bearer auth on /messages; Anthropic ignores it
        ...(apiKey && providerId !== "anthropic" ? { Authorization: `Bearer ${apiKey}` } : {}),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 10,
        messages: [{ role: "user", content: TEST_PROMPT }],
      }),
      signal: controller.signal,
    })
    
    clearTimeout(timeoutId)
    const latencyMs = Date.now() - startTime
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`
      const { status, details } = classifyError(new Error(errorMessage))
      return {
        providerId,
        modelId,
        status,
        latencyMs,
        errorDetails: details,
        testedAt: Date.now(),
        gone: response.status === 404 || response.status === 410,
      }
    }
    
    return {
      providerId,
      modelId,
      status: "available",
      latencyMs,
      testedAt: Date.now(),
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const { status, details } = classifyError(error)
    return {
      providerId,
      modelId,
      status,
      latencyMs,
      errorDetails: details,
      testedAt: Date.now(),
    }
  }
}

async function testModelViaGoogle(options: TestModelOptions): Promise<ModelTestResult> {
  const { providerId, modelId, apiKey, timeoutMs = DEFAULT_TIMEOUT } = options
  const startTime = Date.now()
  
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: TEST_PROMPT }] }],
        generationConfig: { maxOutputTokens: 10, temperature: 0 },
      }),
      signal: controller.signal,
    })
    
    clearTimeout(timeoutId)
    const latencyMs = Date.now() - startTime
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`
      const { status, details } = classifyError(new Error(errorMessage))
      return {
        providerId,
        modelId,
        status,
        latencyMs,
        errorDetails: details,
        testedAt: Date.now(),
        gone: response.status === 404 || response.status === 410,
      }
    }
    
    return {
      providerId,
      modelId,
      status: "available",
      latencyMs,
      testedAt: Date.now(),
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const { status, details } = classifyError(error)
    return {
      providerId,
      modelId,
      status,
      latencyMs,
      errorDetails: details,
      testedAt: Date.now(),
    }
  }
}

// Local models can take a long time to load from disk on first use
const OLLAMA_MIN_TIMEOUT = Number(process.env.OLLAMA_TEST_TIMEOUT_MS) || 60_000

async function testOllamaEmbedding(baseUrl: string, modelId: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, input: "test" }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

async function testModelViaOllama(options: TestModelOptions): Promise<ModelTestResult> {
  const { providerId, modelId, baseUrl = "http://localhost:11434" } = options
  const timeoutMs = Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT, OLLAMA_MIN_TIMEOUT)
  const startTime = Date.now()
  
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        prompt: TEST_PROMPT,
        stream: false,
        options: { num_predict: 10, temperature: 0 },
      }),
      signal: controller.signal,
    })
    
    clearTimeout(timeoutId)
    const latencyMs = Date.now() - startTime
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage = errorData.error || `HTTP ${response.status}: ${response.statusText}`
      // Embedding models can't generate text; check them with /api/embed instead
      if (String(errorMessage).includes("does not support generate")) {
        if (await testOllamaEmbedding(baseUrl, modelId, timeoutMs)) {
          return { providerId, modelId, status: "available", latencyMs: Date.now() - startTime, testedAt: Date.now() }
        }
      }
      const { status, details } = classifyError(new Error(errorMessage))
      return {
        providerId,
        modelId,
        status,
        latencyMs,
        errorDetails: details,
        testedAt: Date.now(),
        gone: response.status === 404 || response.status === 410,
      }
    }
    
    return {
      providerId,
      modelId,
      status: "available",
      latencyMs,
      testedAt: Date.now(),
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const { status, details } = classifyError(error)
    return {
      providerId,
      modelId,
      status,
      latencyMs,
      errorDetails: details,
      testedAt: Date.now(),
    }
  }
}

// Env vars checked (in order) after auth.json and opencode.json
const PROVIDER_KEY_ENV: Record<string, string[]> = {
  openrouter: ["OPENROUTER_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
  nous: ["NOUS_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"],
}

type ProviderSettings = { apiKey?: string; baseURL?: string }

let settingsCache: { stamp: string; byProvider: Map<string, ProviderSettings> } | null = null

function fileStamp(path: string | null): string {
  if (!path || !existsSync(path)) return "-"
  try {
    return `${path}:${statSync(path).mtimeMs}`
  } catch {
    return "-"
  }
}

function readJson(path: string | null): any {
  if (!path || !existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

/** "{env:NAME}" → process.env.NAME; plain strings returned as-is */
function expandEnvRef(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined
  const m = value.match(/^\{env:([A-Za-z0-9_]+)\}$/)
  return m ? process.env[m[1]] || undefined : value
}

/**
 * Per-provider API key and base URL from OpenCode's own files:
 *  - auth.json (where `opencode auth login` stores keys)
 *  - opencode.json provider.<id>.options.{apiKey, baseURL}
 * Re-read only when either file changes.
 */
function loadProviderSettings(): Map<string, ProviderSettings> {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const authPath = process.env.OPENCODE_AUTH_FILE || join(dataHome, "opencode", "auth.json")
  const configPath = findOpencodeJson()
  const stamp = `${fileStamp(authPath)}|${fileStamp(configPath)}`
  if (settingsCache && settingsCache.stamp === stamp) return settingsCache.byProvider

  const byProvider = new Map<string, ProviderSettings>()
  const auth = readJson(authPath) ?? {}
  for (const [id, entry] of Object.entries<any>(auth)) {
    // Only API-key logins; OAuth tokens need a different auth flow
    if (entry && typeof entry.key === "string") byProvider.set(id, { apiKey: entry.key })
  }
  const config = readJson(configPath) ?? {}
  for (const [id, provider] of Object.entries<any>(config.provider ?? {})) {
    const opts = provider?.options ?? {}
    const current = byProvider.get(id) ?? {}
    byProvider.set(id, {
      apiKey: current.apiKey ?? expandEnvRef(opts.apiKey),
      baseURL: typeof opts.baseURL === "string" ? opts.baseURL : undefined,
    })
  }
  settingsCache = { stamp, byProvider }
  return byProvider
}

function resolveApiKey(providerId: string, apiKey?: string): string | undefined {
  if (apiKey) return apiKey
  const fromFiles = loadProviderSettings().get(providerId)?.apiKey
  if (fromFiles) return fromFiles
  for (const name of PROVIDER_KEY_ENV[providerId] ?? []) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

function resolveBaseUrl(providerId: string, baseUrl?: string): string {
  let url = (baseUrl || loadProviderSettings().get(providerId)?.baseURL || getBaseUrlForProvider(providerId)).replace(/\/+$/, "")
  // OpenCode Go's API lives under /v1 (https://opencode.ai/zen/go/v1)
  if (providerId === "opencode-go" && !url.endsWith("/v1")) url += "/v1"
  return url
}

// OpenCode Go serves Qwen and MiniMax models only in Anthropic /messages format
function usesAnthropicFormat(providerId: string, modelId: string): boolean {
  return providerId === "opencode-go" && /^(qwen|minimax)/i.test(modelId)
}

export async function testModel(rawOptions: TestModelOptions): Promise<ModelTestResult> {
  const options: TestModelOptions = {
    ...rawOptions,
    apiKey: resolveApiKey(rawOptions.providerId, rawOptions.apiKey),
  }
  const { providerId } = options
  
  // Set testing status immediately
  const testingResult: ModelTestResult = {
    providerId,
    modelId: options.modelId,
    status: "testing",
    latencyMs: 0,
    testedAt: Date.now(),
  }
  
  try {
    let result: ModelTestResult
    
    switch (providerId) {
      case "openrouter":
      case "openai":
      case "nvidia":
      case "nous":
      case "opencode-go":
      case "openrouter-fallback":
      case "ornith":
      case "mlx":
      case "mlx-deepseek": {
        const baseUrl = resolveBaseUrl(providerId, options.baseUrl)
        result = usesAnthropicFormat(providerId, options.modelId)
          ? await testModelViaAnthropic({ ...options, baseUrl })
          : await testModelViaOpenAICompatible({ ...options, baseUrl })
        break
      }
      case "anthropic":
        result = await testModelViaAnthropic(options)
        break
      case "google":
        result = await testModelViaGoogle(options)
        break
      case "ollama":
        result = await testModelViaOllama(options)
        break
      default:
        throw new Error(`Unsupported provider for testing: ${providerId}`)
    }
    
    return result
  } catch (error) {
    return {
      providerId,
      modelId: options.modelId,
      status: "error",
      latencyMs: Date.now() - testingResult.testedAt,
      errorDetails: error instanceof Error ? error.message : String(error),
      testedAt: Date.now(),
    }
  }
}

function getBaseUrlForProvider(providerId: string): string {
  switch (providerId) {
    case "openrouter":
      return "https://openrouter.ai/api/v1"
    case "openai":
      return "https://api.openai.com/v1"
    case "nvidia":
      return "https://integrate.api.nvidia.com/v1"
    case "nous":
      return "https://inference-api.nousresearch.com/v1"
    case "opencode-go":
      return "https://opencode.ai/zen/go/v1"
    case "openrouter-fallback":
      return "http://127.0.0.1:11436/v1"
    case "ornith":
      return "http://127.0.0.1:11435/v1"
    case "mlx":
      return "http://127.0.0.1:8080/v1"
    case "mlx-deepseek":
      return "http://127.0.0.1:8082/v1"
    default:
      return "https://api.openai.com/v1"
  }
}

// Batch test multiple models with concurrency control.
// Ollama models run one at a time in their own lane: loading several local
// models at once makes them all time out.
export async function testModelsBatch(
  options: TestModelOptions[],
  concurrency = 3
): Promise<ModelTestResult[]> {
  const results: ModelTestResult[] = []
  const localQueue = options.filter((o) => o.providerId === "ollama")
  const remoteQueue = options.filter((o) => o.providerId !== "ollama")

  async function worker(queue: TestModelOptions[]): Promise<void> {
    while (queue.length > 0) {
      const option = queue.shift()
      if (!option) break
      results.push(await testModel(option))
    }
  }

  const workers = [
    ...Array.from({ length: Math.min(Math.max(1, concurrency), remoteQueue.length) }, () => worker(remoteQueue)),
    ...(localQueue.length > 0 ? [worker(localQueue)] : []),
  ]
  await Promise.all(workers)

  return results
}
