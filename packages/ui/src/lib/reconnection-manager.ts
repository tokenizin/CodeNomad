// ---------------------------------------------------------------------------
// Reconnection Manager
//
// Handles automatic reconnection after a workspace instance disconnects.
//
// `instance.eventStatus: "disconnected"` only fires when the workspace's own
// backend process has actually stopped or crashed (see
// InstanceEventBridge.stopStream on the server) — it is not a signal about
// the browser's own connection to the CodeNomad server (that has its own,
// separate recovery loop in server-events.ts). So the fix for a disconnected
// instance is to relaunch the workspace process, not to refresh an auth
// cookie: the workspace manager already knows how to replace an errored
// workspace for the same folder in place (see WorkspaceManager.create), so
// each retry attempt just re-issues the create call.
//
// A StarGuard re-auth is only attempted as a secondary remedy, when a
// relaunch attempt itself fails with what looks like an expired/invalid
// CodeNomad session (401/403) — that's a real but different failure mode
// (the browser's own session with the CodeNomad server lapsed) and doesn't
// apply when no StarGuard token is in play (e.g. plain local dev).
// ---------------------------------------------------------------------------

import type { WorkspaceDescriptor } from "../../../server/src/api-types"
import {
  resetReconnect,
  startReconnect,
  incrementRetry,
  MAX_RETRIES,
  starGuardToken,
  getReconnectAbortSignal,
} from "../stores/session-recovery"
import { getStoredStarGuardToken } from "./server-events"
import { serverApi } from "./api-client"
import { getLogger } from "./logger"

const log = getLogger("reconnection")

/** Exponential backoff delays in milliseconds, capped at 10 s. */
const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 10_000]

function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new DOMException("Aborted", "AbortError"))
      },
      { once: true },
    )
  })
}

function isAuthFailureMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  )
}

/** Best-effort StarGuard cookie refresh; failures just fall through to the next retry. */
async function reauthWithStarGuard(token: string, signal: AbortSignal | null): Promise<boolean> {
  try {
    const response = await fetch(`/auth/starguard?starguard_token=${encodeURIComponent(token)}`, {
      method: "GET",
      credentials: "include",
      redirect: "manual",
      signal: signal ?? undefined,
    })
    // Opaque redirect (type === "opaqueredirect") means the server responded
    // with a 302 and the cookie was set in the response headers.
    return response.ok || response.type === "opaqueredirect"
  } catch {
    return false
  }
}

/**
 * Attempt to reconnect after a workspace instance disconnects, by relaunching
 * the workspace process for its folder.
 *
 * Flow:
 *   1. Retry up to {@link MAX_RETRIES} times with exponential backoff.
 *   2. Each attempt calls `POST /workspaces` for the same folder. The server
 *      detects the existing (now-errored) workspace record and replaces it
 *      in place, preserving its id.
 *   3. If an attempt fails with what looks like an expired CodeNomad session
 *      (401/403) and a StarGuard token is available, refresh it before the
 *      next attempt.
 *   4. On success: resets reconnection state and returns the new descriptor.
 *   5. On failure: invokes the provided fallback handler and returns `null`.
 *
 * @param instanceId - The disconnected workspace instance.
 * @param folder - The workspace's folder path, used to relaunch it.
 * @param name - Optional workspace/project name to preserve on relaunch.
 * @param onConnectionLost - Fallback handler invoked when all retries fail.
 * @returns The relaunched workspace descriptor, or `null` if recovery failed/was cancelled.
 */
export async function reconnectWithRecovery(
  instanceId: string,
  folder: string,
  name: string | undefined,
  onConnectionLost: (instanceId: string, reason: string) => void | Promise<void>,
): Promise<WorkspaceDescriptor | null> {
  log.info("Starting reconnection", { instanceId })
  startReconnect(instanceId)

  const signal = getReconnectAbortSignal(instanceId)

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Check if cancelled before starting next attempt.
    if (signal?.aborted) {
      log.info("Reconnection cancelled by user", { instanceId })
      resetReconnect(instanceId)
      return null
    }

    const delay = BACKOFF_DELAYS[Math.min(attempt, BACKOFF_DELAYS.length - 1)]
    log.info(`Reconnection attempt ${attempt + 1}/${MAX_RETRIES}`, {
      instanceId,
      delayMs: delay,
    })

    try {
      await sleep(delay, signal)
    } catch {
      // AbortError — user cancelled or new reconnection started.
      log.info("Reconnection sleep interrupted", { instanceId })
      return null
    }

    try {
      const workspace = await serverApi.createWorkspace({ path: folder, name })
      log.info("Workspace relaunch successful", { instanceId, workspaceId: workspace.id })
      resetReconnect(instanceId)
      return workspace
    } catch (error) {
      if (signal?.aborted) {
        log.info("Reconnection cancelled during relaunch", { instanceId })
        return null
      }

      const message = error instanceof Error ? error.message : String(error)

      if (isAuthFailureMessage(message)) {
        const token = getStoredStarGuardToken() ?? starGuardToken()
        if (token) {
          log.info("Relaunch blocked by an auth failure, refreshing StarGuard session", { instanceId })
          await reauthWithStarGuard(token, signal)
        }
      }

      incrementRetry(instanceId, message)
      log.warn("Workspace relaunch attempt failed", { instanceId, error: message })
    }
  }

  // All attempts exhausted — invoke the original fallback handler.
  log.error("Reconnection failed after all attempts", { instanceId })
  resetReconnect(instanceId)
  await onConnectionLost(instanceId, "reconnection_failed")
  return null
}
