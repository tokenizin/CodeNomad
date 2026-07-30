/**
 * Piper TTS voice profiles — gender / age / style variants + synthesis calibration.
 * SSOT for local + Ornith voice engines (client). Server mirror:
 * CodeNomad/.../concierge/piper-voice-catalog.ts
 */

export type PiperLocale = 'en' | 'id'
export type VoiceSpeechLocale = 'en' | 'id' | 'auto'
export type PiperGender = 'female' | 'male' | 'neutral'

/** Style presets — synthesis calibration that varies speaking rate and energy. */
export const PIPER_STYLE_PRESETS: Record<string, Required<Pick<PiperSynthesisParams, 'lengthScale' | 'noiseScale' | 'noiseWScale' | 'volume'>>> = {
  Professional: { lengthScale: 1.05, noiseScale: 0.55, noiseWScale: 0.75, volume: 1.0 },
  Calm: { lengthScale: 1.18, noiseScale: 0.45, noiseWScale: 0.65, volume: 0.95 },
  Enthusiastic: { lengthScale: 0.9, noiseScale: 0.72, noiseWScale: 0.9, volume: 1.05 },
  Conversational: { lengthScale: 1.0, noiseScale: 0.667, noiseWScale: 0.8, volume: 1.0 },
  News: { lengthScale: 1.02, noiseScale: 0.5, noiseWScale: 0.72, volume: 1.0 },
}

/** Piper SynthesisConfig knobs (length_scale ≈ inverse of speaking rate). */
export interface PiperSynthesisParams {
  lengthScale?: number
  noiseScale?: number
  noiseWScale?: number
  volume?: number
  speakerId?: number
  /** Legacy alias — converted to lengthScale = 1/speed when lengthScale omitted. */
  speed?: number
}

/** One profile per ONNX model — style variants are separate. */
export interface PiperVoiceProfile {
  id: string
  label: string
  /** Piper ONNX voice key, e.g. en_US-lessac-high */
  model: string
  locale: PiperLocale
  gender: PiperGender
  demographic: string
  energy: string
  persona: string
  /** Best-practice synthesis calibration for this profile. */
  synthesis: Required<
    Pick<PiperSynthesisParams, 'lengthScale' | 'noiseScale' | 'noiseWScale' | 'volume'>
  > & { speakerId?: number }
}

/** High-quality EN defaults + Indonesian news voice. */
export const PIPER_VOICE_PROFILES: PiperVoiceProfile[] = [
  {
    id: 'piper-en-female-lessac',
    label: 'US Lessac (High)',
    model: 'en_US-lessac-high',
    locale: 'en',
    gender: 'female',
    demographic: 'Female · US English · High quality',
    energy: 'Clear, authoritative',
    persona: 'Certificated presenter — crisp diction, boardroom-ready',
    synthesis: { lengthScale: 1.05, noiseScale: 0.55, noiseWScale: 0.75, volume: 1.0 },
  },
  {
    id: 'piper-en-female-alba',
    label: 'UK Alba (Medium)',
    model: 'en_GB-alba-medium',
    locale: 'en',
    gender: 'female',
    demographic: 'Female · UK English · Medium quality',
    energy: 'Bright, clear',
    persona: 'Friendly host — light, approachable',
    synthesis: { lengthScale: 0.97, noiseScale: 0.62, noiseWScale: 0.8, volume: 1.0 },
  },
  {
    id: 'piper-en-female-amy',
    label: 'US Amy (Medium)',
    model: 'en_US-amy-medium',
    locale: 'en',
    gender: 'female',
    demographic: 'Female · US English · Conversational',
    energy: 'Upbeat, energetic',
    persona: 'Demo host — product tours, warm encouragement',
    synthesis: { lengthScale: 0.9, noiseScale: 0.72, noiseWScale: 0.9, volume: 1.05 },
  },
  {
    id: 'piper-en-male-ryan',
    label: 'US Ryan (High)',
    model: 'en_US-ryan-high',
    locale: 'en',
    gender: 'male',
    demographic: 'Male · US English · High quality',
    energy: 'Confident, direct',
    persona: 'Briefing lead — clear decisions, low drama',
    synthesis: { lengthScale: 1.05, noiseScale: 0.55, noiseWScale: 0.75, volume: 1.0 },
  },
  {
    id: 'piper-en-female-libritts',
    label: 'US LibriTTS (Medium)',
    model: 'en_US-libritts_r-medium',
    locale: 'en',
    gender: 'female',
    demographic: 'Female · US English · Medium quality',
    energy: 'Natural, measured',
    persona: 'Narrative reader — calm storytelling voice',
    synthesis: { lengthScale: 1.08, noiseScale: 0.52, noiseWScale: 0.73, volume: 0.98 },
  },
  {
    id: 'piper-id-news',
    label: 'ID News TTS (Medium)',
    model: 'id_ID-news_tts-medium',
    locale: 'id',
    gender: 'neutral',
    demographic: 'Indonesian · News TTS',
    energy: 'Clear, broadcast',
    persona: 'Bahasa Indonesia — calm news-style delivery',
    synthesis: { lengthScale: 1.08, noiseScale: 0.55, noiseWScale: 0.75, volume: 1.0 },
  },
]

