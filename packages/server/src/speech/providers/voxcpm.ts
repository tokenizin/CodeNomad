/**
 * VoxCPM2 sidecar SpeechProvider.
 *
 * Proxies TTS to the local VoxCPM2 FastAPI sidecar on :9972.
 * STT is not exposed through this provider (use OpenAI/Deepgram/local
 * for speech-to-text). The settings panel's Test button and any
 * non-streaming TTS path both flow through here.
 *
 * Required server env/config:
 *   VOXCPM_SIDECAR_URL — defaults to http://127.0.0.1:9972
 *   VOXCPM_SIDECAR_API_KEY — bearer token for the sidecar
 */

import { Readable } from "node:stream"
import type { SpeechCapabilitiesResponse, SpeechSynthesisResponse } from "../../api-types"
import type { Logger } from "../../logger"
import type {
  NormalizedSpeechSettings,
  SpeechProvider,
  SpeechSynthesisStreamResponse,
  SynthesizeSpeechInput,
  TranscribeAudioInput,
} from "../service"

interface VoxCpmSpeechProviderOptions {
  settings: NormalizedSpeechSettings
  logger: Logger
}

const VOXCPM_DEFAULT_BASE_URL = "http://127.0.0.1:9972"
const VOXCPM_STREAM_FORMAT = "pcm"
const VOXCPM_SAMPLE_RATE = 48000

export class VoxCpmSpeechProvider implements SpeechProvider {
  constructor(private readonly options: VoxCpmSpeechProviderOptions) {}

  getCapabilities(): SpeechCapabilitiesResponse {
    const apiKey = this.resolveApiKey()
    return {
      available: true,
      configured: Boolean(apiKey),
      provider: "voxcpm",
      supportsStt: false,
      supportsTts: true,
      supportsStreamingTts: true,
      baseUrl: this.resolveBaseUrl(),
      sttModel: "",
      ttsModel: "voxcpm",
      ttsVoice: this.options.settings.ttsVoice || "concierge",
      ttsFormats: ["wav", "pcm", "flac", "mp3", "opus", "aac"],
      streamingTtsFormats: ["wav", "pcm"],
    }
  }

  async transcribe(_input: TranscribeAudioInput): Promise<never> {
    throw new Error(
      "VoxCPM2 does not expose STT through the speech provider. " +
        "Use OpenAI-compatible, Deepgram, or local for transcription.",
    )
  }

  async synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    const apiKey = this.resolveApiKey()
    const mimeType = this.resolveMimeType(input.format)
    const format = input.format ?? this.options.settings.ttsFormat ?? "mp3"

    this.options.logger.info(
      { textLength: input.text.length, voice: this.options.settings.ttsVoice, format },
      "voxcpm.synthesize",
    )

    const response = await this.requestSpeech({
      input: input.text,
      voice: this.options.settings.ttsVoice,
      response_format: format,
      stream: false,
    })

    const audioBuffer = Buffer.from(await response.arrayBuffer())
    return {
      audioBase64: audioBuffer.toString("base64"),
      mimeType: response.headers.get("content-type") || mimeType,
    }
  }

  async synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    const apiKey = this.resolveApiKey()
    const mimeType = this.resolveMimeType(VOXCPM_STREAM_FORMAT)

    this.options.logger.info(
      { textLength: input.text.length, voice: this.options.settings.ttsVoice },
      "voxcpm.synthesize.stream",
    )

    const response = await this.requestSpeech({
      input: input.text,
      voice: this.options.settings.ttsVoice,
      response_format: VOXCPM_STREAM_FORMAT,
      stream: true,
    })

    if (!response.body) {
      throw new Error("VoxCPM2 streaming response had no body.")
    }

    return {
      stream: Readable.fromWeb(response.body as any),
      mimeType,
    }
  }

  private resolveBaseUrl(): string {
    const fromSettings = this.options.settings.baseUrl?.trim()
    const fromEnv = process.env.VOXCPM_SIDECAR_URL?.trim()
    return fromSettings || fromEnv || VOXCPM_DEFAULT_BASE_URL
  }

  private resolveApiKey(): string | undefined {
    const fromSettings = this.options.settings.apiKey?.trim()
    const fromEnv = process.env.VOXCPM_SIDECAR_API_KEY?.trim()
    return fromSettings || fromEnv || undefined
  }

  private resolveMimeType(format?: string): string {
    switch (format) {
      case "wav":
        return "audio/wav"
      case "pcm":
        return "audio/pcm"
      case "flac":
        return "audio/flac"
      case "mp3":
        return "audio/mpeg"
      case "opus":
        return "audio/opus"
      case "aac":
        return "audio/aac"
      default:
        return "audio/mpeg"
    }
  }

  private async requestSpeech(body: Record<string, unknown>): Promise<Response> {
    const apiKey = this.resolveApiKey()
    const baseUrl = this.resolveBaseUrl()
    const url = `${baseUrl.replace(/\/$/, "")}/api/voxcpm/speech`

    const headers: Record<string, string> = {
      "content-type": "application/json",
    }
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120_000)

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      })

      if (!response.ok) {
        let message = `VoxCPM2 error ${response.status}`
        try {
          const parsed = (await response.json()) as { detail?: unknown; error?: unknown }
          message = String(parsed.detail ?? parsed.error ?? message)
        } catch {
          // keep generic message
        }
        throw new Error(message)
      }

      return response
    } finally {
      clearTimeout(timeout)
    }
  }
}
