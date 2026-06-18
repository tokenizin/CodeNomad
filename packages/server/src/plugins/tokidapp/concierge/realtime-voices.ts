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

/**
 * Default voice resolved from OPENAI_REALTIME_VOICE env var, falling back to "marin".
 * Accepts any valid RealtimeVoiceId (case-insensitive).
 */
function resolveDefaultVoice(): RealtimeVoiceId {
  const fromEnv = process.env.OPENAI_REALTIME_VOICE?.trim().toLowerCase()
  if (fromEnv && (REALTIME_VOICE_IDS as readonly string[]).includes(fromEnv)) {
    return fromEnv as RealtimeVoiceId
  }
  return "marin"
}

export const DEFAULT_REALTIME_VOICE: RealtimeVoiceId = resolveDefaultVoice()

export function normalizeRealtimeVoice(raw: unknown): RealtimeVoiceId {
  if (typeof raw === "string") {
    const id = raw.trim().toLowerCase()
    if ((REALTIME_VOICE_IDS as readonly string[]).includes(id)) {
      return id as RealtimeVoiceId
    }
  }
  return DEFAULT_REALTIME_VOICE
}
