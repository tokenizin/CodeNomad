/**
 * StarXP voice usage debit — the Kysely-based, voice-path counterpart to
 * atomicDebit() in scripts/tokidapp-server/lib/starxp-debit.ts (referenced
 * there but never actually built, until now).
 *
 * Text chat debits per turn via the sidecar's pg-transaction atomicDebit().
 * Voice never reached that function — it only ran Phase 1 measurement
 * (AiUsageEvent rows with starXpCost left null), so every voice session
 * settled for StarXp 0 regardless of real usage. This module closes that
 * gap: one debit per voice session, at session end, priced from the
 * already-captured audioInputMs + audioOutputMs duration.
 *
 * Same credit/debt/surcharge math as atomicDebit (SCR-2026-08-15-001
 * §Overdraft Rule 2 — overdraft StarXp priced at 1.5x). Duplicated locally
 * rather than imported: CodeNomad is a separate git submodule/package and
 * cannot reach across to the main repo's src/lib/starxp-constants.ts, the
 * same reason starxp-debit.ts duplicates its own decimal helpers.
 */

import { getTokidappDb } from "./db"

/** Mirrors STARXP_AI_USD_RATE in src/lib/starxp-constants.ts ($1 = 150,000 StarXp). */
const STARXP_AI_USD_RATE = 150_000n

/**
 * Placeholder blended voice rate (STT + LLM + TTS), same caveat as the rest
 * of this system: not yet measured against real per-minute provider costs.
 * $0.10/min × 150,000 StarXp/$1 = 15,000 StarXp/min.
 */
const VOICE_USD_PER_MINUTE_SCALED = 10n // $0.10, scaled by 100 to stay integer
const STARXP_PER_MINUTE = (STARXP_AI_USD_RATE * VOICE_USD_PER_MINUTE_SCALED) / 100n // 15,000n

const STARXP_SURCHARGE_MULTIPLIER_NUM = 3n
const STARXP_SURCHARGE_MULTIPLIER_DEN = 2n // 1.5x, matching STARXP_SURCHARGE_MULTIPLIER

const MS_PER_MINUTE = 60_000n

/** Postgres unique-violation code — a replayed requestId, not a real failure. */
const UNIQUE_VIOLATION = "23505"

function parseDecimalToBigInt(dec: string): bigint {
  const s = (dec ?? "0").trim()
  if (!s || s === "0") return 0n
  const neg = s.startsWith("-")
  const digits = neg ? s.slice(1) : s
  const [intPart, fracPart = ""] = digits.split(".")
  const intDigits = intPart.replace(/^0+/, "") || "0"
  const fracPadded = (fracPart + "0".repeat(9)).slice(0, 9)
  const combined = `${intDigits}${fracPadded}`
  const value = BigInt(combined || "0")
  return neg ? -value : value
}

function bigIntToDecimalString(scaled: bigint): string {
  if (scaled === 0n) return "0"
  const neg = scaled < 0n
  const abs = neg ? -scaled : scaled
  const scale = 1_000_000_000n
  const intPart = abs / scale
  const fracPart = abs % scale
  if (fracPart === 0n) return neg ? `-${intPart.toString()}` : intPart.toString()
  const fracStr = fracPart.toString().padStart(9, "0").replace(/0+$/, "")
  const result = `${intPart.toString()}.${fracStr}`
  return neg ? `-${result}` : result
}

/** StarXp cost (unscaled integer, floored) for a voice session's audio duration. */
function computeVoiceStarXpCost(totalMs: number): bigint {
  if (totalMs <= 0) return 0n
  return (BigInt(Math.floor(totalMs)) * STARXP_PER_MINUTE) / MS_PER_MINUTE
}

export interface VoiceDebitResult {
  starXpCost: string
  surcharged: boolean
  /** False when there was nothing to bill, no ledger row, or the write failed. */
  recorded: boolean
}

/**
 * Atomic per-session voice debit — locks the ledger row, applies the same
 * credit/debt/surcharge split as atomicDebit, writes a real-priced
 * AiUsageEvent. Idempotent per agentSessionId via a stable requestId, so a
 * retried call (e.g. a process restart re-running session-end) cannot
 * double-charge.
 *
 * Mirrors atomicDebit's contract: never throws, always resolves — metering
 * must not block a session from ending.
 */
export async function debitVoiceSessionUsage(args: {
  userId: string
  agentSessionId: string
  audioInputMs: number
  audioOutputMs: number
  engine: string
}): Promise<VoiceDebitResult> {
  const totalMs = (args.audioInputMs || 0) + (args.audioOutputMs || 0)
  const cost = computeVoiceStarXpCost(totalMs)

  if (cost <= 0n) {
    return { starXpCost: "0", surcharged: false, recorded: false }
  }

  const db = getTokidappDb()
  const requestId = `voice_${args.agentSessionId}`

  try {
    return await db.transaction().execute(async (trx) => {
      const ledger = await trx
        .selectFrom("StarXpUsageLedger")
        .select(["credit", "debt"])
        .where("userId", "=", args.userId)
        .forUpdate()
        .executeTakeFirst()

      if (!ledger) {
        // Not onboarded for AI usage settlement — matches atomicDebit's
        // graceful skip (NoLedgerError is only thrown by the pre-flight gate,
        // not by the debit itself).
        return { starXpCost: "0", surcharged: false, recorded: false }
      }

      const currentCredit = parseDecimalToBigInt(String(ledger.credit ?? "0"))
      const currentDebt = parseDecimalToBigInt(String(ledger.debt ?? "0"))

      let newCredit: bigint
      let newDebt: bigint
      let surcharged: boolean
      let finalCost: bigint

      if (cost <= currentCredit) {
        newCredit = currentCredit - cost
        newDebt = currentDebt
        surcharged = false
        finalCost = cost
      } else {
        const overdraftPortion = cost - currentCredit
        const surchargedOverdraft =
          (overdraftPortion * STARXP_SURCHARGE_MULTIPLIER_NUM) / STARXP_SURCHARGE_MULTIPLIER_DEN
        finalCost = currentCredit + surchargedOverdraft
        newCredit = 0n
        newDebt = currentDebt + surchargedOverdraft
        surcharged = true
      }

      await trx
        .updateTable("StarXpUsageLedger")
        .set({
          credit: bigIntToDecimalString(newCredit),
          debt: bigIntToDecimalString(newDebt),
          updatedAt: new Date(),
        })
        .where("userId", "=", args.userId)
        .execute()

      await trx
        .insertInto("AiUsageEvent")
        .values({
          id: `usage_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          userId: args.userId,
          tokidappSessionId: null,
          agentSessionId: args.agentSessionId,
          modelId: `voice-${args.engine}`,
          provider: args.engine,
          eventType: "GENERATION",
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          usageSource: "ESTIMATED",
          promptTextTokens: null,
          promptAudioTokens: args.audioInputMs || 0,
          completionTextTokens: null,
          completionAudioTokens: args.audioOutputMs || 0,
          promptCachedTokens: null,
          starXpCost: bigIntToDecimalString(finalCost),
          requestId,
          createdAt: new Date(),
        })
        .execute()

      return { starXpCost: bigIntToDecimalString(finalCost), surcharged, recorded: true }
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === UNIQUE_VIOLATION) {
      // Same agentSessionId already debited — replay-safe, not a real failure.
      return { starXpCost: bigIntToDecimalString(cost), surcharged: false, recorded: true }
    }
    console.error("[starxp-voice-debit] transaction failed:", (err as Error).message)
    return { starXpCost: "0", surcharged: false, recorded: false }
  }
}
