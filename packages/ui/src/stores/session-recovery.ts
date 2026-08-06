import { createSignal } from "solid-js"

// ---------------------------------------------------------------------------
// Session Recovery Store
//
// Tracks per-instance workspace reconnection state and persists the
// StarGuard auth token across browser sessions so CodeNomad can auto-reauth
// after a full page reload without requiring the user to sign in again.
//
// Reconnection state (reconnecting/retryCount/lastError/abort signal) is
// keyed by instanceId: CodeNomad can run several workspace instances at
// once, and a single shared/global state meant a second instance losing its
// connection would silently abort the first instance's in-flight retry loop
// (its AbortController was a lone module-level variable). Keeping state per
// instance lets every instance's reconnection sequence run to completion
// independently. `activeReconnectInstanceId` separately tracks which single
// instance's progress is currently surfaced in the disconnected-instance
// modal — the UI still only shows one dialog at a time.
// ---------------------------------------------------------------------------

const TOKEN_STORAGE_KEY = "codenomad:starguard-token"

export const MAX_RETRIES = 5

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const [reconnectingMap, setReconnectingMap] = createSignal<Map<string, boolean>>(new Map())
const [retryCountMap, setRetryCountMap] = createSignal<Map<string, number>>(new Map())
const [lastErrorMap, setLastErrorMap] = createSignal<Map<string, string | null>>(new Map())

/** Which instance's reconnect progress is currently shown in the modal, if any. */
export const [activeReconnectInstanceId, setActiveReconnectInstanceId] = createSignal<string | null>(null)

export const [starGuardToken, setStarGuardToken] = createSignal<string | null>(loadPersistedToken())

// ---------------------------------------------------------------------------
// Abort controllers — one per instance, so cancelling/restarting one
// instance's reconnection sequence never touches another instance's.
// ---------------------------------------------------------------------------

const abortControllers = new Map<string, AbortController>()

/** Return the current abort signal for an instance (or null when idle). */
export function getReconnectAbortSignal(instanceId: string): AbortSignal | null {
  return abortControllers.get(instanceId)?.signal ?? null
}

// ---------------------------------------------------------------------------
// Per-instance readers
// ---------------------------------------------------------------------------

export function isReconnecting(instanceId: string): boolean {
  return reconnectingMap().get(instanceId) ?? false
}

export function getRetryCount(instanceId: string): number {
  return retryCountMap().get(instanceId) ?? 0
}

export function getLastError(instanceId: string): string | null {
  return lastErrorMap().get(instanceId) ?? null
}

function dropKey<T>(map: Map<string, T>, key: string): Map<string, T> {
  if (!map.has(key)) {
    return map
  }
  const next = new Map(map)
  next.delete(key)
  return next
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Begin a new reconnection sequence for an instance. Resets its retry counter and creates a fresh AbortController. */
export function startReconnect(instanceId: string): void {
  // Abort any in-flight reconnection for this instance before starting a new one.
  abortControllers.get(instanceId)?.abort()
  abortControllers.set(instanceId, new AbortController())

  setReconnectingMap((prev) => new Map(prev).set(instanceId, true))
  setRetryCountMap((prev) => new Map(prev).set(instanceId, 0))
  setLastErrorMap((prev) => new Map(prev).set(instanceId, null))
  setActiveReconnectInstanceId(instanceId)
}

/** Bump an instance's retry counter and record its most recent error message. */
export function incrementRetry(instanceId: string, error?: string): void {
  setRetryCountMap((prev) => new Map(prev).set(instanceId, (prev.get(instanceId) ?? 0) + 1))
  setLastErrorMap((prev) => new Map(prev).set(instanceId, error ?? null))
}

/** Reset an instance's reconnection state back to idle. */
export function resetReconnect(instanceId: string): void {
  abortControllers.get(instanceId)?.abort()
  abortControllers.delete(instanceId)
  setReconnectingMap((prev) => dropKey(prev, instanceId))
  setRetryCountMap((prev) => dropKey(prev, instanceId))
  setLastErrorMap((prev) => dropKey(prev, instanceId))
  setActiveReconnectInstanceId((current) => (current === instanceId ? null : current))
}

/** Cancel an in-progress reconnection sequence for an instance. */
export function cancelReconnect(instanceId: string): void {
  resetReconnect(instanceId)
}

/** Persist the StarGuard token to localStorage. */
export function storeStarGuardToken(token: string): void {
  setStarGuardToken(token)
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
    }
  } catch {
    // localStorage may be full or disabled – non-fatal.
  }
}

/** Remove the persisted StarGuard token. */
export function clearStarGuardToken(): void {
  setStarGuardToken(null)
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY)
    }
  } catch {
    // Non-fatal — token will just reappear on next page load if the
    // write succeeded previously.
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadPersistedToken(): string | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? null
    }
  } catch {
    // localStorage unavailable — return null so the caller starts fresh.
  }
  return null
}
