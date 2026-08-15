/**
 * AI usage metering for the voice engines.
 *
 * The counterpart to the sidecar's `lib/usage-metering.ts`. It is a separate
 * implementation rather than a shared import because this package talks to
 * Postgres through Kysely and the sidecar through raw `pg`; they share the
 * table and the rules, not the code.
 *
 * Two rules, the same as the sidecar's:
 *
 *  1. Metering never breaks a conversation. Every write is best-effort — a
 *     database outage degrades billing accuracy, it does not drop the call.
 *  2. Estimated counts are labelled as estimates. A provider-reported count and
 *     a length-based guess differ severalfold on short turns, so a row that was
 *     guessed must never be mistaken for a row that was measured.
 */

import { getTokidappDb } from './db'

export type AiUsageEventType =
  | 'GENERATION'
  | 'TOOL_CALL'
  | 'TOOLKIT_UNLOCK'
  | 'RECONCILIATION_ADJUSTMENT'

export type AiUsageSource = 'PROVIDER_REPORTED' | 'ESTIMATED'

/**
 * The text/audio split of a turn's tokens, when the provider reports one.
 *
 * Realtime prices audio tokens roughly an order of magnitude above text, so a
 * row carrying only totals cannot be priced correctly — applying one rate per
 * token to a mostly-audio turn understates it severalfold.
 *
 * Every bucket is independently nullable, and null means "not reported", never
 * zero. Chat Completions is the reason: it reports `audio_tokens` with no
 * matching `text_tokens`, and deriving the remainder would silently fold image
 * tokens into the text bucket.
 */
export interface TokenDetails {
  promptTextTokens: number | null
  promptAudioTokens: number | null
  completionTextTokens: number | null
  completionAudioTokens: number | null
  /** A discounted *subset* of promptTokens, overlapping the split above. */
  promptCachedTokens: number | null
}

export interface ResolvedUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  usageSource: AiUsageSource
  /** Absent when the provider reported totals only. */
  details?: TokenDetails
}

/** Postgres unique-violation code — a replayed requestId, not a real failure. */
const UNIQUE_VIOLATION = '23505'

/**
 * Ollama `/api/chat` reports counts at the top level of the body when
 * `stream:false`, and only on the terminal `done:true` chunk when streaming.
 */
export function ollamaUsage(data: unknown): ResolvedUsage | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const promptTokens = Number(d.prompt_eval_count ?? 0) || 0
  const completionTokens = Number(d.eval_count ?? 0) || 0
  if (!promptTokens && !completionTokens) return null
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    usageSource: 'PROVIDER_REPORTED',
  }
}

/** Read a reported count, distinguishing "absent" from "zero". */
function count(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/**
 * Pull the text/audio breakdown out of an OpenAI usage block.
 *
 * Realtime calls these `input_token_details`/`output_token_details`; Chat
 * Completions calls the same thing `prompt_tokens_details`/
 * `completion_tokens_details`. Both spellings are read, the same way the totals
 * above accept both of that API's namings.
 */
function tokenDetails(usage: Record<string, unknown>): TokenDetails | undefined {
  const input = asObject(usage.input_token_details ?? usage.prompt_tokens_details)
  const output = asObject(usage.output_token_details ?? usage.completion_tokens_details)
  if (!input && !output) return undefined

  const details: TokenDetails = {
    promptTextTokens: count(input?.text_tokens),
    promptAudioTokens: count(input?.audio_tokens),
    completionTextTokens: count(output?.text_tokens),
    completionAudioTokens: count(output?.audio_tokens),
    promptCachedTokens: count(input?.cached_tokens),
  }
  // An empty details object reports nothing; recording it would claim a
  // breakdown exists and price the row as "no audio".
  return Object.values(details).some((v) => v !== null) ? details : undefined
}

/**
 * OpenAI-shaped usage. Covers both the Chat Completions body
 * (`prompt_tokens`/`completion_tokens`) and the Realtime `response.done`
 * payload (`input_tokens`/`output_tokens`), which name the same two counts
 * differently.
 */
export function openAiUsage(data: unknown): ResolvedUsage | null {
  if (!data || typeof data !== 'object') return null
  const u = (data as Record<string, unknown>).usage ?? data
  if (!u || typeof u !== 'object') return null
  const d = u as Record<string, unknown>
  const promptTokens = Number(d.prompt_tokens ?? d.input_tokens ?? 0) || 0
  const completionTokens = Number(d.completion_tokens ?? d.output_tokens ?? 0) || 0
  if (!promptTokens && !completionTokens) return null
  const details = tokenDetails(d)
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    usageSource: 'PROVIDER_REPORTED',
    ...(details ? { details } : {}),
  }
}

/**
 * Rough token estimate for providers that report nothing. Deliberately crude —
 * it exists to keep a row from being zero, and every row it produces is
 * labelled ESTIMATED so it can be excluded from anything that bills.
 */
export function estimateUsage(promptText: string, completionText: string): ResolvedUsage {
  const promptTokens = promptText ? Math.ceil(promptText.length / 4) : 0
  const completionTokens = completionText ? Math.ceil(completionText.length / 4) : 0
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    usageSource: 'ESTIMATED',
  }
}

/** What a voice turn needs to attribute a generation, held on every session. */
export interface VoiceUsageContext {
  chatSessionId?: string | null
  userId?: string | null
  agentSessionId?: string | null
}

/**
 * Meter one voice turn: prefer the provider's counts, estimate from text when
 * it reported none, and write the row. Fire-and-forget by design — call sites
 * are inside an audio pipeline, so this returns immediately and never rejects.
 */
