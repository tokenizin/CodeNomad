/**
 * "VoxCPM2 (Local TTS)" speech provider.
 *
 *   TTS: the VoxCPM2 sidecar on the Mac Studio (default http://127.0.0.1:9972) with the
 *        voice, style, quality, speed, instructions and seed from the Speech settings.
 *   STT: VoxCPM2 is TTS-only, so transcription goes to the source picked in settings —
 *        faster-whisper on this host (default), whisper.cpp, or Deepgram.
 *
 * The sidecar key comes from settings, else VOXCPM_SIDECAR_API_KEY, else the sidecar's own
 * scripts/voxcpm-server/engine-data/.api-key (see voxcpm-client.ts).
 *
 * @module voxcpm-speech-provider
 */

import type { SpeechCapabilitiesResponse, SpeechSynthesisResponse, SpeechTranscriptionResponse } from "../../api-types"
import type { Logger } from "../../logger"
import { resolveVoxCpmConfig } from "../../plugins/tokidapp/concierge/voxcpm-client"
import type {
  NormalizedSpeechSettings,
  SpeechProvider,
  SpeechSynthesisStreamResponse,
  SynthesizeSpeechInput,
  TranscribeAudioInput,
} from "../service"
import { DeepgramSpeechProvider } from "./deepgram"
import { LocalSpeechProvider } from "./local"
import { VoxCpmSynthesizer } from "./voxcpm-synth"
import { WhisperSpeechProvider } from "./whisper"

export type VoxCpmSttSource = "local" | "whisper" | "deepgram"

export interface NormalizedVoxCpmSettings {
  baseUrl?: string
  apiKey?: string
  style?: string
  quality?: string
  speed?: number
  instructions?: string
  seed?: number
  sttSource: VoxCpmSttSource
  /** Deepgram key when sttSource is "deepgram" (else DEEPGRAM_API_KEY, else the main speech key). */
  sttApiKey?: string
  sttModel?: string
}

const DEEPGRAM_BASE_URL = "https://api.deepgram.com/v1"

interface Options {
  settings: NormalizedSpeechSettings
  logger: Logger
}

export class VoxCpmSpeechProvider implements SpeechProvider {
  private readonly tts: VoxCpmSynthesizer
  private readonly vox: NormalizedVoxCpmSettings

  constructor(private readonly options: Options) {
    this.vox = options.settings.voxcpm ?? { sttSource: "local" }
    const config = resolveVoxCpmConfig({
      ...(this.vox.baseUrl ? { baseUrl: this.vox.baseUrl.replace(/\/$/, "") } : {}),
      ...(this.vox.apiKey ? { apiKey: this.vox.apiKey } : {}),
    })
    this.tts = new VoxCpmSynthesizer({
      voice: options.settings.ttsVoice,
      defaultFormat: options.settings.ttsFormat,
      logger: options.logger,
      config,
      delivery: {
        style: this.vox.style,
        quality: this.vox.quality,
        speed: this.vox.speed,
        instructions: this.vox.instructions,
        seed: this.vox.seed,
      },
    })
  }

  /** The provider that transcribes for this one. */
  private stt(): SpeechProvider {
    const { settings, logger } = this.options
    switch (this.vox.sttSource) {
      case "deepgram":
        return new DeepgramSpeechProvider({
          settings: {
            ...settings,
            provider: "deepgram",
            apiKey: this.vox.sttApiKey || process.env.DEEPGRAM_API_KEY || settings.apiKey,
            baseUrl: DEEPGRAM_BASE_URL,
            sttModel: this.vox.sttModel || "nova-3",
          },
          logger,
        })
      case "whisper":
        return new WhisperSpeechProvider({ settings: { ...settings, provider: "whisper" }, logger })
      default:
        return new LocalSpeechProvider({ settings: { ...settings, provider: "local" }, logger })
    }
  }

  getCapabilities(): SpeechCapabilitiesResponse {
    const stt = this.stt().getCapabilities()
    return {
      ...stt,
      ...this.tts.capabilities(),
      provider: "voxcpm",
      available: true,
      // The sidecar is local; a missing key shows up as a clear error on first use.
      configured: true,
      supportsStt: stt.supportsStt,
      sttModel: stt.sttModel,
    }
  }

  transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse> {
    return this.stt().transcribe(input)
  }

  synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    return this.tts.synthesize(input)
  }

  synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    // mp3/aac are transcoded by ffmpeg on this host; without it this fails with a clear
    // message (streamed WAV isn't an option: the browser player uses MediaSource).
    return this.tts.synthesizeStream(input)
  }
}
