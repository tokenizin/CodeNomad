import type { ModelCapabilities } from "../../../ui/src/types/session"

export interface GoogleModelConfig {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  capabilities: ModelCapabilities
}

// Known Google/Gemini models with capabilities (as of 2026)
export const GOOGLE_MODELS: GoogleModelConfig[] = [
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash (video)",
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    inputCostPerToken: 0.075 / 1_000_000,
    outputCostPerToken: 0.3 / 1_000_000,
    capabilities: { tools: true, image: true, video: true, reasoning: true, audio: true, cloud: true },
  },
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro (video, deep reasoning)",
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    inputCostPerToken: 1.25 / 1_000_000,
    outputCostPerToken: 5 / 1_000_000,
    capabilities: { tools: true, image: true, video: true, reasoning: true, audio: true, cloud: true },
  },
  {
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite (video, cheap)",
    contextLength: 1_048_576,
    maxOutputTokens: 65_536,
    inputCostPerToken: 0.0375 / 1_000_000,
    outputCostPerToken: 0.15 / 1_000_000,
    capabilities: { tools: true, image: true, video: true, reasoning: true, audio: true, cloud: true },
  },
  // Legacy models
  {
    id: "gemini-1.5-pro",
    name: "Gemini 1.5 Pro",
    contextLength: 1_048_576,
    maxOutputTokens: 8192,
    inputCostPerToken: 1.25 / 1_000_000,
    outputCostPerToken: 5 / 1_000_000,
    capabilities: { tools: true, image: true, video: true, reasoning: false, audio: true, cloud: true },
  },
  {
    id: "gemini-1.5-flash",
    name: "Gemini 1.5 Flash",
    contextLength: 1_048_576,
    maxOutputTokens: 8192,
    inputCostPerToken: 0.075 / 1_000_000,
    outputCostPerToken: 0.3 / 1_000_000,
    capabilities: { tools: true, image: true, video: true, reasoning: false, audio: true, cloud: true },
  },
]

export function getGoogleModels(): GoogleModelConfig[] {
  return GOOGLE_MODELS
}

export function transformGoogleModels(models: GoogleModelConfig[]): Array<{
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
    providerId: "google",
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