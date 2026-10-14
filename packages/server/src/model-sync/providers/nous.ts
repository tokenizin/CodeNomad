import type { ModelCapabilities } from "../../../../ui/src/types/session"

export interface NousModelConfig {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  capabilities: ModelCapabilities
}

// Known Nous Research models (free tier)
export const NOUS_MODELS: NousModelConfig[] = [
  {
    id: "meituan/longcat-2.0:free",
    name: "LongCat 2.0 (free)",
    contextLength: 1_048_576,
    maxOutputTokens: 131_072,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: true },
  },
  {
    id: "tencent/hy3:free",
    name: "Hy3 (free)",
    contextLength: 262_144,
    maxOutputTokens: 128_000,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: true, video: false, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "stepfun/step-3.7-flash:free",
    name: "Step 3.7 Flash (free)",
    contextLength: 262_144,
    maxOutputTokens: 230_400,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: true, video: false, reasoning: true, audio: false, cloud: true },
  },
  {
    id: "upstage/solar-pro4:free",
    name: "Solar Pro 4 (free)",
    contextLength: 524_288,
    maxOutputTokens: 131_072,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: true },
  },
  {
    id: "poolside/laguna-s-2.1:free",
    name: "Laguna S 2.1 (free)",
    contextLength: 262_144,
    maxOutputTokens: 131_072,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: true },
  },
  {
    id: "poolside/laguna-xs-2.1:free",
    name: "Laguna XS 2.1 (free)",
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    inputCostPerToken: 0,
    outputCostPerToken: 0,
    capabilities: { tools: true, image: false, video: false, reasoning: false, audio: false, cloud: true },
  },
]

export function getNousModels(): NousModelConfig[] {
  return NOUS_MODELS
}

export function transformNousModels(models: NousModelConfig[]): Array<{
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
    providerId: "nous",
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