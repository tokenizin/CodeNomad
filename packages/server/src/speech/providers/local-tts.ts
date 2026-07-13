/**
 * Local Piper TTS SpeechProvider implementation.
 *
 * Provides batch (non-streaming) TTS synthesis using the local Piper TTS
 * engine via the `local-tts.ts` child process module.  STT is not supported
 * — use a separate provider for transcription.
 *
 * This provider is selected when the speech settings `provider` is `"local"`.
 *
 * @module speech/providers/local-tts
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
import {
  createLocalTTSConnection,
  splitSentences,
  type LocalTTSConnection,
} from "../../plugins/tokidapp/concierge/local-tts"

interface LocalSpeechProviderOptions {
  settings: NormalizedSpeechSettings
  logger: Logger
}

/** PCM sample rate — must match the Python server output. */
const SAMPLE_RATE = 24000

/**
 * Local Piper TTS SpeechProvider.
 *
 * Uses `createLocalTTSConnection` to spawn a Python child process for each
 * synthesis request.  The connection is reused across calls and only closed
 * when the provider is disposed.
 */
export class LocalSpeechProvider implements SpeechProvider {
  private connection: LocalTTSConnection | null = null

  constructor(private readonly options: LocalSpeechProviderOptions) {}

  getCapabilities(): SpeechCapabilitiesResponse {
    return {
      available: true,
      configured: true, // Always available — no API key needed
      provider: "local",
      supportsStt: false,
      supportsTts: true,
      supportsStreamingTts: true,
      baseUrl: "local://piper",
      sttModel: "",
      ttsModel: "piper",
      ttsVoice: this.options.settings.ttsVoice || "en_US-amy-medium",
      ttsFormats: ["wav"],
      streamingTtsFormats: ["wav"],
    }
  }

  async transcribe(_input: TranscribeAudioInput): Promise<never> {
    throw new Error(
      "Local Piper TTS does not support speech-to-text. " +
      "Use a separate STT provider (Deepgram, OpenAI) for transcription.",
    )
  }

  async synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    const voice = this.options.settings.ttsVoice || "en_US-amy-medium"

    this.options.logger.info(
      { textLength: input.text.length, voice },
      "local-tts.synthesize",
    )

    const audioChunks = await this.synthesizeAudio(input.text, voice)

    // Concatenate all base64 chunks into a single audio buffer
    const combined = audioChunks.join("")
    const pcmBuffer = Buffer.from(combined, "base64")

    // Wrap raw PCM in a WAV container for downstream compatibility
    const wavBuffer = pcmToWav(pcmBuffer, SAMPLE_RATE)

    return {
      audioBase64: wavBuffer.toString("base64"),
      mimeType: "audio/wav",
    }
  }

  async synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    const voice = this.options.settings.ttsVoice || "en_US-amy-medium"

    this.options.logger.info(
      { textLength: input.text.length, voice },
      "local-tts.synthesize.stream",
    )

    const sentences = splitSentences(input.text)

    const readable = new Readable({
      read() {
        // The stream is pushed via the connection callbacks
      },
    })

    // Open a fresh connection for this stream
    const conn = createLocalTTSConnection(voice, {
      onAudio(base64Chunk) {
        const pcm = Buffer.from(base64Chunk, "base64")
        readable.push(pcm)
      },
      onFlushed() {
        readable.push(null) // Signal end of stream
      },
      onError(err) {
        readable.destroy(err)
      },
    })

    // Send all sentences
    for (const sentence of sentences) {
      conn.speak(sentence)
    }
    conn.flush()

    // Clean up connection when stream ends
    readable.on("close", () => conn.close())

    return {
      stream: readable,
      mimeType: "audio/pcm",
    }
  }

  /**
   * Synthesize text and return an array of base64-encoded PCM chunks.
   * Used by the batch `synthesize` method.
   */
  private async synthesizeAudio(text: string, voice: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const chunks: string[] = []
      let finished = false

      const conn = createLocalTTSConnection(voice, {
        onAudio(base64Chunk) {
          chunks.push(base64Chunk)
        },
        onFlushed() {
          if (!finished) {
            finished = true
            conn.close()
            resolve(chunks)
          }
        },
        onError(err) {
          if (!finished) {
            finished = true
            conn.close()
            reject(err)
          }
        },
        onClose() {
          // If process closes before flushed, resolve with what we have
          if (!finished) {
            finished = true
            if (chunks.length > 0) {
              resolve(chunks)
            } else {
              reject(new Error("Process closed before producing audio"))
            }
          }
        },
      })

      // Timeout after 30 seconds
      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true
          conn.close()
          reject(new Error("TTS synthesis timed out after 30s"))
        }
      }, 30_000)

      conn.speak(text)
      conn.flush()

      // Clear timeout if we finish early
      const origResolve = resolve
      const origReject = reject
      resolve = (v) => { clearTimeout(timeout); origResolve(v) }
      reject = (e) => { clearTimeout(timeout); origReject(e) }
    })
  }
}

// ── WAV Helpers ──────────────────────────────────────────────────────────

/**
 * Convert raw 16-bit signed LE PCM bytes to a WAV file.
 */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcm.length
  const headerSize = 44

  const header = Buffer.alloc(headerSize)

  // RIFF header
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write("WAVE", 8)

  // fmt sub-chunk
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)        // sub-chunk size
  header.writeUInt16LE(1, 20)         // PCM format
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 30)
  header.writeUInt16LE(bitsPerSample, 32)

  // data sub-chunk
  header.write("data", 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcm])
}
