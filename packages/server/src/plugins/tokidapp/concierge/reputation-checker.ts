/**
 * Agent Reputation Checker — looks up an external agent's on-chain reputation
 * via the three.ws registry before a human operator decides whether to engage it.
 *
 * This is an informational lookup only — nothing automatic depends on its result.
 * Real money per call (~$0.001 USDC), so a per-day call ceiling prevents runaway
 * spend.
 *
 * See SCR-2026-09-05-001 for the full design rationale.
 */

import { apiPost } from '../orchestrator/starguard-client.js'

/** Three.ws API base — confirm before wiring; the API is not assumed stable. */
function getThreeWsBase(): string {
  return process.env.THREE_WS_API_BASE || 'https://api.three.ws'
}

function getThreeWsKey(): string | undefined {
  return process.env.THREE_WS_API_KEY
}

/** Per-day call ceiling. Default 50 — at ~$0.001/call that's ~$0.05/day max. */
function getMaxCallsPerDay(): number {
  return Number(process.env.REPUTATION_CHECK_MAX_DAILY ?? 50)
}

/** In-memory per-day call counter. Resets on process restart. */
let callsToday = 0
let counterDate = new Date().toDateString()

function resetCounterIfNewDay(): void {
  const today = new Date().toDateString()
  if (today !== counterDate) {
    callsToday = 0
    counterDate = today
  }
}

/** Minimum reputation score (0–10000) to be considered "trusted". Default 5000. */
function getTrustThreshold(): number {
  return Number(process.env.REPUTATION_TRUST_THRESHOLD ?? 5000)
}

export interface AgentReputationResult {
  agentId: string
  score: number
  completedTasks: number
  disputes: number
  stakedUsdc: number
  trusted: boolean
  raw?: unknown
}

/**
 * Look up an agent's reputation on the three.ws registry.
 * Returns a plain-text summary suitable for voice/chat output.
 */
export async function checkAgentReputation(agentId: string): Promise<string> {
  if (!agentId || agentId.trim().length === 0) {
    return 'Please provide an agent identifier to look up.'
  }

  resetCounterIfNewDay()
  if (callsToday >= getMaxCallsPerDay()) {
    await logReputationCall(agentId, 'budget_exhausted', null)
    return `Daily reputation lookup limit reached (${getMaxCallsPerDay()}/day). Try again tomorrow.`
  }

  const apiKey = getThreeWsKey()
  if (!apiKey) {
    await logReputationCall(agentId, 'error', { error: 'THREE_WS_API_KEY not set' })
    return 'Agent reputation lookup is not configured — set THREE_WS_API_KEY to enable it.'
  }

  callsToday++

  try {
    const response = await fetch(`${getThreeWsBase()}/v1/agents/${encodeURIComponent(agentId)}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      await logReputationCall(agentId, 'error', { status: response.status, error: errorBody.slice(0, 500) })
      if (response.status === 404) {
        return `Agent "${agentId}" not found on the three.ws registry.`
      }
      return `Reputation lookup failed (HTTP ${response.status}). ${errorBody.slice(0, 200)}`
    }

    const data = await response.json() as Record<string, unknown>
    const result = parseReputationData(agentId, data)

    await logReputationCall(agentId, 'success', { score: result.score, trusted: result.trusted })

    return formatReputationResult(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logReputationCall(agentId, 'error', { error: message.slice(0, 500) })
    return `Reputation lookup error: ${message.slice(0, 200)}`
  }
}

function parseReputationData(agentId: string, data: Record<string, unknown>): AgentReputationResult {
  // The three.ws API shape is not yet confirmed — parse defensively.
  const score = Number(data.score ?? data.reputation_score ?? 0)
  const completedTasks = Number(data.completed_tasks ?? data.tasksCompleted ?? 0)
  const disputes = Number(data.disputes ?? data.dispute_count ?? 0)
  const stakedUsdc = Number(data.staked ?? data.staked_amount ?? 0)

  return {
    agentId,
    score,
    completedTasks,
    disputes,
    stakedUsdc,
    trusted: score >= getTrustThreshold(),
    raw: data,
  }
}

function formatReputationResult(r: AgentReputationResult): string {
  const trustLabel = r.trusted ? 'TRUSTED' : 'NOT TRUSTED'
  return [
    `Agent: ${r.agentId}`,
    `Reputation score: ${r.score}/10000 (${trustLabel})`,
    `Completed tasks: ${r.completedTasks}`,
    `Disputes: ${r.disputes}`,
    `Staked: ${r.stakedUsdc} USDC`,
    `Threshold: ${getTrustThreshold()} (trusted if score ≥ threshold)`,
  ].join('. ')
}

/** Log every call via the existing StarGuard events pattern. */
async function logReputationCall(
  agentId: string,
  outcome: 'success' | 'error' | 'budget_exhausted',
  details: Record<string, unknown> | null,
): Promise<void> {
  try {
    await apiPost('/api/tokidapp/events', {
      type: 'reputation_check',
      agentId,
      outcome,
      details,
      timestamp: new Date().toISOString(),
    })
  } catch {
    // Logging is best-effort — never fail the tool call because logging failed.
  }
}

/** Reset the daily counter (for testing). */
export function _resetDailyCounter(): void {
  callsToday = 0
  counterDate = new Date().toDateString()
}