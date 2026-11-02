import type { ModelCapabilities } from "../../../../ui/src/types/session"
import { getOllamaModelDetails, listLocalLlmModels } from "../../local-llm/service"

export interface OllamaModelConfig {
  id: string
  name: string
  providerId: string
  limit: { context: number; input: number; output: number }
  cost: { input: number; output: number }
  capabilities: ModelCapabilities
}

/**
 * Map Ollama's official `/api/show` capability tags to CodeNomad capabilities.
 * Ollama reports: completion, tools, insert, vision, embedding, thinking, audio.
 */
export function mapOllamaCapabilities(tags: string[], remote: boolean): ModelCapabilities {
  const has = (tag: string) => tags.includes(tag)
  return {
    tools: has("tools"),
    image: has("vision"),
    video: false,
    reasoning: has("thinking"),
    audio: has("audio"),
    cloud: remote,
  }
}

/**
 * Guess capabilities from the model name. Only used when Ollama doesn't
 * report capabilities (older Ollama versions, or /api/show failed).
 */
export function guessOllamaCapabilities(modelId: string, remote: boolean): ModelCapabilities {
  const id = modelId.toLowerCase()
  const embedding = id.includes("embed") || id.includes("minilm") || id.includes("reranker")
  return {
    tools: !embedding,
    image: /vision|[-.]vl\b|vl:|llava|moondream|minicpm-v|gemma[34]/.test(id),
    video: false,
    reasoning: /deepseek-r1|\br1\b|reasoning|think|qwq|qwen3/.test(id),
    audio: false,
    cloud: remote,
  }
}

export async function fetchOllamaModels(baseUrl?: string): Promise<OllamaModelConfig[]> {
  const response = await listLocalLlmModels(baseUrl)

  if (!response.available || response.models.length === 0) {
    return []
  }

  // Official per-model limits and capabilities come from POST /api/show
  // (see local-llm/service.ts). Never hardcode limits here: GET /api/tags has
  // no limits, so a constant would apply the same window to every model.
  return Promise.all(
    response.models.map(async (model) => {
      const details = await getOllamaModelDetails(model.id, baseUrl)
      return {
        id: model.id,
        name: model.name,
        providerId: "ollama",
        limit: {
          context: details.context,
          input: details.context,
          output: details.output,
        },
        cost: {
          input: 0,
          output: 0,
        },
        capabilities: details.capabilities
          ? mapOllamaCapabilities(details.capabilities, details.remote)
          : guessOllamaCapabilities(model.id, details.remote),
      }
    }),
  )
}