export function meterVoiceTurn(args: {
  ctx: VoiceUsageContext
  /** The model that ran *this* turn — fallback chains change it per call. */
  modelId: string
  provider?: string | null
  eventType?: AiUsageEventType
  /** Counts the provider reported, or null to fall back to an estimate. */
  usage?: ResolvedUsage | null
  /** The provider's own id for this response, when it has one. See below. */
  requestId?: string | null
  promptText?: string
  completionText?: string
}): void {
  const usage =
    args.usage ?? estimateUsage(args.promptText ?? '', args.completionText ?? '')

  void recordAiUsage({
    userId: args.ctx.userId,
    tokidappSessionId: args.ctx.chatSessionId,
    agentSessionId: args.ctx.agentSessionId,
    modelId: args.modelId,
    provider: args.provider,
    eventType: args.eventType,
    requestId: args.requestId ?? undefined,
    usage,
  })
}

export interface VoiceMeterInput {
  /** Omit when unknown — it is resolved from the chat session instead. */
  userId?: string | null
  /** TokiDAPPSession.id. Required when userId is absent, to resolve the owner. */
  tokidappSessionId?: string | null
  agentSessionId?: string | null
  /**
   * The model that actually ran this turn. Two engines pick per turn through a
   * fallback chain, so this belongs to the event, never to the session.
   */
  modelId: string
  provider?: string | null
  eventType?: AiUsageEventType
  /** Idempotency key. Supply the provider's response id to make replays safe. */
  requestId?: string
  usage: ResolvedUsage
}

function fk(id: string | null | undefined): string | null {
  return id ? id : null
}

/**
 * Settle on the idempotency key for a row.
 *
 * A key the provider owns — its response id — makes a redelivered event collide
 * on the unique index instead of billing the turn twice. A blank one must fall
 * back to a fresh key rather than being used as-is: a constant key lands the
 * first row and then collides forever, and since a collision is treated as
 * "already recorded", every turn after the first would silently bill nothing.
 *
 * Pass a provider id only when BOTH hold: the response can genuinely arrive
 * twice, and its id is genuinely unique. Only the Realtime socket event
 * qualifies. A `/v1/chat/completions` reply fails both tests — it is returned
 * once from an awaited fetch with no redelivery path, and Ollama's
 * OpenAI-compatible endpoint (the primary provider in both voice LLM chains)
 * numbers its responses `chatcmpl-<0..999>`; sampling it locally returns
 * `chatcmpl-8`, `chatcmpl-41`, `chatcmpl-666`. Across ~1000 keys a collision is
 * likelier than not inside 40 turns, and a collision reads as "already
 * recorded" — so keying on it would quietly stop billing mid-session in
 * exchange for guarding against a replay that cannot happen.
 */
export function resolveRequestId(supplied?: string | null): string {
  const key = typeof supplied === 'string' ? supplied.trim() : ''
  return key || `voice_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Whether a resolved usage is worth a row.
 *
 * An all-zero *estimate* is not a measurement of nothing, it is the absence of
 * a measurement: the provider reported no usage and the call site had no text
 * to fall back on. That is what an interrupted or cancelled realtime response
 * looks like — the OpenAI site passes no promptText, so `estimateUsage('','')`
 * yields 0/0/0. Writing it puts a turn in the ledger that reads as "metered,
 * cost nothing" when it was never metered at all.
 *
 * A PROVIDER_REPORTED zero is kept: the provider actually said zero.
 */
export function isRecordableUsage(usage: ResolvedUsage): boolean {
  return usage.totalTokens > 0 || usage.usageSource === 'PROVIDER_REPORTED'
}

/**
 * Record one voice turn's usage. Returns true when a row landed.
 *
 * Never throws: callers are inside an audio pipeline where an exception would
 * cut off the conversation mid-sentence.
 */
export async function recordAiUsage(input: VoiceMeterInput): Promise<boolean> {
  if (!isRecordableUsage(input.usage)) return false
  const requestId = resolveRequestId(input.requestId)

  try {
    const db = getTokidappDb()

    let userId = input.userId ?? undefined
    if (!userId) {
      const chatId = fk(input.tokidappSessionId)
      if (!chatId) return false // nothing to attribute to, and no owner to look up
      const owner = await db
        .selectFrom('TokiDAPPSession')
        .select('userId')
        .where('id', '=', chatId)
        .executeTakeFirst()
      userId = owner?.userId
    }
    if (!userId) return false

    await db
      .insertInto('AiUsageEvent')
      .values({
        id: `usage_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        userId,
        tokidappSessionId: fk(input.tokidappSessionId),
        agentSessionId: fk(input.agentSessionId),
        modelId: input.modelId,
        provider: input.provider ?? null,
        eventType: input.eventType ?? 'GENERATION',
        promptTokens: input.usage.promptTokens,
        completionTokens: input.usage.completionTokens,
        totalTokens: input.usage.totalTokens,
        usageSource: input.usage.usageSource,
        // Null across the board when the provider reported no breakdown — the
        // pricer reads that as "flat rate", not as "this turn had no audio".
        promptTextTokens: input.usage.details?.promptTextTokens ?? null,
        promptAudioTokens: input.usage.details?.promptAudioTokens ?? null,
        completionTextTokens: input.usage.details?.completionTextTokens ?? null,
        completionAudioTokens: input.usage.details?.completionAudioTokens ?? null,
        promptCachedTokens: input.usage.details?.promptCachedTokens ?? null,
        starXpCost: null,
        requestId,
        createdAt: new Date(),
      })
      .execute()
    return true
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === UNIQUE_VIOLATION) return true // already recorded; the retry is the duplicate
    console.error('[ai-usage] failed to record usage for', input.modelId, '—', (err as Error).message)
    return false
  }
}
