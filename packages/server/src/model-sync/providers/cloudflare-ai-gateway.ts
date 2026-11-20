import {
  getCatalogProviderModels,
  transformCatalogModels,
  type CatalogModel,
  type TransformedCatalogModel,
} from "./catalog"

/**
 * Cloudflare AI Gateway — 83 catalog models.
 *
 * Static: the gateway has no single OpenAI-compatible `/models` endpoint (each
 * upstream provider lives under its own `/{provider}` path), so the catalog is
 * the model list.
 */

export type CloudflareAIGatewayModelConfig = CatalogModel

export const CLOUDFLARE_AI_GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway"

export function getCloudflareAIGatewayModels(): CloudflareAIGatewayModelConfig[] {
  return getCatalogProviderModels(CLOUDFLARE_AI_GATEWAY_PROVIDER_ID)
}

export function transformCloudflareAIGatewayModels(
  models: CloudflareAIGatewayModelConfig[],
): TransformedCatalogModel[] {
  return transformCatalogModels(CLOUDFLARE_AI_GATEWAY_PROVIDER_ID, models)
}
