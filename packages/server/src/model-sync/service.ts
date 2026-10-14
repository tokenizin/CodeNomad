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

function getCachedSync(providerId: string): ModelSyncResult | null {
  const cached = syncCache.get(providerId)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data
  }
  return null
}

function setCachedSync(providerId: string, data: ModelSyncResult): void {
  syncCache.set(providerId, { data, timestamp: Date.now() })
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
    
    // Check for removed models (in config but not in live)
    for (const [key, configured] of configuredMap) {
      if (!liveMap.has(key)) {
        // Model was removed from provider
        mergedModels.push({
          ...configured,
          status: "error",
          errorDetails: "Model no longer available from provider",
          source: "config",
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
      models: configuredModels.map((m) => ({
        ...m,
        providerId,
        status: "error" as ModelStatus,
        errorDetails: error instanceof Error ? error.message : String(error),
        lastTested: Date.now(),
        source: "config",
      })),
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
  const results = await Promise.all(
    configuredProviders.map((provider) =>
      syncProviderModels(provider.id, provider.models).catch((error) => ({
        providerId: provider.id,
        providerName: provider.name,
        models: provider.models.map((m) => ({
          ...m,
          providerId: provider.id,
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
  return results
}

export function clearSyncCache(): void {
  syncCache.clear()
}

export function getProviderConfigs(): ProviderConfig[] {
  return PROVIDER_CONFIGS
}