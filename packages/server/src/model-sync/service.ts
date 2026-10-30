import type { ModelCapabilities, ModelStatus } from "../../../ui/src/types/session"
import { fetchOpenRouterModels, transformOpenRouterModels } from "./providers/openrouter"
import { getAnthropicModels, transformAnthropicModels } from "./providers/anthropic"
import { getGoogleModels, transformGoogleModels } from "./providers/google"
import { getOpenAIModels, transformOpenAIModels } from "./providers/openai"
import { getNvidiaModels, transformNvidiaModels } from "./providers/nvidia"
import { getNousModels, transformNousModels } from "./providers/nous"
import { getOpenCodeGoModels, transformOpenCodeGoModels } from "./providers/opencode-go"
import { getOpenRouterFallbackModels, transformOpenRouterFallbackModels } from "./providers/openrouter-fallback"
import { getOrnithModels, transformOrnithModels } from "./providers/ornith"
import { getMLXModels, transformMLXModels } from "./providers/mlx"
import { getMLXDeepSeekModels, transformMLXDeepSeekModels } from "./providers/mlx-deepseek"
import { fetchOllamaModels } from "./providers/ollama"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface SyncedModel {
  id: string
  name: string
  providerId: string
  limit: { context: number; input: number; output: number }
  cost: { input: number; output: number }
  capabilities: ModelCapabilities
  status: ModelStatus
  lastTested: number
  errorDetails?: string
  source: "config" | "live" | "merged"
}

export interface ModelSyncResult {
  providerId: string
  providerName: string
  models: SyncedModel[]
  added: number
  removed: number
  updated: number
  errors: string[]
}

export interface ProviderConfig {
  id: string
  name: string
  enabled: boolean
  apiKey?: string
  baseUrl?: string
}

// Provider configurations - in production these would come from config
const PROVIDER_CONFIGS: ProviderConfig[] = [
  { id: "openrouter", name: "OpenRouter", enabled: true },
  { id: "anthropic", name: "Anthropic", enabled: true },
  { id: "google", name: "Google Gemini", enabled: true },
  { id: "openai", name: "OpenAI", enabled: true },
  { id: "nvidia", name: "NVIDIA NIM", enabled: true },
  { id: "nous", name: "Nous Research", enabled: true },
  { id: "opencode-go", name: "OpenCode Go", enabled: true },
  { id: "openrouter-fallback", name: "OpenRouter Fallback", enabled: true },
  { id: "ornith", name: "Ornith", enabled: true },
  { id: "mlx", name: "MLX Local", enabled: true },
  { id: "mlx-deepseek", name: "MLX DeepSeek", enabled: true },
  { id: "ollama", name: "Ollama Local", enabled: true },
]

// Cache for model sync results
let syncCache: Map<string, { data: ModelSyncResult; timestamp: number }> = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// File-based persistence path
const SYNC_CACHE_FILE = join(homedir(), ".config", "codenomad", "model-sync-cache.json")

function getCachedSync(providerId: string): ModelSyncResult | null {
  const cached = syncCache.get(providerId)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data
  }
  return null
}

function setCachedSync(providerId: string, data: ModelSyncResult): void {
  syncCache.set(providerId, { data, timestamp: Date.now() })
  persistSyncCache()
}

// Persist sync cache to file so it survives server restarts
function persistSyncCache(): void {
  try {
    const dir = join(homedir(), ".config", "codenomad")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const serialized: Record<string, { data: ModelSyncResult; timestamp: number }> = {}
    for (const [key, value] of syncCache.entries()) {
      serialized[key] = value
    }
    writeFileSync(SYNC_CACHE_FILE, JSON.stringify(serialized, null, 2), "utf-8")
  } catch {
    // Non-fatal — in-memory cache still works
  }
}

