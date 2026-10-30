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
import { transcribeLocally } from "../local-batch-stt"
import { VoxCpmSynthesizer } from "./voxcpm-synth"

interface LocalSpeechProviderOptions {
  settings: NormalizedSpeechSettings
  logger: Logger
}

/**
 * Local STT SpeechProvider — batch transcription via faster-whisper.
 *
 * Transcription goes to a warm Python faster-whisper process (see local-batch-stt.ts); any audio format is
 * converted to the PCM it reads first. For real-time streaming use the concierge `createLocalSTTConnection`.
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
      { mimeType: input.mimeType, bytes: Math.floor(input.audioBase64.length * 0.75), language, model },
      "local.stt.transcribe",
    )
    const result = await transcribeLocally({
      audioBase64: input.audioBase64,
      mimeType: input.mimeType,
      language: language === "auto" ? undefined : language,
      model,
    })
    return { text: result.text, language: result.language ?? language, durationMs: Date.now() - startedAt }
  }

  synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    return this.tts.synthesize(input)
  }

  synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    return this.tts.synthesizeStream(input)
  }
}
