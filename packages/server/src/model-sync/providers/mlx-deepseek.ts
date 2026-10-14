import type { ModelCapabilities } from "../../../ui/src/types/session"

export interface MLXDeepSeekModelConfig {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  capabilities: ModelCapabilities
}

// Known MLX DeepSeek models (local)
export const MLX_DEEPSEEK_MODELS: MLXDeepSeekModelConfig[] = [
  {
    id: "DeepSeek-V4-Flash-0731-2.4bit-mixed:no-think",
    name: "DeepSeek V4 Flash 0731 (2.4-bit MLX)",
    contextLength: 1_048_576,
    maxOutputTokens: 8192,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: false, image: false, video: false, reasoning: false, audio: false, cloud: false },
  },
  {
    id: "/Users/Shared/models/mlx/DeepSeek-V4-Flash-0731-2.4bit-mixed:no-think",
    name: "DeepSeek V4 Flash 0731 (2.4-bit MLX)",
    contextLength: 1_048_576,
    maxOutputTokens: 8192,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: false, image: false, video: false, reasoning: false, audio: false, cloud: false },
  },
  {
    id: "DeepSeek-V4-Flash-0731-2.4bit-mixed:think",
    name: "DeepSeek V4 Flash 0731 (2.4-bit MLX · think — CoT dumps into chat)",
    contextLength: 1_048_576,
    maxOutputTokens: 2048,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: false, image: false, video: false, reasoning: true, audio: false, cloud: false },
  },
  {
    id: "/Users/Shared/models/mlx/DeepSeek-V4-Flash-0731-2.4bit-mixed:think",
    name: "DeepSeek V4 Flash 0731 (2.4-bit MLX · think — CoT dumps into chat)",
    contextLength: 1_048_576,
    maxOutputTokens: 2048,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: false, image: false, video: false, reasoning: true, audio: false, cloud: false },
  },
  {
    id: "DeepSeek-V4-Flash-0731-2.4bit-mixed:precise",
    name: "DeepSeek V4 Flash 0731 (2.4-bit MLX · precise — CoT dumps into chat)",
    contextLength: 1_048_576,
    maxOutputTokens: 2048,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: false, image: false, video: false, reasoning: true, audio: false, cloud: false },
  },
  {
    id: "/Users/Shared/models/mlx/DeepSeek-V4-Flash-0731-2.4bit-mixed:precise",
    name: "DeepSeek V4 Flash 0731 (2.4-bit MLX · precise — CoT dumps into chat)",
    contextLength: 1_048_576,
    maxOutputTokens: 2048,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: false, image: false, video: false, reasoning: true, audio: false, cloud: false },
  },
  {
    id: "DeepSeek-V4-Flash-0731-2.4bit-mixed:creative",
    name: "DeepSeek V4 Flash 0731 (2.4-bit MLX · creative — CoT dumps into chat)",
    contextLength: 1_048_576,
    maxOutputTokens: 2048,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: false, image: false, video: false, reasoning: true, audio: false, cloud: false },
  },
  {
    id: "/Users/Shared/models/mlx/DeepSeek-V4-Flash-0731-2.4bit-mixed:creative",
    name: "DeepSeek V4 Flash 0731 (2.4-bit MLX · creative — CoT dumps into chat)",
    contextLength: 1_048_576,
    maxOutputTokens: 2048,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: false, image: false, video: false, reasoning: true, audio: false, cloud: false },
  },
]

export function getMLXDeepSeekModels(): MLXDeepSeekModelConfig[] {
  return MLX_DEEPSEEK_MODELS
}

export function transformMLXDeepSeekModels(models: MLXDeepSeekModelConfig[]): Array<{
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
    providerId: "mlx-deepseek",
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