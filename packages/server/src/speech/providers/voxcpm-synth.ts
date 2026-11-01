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

import { PassThrough, Readable } from "node:stream"
import type { SpeechCapabilitiesResponse, SpeechSynthesisResponse } from "../../api-types"
import type { Logger } from "../../logger"
import type { SpeechSynthesisStreamResponse, SynthesizeSpeechInput } from "../service"
import { VOXCPM_KEY_HINT, postSpeech, resolveVoxCpmConfig, sidecarErrorDetail, type VoxCpmConfig } from "../../plugins/tokidapp/concierge/voxcpm-client"
import { DEFAULT_VOXCPM_VOICE, resolveSpeechVoice } from "../../plugins/tokidapp/concierge/voxcpm-tts"
import { TRANSCODE_MIME, ffmpegAvailable, transcodePcmStream, type TranscodeFormat } from "../pcm-transcode"

type Format = NonNullable<SynthesizeSpeechInput["format"]>

/** Characters per sidecar request (it rejects more than 4000; shorter chunks start playing sooner). */
export const MAX_SPEECH_CHARS = 1500

/** Longest text one Speak request accepts (about 20 minutes of audio). */
export const MAX_TOTAL_SPEECH_CHARS = 20_000

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
  private config: VoxCpmConfig
  private voice: string

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
    const chunks = this.prepare(input.text)
    const format = input.format ?? this.options.defaultFormat
    const textLength = chunks.reduce((n, c) => n + c.length, 0)
    this.options.logger.info({ textLength, chunks: chunks.length, voice: this.voice, format }, "voxcpm.synthesize")

    if (chunks.length > 1) {
      // Long text: one sidecar request per chunk as raw PCM, joined into a single WAV.
      let sampleRate = 48000
      const parts: Buffer[] = []
      for (const chunk of chunks) {
        const res = await this.request({ ...this.deliveryBody(), input: chunk, voice: this.voice, stream: false, response_format: "pcm" })
        sampleRate = Number(res.headers.get("x-sample-rate")) || sampleRate
        parts.push(Buffer.from(await res.arrayBuffer()))
      }
      const pcm = Buffer.concat(parts)
      const audio = Buffer.concat([wavHeader(sampleRate, pcm.length), pcm])
      return { audioBase64: audio.toString("base64"), mimeType: BATCH_MIME.wav }
    }

    const body = { ...this.deliveryBody(), input: chunks[0], voice: this.voice, stream: false }
    let res: Response
    try {
      res = await this.request({ ...body, response_format: format })
    } catch (err) {
      // mp3/opus/aac need ffmpeg on the sidecar host. When it isn't there, send WAV
      // (every browser plays it in buffered mode) instead of failing the request.
      if (format === "wav" || !(err instanceof SidecarFormatError)) throw err
      this.options.logger.warn({ format, detail: err.message }, "voxcpm.synthesize.wav-fallback")
      res = await this.request({ ...body, response_format: "wav" })
      const audio = Buffer.from(await res.arrayBuffer())
      return { audioBase64: audio.toString("base64"), mimeType: BATCH_MIME.wav }
    }
    const audio = Buffer.from(await res.arrayBuffer())
    return { audioBase64: audio.toString("base64"), mimeType: BATCH_MIME[format] }
  }

  async synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    const chunks = this.prepare(input.text)
    const format = input.format ?? this.options.defaultFormat
    if (!STREAMING_FORMATS.includes(format)) {
      throw new Error(`VoxCPM2 streams ${STREAMING_FORMATS.join(", ")}; ${format} is only available without streaming`)
    }
    const transcoded = format !== "wav"
    if (transcoded && !(this.options.ffmpegAvailable ?? ffmpegAvailable)()) {
      // "not configured" maps to HTTP 503 in the speech route.
      throw new Error(`VoxCPM2 ${format} streaming is not configured: ffmpeg is not installed on this host (brew install ffmpeg), or use wav`)
    }
    const textLength = chunks.reduce((n, c) => n + c.length, 0)
    this.options.logger.info({ textLength, chunks: chunks.length, voice: this.voice, format }, "voxcpm.synthesize.stream")

    const abort = new AbortController()
    const open = (chunk: string, responseFormat: string) =>
      this.request({ ...this.deliveryBody(), input: chunk, voice: this.voice, stream: true, response_format: responseFormat }, abort.signal)

    if (chunks.length === 1) {
      const res = await open(chunks[0], transcoded ? "pcm" : "wav")
      if (!res.body) throw new Error("VoxCPM2 sidecar returned no audio stream")
      const source = Readable.fromWeb(res.body as never)
      abortWhenClosed(source, abort)
      if (!transcoded) return { stream: source, mimeType: "audio/wav" }
      const sampleRate = Number(res.headers.get("x-sample-rate")) || 48000
      const stream = (this.options.transcode ?? transcodePcmStream)(source, { sampleRate, format: format as TranscodeFormat })
      return { stream, mimeType: TRANSCODE_MIME[format as TranscodeFormat] }
    }

    // Long text: chunks streamed one after another as one continuous PCM stream.
    const first = await open(chunks[0], "pcm")
    const sampleRate = Number(first.headers.get("x-sample-rate")) || 48000
    const pcm = new PassThrough()
    pcm.on("close", () => abort.abort())
    void (async () => {
      try {
        for (let i = 0; i < chunks.length; i += 1) {
          const res = i === 0 ? first : await open(chunks[i], "pcm")
          if (!res.body) throw new Error("VoxCPM2 sidecar returned no audio stream")
          for await (const piece of Readable.fromWeb(res.body as never)) {
            if (pcm.destroyed) return
            if (!pcm.write(piece)) await new Promise((r) => pcm.once("drain", r))
          }
        }
        pcm.end()
      } catch (err) {
        if (!pcm.destroyed) pcm.destroy(err as Error)
      }
    })()

    if (!transcoded) {
      const wav = new PassThrough()
      wav.write(wavHeader(sampleRate, 0xffffffff - 36))
      pcm.pipe(wav)
      pcm.on("error", (err) => wav.destroy(err))
      wav.on("close", () => pcm.destroy())
      return { stream: wav, mimeType: "audio/wav" }
    }
    const stream = (this.options.transcode ?? transcodePcmStream)(pcm, { sampleRate, format: format as TranscodeFormat })
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

  /** The text split into sidecar-sized chunks. */
  private prepare(raw: string): string[] {
    const text = raw.trim()
    if (!text) throw new Error("Text is required")
    if (text.length > MAX_TOTAL_SPEECH_CHARS) {
      throw new Error(`Text is too long to speak: ${text.length} characters (at most ${MAX_TOTAL_SPEECH_CHARS})`)
    }
    return splitForSpeech(text, MAX_SPEECH_CHARS)
  }

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.send(body, signal)
    } catch (err) {
      // A saved voice the sidecar doesn't have (deleted library voice, an OpenAI name like "alloy"):
      // speak with the default voice instead of failing every request.
      if (!(err instanceof SidecarUnknownVoiceError) || body.voice === DEFAULT_VOXCPM_VOICE) throw err
      this.options.logger.warn({ voice: body.voice, fallback: DEFAULT_VOXCPM_VOICE }, "voxcpm.synthesize.unknown-voice")
      this.voice = DEFAULT_VOXCPM_VOICE
      return this.send({ ...body, voice: DEFAULT_VOXCPM_VOICE }, signal)
    }
  }

  private async send(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let res: Response
    try {
      res = await postSpeech(this.config, body, { signal, fetchImpl: this.options.fetchImpl })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`VoxCPM2 sidecar unreachable at ${this.config.baseUrl}: ${message}`)
    }
    if (res.ok) return res

    if ((res.status === 401 || res.status === 403) && this.config.fallbackApiKey) {
      // The key saved in Speech settings is wrong; the sidecar's own key (found on this host) is right.
      this.options.logger.warn({ baseUrl: this.config.baseUrl }, "voxcpm.synthesize.saved-key-refused")
      this.config = { ...this.config, apiKey: this.config.fallbackApiKey, fallbackApiKey: undefined }
      return this.send(body, signal)
    }
    const detail = await sidecarErrorDetail(res)
    if (res.status === 401 || res.status === 403) {
      throw new Error(`VoxCPM2 sidecar refused the API key. ${VOXCPM_KEY_HINT}; put that value in Speech settings → Sidecar API key.`)
    }
    // 503 = model still loading or queue full. "not configured" is what the speech route maps to HTTP 503.
    if (res.status === 503) throw new Error(`VoxCPM2 is not configured or not ready: ${detail}`)
    if (res.status === 404 && /unknown voice/i.test(detail)) throw new SidecarUnknownVoiceError(`VoxCPM2 sidecar: ${detail}`)
    if (res.status === 400 && /response_format|ffmpeg/i.test(detail)) throw new SidecarFormatError(`VoxCPM2 sidecar: ${detail}`)
    throw new Error(`VoxCPM2 sidecar ${res.status}: ${detail}`)
  }
}

