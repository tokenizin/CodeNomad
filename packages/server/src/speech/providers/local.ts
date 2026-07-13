/**
 * Local STT SpeechProvider — faster-whisper batch transcription.
 *
 * Implements the `SpeechProvider` interface for the speech settings panel.
 * Uses the local Python faster-whisper server for batch transcription
 * (non-streaming). TTS is not supported — use OpenAI or Deepgram for that.
 *
 * This provider is selected when the speech provider is set to "local"
 * in the speech settings. It requires no API keys — runs fully offline
 * on the Mac Studio Ultra with Metal GPU acceleration.
 *
 * @module local-stt-provider
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
  constructor(private readonly options: LocalSpeechProviderOptions) {}

  getCapabilities(): SpeechCapabilitiesResponse {
    return {
      available: true,
      configured: true, // No API key needed — runs locally
      provider: "local",
      supportsStt: true,
      supportsTts: false, // TTS not supported locally
      supportsStreamingTts: false,
      baseUrl: "localhost",
      sttModel: process.env.LOCAL_STT_MODEL?.trim() || "large-v3",
      ttsModel: "", // Not supported
      ttsVoice: "", // Not supported
      ttsFormats: [], // Not supported
      streamingTtsFormats: [], // Not supported
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

  async synthesize(_input: SynthesizeSpeechInput): Promise<never> {
    throw new Error(
      "Local STT does not support speech synthesis. " +
      "Use OpenAI or Deepgram for TTS."
    )
  }

  async synthesizeStream(_input: SynthesizeSpeechInput): Promise<never> {
    throw new Error(
      "Local STT does not support speech synthesis. " +
      "Use OpenAI or Deepgram for TTS."
    )
  }
}
