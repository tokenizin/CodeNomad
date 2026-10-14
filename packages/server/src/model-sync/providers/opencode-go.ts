import type { ModelCapabilities } from "../../../ui/src/types/session"

export interface OpenCodeGoModelConfig {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  capabilities: ModelCapabilities
}

// Known OpenCode Go models
export const OPENCODE_GO_MODELS: OpenCodeGoModelConfig[] = [
  {
    id: "mimo-v2.5",
    name: "MiMo V2.5",
    contextLength: 128_000,
    maxOutputTokens: 8192,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "mimo-v2.5-pro",
    name: "MiMo V2.5 Pro",
    contextLength: 128_000,
    maxOutputTokens: 8192,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    contextLength: 200_000,
    maxOutputTokens: 8192,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "qwen3.7-plus",
    name: "Qwen 3.7 Plus",
    contextLength: 256_000,
    maxOutputTokens: 8192,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    contextLength: 200_000,
    maxOutputTokens: 8192,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: true, audio: false, cloud: true },
  },
]

export function getOpenCodeGoModels(): OpenCodeGoModelConfig[] {
  return OPENCODE_GO_MODELS
}

export function transformOpenCodeGoModels(models: OpenCodeGoModelConfig[]): Array<{
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
    providerId: "opencode-go",
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