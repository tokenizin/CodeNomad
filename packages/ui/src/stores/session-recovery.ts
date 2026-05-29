import { createSignal } from "solid-js"

// ---------------------------------------------------------------------------
// Session Recovery Store
//
// Tracks WebSocket / tunnel reconnection state and persists the StarGuard
// auth token across browser sessions so CodeNomad can auto-reconnect after
// a full page reload without requiring the user to re-authenticate.
// ---------------------------------------------------------------------------

const TOKEN_STORAGE_KEY = "codenomad:starguard-token"

export const MAX_RETRIES = 5

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export const [reconnecting, setReconnecting] = createSignal(false)
export const [retryCount, setRetryCount] = createSignal(0)
export const [lastError, setLastError] = createSignal<string | null>(null)
export const [starGuardToken, setStarGuardToken] = createSignal<string | null>(loadPersistedToken())

// ---------------------------------------------------------------------------
// Abort controller — allows cancelReconnect() to stop the in-flight retry loop
// ---------------------------------------------------------------------------

let activeAbortController: AbortController | null = null

/** Return the current abort signal (or null when idle). */
export function getReconnectAbortSignal(): AbortSignal | null {
  return activeAbortController?.signal ?? null
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Begin a new reconnection sequence. Resets retry counter and creates a fresh AbortController. */
export function startReconnect(token: string): void {
  // Abort any in-flight reconnection before starting a new one.
  activeAbortController?.abort()
  activeAbortController = new AbortController()

  setReconnecting(true)
  setRetryCount(0)
  setLastError(null)
  storeStarGuardToken(token)
}

/** Bump the retry counter and record the most recent error message. */
export function incrementRetry(error?: string): void {
  setRetryCount((prev) => prev + 1)
  setLastError(error ?? null)
}

/** Reset all reconnection state back to idle. */
export function resetReconnect(): void {
  activeAbortController?.abort()
  activeAbortController = null
  setReconnecting(false)
  setRetryCount(0)
  setLastError(null)
}

/** Cancel an in-progress reconnection sequence. */
export function cancelReconnect(): void {
  activeAbortController?.abort()
  activeAbortController = null
  setReconnecting(false)
  setRetryCount(0)
  setLastError(null)
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
