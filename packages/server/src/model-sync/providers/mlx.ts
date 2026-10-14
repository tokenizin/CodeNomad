import type { ModelCapabilities } from "../../../ui/src/types/session"

export interface MLXModelConfig {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  capabilities: ModelCapabilities
}

// Known MLX models (local)
export const MLX_MODELS: MLXModelConfig[] = [
  {
    id: "mlx-community/Llama-3_3-Nemotron-Super-49B-v1-mlx-4bit",
    name: "Nemotron Super 49B (4-bit MLX)",
    contextLength: 131_072,
    maxOutputTokens: 8192,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: true, audio: false, cloud: false },
  },
]

export function getMLXModels(): MLXModelConfig[] {
  return MLX_MODELS
}

export function transformMLXModels(models: MLXModelConfig[]): Array<{
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
    providerId: "mlx",
    limit: {
      context: model.contextLength,
      input: model.contextLength,
      output: model.maxOutputTokens,
    },
    cost: {
      input: model.inputCostPerToken,
      output: model.outputCostPerToken,
    },
    capabilities: model.capabilities,
  }))
}