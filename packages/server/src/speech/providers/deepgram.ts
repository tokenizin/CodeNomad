/**
 * Deepgram REST TTS SpeechProvider for the speech settings panel.
 *
 * Implements the `SpeechProvider` interface from the speech service,
 * using Deepgram's REST `POST /v1/speak` endpoint for non-streaming
 * and streaming TTS synthesis.
 *
 * Live WebSocket STT/TTS is handled by the `deepgram-speech.ts` concierge
 * module — this provider only covers the REST path used by the settings
 * panel's "Test" button and non-streaming TTS calls.
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

interface DeepgramSpeechProviderOptions {
  settings: NormalizedSpeechSettings
  logger: Logger
}

const DEEPGRAM_BASE = "https://api.deepgram.com/v1"
const SAMPLE_RATE = 24000
const ENCODING = "linear16"

export class DeepgramSpeechProvider implements SpeechProvider {
  constructor(private readonly options: DeepgramSpeechProviderOptions) {}

  getCapabilities(): SpeechCapabilitiesResponse {
    const apiKey = this.resolveApiKey()
    return {
      available: true,
      configured: Boolean(apiKey),
      provider: "deepgram",
      supportsStt: false,
      supportsTts: true,
      supportsStreamingTts: true,
      baseUrl: DEEPGRAM_BASE,
      sttModel: "nova-3",
      ttsModel: "aura-2",
      ttsVoice: this.options.settings.ttsVoice || "aura-asteria-en",
      ttsFormats: ["mp3", "wav", "opus", "aac"],
      streamingTtsFormats: ["mp3", "wav", "opus", "aac"],
    }
  }

  async transcribe(_input: TranscribeAudioInput): Promise<never> {
    throw new Error(
      "Deepgram REST transcription is not supported via this provider. " +
      "Live STT is handled via WebSocket in the concierge module.",
    )
  }

  async synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    const apiKey = this.resolveApiKey()
    const mimeType = resolveMimeType(input.format)

    this.options.logger.info(
      { textLength: input.text.length, voice: this.options.settings.ttsVoice, format: input.format },
      "deepgram.synthesize",
    )

    const response = await this.requestTts(input.text, apiKey, input.format)
    const audioBuffer = Buffer.from(await response.arrayBuffer())

    return {
      audioBase64: audioBuffer.toString("base64"),
      mimeType: response.headers.get("content-type") || mimeType,
    }
  }

  async synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    const apiKey = this.resolveApiKey()
    const mimeType = resolveMimeType(input.format)

    this.options.logger.info(
      { textLength: input.text.length, voice: this.options.settings.ttsVoice, format: input.format },
      "deepgram.synthesize.stream",
    )

    const response = await this.requestTts(input.text, apiKey, input.format)

    if (!response.body) {
      throw new Error("Deepgram TTS did not return a response body.")
    }

    return {
      stream: Readable.fromWeb(response.body as any),
      mimeType: response.headers.get("content-type") || mimeType,
    }
  }

  private async requestTts(
    text: string,
    apiKey: string,
    format?: "mp3" | "wav" | "opus" | "aac",
  ): Promise<Response> {
    const voice = this.options.settings.ttsVoice || "aura-asteria-en"

    // Map the abstract format to encoding/container parameters
    const params = encodingParamsForFormat(format)

    const url = new URL(`${DEEPGRAM_BASE}/speak`)
    url.searchParams.set("model", voice)
    if (params.encoding) url.searchParams.set("encoding", params.encoding)
    if (params.sampleRate) url.searchParams.set("sample_rate", String(params.sampleRate))
    if (params.container) url.searchParams.set("container", params.container)

    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
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
        "deepgram.synthesize fetch failed",
      )
      throw error
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(
        `Deepgram TTS failed (${response.status}): ${detail || response.statusText}`,
      )
    }

    return response
  }

  private resolveApiKey(): string {
    const key =
      this.options.settings.apiKey?.trim() || process.env.DEEPGRAM_API_KEY?.trim()

    if (!key) {
      throw new Error(
        "Deepgram API key is not configured. Set DEEPGRAM_API_KEY in the CodeNomad .env " +
        "or configure it in the Speech settings panel.",
      )
    }

    return key
  }
}

// ── Format Helpers ──────────────────────────────────────────────────────

function resolveMimeType(format?: "mp3" | "wav" | "opus" | "aac"): string {
  switch (format) {
    case "wav":
      return `audio/wav`
    case "opus":
      return 'audio/ogg; codecs="opus"'
    case "aac":
      return "audio/aac"
    case "mp3":
    default:
      return "audio/mpeg"
  }
}

interface EncodingParams {
  encoding?: string
  sampleRate?: number
  container?: string
}

function encodingParamsForFormat(format?: "mp3" | "wav" | "opus" | "aac"): EncodingParams {
  switch (format) {
    case "wav":
      return { encoding: "linear16", sampleRate: SAMPLE_RATE, container: "wav" }
    case "opus":
      return { encoding: "opus", sampleRate: SAMPLE_RATE }
    case "aac":
      return { encoding: "aac", sampleRate: SAMPLE_RATE }
    case "mp3":
    default:
      // Deepgram defaults to MP3 when no encoding is specified
      return {}
  }
}
