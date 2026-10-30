import { z } from "zod"
import type { Readable } from "node:stream"
import type { Logger } from "../logger"
import type { SettingsService } from "../settings/service"
import type { SpeechCapabilitiesResponse, SpeechSynthesisResponse, SpeechTranscriptionResponse } from "../api-types"
import { OpenAICompatibleSpeechProvider } from "./providers/openai-compatible"
import { NvidiaSpeechProvider } from "./providers/nvidia"
import { LocalSpeechProvider } from "./providers/local"
import { WhisperSpeechProvider } from "./providers/whisper"
import { DeepgramSpeechProvider } from "./providers/deepgram"
import { VoxCpmSpeechProvider, type NormalizedVoxCpmSettings } from "./providers/voxcpm"
import { resolveVoxCpmConfig } from "../plugins/tokidapp/concierge/voxcpm-client"

export interface VoxCpmStatus {
  baseUrl: string
  /** Key found (settings, VOXCPM_SIDECAR_API_KEY, or the sidecar's engine-data/.api-key). */
  hasKey: boolean
  reachable: boolean
  /** Model loaded and ready to synthesize. */
  ready: boolean
  status?: string
  device?: string
  formats?: string[]
  voices: Array<{ id: string; name: string; type?: string; builtin?: boolean; language?: string | null }>
  styles: string[]
  qualities: string[]
  error?: string
}

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
      /** "VoxCPM2 (Local TTS)" provider settings. */
      voxcpm: z
        // nullish: a cleared field may be stored as null; it means "not set".
        .object({
          baseUrl: z.string().nullish(),
          apiKey: z.string().nullish(),
          style: z.string().nullish(),
          quality: z.string().nullish(),
          speed: z.number().nullish(),
          instructions: z.string().nullish(),
          seed: z.number().int().nullish(),
          sttSource: z.enum(["local", "whisper", "deepgram"]).nullish(),
          sttApiKey: z.string().nullish(),
          sttModel: z.string().nullish(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
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
  voxcpm?: NormalizedVoxCpmSettings
}

/** VoxCPM2 on the Mac Studio, with local transcription: works without any cloud key. */
const DEFAULT_PROVIDER = "voxcpm"
const DEFAULT_STT_MODEL = "gpt-4o-transcribe"
const DEFAULT_TTS_MODEL = "gpt-realtime-2"
const DEFAULT_TTS_VOICE = "marin"
const DEFAULT_TTS_FORMAT = "mp3"
const DEFAULT_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
const DEEPGRAM_BASE_URL = "https://api.deepgram.com/v1"
const DEEPGRAM_STT_MODEL = "nova-3"
const DEEPGRAM_TTS_MODEL = "aura-2"
const DEEPGRAM_TTS_VOICE = "aura-asteria-en"

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

  /** VoxCPM2 sidecar health and voice list, for the Speech settings page. */
  async voxcpmStatus(fetchImpl: typeof fetch = fetch): Promise<VoxCpmStatus> {
    const parsed = ServerSpeechSettingsSchema.parse(this.settings.getOwner("config", "server") ?? {})
    const vox = normalizeVoxCpm(parsed.speech?.voxcpm)
    const config = resolveVoxCpmConfig({
      ...(vox.baseUrl ? { baseUrl: vox.baseUrl.replace(/\/$/, "") } : {}),
      ...(vox.apiKey ? { apiKey: vox.apiKey } : {}),
    })
    const status: VoxCpmStatus = {
      baseUrl: config.baseUrl,
      hasKey: Boolean(config.apiKey),
      reachable: false,
      ready: false,
      voices: [],
      styles: [],
      qualities: [],
    }
    const headers = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : undefined
    try {
      const health = await fetchImpl(`${config.baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
      const body = (await health.json().catch(() => ({}))) as Record<string, any>
      status.reachable = health.ok
      status.ready = body.ready === true
      status.status = typeof body.status === "string" ? body.status : undefined
      status.device = typeof body.device === "string" ? body.device : undefined
      status.formats = Array.isArray(body.formats) ? body.formats : undefined
      if (typeof body.error === "string" && body.error) status.error = body.error
    } catch (error) {
      status.error = `VoxCPM2 sidecar unreachable at ${config.baseUrl}: ${error instanceof Error ? error.message : String(error)}`
      return status
    }
    try {
      const res = await fetchImpl(`${config.baseUrl}/v1/voices`, { headers, signal: AbortSignal.timeout(5000) })
      if (res.status === 401 || res.status === 403) {
        status.error = "The sidecar refused the API key. It's in scripts/voxcpm-server/engine-data/.api-key on the Mac Studio."
      } else if (res.ok) {
        const body = (await res.json()) as Record<string, any>
        status.voices = (Array.isArray(body.voices) ? body.voices : [])
          .filter((v: any) => typeof v?.id === "string")
          .map((v: any) => ({ id: v.id, name: v.name || v.id, type: v.type, builtin: v.builtin, language: v.language ?? null }))
        status.styles = Array.isArray(body.styles) ? body.styles : []
        status.qualities = Array.isArray(body.qualities) ? body.qualities : []
      }
    } catch (error) {
      status.error = `Could not list voices: ${error instanceof Error ? error.message : String(error)}`
    }
    return status
  }

  private createProvider(): SpeechProvider {
    const settings = this.resolveSettings()
    const logger = this.logger.child({ provider: settings.provider })

    // Route to the appropriate provider based on settings
    if (settings.provider === "nvidia") {
      return new NvidiaSpeechProvider({ settings, logger })
    }

    if (settings.provider === "local") {
      return new LocalSpeechProvider({ settings, logger })
    }

    if (settings.provider === "whisper") {
      return new WhisperSpeechProvider({ settings, logger })
    }

    if (settings.provider === "deepgram") {
      return new DeepgramSpeechProvider({ settings, logger })
    }

    if (settings.provider === "voxcpm") {
      return new VoxCpmSpeechProvider({ settings, logger })
    }

    // Default to OpenAI-compatible provider
    return new OpenAICompatibleSpeechProvider({ settings, logger })
  }

  private resolveSettings(): NormalizedSpeechSettings {
    const parsed = ServerSpeechSettingsSchema.parse(this.settings.getOwner("config", "server") ?? {})
    const speech = parsed.speech ?? {}
    const provider = speech.provider?.trim() || DEFAULT_PROVIDER
    const isDeepgram = provider === "deepgram"

    return {
      provider,
      apiKey:
        speech.apiKey?.trim() ||
        (isDeepgram ? process.env.DEEPGRAM_API_KEY : process.env.OPENAI_API_KEY),
      baseUrl:
        speech.baseUrl?.trim() ||
        (isDeepgram ? DEEPGRAM_BASE_URL : DEFAULT_BASE_URL),
      sttModel:
        speech.sttModel?.trim() ||
        (isDeepgram ? DEEPGRAM_STT_MODEL : DEFAULT_STT_MODEL),
      ttsModel:
        speech.ttsModel?.trim() ||
        (isDeepgram ? DEEPGRAM_TTS_MODEL : DEFAULT_TTS_MODEL),
      ttsVoice:
        speech.ttsVoice?.trim() ||
        (isDeepgram ? DEEPGRAM_TTS_VOICE : DEFAULT_TTS_VOICE),
      ttsFormat: speech.ttsFormat ?? DEFAULT_TTS_FORMAT,
      ...(provider === "voxcpm" ? { voxcpm: normalizeVoxCpm(speech.voxcpm) } : {}),
    }
  }
}

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

function normalizeVoxCpm(raw: Record<string, unknown> | undefined): NormalizedVoxCpmSettings {
  const v = raw ?? {}
  const speed = typeof v.speed === "number" && v.speed >= 0.25 && v.speed <= 4 ? v.speed : undefined
  const seed = typeof v.seed === "number" && Number.isInteger(v.seed) ? v.seed : undefined
  const sttSource = v.sttSource === "whisper" || v.sttSource === "deepgram" ? v.sttSource : "local"
  return {
    baseUrl: str(v.baseUrl),
    apiKey: str(v.apiKey),
    style: str(v.style),
    quality: str(v.quality),
    speed,
    instructions: str(v.instructions),
    seed,
    sttSource,
    sttApiKey: str(v.sttApiKey),
    sttModel: str(v.sttModel),
  }
}
