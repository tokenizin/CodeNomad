import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { getRootClient } from "../stores/opencode-client"
import type { ProviderAuthMethod } from "./provider-auth"
import { requestData } from "./opencode-api"

const CACHE_TTL_MS = 5 * 60_000

type FileNode = {
  name: string
  path: string
  type: "file" | "directory"
}

type ProviderAuthCache = {
  fetchedAt: number
  methodsByProvider: Record<string, ProviderAuthMethod[]>
  connectedProviderIds: string[]
  configuredProviderIds: Set<string>
  configData: Record<string, unknown>
  availableProviders: Array<{
    id: string
    name: string
    modelCount: number
    source: string
  }>
}

const fileListCache = new Map<string, { fetchedAt: number; entries: FileNode[] }>()
const providerAuthCache = new Map<string, ProviderAuthCache>()

function fileCacheKey(instanceId: string, path: string): string {
  return `${instanceId}:${path}`
}

function isFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt < CACHE_TTL_MS
}

export function getCachedFileList(instanceId: string, path: string): FileNode[] | null {
  const cached = fileListCache.get(fileCacheKey(instanceId, path))
  if (!cached || !isFresh(cached.fetchedAt)) return null
  return cached.entries
}

export function setCachedFileList(instanceId: string, path: string, entries: FileNode[]): void {
  fileListCache.set(fileCacheKey(instanceId, path), { fetchedAt: Date.now(), entries })
}

export function getCachedProviderAuth(instanceId: string): ProviderAuthCache | null {
  const cached = providerAuthCache.get(instanceId)
  if (!cached || !isFresh(cached.fetchedAt)) return null
  return cached
}

function modelCountFromProvider(provider: { models?: Record<string, unknown> }): number {
  return provider.models ? Object.keys(provider.models).length : 0
}

export async function prefetchRootFileList(instanceId: string): Promise<void> {
  try {
    const client = getRootClient(instanceId)
    const nodes = await requestData<FileNode[]>(client.file.list({ path: "." }), "file.list.prefetch")
    if (Array.isArray(nodes)) {
      setCachedFileList(instanceId, ".", nodes)
    }
  } catch {
    // Expected while OpenCode child is still warming; UI revalidates on panel open.
  }
}

export async function prefetchProviderAuth(instanceId: string): Promise<void> {
  try {
    const client = getRootClient(instanceId) as OpencodeClient & {
      provider: {
        list: () => Promise<{ data?: { all?: unknown[]; connected?: string[] } }>
        auth: () => Promise<{ data?: Record<string, unknown[]> }>
      }
      config: { get: () => Promise<{ data?: Record<string, unknown> }> }
    }

    const [providerListResponse, authResponse, configResponse] = await Promise.all([
      client.provider.list(),
      client.provider.auth(),
      client.config.get(),
    ])

    const nextConfigData = (configResponse?.data ?? {}) as Record<string, unknown>
    const nextConfiguredIds = new Set(Object.keys((nextConfigData.provider ?? {}) as Record<string, unknown>))
    const listed = ((providerListResponse?.data?.all ?? []) as Array<Record<string, unknown>>)
      .map((provider) => ({
        id: String(provider.id ?? ""),
        name: String(provider.name ?? provider.id ?? ""),
        modelCount: modelCountFromProvider(provider as { models?: Record<string, unknown> }),
        source: String(provider.source ?? "unknown"),
      }))
      .filter((provider) => provider.id.length > 0)

    providerAuthCache.set(instanceId, {
      fetchedAt: Date.now(),
      methodsByProvider: (authResponse?.data ?? {}) as Record<string, ProviderAuthMethod[]>,
      connectedProviderIds: (providerListResponse?.data?.connected ?? []) as string[],
      configuredProviderIds: nextConfiguredIds,
      configData: nextConfigData,
      availableProviders: listed,
    })
  } catch {
    // Expected while OpenCode child is still warming; modal revalidates on open.
  }
}

export async function prefetchInteractiveResources(instanceId: string): Promise<void> {
  await Promise.allSettled([prefetchRootFileList(instanceId), prefetchProviderAuth(instanceId)])
}

export function clearInstancePreloadCache(instanceId: string): void {
  providerAuthCache.delete(instanceId)
  for (const key of Array.from(fileListCache.keys())) {
    if (key.startsWith(`${instanceId}:`)) {
      fileListCache.delete(key)
    }
  }
}
