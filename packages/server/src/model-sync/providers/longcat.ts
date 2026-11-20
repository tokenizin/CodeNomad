import {
  getCatalogProviderModels,
  transformCatalogModels,
  type CatalogModel,
  type TransformedCatalogModel,
} from "./catalog"

/**
 * LongCat — 2 catalog models (LongCat-2.0, LongCat-2.5-Preview).
 *
 * Static: `LONGCAT_API_KEY` is not configured on this host (the key lives in
 * `~/.local/share/opencode/auth.json`), so a live fetch cannot be verified.
 */

export type LongCatModelConfig = CatalogModel

export const LONGCAT_PROVIDER_ID = "longcat"

export function getLongCatModels(): LongCatModelConfig[] {
  return getCatalogProviderModels(LONGCAT_PROVIDER_ID)
}

export function transformLongCatModels(models: LongCatModelConfig[]): TransformedCatalogModel[] {
  return transformCatalogModels(LONGCAT_PROVIDER_ID, models)
}
