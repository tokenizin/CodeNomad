import type { ModelStatus } from "../../../ui/src/types/session"

export interface ModelTestResult {
  providerId: string
  modelId: string
  status: ModelStatus
  latencyMs: number
  errorDetails?: string
  testedAt: number
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
  const { providerId, modelId, apiKey, timeoutMs = DEFAULT_TIMEOUT } = options
  const startTime = Date.now()
  
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey || "",
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

async function testModelViaOllama(options: TestModelOptions): Promise<ModelTestResult> {
  const { providerId, modelId, baseUrl = "http://localhost:11434", timeoutMs = DEFAULT_TIMEOUT } = options
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
      const { status, details } = classifyError(new Error(errorMessage))
      return {
        providerId,
        modelId,
        status,
        latencyMs,
        errorDetails: details,
        testedAt: Date.now(),
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

// Env vars checked (in order) when the caller doesn't pass an API key.
// The UI never sends keys, so without this every cloud provider fails auth.
const PROVIDER_KEY_ENV: Record<string, string[]> = {
  openrouter: ["OPENROUTER_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  nvidia: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
  nous: ["NOUS_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"],
}

function resolveApiKey(providerId: string, apiKey?: string): string | undefined {
  if (apiKey) return apiKey
  for (const name of PROVIDER_KEY_ENV[providerId] ?? []) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
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
      case "mlx-deepseek":
        // All OpenAI-compatible APIs
        result = await testModelViaOpenAICompatible({
          ...options,
          baseUrl: options.baseUrl || getBaseUrlForProvider(providerId),
        })
        break
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
      return "https://opencode.ai/zen/go"
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

// Batch test multiple models with concurrency control
export async function testModelsBatch(
  options: TestModelOptions[],
  concurrency = 3
): Promise<ModelTestResult[]> {
  const results: ModelTestResult[] = []
  const queue = [...options]
  
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const option = queue.shift()
      if (!option) break
      const result = await testModel(option)
      results.push(result)
    }
  }
  
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker())
  await Promise.all(workers)
  
  return results
}