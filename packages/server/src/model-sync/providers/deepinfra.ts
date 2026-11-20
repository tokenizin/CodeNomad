import {
  getCatalogProviderModels,
  probeOpenAICompatibleModels,
  transformCatalogModels,
  type CatalogModel,
  type LiveProbeResult,
  type TransformedCatalogModel,
} from "./catalog"

/**
 * DeepInfra — 80 catalog models.
 *
 * Live-fetch provider: `GET /v1/openai/models` (Bearer `DEEPINFRA_API_KEY`).
 * The endpoint returns ids only, so the catalog supplies limits, cost and
 * capabilities; the live call is an availability probe whose failure is
 * reported instead of thrown.
 */

export type DeepInfraModelConfig = CatalogModel

export const DEEPINFRA_PROVIDER_ID = "deepinfra"
export const DEEPINFRA_MODELS_URL = "https://api.deepinfra.com/v1/openai/models"

export function getDeepInfraModels(): DeepInfraModelConfig[] {
  return getCatalogProviderModels(DEEPINFRA_PROVIDER_ID)
}

export function transformDeepInfraModels(models: DeepInfraModelConfig[]): TransformedCatalogModel[] {
  return transformCatalogModels(DEEPINFRA_PROVIDER_ID, models)
}

export function probeDeepInfraModels(apiKey = process.env.DEEPINFRA_API_KEY): Promise<LiveProbeResult> {
  return probeOpenAICompatibleModels({ url: DEEPINFRA_MODELS_URL, apiKey, label: "DeepInfra" })
}