/** The sidecar can't produce the requested container (usually: no ffmpeg on its host). */
export class SidecarFormatError extends Error {}

/** The sidecar has no voice with the requested id. */
export class SidecarUnknownVoiceError extends Error {}

/**
 * Abort the sidecar request when the consumer stops reading the response.
 *
 * Node emits "close" when a stream is destroyed, but Bun's `Readable.fromWeb()`
 * only does so once the stream has started flowing — a client that disconnects
 * before the first audio byte would leave the sidecar synthesising into the
 * void. The abort is therefore tied to `destroy()` itself as well as to the
 * close/error events, so it happens on both runtimes.
 */
function abortWhenClosed(stream: Readable, abort: AbortController): void {
  const cancel = () => abort.abort()
  stream.on("close", cancel)
  stream.on("error", cancel)
  const destroy = stream.destroy.bind(stream)
  stream.destroy = (error?: Error) => {
    cancel()
    return destroy(error)
  }
}

/** Split text into chunks of at most `max` characters, at paragraph, then sentence, then word boundaries. */
export function splitForSpeech(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const pieces = text.split(/(?<=\n\n)|(?<=[.!?。！？])\s+/)
  const chunks: string[] = []
  let current = ""
  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ""
  }
  for (const piece of pieces) {
    if (!piece) continue
    if (piece.length > max) {
      flush()
      let rest = piece
      while (rest.length > max) {
        let cut = rest.lastIndexOf(" ", max)
        if (cut < max / 2) cut = max
        chunks.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut)
      }
      current = rest
      continue
    }
    if (current && current.length + 1 + piece.length > max) flush()
    current = current ? `${current} ${piece}` : piece
  }
  flush()
  return chunks.filter(Boolean)
}

/** 44-byte header for 16-bit mono PCM. */
function wavHeader(sampleRate: number, dataBytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write("RIFF", 0)
  h.writeUInt32LE(Math.min(0xffffffff, 36 + dataBytes), 4)
  h.write("WAVE", 8)
  h.write("fmt ", 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write("data", 36)
  h.writeUInt32LE(Math.min(0xffffffff, dataBytes), 40)
  return h
}
