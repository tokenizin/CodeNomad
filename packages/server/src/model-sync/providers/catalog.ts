import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ModelCapabilities } from "../../../../ui/src/types/session"

/**
 * Shared helpers for the providers added in TASK-2026-11-20-001:
 * cloudflare-ai-gateway, cloudflare-workers-ai, deepinfra, groq, longcat,
 * vercel and xai.
 *
 * `~/.cache/opencode/models.json` is the models.dev catalog OpenCode itself
 * loads, so it is the authoritative source for model ids, limits, pricing and
 * capability flags. The providers' own `/models` endpoints only return ids, so
 * they are used as an availability probe (see `probeOpenAICompatibleModels`)
 * rather than as the model list — that keeps every synced model carrying real
 * limits, cost and capabilities.
 *
 * Set `CODENOMAD_MODELS_CATALOG` to point at a fixture instead of the machine
 * catalog (tests do this).
 */

/** One `models.<id>` entry exactly as stored in the catalog file (no `id`). */
export interface CatalogModelEntry {
  name?: string
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number }
  tool_call?: boolean
  reasoning?: boolean
  attachment?: boolean
  modalities?: { input?: string[]; output?: string[] }
  [key: string]: unknown
}

/** A catalog entry with its map key stamped on as `id`. */
export interface CatalogModel extends CatalogModelEntry {
  id: string
}

interface CatalogProvider {
  id?: string
  name?: string
  models?: Record<string, CatalogModelEntry>
}

export type CatalogFile = Record<string, CatalogProvider>

export function modelCatalogPath(): string {
  return process.env.CODENOMAD_MODELS_CATALOG || join(homedir(), ".cache", "opencode", "models.json")
}

let cachedPath: string | null = null
let cachedCatalog: CatalogFile = {}

/**
 * Load the models.dev catalog once per process. A missing or unreadable file
 * yields an empty catalog — providers then return no models, which the sync
 * surfaces as an error rather than an unhandled throw.
 */
export function loadModelCatalog(): CatalogFile {
  const path = modelCatalogPath()
  if (cachedPath === path) return cachedCatalog
  try {
    cachedCatalog = JSON.parse(readFileSync(path, "utf-8")) as CatalogFile
  } catch {
    cachedCatalog = {}
  }
  cachedPath = path
  return cachedCatalog
}

export function resetModelCatalogCache(): void {
  cachedPath = null
  cachedCatalog = {}
}

/** Every catalog entry for a provider, with `id` guaranteed to be set. */
export function getCatalogProviderModels(providerId: string): CatalogModel[] {
  const models = loadModelCatalog()[providerId]?.models
  if (!models) return []
  return Object.entries(models).map(([id, model]) => ({ ...model, id }))
}

export function getCatalogModel(providerId: string, modelId: string): CatalogModel | undefined {
  const model = loadModelCatalog()[providerId]?.models?.[modelId]
  return model ? { ...model, id: modelId } : undefined
}

/**
 * Map a catalog entry to CodeNomad capabilities:
 * `tool_call` → tools, `reasoning` → reasoning, `attachment` → image, and the
 * declared modalities fill in image/video/audio. Every provider here is a
 * hosted API, so `cloud` is always true.
 */
export function catalogCapabilities(model: CatalogModel): ModelCapabilities {
  const inputs = model.modalities?.input ?? []
  return {
    tools: Boolean(model.tool_call),
    image: Boolean(model.attachment) || inputs.includes("image"),
    video: inputs.includes("video"),
    reasoning: Boolean(model.reasoning),
    audio: inputs.includes("audio"),
    cloud: true,
  }
}

export interface TransformedCatalogModel {
  id: string
  name: string
  providerId: string
  limit: { context: number; input: number; output: number }
  cost: { input: number; output: number }
  capabilities: ModelCapabilities
}

export function transformCatalogModels(
  providerId: string,
  models: CatalogModel[],
): TransformedCatalogModel[] {
  return models.map((model) => {
    const context = model.limit?.context ?? 0
    return {
      id: model.id,
      name: model.name || model.id,
      providerId,
      limit: { context, input: context, output: model.limit?.output ?? 0 },
      cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 },
      capabilities: catalogCapabilities(model),
    }
  })
}

export interface LiveProbeResult {
  /** Model ids the provider currently serves, or null when the probe failed. */
  ids: Set<string> | null
  /** Human-readable failure reason, or null on success. Never thrown. */
  error: string | null
}

/**
 * Best-effort availability probe against an OpenAI-compatible `/models`
 * endpoint. Never throws: a missing key, HTTP error or network failure is
 * reported through `error` so the caller can record it in
 * `ModelSyncResult.errors[]` and still sync the catalog models.
 */
export async function probeOpenAICompatibleModels(options: {
  url: string
  apiKey?: string
  label: string
  timeoutMs?: number
}): Promise<LiveProbeResult> {
  const { url, apiKey, label, timeoutMs = 10_000 } = options

  if (!apiKey) {
    return {
      ids: null,
      error: `${label}: no API key configured — model list taken from the local catalog`,
    }
  }

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      return {
        ids: null,
        error: `${label}: live model list returned ${response.status} ${response.statusText} — model list taken from the local catalog`,
      }
    }

    const body = (await response.json()) as { data?: Array<{ id?: string }> }
    const ids = new Set<string>()
    for (const model of body.data ?? []) {
      if (model?.id) ids.add(model.id)
    }
    return { ids, error: null }
  } catch (error) {
    return {
      ids: null,
      error: `${label}: live model list failed (${error instanceof Error ? error.message : String(error)}) — model list taken from the local catalog`,
    }
  }
}
