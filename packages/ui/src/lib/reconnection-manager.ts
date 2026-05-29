// ---------------------------------------------------------------------------
// Reconnection Manager
//
// Handles automatic reconnection after an SSE disconnect by attempting
// re-authentication via the StarGuard SSO endpoint when a stored token is
// available. Uses exponential backoff across retries and falls back to the
// original connection-lost handler if all attempts fail.
// ---------------------------------------------------------------------------

import {
  resetReconnect,
  startReconnect,
  incrementRetry,
  MAX_RETRIES,
  starGuardToken,
  getReconnectAbortSignal,
} from "../stores/session-recovery"
import { getStoredStarGuardToken } from "./server-events"
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

/**
 * Attempt to reconnect after an SSE disconnect by re-authenticating with the
 * server using a stored StarGuard token.
 *
 * Flow:
 *   1. Check for a persisted StarGuard token (localStorage via session-recovery).
 *   2. If no token is available, return `false` immediately.
 *   3. Otherwise, retry up to {@link MAX_RETRIES} times with exponential backoff.
 *   4. Each attempt issues a GET `/auth/starguard?starguard_token=…` which the
 *      server validates, creates a new session, and sets the `codenomad_session`
 *      cookie before responding (opaque redirect).
 *   5. On success: resets reconnection state and returns `true`.
 *   6. On failure: invokes the provided fallback handler and returns `false`.
 *
 * @param instanceId   - The disconnected workspace instance.
 * @param onConnectionLost - Fallback handler invoked when all retries fail.
 * @returns `true` if re-auth succeeded, `false` otherwise.
 */
export async function reconnectWithRecovery(
  instanceId: string,
  onConnectionLost: (instanceId: string, reason: string) => void | Promise<void>,
): Promise<boolean> {
  const token = getStoredStarGuardToken() ?? starGuardToken()
  if (!token) {
    log.info("No StarGuard token available for reconnection", { instanceId })
    return false
  }

  log.info("Starting reconnection with StarGuard token", { instanceId })
  startReconnect(token)

  const signal = getReconnectAbortSignal()

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Check if cancelled before starting next attempt.
    if (signal?.aborted) {
      log.info("Reconnection cancelled by user", { instanceId })
      resetReconnect()
      return false
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
      return false
    }

    try {
      // The /auth/starguard server route verifies the JWT, creates a session,
      // and sets the codenomad_session cookie. We use `redirect: "manual"` so
      // the browser does not navigate away — the cookie is still applied.
      const response = await fetch(
        `/auth/starguard?starguard_token=${encodeURIComponent(token)}`,
        { method: "GET", credentials: "include", redirect: "manual", signal: signal ?? undefined },
      )

      // Opaque redirect (type === "opaqueredirect") means the server responded
      // with a 302 and the cookie was set in the response headers.
      if (response.ok || response.type === "opaqueredirect") {
        log.info("Re-auth successful, cookie updated", { instanceId })
        resetReconnect()
        return true
      }

      // Token rejected — no point retrying with the same token.
      if (response.status === 401 || response.status === 403) {
        log.warn("StarGuard token rejected, stopping reconnection", {
          instanceId,
          status: response.status,
        })
        incrementRetry(`Authentication failed (${response.status})`)
        break
      }

      incrementRetry(`Server returned ${response.status}`)
      log.warn("Re-auth returned unexpected status", {
        instanceId,
        status: response.status,
      })
    } catch (error) {
      if (signal?.aborted) {
        log.info("Reconnection cancelled during fetch", { instanceId })
        return false
      }
      const message = error instanceof Error ? error.message : String(error)
      incrementRetry(message)
      log.error("Re-auth request failed", { instanceId, error })
    }
  }

  // All attempts exhausted — invoke the original fallback handler.
  log.error("Reconnection failed after all attempts", { instanceId })
  resetReconnect()
  await onConnectionLost(instanceId, "reconnection_failed")
  return false
}
