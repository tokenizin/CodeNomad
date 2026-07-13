/**
 * Whisper.cpp SpeechProvider — batch transcription via local whisper-server.
 *
 * Implements the `SpeechProvider` interface for the speech settings panel.
 * Uses the whisper.cpp server HTTP API for batch transcription (non-streaming).
 * TTS is not supported — use OpenAI or Deepgram for that.
 *
 * This provider is selected when the speech provider is set to "whisper"
 * in the speech settings. It requires no API keys — runs fully offline
 * on the Mac Studio Ultra with Core ML acceleration.
 *
 * @module whisper-speech-provider
 */

import type {
  SpeechCapabilitiesResponse,
  SpeechSynthesisResponse,
  SpeechTranscriptionResponse,
} from "../../api-types"
import type { Logger } from "../../logger"
import type {
  NormalizedSpeechSettings,
  SpeechProvider,
  SpeechSynthesisStreamResponse,
  SynthesizeSpeechInput,
  TranscribeAudioInput,
} from "../service"
import { batchTranscribe, checkHealth } from "../../plugins/tokidapp/concierge/whisper-stt"

interface WhisperSpeechProviderOptions {
  settings: NormalizedSpeechSettings
  logger: Logger
}

/**
 * Whisper.cpp SpeechProvider — batch transcription via local whisper-server.
 *
 * Transcription sends the complete audio buffer to the whisper-server HTTP
 * endpoint and returns the final transcript. This is suitable for the speech
 * settings "Test" button but not for real-time streaming (use the concierge
 * `createWhisperSTTConnection` for that).
 */
export class WhisperSpeechProvider implements SpeechProvider {
  constructor(private readonly options: WhisperSpeechProviderOptions) {}

  getCapabilities(): SpeechCapabilitiesResponse {
    const serverUrl = this.resolveServerUrl()
    return {
      available: true,
      configured: true, // No API key needed — runs locally
      provider: "whisper",
      supportsStt: true,
      supportsTts: false, // TTS not supported by whisper.cpp
      supportsStreamingTts: false,
      baseUrl: serverUrl,
      sttModel: process.env.LOCAL_STT_MODEL?.trim() || "large-v3",
      ttsModel: "", // Not supported
      ttsVoice: "", // Not supported
      ttsFormats: [], // Not supported
      streamingTtsFormats: [], // Not supported
    }
  }

  async transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse> {
    const startedAt = Date.now()
    const serverUrl = this.resolveServerUrl()
    const model = process.env.LOCAL_STT_MODEL?.trim() || "large-v3"
    const language = input.language || process.env.LOCAL_STT_LANGUAGE?.trim() || "en"

    this.options.logger.info(
      {
        mimeType: input.mimeType,
        bytes: Math.floor(input.audioBase64.length * 0.75),
        language,
        model,
        serverUrl,
      },
      "whisper.stt.transcribe",
    )

    const audioBuffer = Buffer.from(input.audioBase64, "base64")
    const result = await batchTranscribe(serverUrl, audioBuffer, model, language)

    return {
      text: result.text,
      language: result.language || language,
      durationMs: result.durationMs ?? Date.now() - startedAt,
    }
  }

  async synthesize(_input: SynthesizeSpeechInput): Promise<never> {
    throw new Error(
      "Whisper.cpp does not support speech synthesis. " +
      "Use OpenAI or Deepgram for TTS.",
    )
  }

  async synthesizeStream(_input: SynthesizeSpeechInput): Promise<never> {
    throw new Error(
      "Whisper.cpp does not support speech synthesis. " +
      "Use OpenAI or Deepgram for TTS.",
    )
  }

  private resolveServerUrl(): string {
    return (
      this.options.settings.baseUrl?.trim() ||
      process.env.WHISPER_SERVER_URL?.trim() ||
      "http://127.0.0.1:8090"
    )
  }
}
