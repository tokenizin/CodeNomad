/**
 * Reports AI usage to StarGuard for StarXP billing, via POST
 * /api/internal/ai-usage-event. Shared by every CodeNomad path that calls
 * an AI provider directly: the realtime-voice/concierge turn handler
 * (openai-realtime.ts) and the speech/ STT+TTS provider
 * (openai-compatible.ts).
 *
 * CodeNomad has no database connection of its own (no pg/kysely/prisma
 * dependency anywhere in this package) — StarXpUsageLedger and AiUsageEvent
 * live in StarGuard's Postgres, not here. This reports over HTTP through
 * apiPost (the same INTERNAL_API_KEY-authenticated client already used for
 * the orchestrator's StarGuard calls) instead of adding a direct DB
 * dependency to a service that has never needed one.
 *
 * Two mutually-exclusive pricing bases, matching the endpoint's contract:
 *  - `raw`: a provider response StarGuard extracts real token usage from
 *    (chat, realtime voice, transcription — anything token-priced).
 *  - `characterCount`: TTS synthesis, which returns no usage data at all —
 *    StarGuard prices this from OpenAI's own published per-character rate
 *    when the model has one (tts-1/tts-1-hd), or measures the occurrence
 *    without pricing it when it doesn't (gpt-4o-mini-tts) — see that
 *    endpoint's module doc for why it doesn't get priced.
 *
 * Fire-and-forget by design, matching the rest of this codebase's metering
 * philosophy: a StarGuard outage or a slow response must never delay or
 * break a turn already delivered to the user. Every failure is caught and
 * logged, never thrown.
 */

import { apiPost } from '../plugins/tokidapp/orchestrator/starguard-client'

export interface ReportAiUsageInput {
  userId: string
  modelId: string
  provider: string
  /** Idempotency key — stable per call so a retry can't double-bill. */
  requestId: string
  /** Raw provider response (or the relevant slice of it) usage is extracted from — token-priced calls. */
  raw?: unknown
  /** Input text length — character-priced calls (TTS synthesis). */
  characterCount?: number
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