// Load sync cache from file on startup
function loadSyncCacheFromFile(): void {
  try {
    if (!existsSync(SYNC_CACHE_FILE)) return
    const raw = readFileSync(SYNC_CACHE_FILE, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, { data: ModelSyncResult; timestamp: number }>
    for (const [key, value] of Object.entries(parsed)) {
      syncCache.set(key, value)
    }
  } catch {
    // Non-fatal — start with empty cache
  }
}

// Load on module init
loadSyncCacheFromFile()

// ─── Config file persistence: write synced models back to opencode.json ───

/**
 * Find opencode.json by searching upward from process.cwd() and from the
 * compiled server directory. Returns the first match or null.
 */
function findOpencodeJson(): string | null {
  const searchDirs = [
    process.cwd(),
    join(homedir(), "starworld"),
    // From compiled JS: dist/model-sync/service.js → go up 5 levels to starworld root
    join(__dirname, "..", "..", "..", "..", ".."),
    join(__dirname, "..", "..", "..", "..", "..", ".."),
  ]
  for (const dir of searchDirs) {
    const candidate = join(dir, "opencode.json")
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Persist synced models back to opencode.json so that OpenCode / NomadWorks
 * agents pick up the latest model lists, context limits, and capabilities.
 *
 * For each provider in the sync cache:
 *  - New models are added
 *  - Existing models get updated limits and capability flags
 *  - Models that were removed from the provider are left untouched (safe merge)
 */
export function persistSyncedModelsToConfig(): { updated: number; added: number; path: string } {
  const configPath = findOpencodeJson()
  if (!configPath) {
    throw new Error("opencode.json not found — cannot persist synced models")
  }

  const raw = readFileSync(configPath, "utf-8")
  const config = JSON.parse(raw) as {
    provider?: Record<string, {
      models?: Record<string, {
        name?: string
        tool_call?: boolean
        reasoning?: boolean
        attachment?: boolean
        limit?: { context?: number; output?: number; input?: number }
        cost?: { input?: number; output?: number }
      }>
      [key: string]: unknown
    }>
  }

  if (!config.provider) {
    config.provider = {}
  }

  let added = 0
  let updated = 0

  for (const result of getCachedSyncResults()) {
    const providerId = result.providerId
    if (!config.provider[providerId]) {
      // Skip providers not already in opencode.json — don't create new provider entries
      continue
    }

    if (!config.provider[providerId].models) {
      config.provider[providerId].models = {}
    }

    const modelsMap = config.provider[providerId].models!

    for (const synced of result.models) {
      const existing = modelsMap[synced.id]
      const cap = synced.capabilities

      const modelEntry = {
        name: synced.name,
        tool_call: cap?.tools ?? existing?.tool_call ?? false,
        reasoning: cap?.reasoning ?? existing?.reasoning ?? false,
        attachment: cap?.image ?? existing?.attachment ?? false,
        limit: {
          context: synced.limit?.context ?? existing?.limit?.context ?? 0,
          output: synced.limit?.output ?? existing?.limit?.output ?? 0,
          ...(synced.limit?.input || existing?.limit?.input
            ? { input: synced.limit?.input ?? existing?.limit?.input }
            : {}),
        },
        ...(synced.cost?.input || synced.cost?.output
          ? { cost: { input: synced.cost?.input ?? 0, output: synced.cost?.output ?? 0 } }
          : existing?.cost
            ? { cost: existing.cost }
            : {}),
      }

      if (!existing) {
        modelsMap[synced.id] = modelEntry
        added++
      } else {
        // Update existing entry — preserve any extra fields, update known ones
        modelsMap[synced.id] = { ...existing, ...modelEntry }
        updated++
      }
    }
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
  return { updated, added, path: configPath }
}

/**
 * Write model test results into the sync cache so the Model Status table
 * (which polls /api/model-sync/cached) shows the tested status and time.
 * Updates entries even if the provider's cache TTL has expired.
 */
export function applyModelTestResults(
  results: Array<{ providerId: string; modelId: string; status: ModelStatus; errorDetails?: string; testedAt: number }>
): number {
  let applied = 0
  for (const result of results) {
    if (result.status === "testing") continue
    const entry = syncCache.get(result.providerId)
    if (!entry) continue
    const model = entry.data.models.find((m) => m.id === result.modelId)
    if (!model) continue
    model.status = result.status
    model.lastTested = result.testedAt
    model.errorDetails = result.status === "available" ? undefined : result.errorDetails
    applied++
  }
  if (applied > 0) persistSyncCache()
  return applied
}

// Get all cached sync results (for merging into model selector)
export function getCachedSyncResults(): ModelSyncResult[] {
  return Array.from(syncCache.values()).map((v) => v.data)
}

// Build a lookup map of "providerId/modelId" → SyncedModel for quick merging
export function getCachedModelMap(): Map<string, SyncedModel> {
  const map = new Map<string, SyncedModel>()
  for (const result of getCachedSyncResults()) {
    for (const model of result.models) {
      map.set(`${result.providerId}/${model.id}`, model)
    }
  }
  return map
}

async function fetchProviderModels(config: ProviderConfig): Promise<SyncedModel[]> {
  const providerId = config.id
  
  try {
    let models: SyncedModel[] = []
    
    switch (providerId) {
      case "openrouter": {
        const rawModels = await fetchOpenRouterModels(config.apiKey)
        models = transformOpenRouterModels(rawModels).map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "live" }))
        break
      }
      case "anthropic": {
        const rawModels = getAnthropicModels()
        models = transformAnthropicModels(rawModels).map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "config" }))
        break
      }
      case "google": {
        const rawModels = getGoogleModels()
        models = transformGoogleModels(rawModels).map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "config" }))
        break
      }
      case "openai": {
        const rawModels = getOpenAIModels()
        models = transformOpenAIModels(rawModels).map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "config" }))
        break
      }
      case "nvidia": {
        const rawModels = getNvidiaModels()
        models = transformNvidiaModels(rawModels).map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "config" }))
        break
      }
      case "nous": {
        const rawModels = getNousModels()
        models = transformNousModels(rawModels).map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "config" }))
        break
      }
      case "opencode-go": {
        const rawModels = getOpenCodeGoModels()
        models = transformOpenCodeGoModels(rawModels).map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "config" }))
        break
      }
      case "openrouter-fallback": {
        const rawModels = getOpenRouterFallbackModels()
        models = transformOpenRouterFallbackModels(rawModels).map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "config" }))
        break
      }
      case "ornith": {
        const rawModels = getOrnithModels()
        models = transformOrnithModels(rawModels).map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "config" }))
        break
      }
      case "mlx": {
        const rawModels = getMLXModels()
        models = transformMLXModels(rawModels).map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "config" }))
        break
      }
      case "mlx-deepseek": {
        const rawModels = getMLXDeepSeekModels()
        models = transformMLXDeepSeekModels(rawModels).map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "config" }))
        break
      }
      case "ollama": {
        const rawModels = await fetchOllamaModels(config.baseUrl)
        models = rawModels.map((m) => ({ ...m, status: "unknown" as ModelStatus, lastTested: 0, source: "live" }))
        break
      }
      default:
        throw new Error(`Unknown provider: ${providerId}`)
    }
    
    return models
  } catch (error) {
    throw new Error(`Failed to fetch models for ${providerId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function syncProviderModels(
  providerId: string,
  configuredModels: Array<{
    id: string
    name: string
    limit?: { context?: number; input?: number; output?: number }
    cost?: { input?: number; output?: number }
    capabilities?: ModelCapabilities
    status?: ModelStatus
    lastTested?: number
    errorDetails?: string
  }>
): Promise<ModelSyncResult> {
  const cached = getCachedSync(providerId)
  if (cached) return cached
  
  const config = PROVIDER_CONFIGS.find((c) => c.id === providerId)
  if (!config || !config.enabled) {
    return {
      providerId,
      providerName: config?.name || providerId,
      models: [],
      added: 0,
      removed: 0,
      updated: 0,
      errors: [`Provider ${providerId} not found or disabled`],
    }
  }
  
  const errors: string[] = []
  let added = 0
  let removed = 0
  let updated = 0
  
  try {
    const liveModels = await fetchProviderModels(config)
    
    // Create a map of configured models for comparison
    const configuredMap = new Map(configuredModels.map((m) => [`${providerId}/${m.id}`, m]))
    const liveMap = new Map(liveModels.map((m) => [`${providerId}/${m.id}`, m]))
    // Previous results (even if the TTL expired) so a re-sync keeps test status
    const previousMap = new Map(
      (syncCache.get(providerId)?.data.models ?? []).map((m) => [`${providerId}/${m.id}`, m])
    )
    
    // Merge: keep configured models, add new live models, mark removed
    const mergedModels: SyncedModel[] = []
    
    // Process live models
    for (const liveModel of liveModels) {
      const key = `${providerId}/${liveModel.id}`
      const configured = configuredMap.get(key)
      
      if (configured) {
        // Model exists in both - merge, preserving configured status/tested info
        mergedModels.push({
          ...liveModel,
          status: configured.status || "unknown",
          lastTested: configured.lastTested || 0,
          errorDetails: configured.errorDetails,
          source: "merged",
        })
        updated++
      } else {
        const previous = previousMap.get(key)
        if (previous) {
          // Known from an earlier sync - keep its last test result
          mergedModels.push({
            ...liveModel,
            status: previous.status || "unknown",
            lastTested: previous.lastTested || 0,
            errorDetails: previous.errorDetails,
          })
          updated++
        } else {
          // New model from live
          mergedModels.push({
            ...liveModel,
            status: "unknown",
            lastTested: 0,
            source: "live",
          })
          added++
        }
      }
    }
    
    // Check for removed models (in config but not in live)
    for (const [key, configured] of configuredMap) {
      if (!liveMap.has(key)) {
        // Model was removed from provider
        mergedModels.push({
          ...configured,
          providerId: providerId as string,
          limit: {
            context: configured.limit?.context ?? 0,
            input: configured.limit?.input ?? 0,
            output: configured.limit?.output ?? 0,
          },
          cost: {
            input: configured.cost?.input ?? 0,
            output: configured.cost?.output ?? 0,
          },
          status: "error" as ModelStatus,
          errorDetails: "Model no longer available from provider",
          source: "config",
          capabilities: configured.capabilities || ("unknown" as unknown as ModelCapabilities),
          lastTested: configured.lastTested ?? 0,
        })
        removed++
      }
    }
    
    const result: ModelSyncResult = {
      providerId,
      providerName: config.name,
      models: mergedModels,
      added,
      removed,
      updated,
      errors,
    }
    
    setCachedSync(providerId, result)
    return result
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    return {
      providerId,
      providerName: config.name,
      models: configuredModels.map((m) => ({  ...m,
        providerId,
        status: "error" as ModelStatus,
        errorDetails: error instanceof Error ? error.message : String(error),
        lastTested: Date.now(),
        source: "config",
      }) as SyncedModel),
      added: 0,
      removed: 0,
      updated: 0,
      errors,
    }
  }
}

export async function syncAllProviders(
  configuredProviders: Array<{
    id: string
    name: string
    models: Array<{
      id: string
      name: string
      limit?: { context?: number; input?: number; output?: number }
      cost?: { input?: number; output?: number }
      capabilities?: ModelCapabilities
      status?: ModelStatus
      lastTested?: number
      errorDetails?: string
    }>
  }>
): Promise<ModelSyncResult[]> {
  // If no providers passed, sync ALL built-in providers
  const providersToSync = configuredProviders.length > 0
    ? configuredProviders
    : PROVIDER_CONFIGS.map((c) => ({ id: c.id, name: c.name, models: [] }))

  const results = await Promise.all(
    providersToSync.map((provider) =>
      syncProviderModels(provider.id, provider.models).catch((error) => ({
        providerId: provider.id,
        providerName: provider.name,
        models: provider.models.map((m) => ({
          ...m,
          providerId: provider.id,
          limit: {
            context: m.limit?.context ?? 0,
            input: m.limit?.input ?? 0,
            output: m.limit?.output ?? 0,
          },
          cost: {
            input: m.cost?.input ?? 0,
            output: m.cost?.output ?? 0,
          },
          status: "error" as ModelStatus,
          errorDetails: error instanceof Error ? error.message : String(error),
          lastTested: Date.now(),
          source: "config" as const,
        })),
        added: 0,
        removed: 0,
        updated: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      }))
    )
  )
  return results as ModelSyncResult[]
}

export function clearSyncCache(): void {
  syncCache.clear()
  persistSyncCache()
}

export function getProviderConfigs(): ProviderConfig[] {
  return PROVIDER_CONFIGS
}