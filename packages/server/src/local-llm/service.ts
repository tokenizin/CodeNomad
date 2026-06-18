import type { LocalLlmModelsResponse } from "../api-types"

export const LOCAL_LLM_PROVIDER_ID = "ollama"
export const DEFAULT_LOCAL_LLM_HOST = process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434"
export const DEFAULT_LOCAL_LLM_MODEL = process.env.OLLAMA_MODEL?.trim() || "gemma4:latest"

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
