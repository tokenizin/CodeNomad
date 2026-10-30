/**
 * VoxCPM2 text-to-speech for the `/api/speech` endpoints (batch + streaming).
 *
 *   synthesize        → one sidecar request in the requested container (wav always; mp3/opus/aac need ffmpeg on the sidecar host)
 *   synthesizeStream  → wav: the sidecar's WAV stream passed straight through
 *                       mp3/aac: the sidecar's PCM stream transcoded live by ffmpeg on this host (MediaSource-playable)
 *                       opus: not streamable (use batch)
 *
 * @module voxcpm-synth
 */

import { Readable } from "node:stream"
import type { SpeechCapabilitiesResponse, SpeechSynthesisResponse } from "../../api-types"
import type { Logger } from "../../logger"
import type { SpeechSynthesisStreamResponse, SynthesizeSpeechInput } from "../service"
import { postSpeech, resolveVoxCpmConfig, sidecarErrorDetail, type VoxCpmConfig } from "../../plugins/tokidapp/concierge/voxcpm-client"
import { resolveSpeechVoice } from "../../plugins/tokidapp/concierge/voxcpm-tts"
import { TRANSCODE_MIME, ffmpegAvailable, transcodePcmStream, type TranscodeFormat } from "../pcm-transcode"

type Format = NonNullable<SynthesizeSpeechInput["format"]>

/** The sidecar rejects input above 4000 characters. */
export const MAX_SPEECH_CHARS = 3500

const BATCH_MIME: Record<Format, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  aac: "audio/aac",
}

export const STREAMING_FORMATS: readonly Format[] = ["wav", "mp3", "aac"]

/** VoxCPM2 delivery settings sent with every request (all optional; the sidecar has defaults). */
export interface VoxCpmDelivery {
  /** professional | calm | enthusiastic | conversational | news */
  style?: string
  /** fast (6 steps) | balanced (10) | high (16) */
  quality?: string
  /** 0.25 – 4.0 */
  speed?: number
  /** Free-text delivery control ("warm, unhurried"). */
  instructions?: string
  /** Fixed seed for a repeatable timbre. */
  seed?: number
}

export interface VoxCpmSynthOptions {
  /** The `ttsVoice` speech setting. */
  voice: string
  delivery?: VoxCpmDelivery
  /** The `ttsFormat` speech setting, used when a request names no format. */
  defaultFormat: Format
  logger: Logger
  config?: Partial<VoxCpmConfig>
  fetchImpl?: typeof fetch
  /** Overridable for tests. */
  ffmpegAvailable?: () => boolean
  transcode?: typeof transcodePcmStream
}

export class VoxCpmSynthesizer {
  private readonly config: VoxCpmConfig
  private readonly voice: string

  constructor(private readonly options: VoxCpmSynthOptions) {
    this.config = resolveVoxCpmConfig(options.config)
    this.voice = resolveSpeechVoice(options.voice)
  }

  capabilities(): Pick<
    SpeechCapabilitiesResponse,
    "supportsTts" | "supportsStreamingTts" | "ttsModel" | "ttsVoice" | "ttsFormats" | "streamingTtsFormats" | "baseUrl"
  > {
    return {
      supportsTts: true,
      supportsStreamingTts: true,
      baseUrl: this.config.baseUrl,
      ttsModel: "voxcpm2",
      ttsVoice: this.voice,
      // mp3/opus/aac depend on ffmpeg being installed (sidecar host for batch, this host for streaming).
      ttsFormats: ["wav", "mp3", "opus", "aac"],
      streamingTtsFormats: [...STREAMING_FORMATS],
    }
  }

  async synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    const text = this.prepare(input.text)
    const format = input.format ?? this.options.defaultFormat
    this.options.logger.info({ textLength: text.length, voice: this.voice, format }, "voxcpm.synthesize")

    const res = await this.request({ ...this.deliveryBody(), input: text, voice: this.voice, stream: false, response_format: format })
    const audio = Buffer.from(await res.arrayBuffer())
    return { audioBase64: audio.toString("base64"), mimeType: BATCH_MIME[format] }
  }

  async synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    const text = this.prepare(input.text)
    const format = input.format ?? this.options.defaultFormat
    if (!STREAMING_FORMATS.includes(format)) {
      throw new Error(`VoxCPM2 streams ${STREAMING_FORMATS.join(", ")}; ${format} is only available without streaming`)
    }
    const transcoded = format !== "wav"
    if (transcoded && !(this.options.ffmpegAvailable ?? ffmpegAvailable)()) {
      // "not configured" maps to HTTP 503 in the speech route.
      throw new Error(`VoxCPM2 ${format} streaming is not configured: ffmpeg is not installed on this host (brew install ffmpeg), or use wav`)
    }
    this.options.logger.info({ textLength: text.length, voice: this.voice, format }, "voxcpm.synthesize.stream")

    const abort = new AbortController()
    const res = await this.request(
      { ...this.deliveryBody(), input: text, voice: this.voice, stream: true, response_format: transcoded ? "pcm" : "wav" },
      abort.signal,
    )
    if (!res.body) throw new Error("VoxCPM2 sidecar returned no audio stream")
    const source = Readable.fromWeb(res.body as never)
    source.on("close", () => abort.abort())

    if (!transcoded) return { stream: source, mimeType: "audio/wav" }
    const sampleRate = Number(res.headers.get("x-sample-rate")) || 48000
    const stream = (this.options.transcode ?? transcodePcmStream)(source, { sampleRate, format: format as TranscodeFormat })
    return { stream, mimeType: TRANSCODE_MIME[format as TranscodeFormat] }
  }

  /** Delivery fields for the sidecar's /v1/audio/speech (only the ones set). */
  private deliveryBody(): Record<string, unknown> {
    const d = this.options.delivery ?? {}
    const body: Record<string, unknown> = {}
    if (d.style) body.style = d.style
    if (d.quality) body.quality = d.quality
    if (typeof d.speed === "number" && d.speed >= 0.25 && d.speed <= 4) body.speed = d.speed
    if (d.instructions) body.instructions = d.instructions
    if (typeof d.seed === "number" && Number.isInteger(d.seed)) body.seed = d.seed
    return body
  }

  private prepare(raw: string): string {
    const text = raw.trim()
    if (!text) throw new Error("Text is required")
    if (text.length > MAX_SPEECH_CHARS) {
      throw new Error(`Text is ${text.length} characters; VoxCPM2 accepts at most ${MAX_SPEECH_CHARS} per request — split it`)
    }
    return text
  }

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let res: Response
    try {
      res = await postSpeech(this.config, body, { signal, fetchImpl: this.options.fetchImpl })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`VoxCPM2 sidecar unreachable at ${this.config.baseUrl}: ${message}`)
    }
    if (res.ok) return res

    const detail = await sidecarErrorDetail(res)
    if (res.status === 401 || res.status === 403) {
      throw new Error("VoxCPM2 sidecar rejected the request — VOXCPM_SIDECAR_API_KEY must match the sidecar's key")
    }
    // 503 = model still loading or queue full. "not configured" is what the speech route maps to HTTP 503.
    if (res.status === 503) throw new Error(`VoxCPM2 is not configured or not ready: ${detail}`)
    throw new Error(`VoxCPM2 sidecar ${res.status}: ${detail}`)
  }
}