export const DEFAULT_PIPER_VOICE_ID = 'piper-en-female-lessac'

export const PIPER_VOICE_IDS = PIPER_VOICE_PROFILES.map((p) => p.id)

export function isPiperVoiceId(value: string): boolean {
  return PIPER_VOICE_IDS.includes(value)
}

export function getPiperVoiceProfile(id: string | undefined | null): PiperVoiceProfile {
  if (id) {
    const found = PIPER_VOICE_PROFILES.find((p) => p.id === id)
    if (found) return found
    // Allow raw Piper model keys (en_US-lessac-high) from env / legacy
    const byModel = PIPER_VOICE_PROFILES.find((p) => p.model === id)
    if (byModel) return byModel
  }
  return PIPER_VOICE_PROFILES.find((p) => p.id === DEFAULT_PIPER_VOICE_ID)!
}

export function resolvePiperModelAndSynthesis(id: string | undefined | null, style?: string): {
  model: string
  synthesis: PiperSynthesisParams
  profile: PiperVoiceProfile
} {
  const profile = getPiperVoiceProfile(id)
  // Merge style preset over base profile's synthesis if provided
  if (style && PIPER_STYLE_PRESETS[style]) {
    return {
      model: profile.model,
      synthesis: { ...profile.synthesis, ...(PIPER_STYLE_PRESETS[style] as PiperSynthesisParams) },
      profile,
    }
  }
  // Raw model key not in catalog — use defaults with that model
  if (id && !isPiperVoiceId(id) && !PIPER_VOICE_PROFILES.some((p) => p.model === id)) {
    return {
      model: id,
      synthesis: { lengthScale: 1.05, noiseScale: 0.55, noiseWScale: 0.75, volume: 1.0 },
      profile,
    }
  }
  return { model: profile.model, synthesis: { ...profile.synthesis }, profile }
}

export function piperVoicesForLocale(locale: PiperLocale | 'all'): PiperVoiceProfile[] {
  if (locale === 'all') return PIPER_VOICE_PROFILES
  return PIPER_VOICE_PROFILES.filter((p) => p.locale === locale)
}

/** Prefer Indonesian Piper profile when speech locale is id. */
export function pickPiperVoiceForLocale(
  preferredId: string | undefined,
  locale: VoiceSpeechLocale,
): PiperVoiceProfile {
  const preferred = getPiperVoiceProfile(preferredId)
  if (locale === 'id' && preferred.locale !== 'id') {
    return PIPER_VOICE_PROFILES.find((p) => p.model === 'id_ID-news_tts-medium')!
  }
  if (locale === 'en' && preferred.locale !== 'en') {
    return getPiperVoiceProfile('piper-en-female-lessac')
  }
  return preferred
}

/** Style presets for synthesis calibration. */
export type PiperStylePreset = keyof typeof PIPER_STYLE_PRESETS
