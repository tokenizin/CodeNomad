import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { getClientIdentity } from "./client-identity"
import { markBackendOffline, markBackendOnline } from "./connection-recovery"
import { getLogger } from "./logger"
import { storeStarGuardToken, starGuardToken } from "../stores/session-recovery"
import { captureStarGuardTokenFromHash, getStarGuardBearerToken } from "./starguard-auth"

const RETRY_BASE_DELAY = 1000
const RETRY_MAX_DELAY = 10000
/** Avoid reload loops when the tunnel watchdog flaps. */
const RELOAD_AFTER_RECONNECT_COOLDOWN_MS = 30_000
const RELOAD_AFTER_RECONNECT_KEY = "codenomad_sse_reload_ts"
const log = getLogger("sse")

function reloadAppAfterEventsReconnect(): void {
  if (typeof window === "undefined") return
  const last = Number(sessionStorage.getItem(RELOAD_AFTER_RECONNECT_KEY) || 0)
  if (Date.now() - last < RELOAD_AFTER_RECONNECT_COOLDOWN_MS) {
    logSse("Skipping reload after reconnect (cooldown)")
    return
  }
  sessionStorage.setItem(RELOAD_AFTER_RECONNECT_KEY, String(Date.now()))
  logSse("Events stream reconnected — reloading app")
  window.location.reload()
}

function logSse(message: string, context?: Record<string, unknown>) {
  if (context) {
    log.info(message, context)
    return
  }
  log.info(message)
}

class ServerEvents {
  private handlers = new Map<WorkspaceEventType | "*", Set<(event: WorkspaceEventPayload) => void>>()
  private openHandlers = new Set<() => void>()
  private source: EventSource | null = null
  private retryDelay = RETRY_BASE_DELAY
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Set when a disconnect scheduled a reconnect; cleared after reload or successful open. */
  private reloadOnNextOpen = false

  constructor() {
    this.connect()
  }

  private connect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.source) {
      this.source.close()
    }

    // Capture StarGuard token from URL hash on initial connection so it is
    // persisted across page reloads for automatic reconnection later.
    if (!starGuardToken()) {
      captureStarGuardTokenFromHash()
      const token = getStarGuardBearerToken()
      if (token) {
        storeStarGuardToken(token)
        logSse("Captured StarGuard token for session recovery")
      }
    }

    logSse("Connecting to backend events stream")
    this.source = serverApi.connectEvents(
      (event) => this.dispatch(event),
      () => this.scheduleReconnect(),
      (payload) => {
        void serverApi
          .sendClientConnectionPong({
            ...getClientIdentity(),
            pingTs: payload.ts,
          })
          .catch((error) => {
            log.error("Failed to send client connection pong", error)
          })
      },
    )
    this.source.onopen = () => {
      logSse("Events stream connected")
      this.retryDelay = RETRY_BASE_DELAY
      markBackendOnline()
      if (this.reloadOnNextOpen) {
        this.reloadOnNextOpen = false
        reloadAppAfterEventsReconnect()
        return
      }
      this.openHandlers.forEach((handler) => handler())
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) {
      return
    }
    this.reloadOnNextOpen = true
    markBackendOffline("sse_disconnect")
    const source = this.source
    this.source = null
    logSse("Events stream disconnected, scheduling reconnect", { delayMs: this.retryDelay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_DELAY)
      this.connect()
    }, this.retryDelay)
    source?.close()
  }

  private dispatch(event: WorkspaceEventPayload) {
    logSse(`event ${event.type}`)
    this.handlers.get("*")?.forEach((handler) => handler(event))
    this.handlers.get(event.type)?.forEach((handler) => handler(event))
  }

  on(type: WorkspaceEventType | "*", handler: (event: WorkspaceEventPayload) => void): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    const bucket = this.handlers.get(type)!
    bucket.add(handler)
    return () => bucket.delete(handler)
  }

  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler)
    return () => this.openHandlers.delete(handler)
  }
}

export const serverEvents = new ServerEvents()

/**
 * Returns the StarGuard token persisted in the session-recovery store
 * (localStorage). Used by the reconnection manager to attempt automatic
 * re-auth after an SSE disconnect.
 */
export function getStoredStarGuardToken(): string | null {
  return starGuardToken()
}
