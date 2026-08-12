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
import { createRecording } from "../../../lib/tokidapp-queries"

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
}

const wikiEnded = new Set<string>()
const recordingEnded = new Set<string>()

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
      duration: ctx.durationMs,
      format: "audio/pcm",
      status: "voice-session",
      userId: ctx.userId,
    }).catch((err) => {
      console.error(
        "[voice-session-end] recording metadata failed:",
        (err as Error).message,
      )
    })
  }
}
