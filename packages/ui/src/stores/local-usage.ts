/**
 * Puts the tokens of a Claude Code (Rust) model call on the assistant message the way OpenCode does,
 * so the context meter (Used / Avail) follows the run: a message sent from this tab, a run this tab
 * attached to, and each delegated task's own session.
 */

import { RUST_PROVIDER_ID, usageToTokens, type LocalEngineUsage } from "../lib/local-engine"
import { messageStoreBus } from "./message-v2/bus"
import { updateSessionInfo } from "./message-v2/session-info"

export function recordLocalUsage(
  instanceId: string,
  sessionId: string,
  messageId: string,
  usage: LocalEngineUsage | undefined,
  model: string | undefined,
  createdAt: number,
): void {
  if (!usage) return
  messageStoreBus.getOrCreate(instanceId).setMessageInfo(messageId, {
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    providerID: RUST_PROVIDER_ID,
    modelID: model || "",
    tokens: usageToTokens(usage),
    cost: 0,
    time: { created: createdAt },
  } as any)
  updateSessionInfo(instanceId, sessionId)
}
