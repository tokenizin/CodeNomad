import type { ModelCapabilities } from "../../../../ui/src/types/session"

export interface OpenRouterModel {
  id: string
  name: string
  description: string
  context_length: number
  pricing: {
    prompt: string
    completion: string
  }
  architecture: {
    modality: string
    tokenizer: string
    instruct_type?: string
  }
  top_provider?: {
    max_completion_tokens: number
    is_moderated: boolean
  }
  per_request_limits?: unknown
}

export interface OpenRouterModelsResponse {
  data: OpenRouterModel[]
}

function detectCapabilities(model: OpenRouterModel): ModelCapabilities {
  const modality = model.architecture?.modality?.toLowerCase() || ""
  const id = model.id.toLowerCase()
  const name = model.name.toLowerCase()

  // Tool calling - most modern models support it
  const tools = true

  // Image/vision - check modality and name
  const image = modality.includes("image") || 
                modality.includes("vision") || 
                modality.includes("multimodal") ||
                id.includes("vision") || 
                id.includes("vl") ||
                id.includes("omni") ||
                name.includes("vision")

  // Video - specific models
  const video = id.includes("video") || 
                id.includes("vl") && (id.includes("nemotron") || id.includes("gemini")) ||
                name.includes("video")

  // Reasoning - check for reasoning models
  const reasoning = id.includes("reasoning") || 
                    id.includes("o1") || 
                    id.includes("o3") || 
                    id.includes("r1") ||
                    id.includes("thinking") ||
                    name.includes("reasoning") ||
                    name.includes("thinking")

  // Audio - check for audio models
  const audio = modality.includes("audio") || 
                id.includes("audio") || 
                id.includes("omni") ||
                name.includes("audio")

  // Cloud - OpenRouter is always cloud
  const cloud = true

  return { tools, image, video, reasoning, audio, cloud }
}

export async function fetchOpenRouterModels(apiKey?: string): Promise<OpenRouterModel[]> {
  const url = "https://openrouter.ai/api/v1/models"
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`
  }

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`)
    }
    const data = (await response.json()) as OpenRouterModelsResponse
    return data.data
  } catch (error) {
    throw new Error(`Failed to fetch OpenRouter models: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function transformOpenRouterModels(models: OpenRouterModel[]): Array<{
  id: string
  name: string
  providerId: string
  limit: { context: number; input: number; output: number }
  cost: { input: number; output: number }
  capabilities: ModelCapabilities
}> {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    providerId: "openrouter",
    limit: {
      context: model.context_length,
      input: model.context_length,
      output: model.top_provider?.max_completion_tokens || model.context_length,
    },
    cost: {
      input: parseFloat(model.pricing?.prompt || "0"),
      output: parseFloat(model.pricing?.completion || "0"),
    },
    capabilities: detectCapabilities(model),
  }))
}