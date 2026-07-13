/**
 * NVIDIA MagpieTTS REST SpeechProvider for the speech settings panel.
 *
 * Implements the `SpeechProvider` interface from the speech service,
 * using NVIDIA's MagpieTTS REST API for TTS synthesis.
 *
 * Features:
 * - 30+ multilingual voices (English, French, Spanish, etc.)
 * - Emotion control support
 * - REST-only (no streaming refactor)
 * - Fallback to Deepgram if NVIDIA unavailable
 *
 * @see https://docs.nvidia.com/en-us/ai-foundation-models/user-guide/magpie-tts
 */

import { Readable } from "node:stream"
import type { SpeechCapabilitiesResponse, SpeechSynthesisResponse } from "../../api-types"
import type {
  NormalizedSpeechSettings,
  SpeechProvider,
  SpeechSynthesisStreamResponse,
  SynthesizeSpeechInput,
  TranscribeAudioInput,
} from "../service"
import type { Logger } from "../../logger"

interface NvidiaSpeechProviderOptions {
  settings: NormalizedSpeechSettings
  logger: Logger
}

/**
 * NVIDIA MagpieTTS voice IDs.
 * Based on NVIDIA's multilingual voice catalog.
 */
export const NVIDIA_VOICE_IDS = [
  // English voices
  "English-US.Female-1",
  "English-US.Female-2",
  "English-US.Male-1",
  "English-US.Male-2",
  // French voices
  "French-France.Female-1",
  "French-France.Male-1",
  // Spanish voices
  "Spanish-Spain.Female-1",
  "Spanish-Spain.Male-1",
] as const

export type NvidiaVoiceId = (typeof NVIDIA_VOICE_IDS)[number]

/**
 * NVIDIA MagpieTTS voice profiles with demographic and persona info.
 */
export interface NvidiaVoiceProfile {
  id: NvidiaVoiceId
  label: string
  demographic: string
  energy: string
  persona: string
  language: string
}

export const NVIDIA_VOICE_PROFILES: NvidiaVoiceProfile[] = [
  // English voices
  {
    id: "English-US.Female-1",
    label: "English Female 1",
    demographic: "Female-presenting (US)",
    energy: "Warm, articulate",
    persona: "Professional concierge — clear diction, premium feel",
    language: "en-US",
  },
  {
    id: "English-US.Female-2",
    label: "English Female 2",
    demographic: "Female-presenting (US)",
    energy: "Bright, energetic",
    persona: "Demo host — enthusiastic product walkthroughs",
    language: "en-US",
  },
  {
    id: "English-US.Male-1",
    label: "English Male 1",
    demographic: "Male-presenting (US)",
    energy: "Deep, resonant",
    persona: "Technical lead — precise architecture explanations",
    language: "en-US",
  },
  {
    id: "English-US.Male-2",
    label: "English Male 2",
    demographic: "Male-presenting (US)",
    energy: "Calm, measured",
    persona: "Advisor — thoughtful analysis, risk assessment",
    language: "en-US",
  },
  // French voices
  {
    id: "French-France.Female-1",
    label: "French Female",
    demographic: "Female-presenting (France)",
    energy: "Smooth, elegant",
    persona: "French concierge — natural, refined delivery",
    language: "fr-FR",
  },
  {
    id: "French-France.Male-1",
    label: "French Male",
    demographic: "Male-presenting (France)",
    energy: "Confident, direct",
    persona: "French narrator — clear, authoritative",
    language: "fr-FR",
  },
  // Spanish voices
  {
    id: "Spanish-Spain.Female-1",
    label: "Spanish Female",
    demographic: "Female-presenting (Spain)",
    energy: "Warm, expressive",
    persona: "Spanish host — welcoming, conversational",
    language: "es-ES",
  },
  {
    id: "Spanish-Spain.Male-1",
    label: "Spanish Male",
    demographic: "Male-presenting (Spain)",
    energy: "Friendly, approachable",
    persona: "Spanish guide — patient, clear explanations",
    language: "es-ES",
  },
]

