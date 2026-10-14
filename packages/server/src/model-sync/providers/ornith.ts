import type { ModelCapabilities } from "../../../../ui/src/types/session"

export interface OrnithModelConfig {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  capabilities: ModelCapabilities
}

// Known Ornith models
export const ORNITH_MODELS: OrnithModelConfig[] = [
  {
    id: "ornith",
    name: "Ornith 1.0",
    contextLength: 262_144,
    maxOutputTokens: 4096,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: true, video: false, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "ornith:latest",
    name: "Ornith 1.0 (latest)",
    contextLength: 262_144,
    maxOutputTokens: 4096,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: true, video: false, reasoning: true, audio: false, cloud: true },
  },
]

export function getOrnithModels(): OrnithModelConfig[] {
  return ORNITH_MODELS
}

export function transformOrnithModels(models: OrnithModelConfig[]): Array<{
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
    providerId: "ornith",
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