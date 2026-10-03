/**
 * Plugin-side adapter for the CodeNomad Jev tool gate.
 *
 * The plugin holds no credential and no policy — it asks the server over the
 * existing authenticated plugin channel and applies only what the server marks
 * `enforced`. Every failure path resolves to `null`, and a `null` verdict means
 * "leave OpenCode's own decision alone".
 */

export type JevAction = "allow" | "ask" | "deny"
export type JevStatus = "ok" | "degraded" | "disabled"

export interface JevVerdict {
  status: JevStatus
  action: JevAction
  enforced: boolean
  reason: string
  degradedReason?: string | null
  scores?: Record<string, unknown>
  latencyMs?: number
  model?: string | null
  cached?: boolean
}

export interface JevPendingAction {
  kind: string
  target?: string | string[]
  title?: string
  detail?: string
  sessionId?: string
}

type Requester = { requestJson: <T>(path: string, init?: RequestInit) => Promise<T> }

const MAX_SHADOW_INFLIGHT = 4
const SHADOW_TIMEOUT_MS = 2500

export function createToolGateClient(requester: Requester) {
  let shadowInFlight = 0

  async function classify(action: JevPendingAction, baseline?: JevAction): Promise<JevVerdict | null> {
    try {
      const verdict = await requester.requestJson<JevVerdict>("/jev/tool-gate", {
        method: "POST",
        body: JSON.stringify({ ...action, baseline }),
      })
      return normalizeVerdict(verdict)
    } catch {
      // The gate is advisory infrastructure: a transport failure must never become
      // a tool-execution failure.
      return null
    }
  }

  /**
   * Observe a tool call that produced no permission prompt. Fire-and-forget by
   * design, bounded so a slow feed cannot pile up in the agent loop.
   */
  function observe(action: JevPendingAction, onVerdict: (verdict: JevVerdict | null) => void): void {
    if (shadowInFlight >= MAX_SHADOW_INFLIGHT) {
      onVerdict(null)
      return
    }
    shadowInFlight += 1
    void classify(action)
      .then(onVerdict)
      .catch(() => onVerdict(null))
      .finally(() => {
        shadowInFlight -= 1
      })
  }

  return { classify, observe, shadowTimeoutMs: SHADOW_TIMEOUT_MS }
}

function normalizeVerdict(value: unknown): JevVerdict | null {
  if (!value || typeof value !== "object") return null
  const verdict = value as Record<string, unknown>
  if (typeof verdict.action !== "string") return null
  if (!["allow", "ask", "deny"].includes(verdict.action)) return null
  if (verdict.status !== "ok" && verdict.status !== "degraded" && verdict.status !== "disabled") return null

  return {
    status: verdict.status,
    action: verdict.action as JevAction,
    enforced: verdict.enforced === true,
    reason: typeof verdict.reason === "string" ? verdict.reason : "jev-unknown",
    degradedReason: typeof verdict.degradedReason === "string" ? verdict.degradedReason : null,
    scores: typeof verdict.scores === "object" && verdict.scores ? (verdict.scores as Record<string, unknown>) : undefined,
    latencyMs: typeof verdict.latencyMs === "number" ? verdict.latencyMs : undefined,
    model: typeof verdict.model === "string" ? verdict.model : null,
    cached: verdict.cached === true,
  }
}