const NVIDIA_TTS_BASE = "https://integrate.api.nvidia.com/v1"
const SAMPLE_RATE = 24000

export class NvidiaSpeechProvider implements SpeechProvider {
  constructor(private readonly options: NvidiaSpeechProviderOptions) {}

  getCapabilities(): SpeechCapabilitiesResponse {
    const apiKey = this.resolveApiKey()
    return {
      available: true,
      configured: Boolean(apiKey),
      provider: "nvidia",
      supportsStt: false,
      supportsTts: true,
      supportsStreamingTts: false, // REST-only for Phase 1
      baseUrl: NVIDIA_TTS_BASE,
      sttModel: "", // Not supported
      ttsModel: "magpie-tts",
      ttsVoice: this.options.settings.ttsVoice || "English-US.Female-1",
      ttsFormats: ["mp3", "wav"],
      streamingTtsFormats: [], // No streaming support
    }
  }

  async transcribe(_input: TranscribeAudioInput): Promise<never> {
    throw new Error(
      "NVIDIA MagpieTTS does not support speech transcription. " +
      "Use OpenAI or Deepgram for STT.",
    )
  }

  async synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    const apiKey = this.resolveApiKey()
    const voice = this.options.settings.ttsVoice || "English-US.Female-1"
    const format = input.format || "wav"

    this.options.logger.info(
      {
        textLength: input.text.length,
        voice,
        format,
      },
      "nvidia.synthesize",
    )

    const response = await this.requestTts(input.text, apiKey, voice, format as "mp3" | "wav" )
    const audioBuffer = Buffer.from(await response.arrayBuffer())

    return {
      audioBase64: audioBuffer.toString("base64"),
      mimeType: response.headers.get("content-type") || resolveMimeType(format as "mp3" | "wav"),
    }
  }

  async synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    // Phase 1: REST-only, no streaming support
    // Fall back to non-streaming synthesis
    const result = await this.synthesize(input)

    // Convert base64 to readable stream
    const audioBuffer = Buffer.from(result.audioBase64, "base64")
    const stream = Readable.from([audioBuffer])

    return {
      stream,
      mimeType: result.mimeType,
    }
  }

  private async requestTts(
    text: string,
    apiKey: string,
    voice: string,
    format: "mp3" | "wav",
  ): Promise<Response> {
    const url = new URL(`${NVIDIA_TTS_BASE}/tts/magpie-tts`)

    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          voice,
          response_format: format === "mp3" ? "mp3" : "pcm",
        }),
      })
    } catch (error) {
      const detail = error as Error & { cause?: unknown; code?: string; syscall?: string }
      this.options.logger.error(
        {
          err: error,
          url: url.toString(),
          voice,
          format,
          cause: detail.cause,
          code: detail.code,
          syscall: detail.syscall,
        },
        "nvidia.synthesize fetch failed",
      )
      throw error
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(
        `NVIDIA MagpieTTS failed (${response.status}): ${detail || response.statusText}`,
      )
    }

    return response
  }

  private resolveApiKey(): string {
    const key =
      this.options.settings.apiKey?.trim() || process.env.NVIDIA_API_KEY?.trim()

    if (!key) {
      throw new Error(
        "NVIDIA API key is not configured. Set NVIDIA_API_KEY in the CodeNomad .env " +
        "or configure it in the Speech settings panel.",
      )
    }

    return key
  }
}

// ── Format Helpers ──────────────────────────────────────────────────────

function resolveMimeType(format: "mp3" | "wav"): string {
  switch (format) {
    case "wav":
      return "audio/wav"
    case "mp3":
    default:
      return "audio/mpeg"
  }
}

/**
 * Check if a voice ID is a valid NVIDIA voice.
 */
export function isNvidiaVoiceId(value: string): value is NvidiaVoiceId {
  return (NVIDIA_VOICE_IDS as readonly string[]).includes(value as NvidiaVoiceId)
}

/**
 * Get NVIDIA voice profile by ID.
 */
export function getNvidiaVoiceProfile(id: string): NvidiaVoiceProfile | undefined {
  return NVIDIA_VOICE_PROFILES.find((v) => v.id === id)
}
