import type { ModelCapabilities } from "../../../ui/src/types/session"
import { listLocalLlmModels } from "../../local-llm/service"

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
  
  return response.models.map((model) => ({
    id: model.id,
    name: model.name,
    providerId: "ollama",
    limit: {
      context: 32768, // Default, would need model-specific detection
      input: 32768,
      output: 8192,
    },
    cost: {
      input: 0,
      output: 0,
    },
    capabilities: detectOllamaCapabilities(model.id),
  }))
}