/** OpenAI Realtime voice allowlist (must be lowercase). */

export const REALTIME_VOICE_IDS = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const

export type RealtimeVoiceId = (typeof REALTIME_VOICE_IDS)[number]

export const DEFAULT_REALTIME_VOICE: RealtimeVoiceId = "alloy"

export function normalizeRealtimeVoice(raw: unknown): RealtimeVoiceId {
  if (typeof raw === "string") {
    const id = raw.trim().toLowerCase()
    if ((REALTIME_VOICE_IDS as readonly string[]).includes(id)) {
      return id as RealtimeVoiceId
    }
  }
  return DEFAULT_REALTIME_VOICE
}
