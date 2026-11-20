import {
  getCatalogProviderModels,
  transformCatalogModels,
  type CatalogModel,
  type TransformedCatalogModel,
} from "./catalog"

/**
 * Cloudflare Workers AI — 30 catalog models.
 *
 * Static: the OpenAI-compatible endpoint needs `CLOUDFLARE_API_KEY`, which is
 * not configured on this host, so a live fetch cannot be verified. The catalog
 * (which OpenCode loads) supplies the model list instead.
 */

export type CloudflareWorkersAIModelConfig = CatalogModel

export const CLOUDFLARE_WORKERS_AI_PROVIDER_ID = "cloudflare-workers-ai"

export function getCloudflareWorkersAIModels(): CloudflareWorkersAIModelConfig[] {
  return getCatalogProviderModels(CLOUDFLARE_WORKERS_AI_PROVIDER_ID)
}

export function transformCloudflareWorkersAIModels(
  models: CloudflareWorkersAIModelConfig[],
): TransformedCatalogModel[] {
  return transformCatalogModels(CLOUDFLARE_WORKERS_AI_PROVIDER_ID, models)
}
