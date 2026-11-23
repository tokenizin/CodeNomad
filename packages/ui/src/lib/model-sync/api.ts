/**
 * Typed API adapter for the CodeNomad Model Sync endpoints (SCR-2026-11-23-001).
 *
 * Injectable `fetch` (defaults to the global) and explicit `!response.ok`
 * failure surfacing. Pure TypeScript — no Solid / DOM imports — so it stays
 * unit-testable with `node:test`.
 */

import { rowKey } from "./filter-models"

export class ModelSyncApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ModelSyncApiError"
    this.status = status
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function createModelSyncFetch(fetchImpl?: FetchLike): FetchLike {
  const doFetch: FetchLike = (input, init) => (fetchImpl ? fetchImpl(input, init) : fetch(input, init))
  return doFetch
}

export async function modelSyncFetch<T>(input: string, init: RequestInit | undefined, fetchImpl?: FetchLike): Promise<T> {
  const doFetch = createModelSyncFetch(fetchImpl)
  const response = await doFetch(input, init)
  if (!response.ok) {
    let message = `HTTP ${response.status}: ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      // Non-JSON error bodies keep the status-based message.
    }
    throw new ModelSyncApiError(message, response.status)
  }
  return (await response.json()) as T
}

export interface ModelSyncApiClientOptions {
  fetchImpl?: FetchLike
}

export interface ModelSyncTestResult {
  providerId: string
  modelId: string
  status?: string
  testedAt?: number
  errorDetails?: string
  removed?: boolean
}

export interface ModelSyncApi {
  getCachedModels(): Promise<{ results: unknown[]; modelMap?: Record<string, unknown> }>
  syncModels(input: { providers: Array<{ id: string; name: string; models: Array<Record<string, unknown>> }> }): Promise<{ results: unknown[]; syncedAt: number }>
  persist(): Promise<{ success: boolean }>
  clearCache(): Promise<{ success: boolean }>
  testModels(input: { tests: Array<{ providerId: string; modelId: string; timeoutMs?: number }>; concurrency?: number }): Promise<{ results: ModelSyncTestResult[] }>
  testModel(input: { providerId: string; modelId: string; timeoutMs?: number }): Promise<{ result: ModelSyncTestResult }>
}

export function createModelSyncApi(options: ModelSyncApiClientOptions = {}): ModelSyncApi {
  const base = { fetchImpl: options.fetchImpl }

  return {
    async getCachedModels() {
      const data = await modelSyncFetch<{ results: unknown[]; modelMap?: Record<string, unknown> }>("/api/model-sync/cached", undefined, base.fetchImpl)
      return { results: data.results ?? [], modelMap: data.modelMap }
    },

    async syncModels(input) {
      const data = await modelSyncFetch<{ results: unknown[]; syncedAt: number }>("/api/model-sync/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: input.providers }),
      }, base.fetchImpl)
      return { results: data.results ?? [], syncedAt: data.syncedAt }
    },

    async persist() {
      const data = await modelSyncFetch<{ success?: boolean }>("/api/model-sync/persist", { method: "POST" }, base.fetchImpl)
      return { success: Boolean(data?.success) }
    },

    async clearCache() {
      const data = await modelSyncFetch<{ success: boolean }>("/api/model-sync/cache/clear", { method: "POST" }, base.fetchImpl)
      return { success: data.success }
    },

    async testModels(input) {
      const data = await modelSyncFetch<{ results: unknown[] }>("/api/model-sync/test/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tests: input.tests, concurrency: input.concurrency }),
      }, base.fetchImpl)
      return { results: (data.results ?? []) as ModelSyncTestResult[] }
    },

    async testModel(input) {
      const data = await modelSyncFetch<{ result: unknown }>("/api/model-sync/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: input.providerId,
          modelId: input.modelId,
          timeoutMs: input.timeoutMs,
        }),
      }, base.fetchImpl)
      return { result: (data.result ?? {}) as ModelSyncTestResult }
    },
  }
}

export { rowKey }
