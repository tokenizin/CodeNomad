import { Readable } from "node:stream"
import OpenAI from "openai"
import { toFile } from "openai/uploads"
import type { SpeechSynthesisResponse, SpeechTranscriptionResponse } from "../../api-types"
import type { Logger } from "../../logger"
import type { NormalizedSpeechSettings, SpeechSynthesisStreamResponse, SynthesizeSpeechInput, TranscribeAudioInput } from "../service"
import { reportAiUsage } from "../../billing/ai-usage-report"

interface OpenAICompatibleSpeechProviderOptions {
  settings: NormalizedSpeechSettings
  logger: Logger
}

export class OpenAICompatibleSpeechProvider {
  constructor(private readonly options: OpenAICompatibleSpeechProviderOptions) {}

  getCapabilities() {
    const { settings } = this.options
    return {
      available: true,
      configured: Boolean(settings.apiKey),
      provider: settings.provider,
      supportsStt: true,
      supportsTts: true,
      supportsStreamingTts: true,
      baseUrl: settings.baseUrl,
      sttModel: settings.sttModel,
      ttsModel: settings.ttsModel,
      ttsVoice: settings.ttsVoice,
      ttsFormats: ["mp3", "wav", "opus", "aac"],
      streamingTtsFormats: ["mp3", "wav", "opus", "aac"],
    }
  }

  async transcribe(input: TranscribeAudioInput, userId: string | null): Promise<SpeechTranscriptionResponse> {
    const client = this.createClient()
    const startedAt = Date.now()
    const extension = extensionForMime(input.mimeType)
    const buffer = Buffer.from(input.audioBase64, "base64")
    const filename = input.filename?.trim() || `prompt-input.${extension}`

    this.options.logger.info(
      {
        mimeType: input.mimeType,
        bytes: buffer.byteLength,
        language: input.language,
        model: this.options.settings.sttModel,
      },
      "speech.transcribe",
    )

    const response = await this.requestTranscription(client, buffer, filename, input)

    // Fire-and-forget — never let a metering report delay or fail a
    // transcription that already succeeded. Token-priced (the response
    // carries real usage for gpt-4o-mini-transcribe), so this always
    // reports regardless of which OpenAI-compatible backend served it —
    // same flat placeholder rate every other token-priced call in this
    // system uses (see /api/internal/ai-usage-event's module doc).
    if (userId) {
      void reportAiUsage({
        userId,
        modelId: this.options.settings.sttModel,
        provider: this.options.settings.provider,
        requestId: `codenomad_speech_stt_${crypto.randomUUID()}`,
        raw: response,
      })
    }

    return {
      text: typeof response?.text === "string" ? response.text : "",
      language: typeof response?.language === "string" ? response.language : input.language,
      durationMs: Number.isFinite(response?.duration) ? Math.round(Number(response.duration) * 1000) : Date.now() - startedAt,
      segments: Array.isArray(response?.segments)
        ? response.segments
            .filter((segment: any) => typeof segment?.text === "string")
            .map((segment: any) => ({
              startMs: Math.max(0, Math.round(Number(segment.start ?? 0) * 1000)),
              endMs: Math.max(0, Math.round(Number(segment.end ?? 0) * 1000)),
              text: String(segment.text),
            }))
        : undefined,
    }
  }

