import type { ModelCapabilities } from "../../../../ui/src/types/session"

export interface OpenRouterFallbackModelConfig {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  capabilities: ModelCapabilities
}

// OpenRouter fallback / shim models
export const OPENROUTER_FALLBACK_MODELS: OpenRouterFallbackModelConfig[] = [
  {
    id: "auto",
    name: "GLM-5.3-Flash (NIM) with automatic Qwen 3.6 / Zen fallback",
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: true, audio: false, cloud: true },
  },
]

export function getOpenRouterFallbackModels(): OpenRouterFallbackModelConfig[] {
  return OPENROUTER_FALLBACK_MODELS
}

export function transformOpenRouterFallbackModels(models: OpenRouterFallbackModelConfig[]): Array<{
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
    providerId: "openrouter-fallback",
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