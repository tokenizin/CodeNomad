import {
  getCatalogProviderModels,
  probeOpenAICompatibleModels,
  transformCatalogModels,
  type CatalogModel,
  type LiveProbeResult,
  type TransformedCatalogModel,
} from "./catalog"

/**
 * Groq — 14 catalog models.
 *
 * Live-fetch provider: `GET /openai/v1/models` (Bearer `GROQ_API_KEY`).
 * The endpoint returns ids only, so the catalog supplies limits, cost and
 * capabilities; the live call is an availability probe whose failure is
 * reported instead of thrown (an invalid/expired key must not kill the sync).
 */

export type GroqModelConfig = CatalogModel

export const GROQ_PROVIDER_ID = "groq"
export const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models"

export function getGroqModels(): GroqModelConfig[] {
  return getCatalogProviderModels(GROQ_PROVIDER_ID)
}

export function transformGroqModels(models: GroqModelConfig[]): TransformedCatalogModel[] {
  return transformCatalogModels(GROQ_PROVIDER_ID, models)
}

export function probeGroqModels(apiKey = process.env.GROQ_API_KEY): Promise<LiveProbeResult> {
  return probeOpenAICompatibleModels({ url: GROQ_MODELS_URL, apiKey, label: "Groq" })
}
