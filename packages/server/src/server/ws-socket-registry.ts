/**
 * Shared WebSocket socket registry for TokiDAPP.
 *
 * Both the tokidapp WS handler (tokidapp.ts) and the Realtime voice
 * orchestrator (openai-realtime.ts) need to send messages to the
 * tokidapp WebSocket.  This module breaks the circular import that
 * would result from either file importing the other directly.
 *
 * Usage:
 *   import { registerTokidappSocket, getTokidappSocket } from './ws-socket-registry'
 */

export interface WsSocketRef {
  send: (msg: string) => void
  close: (code?: number, reason?: string) => void
}

const tokidappSockets = new Map<string, WsSocketRef>()

export function registerTokidappSocket(sessionId: string, socket: WsSocketRef): void {
  tokidappSockets.set(sessionId, socket)
}

export function unregisterTokidappSocket(sessionId: string): void {
  tokidappSockets.delete(sessionId)
}

export function getTokidappSocket(sessionId: string): WsSocketRef | undefined {
  return tokidappSockets.get(sessionId)
}

/** Extract user ID from a sessionId (supports "tokidapp_*" and "voice_*" prefixes). */
export function getUserIdFromSessionId(sessionId: string): string | null {
  if (sessionId.startsWith("tokidapp_")) return sessionId.slice(9)
  if (sessionId.startsWith("voice_")) return sessionId.slice(6)
  return null
}

/** Build the tokidapp sessionId for a userId. */
export function tokidappSessionId(userId: string): string {
  return `tokidapp_${userId}`
}
