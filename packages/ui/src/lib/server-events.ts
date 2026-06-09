import { batch as solidBatch } from "solid-js"
import type { WorkspaceEventPayload, WorkspaceEventType } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { getClientIdentity } from "./client-identity"
import { markBackendOffline, markBackendOnline } from "./connection-recovery"
import { connectWorkspaceEvents, type WorkspaceEventConnection } from "./event-transport"
import { getLogger } from "./logger"
import { retryWithBackoff, isRetryableError } from "./retry-utils"
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
  private connection: WorkspaceEventConnection | null = null
  private connectGeneration = 0
  private retryDelay = RETRY_BASE_DELAY
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Set when a disconnect scheduled a reconnect; cleared after reload or successful open. */
  private reloadOnNextOpen = false

  constructor() {
    void this.connect()
  }

  private async connect() {
    const generation = ++this.connectGeneration
    this.clearReconnectTimer()

    if (this.connection) {
      this.connection.disconnect()
      this.connection = null
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

    try {
      const connection = await connectWorkspaceEvents({
        onBatch: (events) => this.dispatchBatch(events),
        onError: () => {
          if (generation !== this.connectGeneration) {
            return
          }
          this.scheduleReconnect()
        },
        onOpen: () => {
          if (generation !== this.connectGeneration) {
            return
          }
          logSse("Events stream connected")
          this.retryDelay = RETRY_BASE_DELAY
          markBackendOnline()
          if (this.reloadOnNextOpen) {
            this.reloadOnNextOpen = false
            reloadAppAfterEventsReconnect()
            return
          }
          this.openHandlers.forEach((handler) => handler())
        },
        onPing: (payload) => {
          const identity = getClientIdentity()
          const pongPayload = { ...identity, pingTs: payload.ts }

          void retryWithBackoff(
            (signal) => serverApi.sendClientConnectionPong(pongPayload, signal),
            {
              maxAttempts: 3,
              initialDelayMs: 100,
              maxDelayMs: 2000,
              timeoutMs: 10000,
              shouldRetry: (error) => isRetryableError(error),
            },
          ).catch((error) => {
            log.warn("Failed to send client connection pong after retries", error)
          })
        },
      })

      if (generation !== this.connectGeneration) {
        connection.disconnect()
        return
      }

      this.connection = connection
    } catch (error) {
      if (generation !== this.connectGeneration) {
        return
      }

      logSse("Events stream failed to connect, scheduling reconnect", {
        error: error instanceof Error ? error.message : String(error),
      })
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.retryTimer) {
      return
    }

    this.reloadOnNextOpen = true
    markBackendOffline("sse_disconnect")

    if (this.connection) {
      this.connection.disconnect()
      this.connection = null
    }

    logSse("Events stream disconnected, scheduling reconnect", { delayMs: this.retryDelay })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_DELAY)
      void this.connect()
    }, this.retryDelay)
  }

  private clearReconnectTimer() {
    if (!this.retryTimer) {
      return
    }

    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private dispatch(event: WorkspaceEventPayload) {
    this.handlers.get("*")?.forEach((handler) => handler(event))
    this.handlers.get(event.type)?.forEach((handler) => handler(event))
  }

  private dispatchBatch(events: WorkspaceEventPayload[]) {
    if (events.length === 0) {
      return
    }

    logSse("event batch", { size: events.length })
    solidBatch(() => {
      for (const event of events) {
        this.dispatch(event)
      }
    })
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

  restart(reason = "manual restart"): void {
    this.retryDelay = RETRY_BASE_DELAY
    this.clearReconnectTimer()

    if (this.connection) {
      this.connection.disconnect()
      this.connection = null
    }

    logSse("Restarting backend events stream", { reason })
    void this.connect()
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
