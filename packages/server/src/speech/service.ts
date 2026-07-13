import { z } from "zod"
import type { Readable } from "node:stream"
import type { Logger } from "../logger"
import type { SettingsService } from "../settings/service"
import type { SpeechCapabilitiesResponse, SpeechSynthesisResponse, SpeechTranscriptionResponse } from "../api-types"
import { OpenAICompatibleSpeechProvider } from "./providers/openai-compatible"
import { NvidiaSpeechProvider } from "./providers/nvidia"

const ServerSpeechSettingsSchema = z.object({
  speech: z
    .object({
      provider: z.string().optional(),
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      sttModel: z.string().optional(),
      ttsModel: z.string().optional(),
      ttsVoice: z.string().optional(),
      ttsFormat: z.enum(["mp3", "wav", "opus", "aac"]).optional(),
    })
    .optional(),
})

export interface TranscribeAudioInput {
  audioBase64: string
  mimeType: string
  filename?: string
  language?: string
  prompt?: string
}

export interface SynthesizeSpeechInput {
  text: string
  format?: "mp3" | "wav" | "opus" | "aac"
}

export interface SpeechSynthesisStreamResponse {
  stream: Readable
  mimeType: string
}

export interface SpeechProvider {
  getCapabilities(): SpeechCapabilitiesResponse
  transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse>
  synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse>
  synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse>
}

export interface NormalizedSpeechSettings {
  provider: string
  apiKey?: string
  baseUrl?: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  ttsFormat: "mp3" | "wav" | "opus" | "aac"
}

const DEFAULT_PROVIDER = "openai-compatible"
const DEFAULT_STT_MODEL = "gpt-4o-transcribe"
const DEFAULT_TTS_MODEL = "gpt-realtime-2"
const DEFAULT_TTS_VOICE = "marin"
const DEFAULT_TTS_FORMAT = "mp3"
const DEFAULT_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"

export class SpeechService {
  constructor(
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  getCapabilities(): SpeechCapabilitiesResponse {
    return this.createProvider().getCapabilities()
  }

  async transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse> {
    return this.createProvider().transcribe(input)
  }

  async synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    return this.createProvider().synthesize(input)
  }

  async synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    return this.createProvider().synthesizeStream(input)
  }

  private createProvider(): SpeechProvider {
    const settings = this.resolveSettings()
    const logger = this.logger.child({ provider: settings.provider })

    // Route to the appropriate provider based on settings
    if (settings.provider === "nvidia") {
      return new NvidiaSpeechProvider({ settings, logger })
    }

    // Default to OpenAI-compatible provider (covers openai, deepgram, etc.)
    return new OpenAICompatibleSpeechProvider({ settings, logger })
  }

  private resolveSettings(): NormalizedSpeechSettings {
    const parsed = ServerSpeechSettingsSchema.parse(this.settings.getOwner("config", "server") ?? {})
    const speech = parsed.speech ?? {}

    return {
      provider: speech.provider?.trim() || DEFAULT_PROVIDER,
      apiKey: speech.apiKey?.trim() || process.env.OPENAI_API_KEY,
      baseUrl: speech.baseUrl?.trim() || DEFAULT_BASE_URL,
      sttModel: speech.sttModel?.trim() || DEFAULT_STT_MODEL,
      ttsModel: speech.ttsModel?.trim() || DEFAULT_TTS_MODEL,
      ttsVoice: speech.ttsVoice?.trim() || DEFAULT_TTS_VOICE,
      ttsFormat: speech.ttsFormat ?? DEFAULT_TTS_FORMAT,
    }
  }
}
