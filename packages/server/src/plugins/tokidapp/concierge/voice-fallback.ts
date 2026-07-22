/**
 * Voice engine fallback helpers (server).
 *
 * OpenAI Realtime → local (whisper/Piper/Ollama) — no cloud on the fallback path.
 */

export type VoiceEngine = "openai" | "deepgram" | "local" | "ornith"

/** Primary cloud → no-cloud local safety net. */
export const VOICE_FALLBACK_CHAIN: VoiceEngine[] = ["openai", "local"]

export const LOCAL_VOICE_FALLBACK_ENGINE: VoiceEngine = "local"

export function getNextFallbackEngine(currentEngine: VoiceEngine): VoiceEngine | null {
  const index = VOICE_FALLBACK_CHAIN.indexOf(currentEngine)
  if (index === -1 || index >= VOICE_FALLBACK_CHAIN.length - 1) {
    return null
  }
  return VOICE_FALLBACK_CHAIN[index + 1]
}

/**
 * Detect OpenAI / cloud voice failures that should trigger local fallback.
 */
export function isOpenAiVoiceFallbackError(message: string | null | undefined): boolean {
  if (!message) return false
  const m = message.toLowerCase()
  return (
    m.includes("exceeded your current quota") ||
    m.includes("insufficient_quota") ||
    m.includes("quota") ||
    m.includes("billing") ||
    m.includes("rate limit") ||
    m.includes("rate_limit") ||
    m.includes("429") ||
    m.includes("openai realtime connection error") ||
    m.includes("connection error") ||
    m.includes("voice mode requires openai_api_key")
  )
}
