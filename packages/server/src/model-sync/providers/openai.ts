import type { ModelCapabilities } from "../../../ui/src/types/session"

export interface OpenAIModelConfig {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  capabilities: ModelCapabilities
}

// Known OpenAI models with capabilities (as of 2026)
export const OPENAI_MODELS: OpenAIModelConfig[] = [
  {
    id: "gpt-5",
    name: "GPT-5",
    contextLength: 400_000,
    maxOutputTokens: 128_000,
    inputCostPerToken: 5 / 1_000_000,
    outputCostPerToken: 20 / 1_000_000,
    capabilities: { tools: true, image: true, video: false, reasoning: true, audio: true, cloud: true },
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    contextLength: 400_000,
    maxOutputTokens: 128_000,
    inputCostPerToken: 0.25 / 1_000_000,
    outputCostPerToken: 2 / 1_000_000,
    capabilities: { tools: true, image: true, video: false, reasoning: true, audio: true, cloud: true },
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    contextLength: 128_000,
    maxOutputTokens: 16_384,
    inputCostPerToken: 2.5 / 1_000_000,
    outputCostPerToken: 10 / 1_000_000,
    capabilities: { tools: true, image: true, video: true, reasoning: true, audio: true, cloud: true },
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    contextLength: 128_000,
    maxOutputTokens: 16_384,
    inputCostPerToken: 0.15 / 1_000_000,
    outputCostPerToken: 0.6 / 1_000_000,
    capabilities: { tools: true, image: true, video: false, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "o3-mini",
    name: "o3 Mini (Reasoning)",
    contextLength: 200_000,
    maxOutputTokens: 100_000,
    inputCostPerToken: 1.1 / 1_000_000,
    outputCostPerToken: 4.4 / 1_000_000,
    capabilities: { tools: true, image: false, video: false, reasoning: true, audio: false, cloud: true },
  },
  // Legacy
  {
    id: "gpt-4-turbo",
    name: "GPT-4 Turbo",
    contextLength: 128_000,
    maxOutputTokens: 4096,
    inputCostPerToken: 10 / 1_000_000,
    outputCostPerToken: 30 / 1_000_000,
    capabilities: { tools: true, image: true, video: false, reasoning: false, audio: false, cloud: true },
  },
]

export function getOpenAIModels(): OpenAIModelConfig[] {
  return OPENAI_MODELS
}

export function transformOpenAIModels(models: OpenAIModelConfig[]): Array<{
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
    providerId: "openai",
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