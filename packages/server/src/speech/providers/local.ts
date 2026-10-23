/**
 * Local SpeechProvider — faster-whisper STT + VoxCPM2 TTS, fully on the Mac Studio.
 *
 * Selected when the speech provider is "local". STT is batch transcription through the local Python faster-whisper
 * server. TTS (batch and streaming) is the VoxCPM2 sidecar — see `voxcpm-synth.ts` for formats and limits and
 * docs/LOCAL_VOICE_VOXCPM2.md for setup (VOXCPM_SIDECAR_URL / VOXCPM_SIDECAR_API_KEY).
 *
 * @module local-speech-provider
 */

import type { SpeechCapabilitiesResponse, SpeechSynthesisResponse, SpeechTranscriptionResponse } from "../../api-types"
import type { Logger } from "../../logger"
import type {
  NormalizedSpeechSettings,
  SpeechProvider,
  SpeechSynthesisStreamResponse,
  SynthesizeSpeechInput,
  TranscribeAudioInput,
} from "../service"
import { createLocalSTTConnection } from "../../plugins/tokidapp/concierge/local-stt"
import { VoxCpmSynthesizer } from "./voxcpm-synth"

interface LocalSpeechProviderOptions {
  settings: NormalizedSpeechSettings
  logger: Logger
}

/**
 * Local STT SpeechProvider — batch transcription via faster-whisper.
 *
 * Transcription creates a short-lived connection to the Python server,
 * sends the complete audio buffer, and waits for the final transcript.
 * This is suitable for the speech settings "Test" button but not for
 * real-time streaming (use the concierge `createLocalSTTConnection` for that).
 */
export class LocalSpeechProvider implements SpeechProvider {
  private readonly tts: VoxCpmSynthesizer

  constructor(private readonly options: LocalSpeechProviderOptions) {
    this.tts = new VoxCpmSynthesizer({
      voice: options.settings.ttsVoice,
      defaultFormat: options.settings.ttsFormat,
      logger: options.logger,
    })
  }

  getCapabilities(): SpeechCapabilitiesResponse {
    return {
      available: true,
      configured: true, // No API key needed — runs locally
      provider: "local",
      supportsStt: true,
      sttModel: process.env.LOCAL_STT_MODEL?.trim() || "large-v3",
      ...this.tts.capabilities(),
    }
  }

  async transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse> {
    const startedAt = Date.now()
    const model = process.env.LOCAL_STT_MODEL?.trim() || "large-v3"
    const language = input.language || process.env.LOCAL_STT_LANGUAGE?.trim() || "en"

    this.options.logger.info(
      {
        mimeType: input.mimeType,
        bytes: Math.floor(input.audioBase64.length * 0.75),
        language,
        model,
      },
      "local.stt.transcribe",
    )

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        connection.close()
        reject(new Error("Local STT transcription timed out after 30s"))
      }, 30_000)

      const connection = createLocalSTTConnection({
        model,
        language,
        onTranscript: (text, isFinal) => {
          if (isFinal) {
            clearTimeout(timeout)
            connection.close()
            resolve({
              text,
              language,
              durationMs: Date.now() - startedAt,
            })
          }
        },
        onError: (error) => {
          clearTimeout(timeout)
          connection.close()
          reject(error)
        },
        onClose: (code) => {
          clearTimeout(timeout)
          // If process exits before we got a transcript, it's an error
          reject(new Error(`Local STT process exited with code ${code} before producing transcript`))
        },
      })

      // Send the entire audio buffer as a single chunk
      // The Python server will buffer and transcribe it
      connection.sendAudio(input.audioBase64)

      // Flush to trigger immediate transcription of the buffer
      connection.flush()
    })
  }

  synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    return this.tts.synthesize(input)
  }

  synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    return this.tts.synthesizeStream(input)
  }
}
