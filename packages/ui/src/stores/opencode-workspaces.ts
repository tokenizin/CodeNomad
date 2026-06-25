import { getRootClient } from "./opencode-client"
import { getWorktreeSlugForSession, getWorktrees } from "./worktrees"
import { getLogger } from "../lib/logger"
import { mapOpenCodeWorkspacesToWorktreeSlugs } from "./opencode-workspace-matching"

const log = getLogger("api")

type OpenCodeWorkspace = {
  id: string
  type?: string
  name?: string
  branch?: string | null
  directory?: string | null
  projectID?: string
}

const workspaceIdByWorktreeSlug = new Map<string, Map<string, string>>()
const workspaceSyncs = new Map<string, Promise<void>>()

const WORKSPACE_SYNC_LIST_TIMEOUT_MS = 15_000
const WORKSPACE_LIST_TIMEOUT_MS = 15_000

type WorkspaceSyncOptions = {
  /** Register adapter-discovered workspaces via OpenCode sync-list (slow; run after worktree changes only). */
  syncAdapters?: boolean
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function formatWorkspaceApiError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

async function getInstance(instanceId: string) {
  const { instances } = await import("./instances")
  return instances().get(instanceId)
}

function getCachedOpenCodeWorkspaceIdForWorktree(instanceId: string, slug: string): string | null {
  if (!slug || slug === "root") return null
  return workspaceIdByWorktreeSlug.get(instanceId)?.get(slug) ?? null
}

function getCachedOpenCodeWorkspaceIdForSession(instanceId: string, sessionId: string): string | null {
  return getCachedOpenCodeWorkspaceIdForWorktree(instanceId, getWorktreeSlugForSession(instanceId, sessionId))
}

function runWorkspaceSyncList(
  workspaceApi: { syncList: (args: { directory: string }) => Promise<unknown> },
  directory: string,
  instanceId: string,
): void {
  void withTimeout(
    workspaceApi.syncList({ directory }),
    WORKSPACE_SYNC_LIST_TIMEOUT_MS,
    "workspace.syncList",
  ).catch((error) => {
    log.warn("OpenCode workspace sync-list skipped or failed", {
      instanceId,
      directory,
      error: formatWorkspaceApiError(error),
    })
  })
}

async function syncOpenCodeWorkspaces(instanceId: string, options?: WorkspaceSyncOptions): Promise<void> {
  if (!instanceId) return
  const syncKey = `${instanceId}:${options?.syncAdapters ? "adapters" : "list"}`
  const existing = workspaceSyncs.get(syncKey)
  if (existing) return existing

  const task = (async () => {
    const instance = await getInstance(instanceId)
    if (!instance?.client || !instance.folder) return

    const rootClient = getRootClient(instanceId) as any
    const workspaceApi = rootClient.experimental?.workspace
    if (!workspaceApi?.list) {
      log.warn("OpenCode experimental workspace API unavailable", { instanceId })
      workspaceIdByWorktreeSlug.set(instanceId, new Map())
      return
    }

    if (options?.syncAdapters && workspaceApi.syncList) {
      runWorkspaceSyncList(workspaceApi, instance.folder, instanceId)
    }

    const result = await withTimeout(
      workspaceApi.list({ directory: instance.folder }),
      WORKSPACE_LIST_TIMEOUT_MS,
      "workspace.list",
    )
    const workspaces = Array.isArray((result as any)?.data) ? ((result as any).data as OpenCodeWorkspace[]) : []
    const next = mapOpenCodeWorkspacesToWorktreeSlugs(getWorktrees(instanceId), workspaces)

    workspaceIdByWorktreeSlug.set(instanceId, next)
  })()
    .catch((error) => {
      log.warn("Failed to sync OpenCode workspaces", { instanceId, error })
      workspaceIdByWorktreeSlug.set(instanceId, new Map())
    })
    .finally(() => {
      workspaceSyncs.delete(syncKey)
    })

  workspaceSyncs.set(syncKey, task)
  return task
}

async function reloadOpenCodeWorkspaces(instanceId: string): Promise<void> {
  for (const key of Array.from(workspaceSyncs.keys())) {
    if (key === instanceId || key.startsWith(`${instanceId}:`)) {
      workspaceSyncs.delete(key)
    }
  }
  await syncOpenCodeWorkspaces(instanceId, { syncAdapters: true })
}

async function getOpenCodeWorkspaceIdForWorktree(instanceId: string, slug: string): Promise<string | null> {
  if (!slug || slug === "root") return null
  const cached = getCachedOpenCodeWorkspaceIdForWorktree(instanceId, slug)
  if (cached) return cached
  await syncOpenCodeWorkspaces(instanceId)
  return getCachedOpenCodeWorkspaceIdForWorktree(instanceId, slug)
}

async function getOpenCodeWorkspaceIdForSession(instanceId: string, sessionId: string): Promise<string | null> {
  const slug = getWorktreeSlugForSession(instanceId, sessionId)
  return getOpenCodeWorkspaceIdForWorktree(instanceId, slug)
}

function clearOpenCodeWorkspaceCache(instanceId: string): void {
  for (const key of Array.from(workspaceSyncs.keys())) {
    if (key === instanceId || key.startsWith(`${instanceId}:`)) {
      workspaceSyncs.delete(key)
    }
  }
  workspaceIdByWorktreeSlug.delete(instanceId)
}

async function removeOpenCodeWorkspaceForWorktree(instanceId: string, slug: string): Promise<void> {
  const instance = await getInstance(instanceId)
  if (!instance?.folder || !slug || slug === "root") return
  const workspaceId = getCachedOpenCodeWorkspaceIdForWorktree(instanceId, slug)
  if (!workspaceId) return

  const rootClient = getRootClient(instanceId) as any
  const workspaceApi = rootClient.experimental?.workspace
  if (!workspaceApi?.remove) return

  await workspaceApi.remove({ directory: instance.folder, id: workspaceId })
  workspaceIdByWorktreeSlug.get(instanceId)?.delete(slug)
}

export {
  clearOpenCodeWorkspaceCache,
  getCachedOpenCodeWorkspaceIdForSession,
  getCachedOpenCodeWorkspaceIdForWorktree,
  getOpenCodeWorkspaceIdForSession,
  getOpenCodeWorkspaceIdForWorktree,
  reloadOpenCodeWorkspaces,
  removeOpenCodeWorkspaceForWorktree,
  syncOpenCodeWorkspaces,
}
