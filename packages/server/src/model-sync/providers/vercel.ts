import {
  getCatalogProviderModels,
  probeOpenAICompatibleModels,
  transformCatalogModels,
  type CatalogModel,
  type LiveProbeResult,
  type TransformedCatalogModel,
} from "./catalog"

/**
 * Vercel AI Gateway — 417 catalog models.
 *
 * Live-fetch provider: `GET https://ai-gateway.vercel.sh/v1/models`
 * (Bearer `AI_GATEWAY_API_KEY`). The endpoint returns ids only, so the catalog
 * supplies limits, cost and capabilities; the live call is an availability
 * probe whose failure is reported instead of thrown.
 *
 * Deliberately not a static array: 417 entries would be ~2500 lines and breach
 * the CodeNomad ~800-line file guideline.
 */

export type VercelModelConfig = CatalogModel

export const VERCEL_PROVIDER_ID = "vercel"
export const VERCEL_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models"

export function getVercelModels(): VercelModelConfig[] {
  return getCatalogProviderModels(VERCEL_PROVIDER_ID)
}

export function transformVercelModels(models: VercelModelConfig[]): TransformedCatalogModel[] {
  return transformCatalogModels(VERCEL_PROVIDER_ID, models)
}

export function probeVercelModels(apiKey = process.env.AI_GATEWAY_API_KEY): Promise<LiveProbeResult> {
  return probeOpenAICompatibleModels({ url: VERCEL_MODELS_URL, apiKey, label: "Vercel AI Gateway" })
}
