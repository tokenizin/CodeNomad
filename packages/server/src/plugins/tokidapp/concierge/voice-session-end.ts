/**
 * Unified voice session-end pipeline.
 *
 * `voice_stop` is a turn boundary (commit audio). Full teardown
 * (`voice_disconnect`, WS close, engine replace) must call
 * `onVoiceSessionEnd` so wiki + recording metadata cannot drift per engine.
 *
 * OpenAI Realtime historically inlined this; Deepgram duplicated a subset;
 * Ornith and local closed sockets and dropped the transcript. One hook
 * keeps all four engines on the same post-session path.
 */

import { updateWikiFromSession } from "./codebase-tools"
import { createRecording, endAgentSession } from "../../../lib/tokidapp-queries"
import { debitVoiceSessionUsage } from "../../../lib/starxp-voice-debit"

export type VoiceEngineId = "openai" | "deepgram" | "ornith" | "local"

/** Why the engine is coming down. `fallback` skips wiki — the session continues. */
export type VoiceSessionEndReason =
  | "complete"
  | "socket-close"
  | "replace"
  | "fallback"

export interface VoiceSessionEndContext {
  sessionId: string
  engine: VoiceEngineId
  transcript?: string | string[] | null
  chatSessionId?: string | null
  userId?: string
  durationMs?: number
  reason?: VoiceSessionEndReason
  /** TokiDAPPAgentSession row opened at connect. Closed here if present. */
  agentSessionId?: string | null
  audioInputMs?: number
  audioOutputMs?: number
}

const wikiEnded = new Set<string>()
const recordingEnded = new Set<string>()
const agentSessionEnded = new Set<string>()

export function joinVoiceTranscript(
  transcript?: string | string[] | null,
): string {
  if (!transcript) return ""
  if (Array.isArray(transcript)) return transcript.join("\n").trim()
  return String(transcript).trim()
}

/** Test helper — clears idempotency sets between cases. */
export function resetVoiceSessionEndState(): void {
  wikiEnded.clear()
  recordingEnded.clear()
  agentSessionEnded.clear()
}

/**
 * Fire-and-forget post-session work. Safe to call more than once per
 * sessionId (wiki and recording each run at most once).
 */
export function onVoiceSessionEnd(ctx: VoiceSessionEndContext): void {
  const reason = ctx.reason ?? "complete"
  if (reason === "fallback") return

  const text = joinVoiceTranscript(ctx.transcript)
  if (text && !wikiEnded.has(ctx.sessionId)) {
    wikiEnded.add(ctx.sessionId)
    updateWikiFromSession(ctx.sessionId, text).catch((err) => {
      console.error("[voice-session-end] wiki update failed:", err)
    })
  }

  const chatId = ctx.chatSessionId?.trim()
  if (chatId && !recordingEnded.has(ctx.sessionId)) {
    recordingEnded.add(ctx.sessionId)
    const recordingId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    createRecording({
      id: recordingId,
      sessionId: chatId,
      blobUrl: "",
      durationMs: ctx.durationMs,
      mimeType: "audio/pcm",
      userId: ctx.userId,
    }).catch((err) => {
      console.error(
        "[voice-session-end] recording metadata failed:",
        (err as Error).message,
      )
    })
  }

  // Stamp disconnectedAt so the session stops looking live and its usage rows
  // become a closed set the settlement pass can price.
  const agentId = ctx.agentSessionId?.trim()
  if (agentId && !agentSessionEnded.has(agentId)) {
    agentSessionEnded.add(agentId)
    // A socket close is an ordinary tab close, not a failure — every teardown
    // that reaches here is DISCONNECTED. ERROR is for engines that actually errored.
    void endAgentSession(agentId, {
      audioInputMs: ctx.audioInputMs,
      audioOutputMs: ctx.audioOutputMs,
    })

    // ── Real per-session StarXp debit, then on-chain settlement ──
    // Voice usage was previously measured only (AiUsageEvent.starXpCost left
    // null forever), so every voice session settled for StarXp 0 regardless
    // of real usage. debitVoiceSessionUsage() prices this session from the
    // captured audio duration and writes a real AiUsageEvent — must complete
    // BEFORE settlement, since settlement sums this session's AiUsageEvent
    // rows. Fire-and-forget from the caller's perspective; the two steps
    // inside are sequenced so settlement never reads a stale null.
    if (ctx.userId) {
      const userId = ctx.userId
      void (async () => {
        try {
          await debitVoiceSessionUsage({
            userId,
            agentSessionId: agentId,
            audioInputMs: ctx.audioInputMs ?? 0,
            audioOutputMs: ctx.audioOutputMs ?? 0,
            engine: ctx.engine,
          })
        } catch (err) {
          console.error('[voice-session-end] StarXp debit failed (non-fatal):', (err as Error).message)
        }

        // Phase 2 Slice 3: Once-per-session on-chain settlement.
        // SCR-2026-08-15-001 §Settlement. Settle the accumulated StarXP usage
        // on-chain via StarXpUsageLedger.recordUsage() on BSC Testnet (97).
        // Fire-and-forget: a settlement failure never blocks the session from
        // ending — the off-chain mirror is authoritative until recordUsage()
        // succeeds. Retry logic can be a follow-up.
        await settleSessionViaApi(agentId, userId).catch((err) => {
          console.error('[voice-session-end] settlement failed (non-fatal):', (err as Error).message)
        })
      })()
    }
  }
}

/**
 * Settle a voice session's StarXP usage on-chain via the StarWorld settlement API.
 *
 * Calls `POST /api/starxp/settlement` on the StarWorld portal with the
 * `INTERNAL_API_KEY` (server-to-server auth). The API resolves the user's
 * on-chain address, sums the session's AiUsageEvent.starXpCost, and calls
 * `StarXpUsageLedger.recordUsage()` on BSC Testnet 97.
 *
 * Never throws — the caller (onVoiceSessionEnd) already wraps this in a void.
 */
async function settleSessionViaApi(agentSessionId: string, userId: string): Promise<void> {
  // Lazy import to avoid pulling the starguard client into engines that never settle.
  const { apiPost } = await import('../orchestrator/starguard-client')
  const res = await apiPost('/api/starxp/settlement', {
    userId,
    sessionId: agentSessionId,
    // The totalAmount + eventIds are resolved by the StarWorld API from the
    // AiUsageEvent rows for this session — CodeNomad doesn't need to sum them.
    // This keeps the settlement logic in one place (StarWorld side).
    totalAmount: '0', // placeholder — the API resolves the real total from AiUsageEvent rows
    eventIds: [], // placeholder — the API resolves the real event ids
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.warn('[voice-session-end] settlement API returned non-OK:', res.status, text.slice(0, 200))
  }
}
