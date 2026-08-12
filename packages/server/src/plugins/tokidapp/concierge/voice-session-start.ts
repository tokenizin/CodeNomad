/**
 * Unified voice session-start pipeline — the open half of `voice-session-end`.
 *
 * Every realtime engine opens a `TokiDAPPAgentSession` row here so that the
 * tokens and audio milliseconds a conversation spends have somewhere to hang.
 * Settlement is per-session (see the StarXP metering design), so a voice call
 * with no row is a call nobody can bill.
 *
 * The row is optional by construction: a voice conversation must never fail to
 * start because accounting could not. `openVoiceAgentSession` returns null and
 * the session runs unattributed instead.
 */

import { createAgentSession } from "../../../lib/tokidapp-queries"
import type { VoiceEngineId } from "./voice-session-end"

/** Engine → the `provider` string recorded on the row. */
const ENGINE_PROVIDER: Record<VoiceEngineId, string> = {
  openai: "openai",
  deepgram: "deepgram",
  ornith: "ollama",
  local: "ollama",
}

export interface VoiceSessionStartContext {
  /** TokiDAPPSession.id. Without it there is no session to attribute to. */
  chatSessionId?: string | null
  engine: VoiceEngineId
  model?: string | null
}

/**
 * Open the agent-session row for a voice connection.
 * Returns its id, or null when there is nothing to attribute to (no chat
 * session) or the write failed.
 */
export async function openVoiceAgentSession(
  ctx: VoiceSessionStartContext,
): Promise<string | null> {
  const chatId = ctx.chatSessionId?.trim()
  if (!chatId) return null

  const id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return createAgentSession({
    id,
    tokidappSessionId: chatId,
    // Realtime voice is the full concierge — the lightweight path is text-only.
    agentType: "FULL_CONCIERGE",
    model: ctx.model ?? null,
    provider: ENGINE_PROVIDER[ctx.engine],
  })
}
