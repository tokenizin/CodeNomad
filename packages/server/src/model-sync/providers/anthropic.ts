import type { ModelCapabilities } from "../../../../ui/src/types/session"

export interface AnthropicModelConfig {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  capabilities: ModelCapabilities
}

// Known Anthropic models with capabilities (as of 2026)
export const ANTHROPIC_MODELS: AnthropicModelConfig[] = [
  {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    contextLength: 1_000_000,
    maxOutputTokens: 64_000,
    inputCostPerToken: 3 / 1_000_000,
    outputCostPerToken: 15 / 1_000_000,
    capabilities: { tools: true, image: true, video: false, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    contextLength: 200_000,
    maxOutputTokens: 64_000,
    inputCostPerToken: 0.25 / 1_000_000,
    outputCostPerToken: 1.25 / 1_000_000,
    capabilities: { tools: true, image: true, video: false, reasoning: false, audio: false, cloud: true },
  },
  // Legacy models for backward compatibility
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    contextLength: 200_000,
    maxOutputTokens: 8192,
    inputCostPerToken: 3 / 1_000_000,
    outputCostPerToken: 15 / 1_000_000,
    capabilities: { tools: true, image: true, video: false, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "claude-3-5-haiku-20241022",
    name: "Claude 3.5 Haiku",
    contextLength: 200_000,
    maxOutputTokens: 8192,
    inputCostPerToken: 0.8 / 1_000_000,
    outputCostPerToken: 4 / 1_000_000,
    capabilities: { tools: true, image: true, video: false, reasoning: false, audio: false, cloud: true },
  },
  {
    id: "claude-3-opus-20240229",
    name: "Claude 3 Opus",
    contextLength: 200_000,
    maxOutputTokens: 4096,
    inputCostPerToken: 15 / 1_000_000,
    outputCostPerToken: 75 / 1_000_000,
    capabilities: { tools: true, image: true, video: false, reasoning: true, audio: false, cloud: true },
  },
]

export function getAnthropicModels(): AnthropicModelConfig[] {
  return ANTHROPIC_MODELS
}

export function transformAnthropicModels(models: AnthropicModelConfig[]): Array<{
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
    providerId: "anthropic",
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