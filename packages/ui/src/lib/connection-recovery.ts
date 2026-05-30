import { serverApi } from "./api-client"
import { getLogger } from "./logger"

const log = getLogger("api")

/** Per-resource cooldown after auth/tunnel failures (agents, providers, …). */
const RESOURCE_COOLDOWN_MS = 60_000
/** Debounce StarGuard restart-request (Mac watchdog also polls). */
const TUNNEL_RESTART_DEBOUNCE_MS = 60_000

let backendOnline = true
let lastTunnelRestartRequestAt = 0
const resourceBlockedUntil = new Map<string, number>()
const inFlight = new Set<string>()

function resourceKey(instanceId: string, resource: string): string {
  return `${instanceId}:${resource}`
}

function messageOf(error: unknown): string {
  return (
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error ?? "")
  ).toLowerCase()
}

/** Auth failure (401) — needs re-auth, NOT a host/tunnel restart. */
function isAuthFailure(error: unknown): boolean {
  const lower = messageOf(error)
  return lower.includes("401") || lower.includes("unauthorized")
}

/** Genuine tunnel/gateway/network outage — the only case a host restart can fix. */
function isTunnelFailure(error: unknown): boolean {
  const lower = messageOf(error)
  return (
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("bad gateway") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("econnrefused")
  )
}

function isRecoverableFailure(error: unknown): boolean {
  return isAuthFailure(error) || isTunnelFailure(error)
}

export function isBackendOnline(): boolean {
  return backendOnline
}

export function canFetchInstanceResource(instanceId: string, resource: string): boolean {
  if (!backendOnline) return false
  const key = resourceKey(instanceId, resource)
  if (inFlight.has(key)) return false
  const blockedUntil = resourceBlockedUntil.get(key) ?? 0
  return Date.now() >= blockedUntil
}

export function beginInstanceResourceFetch(instanceId: string, resource: string): boolean {
  if (!canFetchInstanceResource(instanceId, resource)) {
    return false
  }
  inFlight.add(resourceKey(instanceId, resource))
  return true
}

export function completeInstanceResourceFetch(instanceId: string, resource: string, error?: unknown): void {
  const key = resourceKey(instanceId, resource)
  inFlight.delete(key)

  if (!error) {
    resourceBlockedUntil.delete(key)
    return
  }

  if (!isRecoverableFailure(error)) {
    return
  }

  // Cool down the resource either way to avoid hammering a failing endpoint.
  resourceBlockedUntil.set(key, Date.now() + RESOURCE_COOLDOWN_MS)

  // Only a genuine tunnel/gateway outage warrants a Mac-host restart request.
  // A 401 is an auth problem (the StarGuard JWT is missing/expired) — restarting
  // the host cannot fix it and previously caused a 400+ crash "port 9899 in use"
  // restart loop. Auth failures get a cooldown only; re-auth must happen client-side.
  if (isTunnelFailure(error)) {
    markBackendOffline(`instance_${resource}_failure`)
  }
}

export function markBackendOnline(): void {
  if (!backendOnline) {
    log.info("Backend connectivity restored")
  }
  backendOnline = true
  resourceBlockedUntil.clear()
  inFlight.clear()
}

export function markBackendOffline(reason: string): void {
  if (backendOnline) {
    log.warn("Backend connectivity lost — pausing instance API calls", { reason })
  }
  backendOnline = false
  requestTunnelRestart(reason)
}

/** Queue Mac-mini tunnel restart (same-origin; host launchd consumer drains queue). */
export function requestTunnelRestart(reason: string): void {
  if (typeof window === "undefined") return

  const now = Date.now()
  if (now - lastTunnelRestartRequestAt < TUNNEL_RESTART_DEBOUNCE_MS) {
    return
  }
  lastTunnelRestartRequestAt = now

  log.info("Requesting CodeNomad tunnel restart", { reason })

  void serverApi
    .fetchTunnelRestartRequest({
      reason: reason.slice(0, 200),
      source: "codenomad_ui",
    })
    .catch(() => {
      // Non-fatal — Mac watchdog also polls tunnel health.
    })
}

/** @deprecated Use requestTunnelRestart — kept for call sites. */
export const requestTunnelRestartFromStarGuard = requestTunnelRestart
