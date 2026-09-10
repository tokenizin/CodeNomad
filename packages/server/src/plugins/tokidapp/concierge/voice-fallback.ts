/**
 * Voice engine fallback chain (server).
 *
 * Descends one tier at a time as engines fail:
 *
 *   openai    gpt-realtime-2 duplex (cloud)
 *     ↓
 *   deepgram  Nova-3 STT + Aura-2 TTS + Ollama/GPT LLM (cloud)
 *     ↓
 *   local     whisper.cpp / faster-whisper STT + Piper TTS + Ollama LLM (no cloud)
 *     ↓
 *   browser   Web Speech API in the client — terminal tier, no server session
 *
 * `ornith` and `nomadworks-pma` are peer engines, not tiers: they are selected
 * explicitly and are not in the default chain, but on failure they descend into
 * the chain from the top.
 *
 * Override with VOICE_FALLBACK_CHAIN, e.g. "openai,local,browser".
 */

export type VoiceEngine =
  | "openai"
  | "deepgram"
  | "local"
  | "ornith"
  | "nomadworks-pma"
  | "browser"

/** Engines that can be selected explicitly but are not fallback tiers. */
const NON_TIER_ENGINES: ReadonlySet<VoiceEngine> = new Set<VoiceEngine>([
  "ornith",
  "nomadworks-pma",
])

export const DEFAULT_VOICE_FALLBACK_CHAIN: VoiceEngine[] = [
  "openai",
  "deepgram",
  "local",
  "browser",
]

/** Kept for callers that only need the no-cloud safety net. */
export const LOCAL_VOICE_FALLBACK_ENGINE: VoiceEngine = "local"

/** Terminal tier — runs entirely in the client, so the server never starts a session. */
export const TERMINAL_VOICE_ENGINE: VoiceEngine = "browser"

const VALID_ENGINES: ReadonlySet<string> = new Set([
  "openai",
  "deepgram",
  "local",
  "ornith",
  "nomadworks-pma",
  "browser",
])

function isVoiceEngine(value: string): value is VoiceEngine {
  return VALID_ENGINES.has(value)
}

/**
 * The active chain. Reads VOICE_FALLBACK_CHAIN on every call so an operator can
 * change it without a restart; falls back to the default on an empty or fully
 * invalid value.
 */
export function getVoiceFallbackChain(): VoiceEngine[] {
  const raw = process.env.VOICE_FALLBACK_CHAIN?.trim()
  if (!raw) return [...DEFAULT_VOICE_FALLBACK_CHAIN]

  const parsed = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
    .filter(isVoiceEngine)

  // De-dupe while preserving order; a repeated engine would loop the descent.
  const seen = new Set<VoiceEngine>()
  const chain = parsed.filter((engine) => {
    if (seen.has(engine)) return false
    seen.add(engine)
    return true
  })

  return chain.length > 0 ? chain : [...DEFAULT_VOICE_FALLBACK_CHAIN]
}

export interface NextFallbackOptions {
  /**
   * Availability probe (API keys present, service reachable). `browser` is always
   * treated as available — the client decides whether it can honour it.
   */
  isAvailable?: (engine: VoiceEngine) => boolean
  /** Engines already tried for this session; skipped so the descent terminates. */
  attempted?: Iterable<VoiceEngine>
  /** Override the chain (tests). */
  chain?: VoiceEngine[]
}

/**
 * Next engine below `currentEngine`, skipping unavailable and already-attempted
 * tiers. Returns null when the chain is exhausted.
 *
 * An engine outside the chain (`ornith`) descends from the top rather than
 * dead-ending, which is why the search starts at -1 for unknown engines.
 */
export function getNextFallbackEngine(
  currentEngine: VoiceEngine,
  options: NextFallbackOptions = {},
): VoiceEngine | null {
  const chain = options.chain ?? getVoiceFallbackChain()
  const attempted = new Set<VoiceEngine>(options.attempted ?? [])
  const isAvailable = options.isAvailable ?? (() => true)

  const startIndex = chain.indexOf(currentEngine)

  for (let i = startIndex + 1; i < chain.length; i++) {
    const candidate = chain[i]
    if (candidate === currentEngine) continue
    if (attempted.has(candidate)) continue
    if (NON_TIER_ENGINES.has(candidate)) continue
    // The browser tier needs no server-side capability.
    if (candidate !== TERMINAL_VOICE_ENGINE && !isAvailable(candidate)) continue
    return candidate
  }

  return null
}

/** Cloud-quota, billing, auth and transport failures on the OpenAI Realtime path. */
const OPENAI_FALLBACK_PATTERNS = [
  "exceeded your current quota",
  "insufficient_quota",
  "quota",
  "billing",
  "rate limit",
  "rate_limit",
  "429",
  "openai realtime connection error",
  "connection error",
  "voice mode requires openai_api_key",
]

const DEEPGRAM_FALLBACK_PATTERNS = [
  "deepgram",
  "nova-3",
  "aura",
  "401",
  "403",
  "websocket close",
  "socket hang up",
]

const LOCAL_FALLBACK_PATTERNS = [
  "whisper",
  "piper",
  "ollama",
  "econnrefused",
  "enoent",
  "spawn",
  "model not found",
]

const SHARED_FALLBACK_PATTERNS = [
  "timeout",
  "timed out",
  "unavailable",
  "econnreset",
  "network",
]

function matchesAny(message: string, patterns: string[]): boolean {
  return patterns.some((pattern) => message.includes(pattern))
}

/**
 * Should this error move the session down a tier?
 *
 * Engine-aware: a Deepgram socket close should descend, but the same string on
 * the OpenAI path should not be mistaken for a Deepgram fault.
 */
export function isVoiceFallbackError(
  message: string | null | undefined,
  engine: VoiceEngine = "openai",
): boolean {
  if (!message) return false
  const m = message.toLowerCase()

  if (matchesAny(m, SHARED_FALLBACK_PATTERNS)) return true

  switch (engine) {
    case "openai":
      return matchesAny(m, OPENAI_FALLBACK_PATTERNS)
    case "deepgram":
      return matchesAny(m, DEEPGRAM_FALLBACK_PATTERNS)
    case "local":
      return matchesAny(m, LOCAL_FALLBACK_PATTERNS)
    case "ornith":
      return matchesAny(m, [...LOCAL_FALLBACK_PATTERNS, "ornith"])
    default:
      return false
  }
}

/**
 * Back-compat alias for the original OpenAI-only classifier.
 * @deprecated Use {@link isVoiceFallbackError} with an explicit engine.
 */
export function isOpenAiVoiceFallbackError(message: string | null | undefined): boolean {
  return isVoiceFallbackError(message, "openai")
}

const ENGINE_LABELS: Record<VoiceEngine, string> = {
  openai: "OpenAI Realtime",
  deepgram: "Deepgram (Nova-3 + Aura-2)",
  local: "local Whisper + Piper + Ollama",
  ornith: "Ornith",
  browser: "browser speech (Web Speech API)",
  "nomadworks-pma": "NomadWorks PMA",
}

export function describeEngine(engine: VoiceEngine): string {
  return ENGINE_LABELS[engine] ?? engine
}

/** User-facing notice for a tier change. */
export function describeFallback(from: VoiceEngine, to: VoiceEngine, reason?: string): string {
  const trimmed = reason?.trim()
  const because = trimmed ? ` (${trimmed.slice(0, 120)})` : ""
  return `${describeEngine(from)} unavailable${because} — switched to ${describeEngine(to)}.`
}
