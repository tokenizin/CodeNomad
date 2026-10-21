import type { LocalLlmModelsResponse } from "../api-types"

export const LOCAL_LLM_PROVIDER_ID = "ollama"
export const DEFAULT_LOCAL_LLM_HOST = process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434"
export const DEFAULT_LOCAL_LLM_MODEL = process.env.OLLAMA_MODEL?.trim() || "hermes3:latest"

interface OllamaTagsResponse {
  models?: Array<{
    name?: string
    model?: string
  }>
}

function normalizeHost(baseUrl?: string): string {
  const raw = baseUrl?.trim() || DEFAULT_LOCAL_LLM_HOST
  return raw.replace(/\/+$/, "")
}

export async function isLocalLlmReachable(baseUrl?: string): Promise<boolean> {
  const host = normalizeHost(baseUrl)
  try {
    const response = await fetch(`${host}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function listLocalLlmModels(baseUrl?: string): Promise<LocalLlmModelsResponse> {
  const host = normalizeHost(baseUrl)

  try {
    const response = await fetch(`${host}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    })

    if (!response.ok) {
      return {
        available: false,
        providerId: LOCAL_LLM_PROVIDER_ID,
        providerName: "Ollama (local)",
        defaultModelId: DEFAULT_LOCAL_LLM_MODEL,
        models: [],
        host,
      }
    }

    const payload = (await response.json()) as OllamaTagsResponse
    const models = (payload.models ?? [])
      .map((entry) => {
        const id = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.model?.trim()
        if (!id) return null
        return { id, name: id }
      })
      .filter((entry): entry is { id: string; name: string } => Boolean(entry))

    const uniqueModels = Array.from(new Map(models.map((model) => [model.id, model])).values()).sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    )

    const defaultModelId =
      uniqueModels.find((model) => model.id === DEFAULT_LOCAL_LLM_MODEL)?.id ??
      uniqueModels[0]?.id ??
      DEFAULT_LOCAL_LLM_MODEL

    return {
      available: uniqueModels.length > 0,
      providerId: LOCAL_LLM_PROVIDER_ID,
      providerName: "Ollama (local)",
      defaultModelId,
      models: uniqueModels,
      host,
    }
  } catch {
    return {
      available: false,
      providerId: LOCAL_LLM_PROVIDER_ID,
      providerName: "Ollama (local)",
      defaultModelId: DEFAULT_LOCAL_LLM_MODEL,
      models: [],
      host,
    }
  }
}

// ─── Per-model official limits (POST /api/show) ─────────────────────────────
//
// GET /api/tags only returns model names. The official per-model context window
// and max output live in POST /api/show under `model_info` (keyed by
// architecture, e.g. `qwen3.context_length`) and `parameters` (e.g. `num_predict`).
// We fall back to the Ollama maximum (256K) when the metadata is absent or the
// request fails, so a missing value never silently shrinks a model's window.

/** Fallback context/output limit — the Ollama maximum (256K). */
export const DEFAULT_OLLAMA_CONTEXT_LIMIT = 262144

export interface OllamaModelLimits {
  context: number
  output: number
}

/**
 * Extract the official context window from an Ollama `/api/show` `model_info`
 * object. Matches any architecture-prefixed key ending in `.context_length`
 * (which also covers `general.context_length`). Returns null when absent.
 */
export function extractOllamaContextLength(
  modelInfo: Record<string, unknown> | undefined | null,
): number | null {
  if (!modelInfo || typeof modelInfo !== "object") return null

  for (const [key, raw] of Object.entries(modelInfo)) {
    if (!key.endsWith(".context_length")) continue
    const value = typeof raw === "number" ? raw : Number(raw)
    if (Number.isFinite(value) && value > 0) return value
  }

  return null
}

/**
 * Extract the advertised max output (`num_predict`) from an Ollama `parameters`
 * string. Returns null when the directive is absent.
 */
export function extractOllamaMaxOutput(parameters: string | undefined | null): number | null {
  if (!parameters || typeof parameters !== "string") return null

  for (const line of parameters.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [directive, value] = trimmed.split(/\s+/)
    if (directive !== "num_predict") continue
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }

  return null
}

interface OllamaShowResponse {
  model_info?: Record<string, unknown>
  parameters?: string
}

/**
 * Resolve the official context window and max output for one Ollama model via
 * `POST /api/show`. Falls back to the Ollama maximum (256K) for both when the
 * model does not advertise them or `/api/show` is unreachable.
 */
export async function getOllamaModelLimits(
  modelId: string,
  baseUrl?: string,
): Promise<OllamaModelLimits> {
  const host = normalizeHost(baseUrl)
  const fallback: OllamaModelLimits = {
    context: DEFAULT_OLLAMA_CONTEXT_LIMIT,
    output: DEFAULT_OLLAMA_CONTEXT_LIMIT,
  }

  try {
    const response = await fetch(`${host}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(5_000),
    })

    if (!response.ok) return fallback

    const payload = (await response.json()) as OllamaShowResponse
    const context = extractOllamaContextLength(payload.model_info) ?? DEFAULT_OLLAMA_CONTEXT_LIMIT
    const output = extractOllamaMaxOutput(payload.parameters) ?? DEFAULT_OLLAMA_CONTEXT_LIMIT
    return { context, output }
  } catch {
    return fallback
  }
}
