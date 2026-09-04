/**
 * Reports one realtime-voice turn's token usage to StarGuard for StarXP
 * billing, via POST /api/internal/ai-usage-event.
 *
 * CodeNomad has no database connection of its own (no pg/kysely/prisma
 * dependency anywhere in this package) — StarXpUsageLedger and AiUsageEvent
 * live in StarGuard's Postgres, not here. This reports over HTTP through
 * apiPost (the same INTERNAL_API_KEY-authenticated client already used for
 * the orchestrator's StarGuard calls) instead of adding a direct DB
 * dependency to a service that has never needed one.
 *
 * Fire-and-forget by design, matching the rest of this codebase's metering
 * philosophy: a StarGuard outage or a slow response must never delay or
 * break a voice turn already delivered to the user. Every failure is
 * caught and logged, never thrown.
 */

import { apiPost } from '../orchestrator/starguard-client'

export interface ReportAiUsageInput {
  userId: string
  modelId: string
  provider: string
  /** Idempotency key — stable per turn so a retry can't double-bill. */
  requestId: string
  /** Raw provider response (or the relevant slice of it) usage is extracted from. */
  raw: unknown
}

export async function reportAiUsage(input: ReportAiUsageInput): Promise<void> {
  try {
    const res = await apiPost('/api/internal/ai-usage-event', input)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(
        `[ai-usage-report] StarGuard returned ${res.status} for requestId=${input.requestId} (non-fatal):`,
        body.slice(0, 200),
      )
    }
  } catch (err) {
    console.warn(
      `[ai-usage-report] failed to report usage for requestId=${input.requestId} (non-fatal):`,
      err instanceof Error ? err.message : err,
    )
  }
}
