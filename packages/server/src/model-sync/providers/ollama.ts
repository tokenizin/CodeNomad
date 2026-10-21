import type { ModelCapabilities } from "../../../../ui/src/types/session"
import { getOllamaModelLimits, listLocalLlmModels } from "../../local-llm/service"

export interface OllamaModelConfig {
  id: string
  name: string
  providerId: string
  limit: { context: number; input: number; output: number }
  cost: { input: number; output: number }
  capabilities: ModelCapabilities
}

function detectOllamaCapabilities(modelId: string): ModelCapabilities {
  const id = modelId.toLowerCase()
  
  // Most Ollama models support tools
  const tools = true
  
  // Vision models
  const image = id.includes("vision") || 
                id.includes("vl") || 
                id.includes("llava") || 
                id.includes("bakllava") ||
                id.includes("moondream") ||
                id.includes("minicpm-v")
  
  // Video - rare in Ollama
  const video = false
  
  // Reasoning models
  const reasoning = id.includes("r1") || 
                    id.includes("reasoning") || 
                    id.includes("think") ||
                    id.includes("deepseek-r1") ||
                    id.includes("qwq")
  
  // Audio - rare in Ollama
  const audio = false
  
  // Local = not cloud
  const cloud = false
  
  return { tools, image, video, reasoning, audio, cloud }
}

export async function fetchOllamaModels(baseUrl?: string): Promise<OllamaModelConfig[]> {
  const response = await listLocalLlmModels(baseUrl)
  
  if (!response.available || response.models.length === 0) {
    return []
  }
  
  // Resolve the official per-model limits via POST /api/show (see local-llm/service.ts).
  // input mirrors context; output is the model's advertised max output (fallback 256K).
  return Promise.all(
    response.models.map(async (model) => {
      const { context, output } = await getOllamaModelLimits(model.id, baseUrl)
      return {
        id: model.id,
        name: model.name,
        providerId: "ollama",
        limit: {
          context,
          input: context,
          output,
        },
        cost: {
          input: 0,
          output: 0,
        },
        capabilities: detectOllamaCapabilities(model.id),
      }
    }),
  )
}