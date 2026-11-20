import {
  getCatalogProviderModels,
  probeOpenAICompatibleModels,
  transformCatalogModels,
  type CatalogModel,
  type LiveProbeResult,
  type TransformedCatalogModel,
} from "./catalog"

/**
 * xAI (Grok) — 11 catalog models.
 *
 * Live-fetch provider: `GET /v1/models` (Bearer `XAI_API_KEY`).
 * The endpoint returns ids only, so the catalog supplies limits, cost and
 * capabilities; the live call is an availability probe whose failure is
 * reported instead of thrown (a team out of credits must not kill the sync).
 */

export type XaiModelConfig = CatalogModel

export const XAI_PROVIDER_ID = "xai"
export const XAI_MODELS_URL = "https://api.x.ai/v1/models"

export function getXaiModels(): XaiModelConfig[] {
  return getCatalogProviderModels(XAI_PROVIDER_ID)
}

export function transformXaiModels(models: XaiModelConfig[]): TransformedCatalogModel[] {
  return transformCatalogModels(XAI_PROVIDER_ID, models)
}

export function probeXaiModels(apiKey = process.env.XAI_API_KEY): Promise<LiveProbeResult> {
  return probeOpenAICompatibleModels({ url: XAI_MODELS_URL, apiKey, label: "xAI" })
}
