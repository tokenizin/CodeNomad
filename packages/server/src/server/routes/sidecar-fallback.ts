/**
 * Sidecar proxy fallback layer.
 *
 * Wraps calls to the tokidapp-server sidecar (:8548) with graceful degradation.
 * When the sidecar is unreachable (timeout, 502, connection refused), each route
 * returns a fallback response instead of a hard failure.
 *
 * Fallback responses:
 * - Read-only queries (GET): return empty data + 503 Retry-After
 * - Write operations (POST/PUT/DELETE): return 503 Retry-After with guidance
 * - Critical paths (session creation): handled directly in CodeNomad
 */

const SIDECAR_BASE = process.env.TOKIDAPP_SIDECAR_URL || "http://127.0.0.1:8548"
const PROXY_TIMEOUT_MS = 10_000
const RETRY_AFTER_SECONDS = 30

export type FallbackStrategy = "empty" | "retry" | "message" | "direct"

interface FallbackConfig {
  strategy: FallbackStrategy
  /** For "message" strategy: the JSON body to return. */
  body?: Record<string, unknown>
  /** For "empty" strategy: the shape of an empty response. */
  empty?: Record<string, unknown>
}

/** Per-route fallback configuration. */
export const FALLBACKS: Record<string, FallbackConfig> = {
  // ── Chat (SSE streaming — can't be proxied when sidecar is down) —
  "POST /api/tokidapp/chat": {
    strategy: "message",
    body: {
      error: "Chat service temporarily unavailable",
      message:
        "The concierge chat service is currently offline for maintenance. " +
        "Please try again in a moment, or open Star World Chat at chat.tokenizin.com " +
        "which may still be serving cached sessions.",
      retryAfter: RETRY_AFTER_SECONDS,
      offline: true,
    },
  },

  // ── Sessions (read-only) —
  "GET /api/tokidapp/sessions": {
    strategy: "empty",
    empty: { sessions: [], total: 0, limit: 50, offset: 0 },
  },
  "GET /api/tokidapp/sessions/:id": {
    strategy: "message",
    body: { error: "Session detail unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "PATCH /api/tokidapp/sessions/:id": {
    strategy: "message",
    body: { error: "Session updates temporarily unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "DELETE /api/tokidapp/sessions/:id": {
    strategy: "message",
    body: { error: "Session deletion temporarily unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "POST /api/tokidapp/sessions/purge-empty": {
    strategy: "message",
    body: { error: "Purge temporarily unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "POST /api/tokidapp/sessions/:id/finalize": {
    strategy: "message",
    body: { error: "Finalization temporarily unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Messages —
  "POST /api/tokidapp/messages": {
    strategy: "message",
    body: { error: "Message sending temporarily unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "GET /api/tokidapp/messages": {
    strategy: "empty",
    empty: { messages: [] },
  },

  // ── Orchestrator —
  "POST /api/tokidapp/orchestrator": {
    strategy: "message",
    body: { error: "Orchestrator temporarily unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "GET /api/tokidapp/orchestrator": {
    strategy: "empty",
    empty: { sessions: [] },
  },
  "GET /api/tokidapp/orchestrator/:id": {
    strategy: "message",
    body: { error: "Orchestrator detail unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "PUT /api/tokidapp/orchestrator/:id": {
    strategy: "message",
    body: { error: "Orchestrator update unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "DELETE /api/tokidapp/orchestrator/:id": {
    strategy: "message",
    body: { error: "Orchestrator deletion unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Approvals —
  "GET /api/tokidapp/approvals": {
    strategy: "empty",
    empty: { approvals: [] },
  },
  "POST /api/tokidapp/approvals": {
    strategy: "message",
    body: { error: "Approval submission unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "GET /api/tokidapp/approvals/:id": {
    strategy: "message",
    body: { error: "Approval detail unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "PUT /api/tokidapp/approvals/:id": {
    strategy: "message",
    body: { error: "Approval update unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Tasks —
  "GET /api/tokidapp/tasks": {
    strategy: "empty",
    empty: { tasks: [] },
  },
  "POST /api/tokidapp/tasks": {
    strategy: "message",
    body: { error: "Task creation unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "GET /api/tokidapp/tasks/:id": {
    strategy: "message",
    body: { error: "Task detail unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "PUT /api/tokidapp/tasks/:id": {
    strategy: "message",
    body: { error: "Task update unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "POST /api/tokidapp/tasks/:id/assign": {
    strategy: "message",
    body: { error: "Task assignment unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Workflows —
  "POST /api/tokidapp/workflows": {
    strategy: "message",
    body: { error: "Workflow creation unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "DELETE /api/tokidapp/workflows": {
    strategy: "message",
    body: { error: "Workflow deletion unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "GET /api/tokidapp/workflows/:slug/dag": {
    strategy: "message",
    body: { error: "Workflow DAG unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "POST /api/tokidapp/workflows/:slug/dag": {
    strategy: "message",
    body: { error: "Workflow DAG save unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Causal graph —
  "GET /api/tokidapp/causal-graph": {
    strategy: "empty",
    empty: { nodes: [], edges: [] },
  },
  "GET /api/tokidapp/causal-graph/:id": {
    strategy: "message",
    body: { error: "Causal graph unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Events —
  "GET /api/tokidapp/events": {
    strategy: "empty",
    empty: { events: [] },
  },
  "POST /api/tokidapp/events": {
    strategy: "message",
    body: { error: "Event logging unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Context —
  "GET /api/tokidapp/context": {
    strategy: "empty",
    empty: { context: {} },
  },
  "POST /api/tokidapp/context/compact": {
    strategy: "message",
    body: { error: "Context compact unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "PUT /api/tokidapp/context/system-prompt": {
    strategy: "message",
    body: { error: "System prompt update unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Models —
  "GET /api/tokidapp/models": {
    strategy: "empty",
    empty: { models: [] },
  },

  // ── Analytics —
  "GET /api/tokidapp/analytics": {
    strategy: "message",
    body: { error: "Analytics unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Attention —
  "GET /api/tokidapp/attention": {
    strategy: "empty",
    empty: { items: [] },
  },

  // ── Connectors —
  "GET /api/tokidapp/connectors": {
    strategy: "empty",
    empty: { connectors: [] },
  },

  // ── Delegations —
  "GET /api/tokidapp/delegations": {
    strategy: "empty",
    empty: { delegations: [] },
  },
  "POST /api/tokidapp/delegations": {
    strategy: "message",
    body: { error: "Delegation unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "POST /api/tokidapp/delegations/draft": {
    strategy: "message",
    body: { error: "Delegation draft unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "GET /api/tokidapp/delegations/:id": {
    strategy: "message",
    body: { error: "Delegation detail unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "GET /api/tokidapp/delegations/:id/stream": {
    strategy: "message",
    body: { error: "Delegation stream unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Agents —
  "POST /api/tokidapp/agents/spawn": {
    strategy: "message",
    body: { error: "Agent spawn unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "GET /api/tokidapp/agents": {
    strategy: "empty",
    empty: { agents: [] },
  },
  "GET /api/tokidapp/commands": {
    strategy: "empty",
    empty: { commands: [] },
  },
  "GET /api/tokidapp/nomadworks/catalog": {
    strategy: "empty",
    empty: { catalog: [] },
  },

  // ── Approvals (chat) —
  "GET /api/tokidapp/chat/approvals": {
    strategy: "empty",
    empty: { approvals: [] },
  },
  "POST /api/tokidapp/chat/approve": {
    strategy: "message",
    body: { error: "Approval unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Deploy status —
  "GET /api/tokidapp/deploy-status": {
    strategy: "empty",
    empty: { status: "unknown" },
  },

  // ── Recordings —
  "GET /api/tokidapp/recordings": {
    strategy: "empty",
    empty: { recordings: [] },
  },
  "POST /api/tokidapp/recordings": {
    strategy: "message",
    body: { error: "Recording unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "GET /api/tokidapp/recordings/:id/audio": {
    strategy: "message",
    body: { error: "Recording audio unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "POST /api/tokidapp/recordings/upload": {
    strategy: "message",
    body: { error: "Recording upload unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "POST /api/tokidapp/recordings/handle-upload": {
    strategy: "message",
    body: { error: "Recording upload unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "DELETE /api/tokidapp/recordings/cleanup": {
    strategy: "message",
    body: { error: "Recording cleanup unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Files —
  "POST /api/tokidapp/files/upload": {
    strategy: "message",
    body: { error: "File upload unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "POST /api/tokidapp/files/handle-upload": {
    strategy: "message",
    body: { error: "File upload unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "POST /api/tokidapp/files/extract": {
    strategy: "message",
    body: { error: "File extraction unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "GET /api/tokidapp/files/artifacts": {
    strategy: "empty",
    empty: { artifacts: [] },
  },
  "GET /api/tokidapp/files/artifacts/:id": {
    strategy: "message",
    body: { error: "Artifact detail unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },

  // ── Attachments —
  "POST /api/tokidapp/attachments/url": {
    strategy: "message",
    body: { error: "Attachment fetch unavailable", retryAfter: RETRY_AFTER_SECONDS },
  },
  "GET /api/tokidapp/attachments/documents": {
    strategy: "empty",
    empty: { documents: [] },
  },
}

/** Build a route key for fallback lookup. */
function routeKey(method: string, path: string): string {
  return `${method} ${path}`
}

/**
 * Get fallback response for a route. Returns null if no fallback configured.
 */
export function getFallback(method: string, path: string): FallbackConfig | null {
  // Try exact match first
  const key = routeKey(method, path)
  if (FALLBACKS[key]) return FALLBACKS[key]

  // Try pattern match for :param routes
  for (const [pattern, config] of Object.entries(FALLBACKS)) {
    const [m, p] = pattern.split(" ")
    if (m !== method) continue
    if (!p.includes(":")) continue
    const regex = new RegExp("^" + p.replace(/:[^/]+/g, "[^/]+") + "$")
    if (regex.test(path)) return config
  }

  return null
}

export interface ProxyResult {
  ok: boolean
  status: number
  headers: Headers
  json: () => Promise<any>
  text: () => Promise<string>
}

/**
 * Proxy a request to the sidecar with fallback on failure.
 *
 * @param method HTTP method
 * @param path Request path (e.g. /api/tokidapp/sessions)
 * @param options Additional fetch options
 * @param options.body Request body
 * @param options.headers Request headers
 * @param options.fallback Fallback config (looked up automatically if omitted)
 * @returns ProxyResult with ok=false if fallback was used
 */
export async function proxyWithFallback(
  method: string,
  path: string,
  options: {
    body?: string
    headers?: Record<string, string>
    fallback?: FallbackConfig | null
  } = {},
): Promise<ProxyResult> {
  const { body, headers } = options
  const fallback = options.fallback !== undefined ? options.fallback : getFallback(method, path)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)

    const res = await fetch(`${SIDECAR_BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body,
      signal: controller.signal,
    })

    clearTimeout(timer)

    return {
      ok: true,
      status: res.status,
      headers: res.headers,
      json: () => res.json(),
      text: () => res.text(),
    }
  } catch (err) {
    // Sidecar unreachable — use fallback
    if (!fallback) {
      return {
        ok: false,
        status: 503,
        headers: new Headers({
          "Retry-After": String(RETRY_AFTER_SECONDS),
          "X-Sidecar-Status": "offline",
        }),
        json: async () => ({
          error: "Service temporarily unavailable",
          retryAfter: RETRY_AFTER_SECONDS,
        }),
        text: async () => "Service unavailable",
      }
    }

    let responseBody: Record<string, unknown>
    switch (fallback.strategy) {
      case "empty":
        responseBody = fallback.empty || {}
        break
      case "message":
        responseBody = fallback.body || { error: "Service unavailable" }
        break
      case "retry":
        responseBody = {
          error: "Service temporarily unavailable",
          retryAfter: RETRY_AFTER_SECONDS,
        }
        break
      default:
        responseBody = { error: "Service unavailable" }
    }

    return {
      ok: false,
      status: 503,
      headers: new Headers({
        "Content-Type": "application/json",
        "Retry-After": String(RETRY_AFTER_SECONDS),
        "X-Sidecar-Status": "offline",
      }),
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    }
  }
}