  private async requestTranscription(
    client: OpenAI,
    buffer: Buffer,
    filename: string,
    input: TranscribeAudioInput,
  ): Promise<any> {
    const baseRequest = {
      model: this.options.settings.sttModel,
      ...(input.language ? { language: input.language } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
    }

    try {
      const file = await toFile(buffer, filename, { type: input.mimeType })
      return (await client.audio.transcriptions.create({
        ...baseRequest,
        file,
        response_format: "json",
      } as any)) as any
    } catch (error) {
      this.options.logger.warn({ err: error }, "speech.transcribe verbose_json failed; retrying default format")
      const retryFile = await toFile(buffer, filename, { type: input.mimeType })
      return (await client.audio.transcriptions.create({
        ...baseRequest,
        file: retryFile,
      } as any)) as any
    }
  }

  async synthesize(input: SynthesizeSpeechInput, userId: string | null): Promise<SpeechSynthesisResponse> {
    const format = input.format ?? this.options.settings.ttsFormat

    this.options.logger.info(
      {
        model: this.options.settings.ttsModel,
        voice: this.options.settings.ttsVoice,
        format,
      },
      "speech.synthesize",
    )

    const response = await this.requestSpeechAudio(input.text, format)
    const mimeType = response.headers.get("content-type") || mimeTypeForFormat(format)

    const audioBuffer = Buffer.from(await response.arrayBuffer())
    this.reportTtsUsage(userId, input.text)
    return {
      audioBase64: audioBuffer.toString("base64"),
      mimeType,
    }
  }

  async synthesizeStream(input: SynthesizeSpeechInput, userId: string | null): Promise<SpeechSynthesisStreamResponse> {
    const format = input.format ?? this.options.settings.ttsFormat

    this.options.logger.info(
      {
        model: this.options.settings.ttsModel,
        voice: this.options.settings.ttsVoice,
        format,
      },
      "speech.synthesize.stream",
    )

    const response = await this.requestSpeechAudio(input.text, format)
    this.reportTtsUsage(userId, input.text)
    if (!response.body) {
      throw new Error("Speech provider did not return a stream.")
    }

    return {
      stream: Readable.fromWeb(response.body as any),
      mimeType: response.headers.get("content-type") || mimeTypeForFormat(format),
    }
  }

  private async requestSpeechAudio(text: string, format: "mp3" | "wav" | "opus" | "aac"): Promise<Response> {
    const { settings } = this.options
    if (!settings.apiKey) {
      throw new Error("Speech provider is not configured. Add an API key in Speech settings.")
    }

    const endpoint = new URL("audio/speech", ensureTrailingSlash(settings.baseUrl ?? "https://api.openai.com/v1"))
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: settings.ttsModel,
          voice: settings.ttsVoice,
          input: text,
          response_format: format,
        }),
      })
    } catch (error) {
      const detailedError = error as Error & {
        cause?: unknown
        code?: string
        errno?: number | string
        syscall?: string
        address?: string
        port?: number
      }
      this.options.logger.error(
        {
          err: error,
          endpoint: endpoint.toString(),
          baseUrl: settings.baseUrl,
          model: settings.ttsModel,
          voice: settings.ttsVoice,
          format,
          cause: detailedError.cause,
          code: detailedError.code,
          errno: detailedError.errno,
          syscall: detailedError.syscall,
          address: detailedError.address,
          port: detailedError.port,
        },
        "speech.synthesize fetch failed",
      )
      throw error
    }

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(detail || `Speech synthesis failed with ${response.status}`)
    }

    return response
  }

  private createClient(): OpenAI {
    const { settings } = this.options
    if (!settings.apiKey) {
      throw new Error("Speech provider is not configured. Add an API key in Speech settings.")
    }

    return new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
    })
  }

  /**
   * Fire-and-forget character-count usage report for a TTS call — never let
   * a metering report delay or fail audio that already synthesized
   * successfully.
   *
   * Only reports when `baseUrl` is unset, i.e. this really went to OpenAI's
   * own `api.openai.com` (the default — see requestSpeechAudio). StarGuard's
   * tts-1/tts-1-hd per-character pricing is OpenAI's own published rate; a
   * custom baseUrl means a different (possibly self-hosted, possibly free)
   * backend, which that rate doesn't describe, so this skips reporting
   * entirely rather than mislabel an unverified call as OpenAI's.
   */
  private reportTtsUsage(userId: string | null, text: string): void {
    if (!userId) return
    if (this.options.settings.baseUrl) return
    void reportAiUsage({
      userId,
      modelId: this.options.settings.ttsModel,
      provider: "openai",
      requestId: `codenomad_speech_tts_${crypto.randomUUID()}`,
      characterCount: text.length,
    })
  }
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes("webm")) return "webm"
  if (normalized.includes("ogg")) return "ogg"
  if (normalized.includes("wav")) return "wav"
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3"
  if (normalized.includes("mp4") || normalized.includes("aac")) return "m4a"
  return "webm"
}

function mimeTypeForFormat(format: "mp3" | "wav" | "opus" | "aac"): string {
  if (format === "wav") return "audio/wav"
  if (format === "opus") return 'audio/ogg; codecs="opus"'
  if (format === "aac") return "audio/aac"
  return "audio/mpeg"
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`
}
