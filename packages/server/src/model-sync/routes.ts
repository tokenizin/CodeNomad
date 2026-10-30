import { createLogger } from "../logger"
import { syncAllProviders, syncProviderModels, clearSyncCache, getProviderConfigs, getCachedSyncResults, getCachedModelMap, persistSyncedModelsToConfig, applyModelTestResults, getRemovedModels, getModelSyncPaths } from "./service"
import { testModel, testModelsBatch, type TestModelOptions, type ModelTestResult } from "./tester"
import type { ModelSyncResult } from "./service"

const log = createLogger({ component: "model-sync-routes" })

export interface SyncModelsRequest {
  providers: Array<{
    id: string
    name: string
    models: Array<{
      id: string
      name: string
      limit?: { context?: number; input?: number; output?: number }
      cost?: { input?: number; output?: number }
      capabilities?: { tools: boolean; image: boolean; video: boolean; reasoning: boolean; audio: boolean; cloud: boolean }
      status?: "available" | "insufficient_funds" | "error" | "testing" | "unknown"
      lastTested?: number
      errorDetails?: string
    }>
  }>
}

export interface SyncModelsResponse {
  results: ModelSyncResult[]
  syncedAt: number
}

export interface TestModelRequest {
  providerId: string
  modelId: string
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
}

export interface TestModelBatchRequest {
  tests: TestModelRequest[]
  concurrency?: number
}

export interface TestModelResponse {
  result: ModelTestResult
}

export interface TestModelBatchResponse {
  results: ModelTestResult[]
}

export interface ProviderConfigsResponse {
  providers: Array<{ id: string; name: string; enabled: boolean }>
}

// Sync all providers
export async function handleSyncModels(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as SyncModelsRequest
    const results = await syncAllProviders(body.providers)
    return Response.json({ results, syncedAt: Date.now() })
  } catch (error) {
    const err = error as Error | unknown
    const message = err instanceof Error ? err.message : "Sync failed"
    log.error("Sync models failed: " + message)
    return Response.json({ error: message }, { status: 500 })
  }
}

// Sync single provider
export async function handleSyncProvider(request: Request, providerId: string): Promise<Response> {
  try {
    const body = (await request.json()) as { models: SyncModelsRequest["providers"][0]["models"] }
    const result = await syncProviderModels(providerId, body.models)
    return Response.json(result)
  } catch (error) {
    const err = error as Error | unknown
    const message = err instanceof Error ? err.message : "Sync failed"
    log.error(`Sync provider ${providerId} failed: ${message}`)
    return Response.json({ error: message }, { status: 500 })
  }
}

// Test single model
export async function handleTestModel(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as TestModelRequest
    const result = await testModel(body)
    applyModelTestResults([result])
    return Response.json({ result })
  } catch (error) {
    const err = error as Error | unknown
    const message = err instanceof Error ? err.message : "Test failed"
    log.error("Test model failed: " + message)
    return Response.json({ error: message }, { status: 500 })
  }
}

// Test multiple models
export async function handleTestModelsBatch(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as TestModelBatchRequest
    const options: TestModelOptions[] = body.tests.map((t) => ({
      providerId: t.providerId,
      modelId: t.modelId,
      apiKey: t.apiKey,
      baseUrl: t.baseUrl,
      timeoutMs: t.timeoutMs,
    }))
    const results = await testModelsBatch(options, body.concurrency)
    const { applied, removed } = applyModelTestResults(results)
    log.info(`Batch test: ${results.length} results, ${applied} written to sync cache, ${removed} removed (404/410)`)
    return Response.json({ results })
  } catch (error) {
    const err = error as Error | unknown
    const message = err instanceof Error ? err.message : "Batch test failed"
    log.error("Batch test models failed: " + message)
    return Response.json({ error: message }, { status: 500 })
  }
}

// Get provider configs
export async function handleGetProviderConfigs(): Promise<Response> {
  const providers = getProviderConfigs()
  return Response.json({ providers })
}

// Clear sync cache
export async function handleClearCache(): Promise<Response> {
  clearSyncCache()
  return Response.json({ success: true })
}

// Get cached sync results (for merging into model selector)
export async function handleGetCachedSync(): Promise<Response> {
  const results = getCachedSyncResults()
  const modelMap = getCachedModelMap()
  // Return both the per-provider results and a flat model lookup map
  const flatMap: Record<string, { capabilities: Record<string, boolean>; status: string; errorDetails?: string; lastTested: number }> = {}
  for (const [key, model] of modelMap.entries()) {
    flatMap[key] = {
      capabilities: model.capabilities as unknown as Record<string, boolean>,
      status: model.status,
      errorDetails: model.errorDetails,
      lastTested: model.lastTested,
    }
  }
  return Response.json({ results, modelMap: flatMap })
}

// Persist synced models to opencode.json config
export async function handlePersistToConfig(): Promise<Response> {
  try {
    const result = persistSyncedModelsToConfig()
    return Response.json({ success: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return Response.json({ success: false, error: message }, { status: 500 })
  }
}

// Route handler for the model sync API
export async function handleModelSyncRoutes(request: Request, path: string): Promise<Response | null> {
  const method = request.method
  
  // POST /api/model-sync/sync - sync all providers
  if (method === "POST" && path === "/api/model-sync/sync") {
    return handleSyncModels(request)
  }
  
  // POST /api/model-sync/sync/:providerId - sync single provider
  if (method === "POST" && path.startsWith("/api/model-sync/sync/")) {
    const providerId = path.split("/api/model-sync/sync/")[1]
    return handleSyncProvider(request, providerId)
  }
  
  // GET /api/model-sync/cached - get cached sync results (no re-sync)
  if (method === "GET" && path === "/api/model-sync/cached") {
    return handleGetCachedSync()
  }

  // POST /api/model-sync/persist - write synced models to opencode.json
  if (method === "POST" && path === "/api/model-sync/persist") {
    return handlePersistToConfig()
  }
  
  // POST /api/model-sync/test - test single model
  if (method === "POST" && path === "/api/model-sync/test") {
    return handleTestModel(request)
  }
  
  // POST /api/model-sync/test/batch - test multiple models
  if (method === "POST" && path === "/api/model-sync/test/batch") {
    return handleTestModelsBatch(request)
  }
  
  // GET /api/model-sync/removed - models removed after a 404/410, plus where state is stored
  if (method === "GET" && path === "/api/model-sync/removed") {
    return Response.json({ ...getModelSyncPaths(), removed: getRemovedModels() })
  }

  // GET /api/model-sync/providers - get provider configs
  if (method === "GET" && path === "/api/model-sync/providers") {
    return handleGetProviderConfigs()
  }
  
  // POST /api/model-sync/cache/clear - clear sync cache
  if (method === "POST" && path === "/api/model-sync/cache/clear") {
    return handleClearCache()
  }
  
  return null
}