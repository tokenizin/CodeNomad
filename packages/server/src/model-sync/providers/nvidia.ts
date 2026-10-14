import type { ModelCapabilities } from "../../../ui/src/types/session"

export interface NvidiaModelConfig {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  capabilities: ModelCapabilities
}

// Known NVIDIA NIM models with capabilities (as of 2026)
export const NVIDIA_MODELS: NvidiaModelConfig[] = [
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM-5.3-Flash (z.ai · NVIDIA NIM)",
    contextLength: 262_144,
    maxOutputTokens: 65_536,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    name: "Nemotron 3 Nano Omni (video+audio, 256k)",
    contextLength: 262_144,
    maxOutputTokens: 131_072,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: true, video: true, reasoning: true, audio: true, cloud: true },
  },
  {
    id: "minimaxai/minimax-m3",
    name: "MiniMax M3 (video, 1M context)",
    contextLength: 1_000_000,
    maxOutputTokens: 131_072,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: true, video: true, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "nvidia/cosmos-reason2-8b",
    name: "Cosmos Reason 2 8B (video reasoning)",
    contextLength: 131_072,
    maxOutputTokens: 16_384,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: true, video: true, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "nvidia/nemotron-nano-12b-v2-vl",
    name: "Nemotron Nano 12B VL (video)",
    contextLength: 128_000,
    maxOutputTokens: 16_384,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: true, video: true, reasoning: true, audio: false, cloud: true },
  },
]

export function getNvidiaModels(): NvidiaModelConfig[] {
  return NVIDIA_MODELS
}

export function transformNvidiaModels(models: NvidiaModelConfig[]): Array<{
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
    providerId: "nvidia",
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