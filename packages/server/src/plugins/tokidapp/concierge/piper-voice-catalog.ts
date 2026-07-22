/**
 * Piper TTS voice profiles — gender / age / style variants + synthesis calibration.
 * SSOT for local + Ornith voice engines (client). Server mirror:
 * CodeNomad/.../concierge/piper-voice-catalog.ts
 */

export type PiperLocale = 'en' | 'id'
export type VoiceSpeechLocale = 'en' | 'id' | 'auto'
export type PiperGender = 'female' | 'male' | 'neutral'
export type PiperStyle =
  | 'calm'
  | 'professional'
  | 'certificated'
  | 'young'
  | 'enthusiastic'
  | 'excited'
  | 'conversational'
  | 'news'

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

export interface PiperVoiceProfile {
  id: string
  label: string
  /** Piper ONNX voice key, e.g. en_US-lessac-high */
  model: string
  locale: PiperLocale
  gender: PiperGender
  style: PiperStyle
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
    id: 'piper-en-female-professional',
    label: 'Lessac · Professional',
    model: 'en_US-lessac-high',
    locale: 'en',
    gender: 'female',
    style: 'professional',
    demographic: 'Female · US English · High quality',
    energy: 'Clear, authoritative',
    persona: 'Certificated presenter — crisp diction, boardroom-ready',
    synthesis: { lengthScale: 1.05, noiseScale: 0.55, noiseWScale: 0.75, volume: 1.0 },
  },
  {
    id: 'piper-en-female-certificated',
    label: 'Lessac · Certificated',
    model: 'en_US-lessac-high',
    locale: 'en',
    gender: 'female',
    style: 'certificated',
    demographic: 'Female · US English · High quality',
    energy: 'Measured, formal',
    persona: 'Official briefing voice — precise, trustworthy',
    synthesis: { lengthScale: 1.1, noiseScale: 0.48, noiseWScale: 0.7, volume: 1.0 },
  },
  {
    id: 'piper-en-female-calm',
    label: 'Lessac · Calm',
    model: 'en_US-lessac-high',
    locale: 'en',
    gender: 'female',
    style: 'calm',
    demographic: 'Female · US English · High quality',
    energy: 'Soft, unhurried',
    persona: 'Supportive guide — patient explanations',
    synthesis: { lengthScale: 1.18, noiseScale: 0.45, noiseWScale: 0.65, volume: 0.95 },
  },
  {
    id: 'piper-en-female-young',
    label: 'Alba · Young',
    model: 'en_GB-alba-medium',
    locale: 'en',
    gender: 'female',
    style: 'young',
    demographic: 'Female · UK English · Young',
    energy: 'Bright, clear',
    persona: 'Friendly host — light, approachable',
    synthesis: { lengthScale: 0.97, noiseScale: 0.62, noiseWScale: 0.8, volume: 1.0 },
  },
  {
    id: 'piper-en-female-enthusiastic',
    label: 'Amy · Enthusiastic',
    model: 'en_US-amy-medium',
    locale: 'en',
    gender: 'female',
    style: 'enthusiastic',
    demographic: 'Female · US English · Conversational',
    energy: 'Upbeat, energetic',
    persona: 'Demo host — product tours, warm encouragement',
    synthesis: { lengthScale: 0.9, noiseScale: 0.72, noiseWScale: 0.9, volume: 1.05 },
  },
  {
    id: 'piper-en-female-excited',
    label: 'Amy · Excited',
    model: 'en_US-amy-medium',
    locale: 'en',
    gender: 'female',
    style: 'excited',
    demographic: 'Female · US English · Conversational',
    energy: 'Fast, lively',
    persona: 'Launch energy — short celebratory updates',
    synthesis: { lengthScale: 0.84, noiseScale: 0.8, noiseWScale: 0.95, volume: 1.08 },
  },
  {
    id: 'piper-en-female-conversational',
    label: 'Amy · Conversational',
    model: 'en_US-amy-medium',
    locale: 'en',
    gender: 'female',
    style: 'conversational',
    demographic: 'Female · US English · Medium',
    energy: 'Natural, friendly',
    persona: 'Everyday chat — balanced cadence',
    synthesis: { lengthScale: 1.0, noiseScale: 0.667, noiseWScale: 0.8, volume: 1.0 },
  },
  {
    id: 'piper-en-male-professional',
    label: 'Ryan · Professional',
    model: 'en_US-ryan-high',
    locale: 'en',
    gender: 'male',
    style: 'professional',
    demographic: 'Male · US English · High quality',
    energy: 'Confident, direct',
    persona: 'Briefing lead — clear decisions, low drama',
    synthesis: { lengthScale: 1.05, noiseScale: 0.55, noiseWScale: 0.75, volume: 1.0 },
  },
  {
    id: 'piper-en-male-certificated',
    label: 'Ryan · Certificated',
    model: 'en_US-ryan-high',
    locale: 'en',
    gender: 'male',
    style: 'certificated',
    demographic: 'Male · US English · High quality',
    energy: 'Formal, steady',
    persona: 'Compliance narrator — authoritative delivery',
    synthesis: { lengthScale: 1.1, noiseScale: 0.5, noiseWScale: 0.7, volume: 1.0 },
  },
  {
    id: 'piper-en-male-calm',
    label: 'Ryan · Calm',
    model: 'en_US-ryan-high',
    locale: 'en',
    gender: 'male',
    style: 'calm',
    demographic: 'Male · US English · High quality',
    energy: 'Low, measured',
    persona: 'Technical explainer — unhurried steps',
    synthesis: { lengthScale: 1.16, noiseScale: 0.48, noiseWScale: 0.68, volume: 0.95 },
  },
  {
    id: 'piper-en-male-enthusiastic',
    label: 'Ryan · Enthusiastic',
    model: 'en_US-ryan-high',
    locale: 'en',
    gender: 'male',
    style: 'enthusiastic',
    demographic: 'Male · US English · High quality',
    energy: 'Dynamic, upbeat',
    persona: 'Pitch presenter — emphasis on milestones',
    synthesis: { lengthScale: 0.9, noiseScale: 0.7, noiseWScale: 0.88, volume: 1.05 },
  },
  {
    id: 'piper-id-news-calm',
    label: 'ID News · Calm',
    model: 'id_ID-news_tts-medium',
    locale: 'id',
    gender: 'neutral',
    style: 'news',
    demographic: 'Indonesian · News TTS',
    energy: 'Clear, broadcast',
    persona: 'Bahasa Indonesia — calm news-style delivery',
    synthesis: { lengthScale: 1.08, noiseScale: 0.55, noiseWScale: 0.75, volume: 1.0 },
  },
  {
    id: 'piper-id-news-professional',
    label: 'ID News · Professional',
    model: 'id_ID-news_tts-medium',
    locale: 'id',
    gender: 'neutral',
    style: 'professional',
    demographic: 'Indonesian · News TTS',
    energy: 'Formal, crisp',
    persona: 'Bahasa Indonesia — certificated / formal tone',
    synthesis: { lengthScale: 1.02, noiseScale: 0.5, noiseWScale: 0.72, volume: 1.0 },
  },
  {
    id: 'piper-id-news-enthusiastic',
    label: 'ID News · Enthusiastic',
    model: 'id_ID-news_tts-medium',
    locale: 'id',
    gender: 'neutral',
    style: 'enthusiastic',
    demographic: 'Indonesian · News TTS',
    energy: 'Brighter, faster',
    persona: 'Bahasa Indonesia — warmer product-tour cadence',
    synthesis: { lengthScale: 0.92, noiseScale: 0.68, noiseWScale: 0.85, volume: 1.05 },
  },
]

export const DEFAULT_PIPER_VOICE_ID = 'piper-en-female-professional'

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

export function resolvePiperModelAndSynthesis(id: string | undefined | null): {
  model: string
  synthesis: PiperSynthesisParams
  profile: PiperVoiceProfile
} {
  const profile = getPiperVoiceProfile(id)
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
    return getPiperVoiceProfile('piper-id-news-professional')
  }
  if (locale === 'en' && preferred.locale !== 'en') {
    return getPiperVoiceProfile(DEFAULT_PIPER_VOICE_ID)
  }
  return preferred
}
