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

/** Ornith 31B-dense voice allowlist (must be lowercase). */
export const ORNITH_VOICE_IDS = [
  "ornith-default",
  "ornith-neutral",
  "ornith-professional",
] as const

export type OrnithVoiceId = (typeof ORNITH_VOICE_IDS)[number]

/** All supported voice IDs across all engines. */
export type AnyVoiceId = RealtimeVoiceId | OrnithVoiceId

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

/**
 * Default voice for Ornith engine, resolved from ORNITH_DEFAULT_VOICE env var.
 * Falls back to "ornith-default".
 */
function resolveOrnithDefaultVoice(): OrnithVoiceId {
  const fromEnv = process.env.ORNITH_DEFAULT_VOICE?.trim().toLowerCase()
  if (fromEnv && (ORNITH_VOICE_IDS as readonly string[]).includes(fromEnv)) {
    return fromEnv as OrnithVoiceId
  }
  return "ornith-default"
}

export const DEFAULT_ORNITH_VOICE: OrnithVoiceId = resolveOrnithDefaultVoice()

export function normalizeRealtimeVoice(raw: unknown): RealtimeVoiceId {
  if (typeof raw === "string") {
    const id = raw.trim().toLowerCase()
    if ((REALTIME_VOICE_IDS as readonly string[]).includes(id)) {
      return id as RealtimeVoiceId
    }
  }
  return DEFAULT_REALTIME_VOICE
}

/** Server-side canonical union of supported realtime voice engines.
 * The `nomadworks-pma` engine is a composite adapter that routes
 * through the PMA-specific voice orchestrator (OpenAI fallback / Grok xAI).
 */
export type VoiceEngine =
  | "openai"
  | "deepgram"
  | "local"
  | "ornith"
  | "nomadworks-pma"

export function normalizeOrnithVoice(raw: unknown): OrnithVoiceId {
  if (typeof raw === "string") {
    const id = raw.trim().toLowerCase()
    if ((ORNITH_VOICE_IDS as readonly string[]).includes(id)) {
      return id as OrnithVoiceId
    }
  }
  return DEFAULT_ORNITH_VOICE
}

export function isOrnithVoice(voiceId: string): boolean {
  return (ORNITH_VOICE_IDS as readonly string[]).includes(voiceId.toLowerCase())
}
