/**
 * Service-layer speech adapter.
 *
 * Receives user requests (STT or TTS) and routes to the right provider
 * per the current provider chain from SettingsService.
 */

import { z } from 'zod';

// ── Provider chain (populated from SettingsService) ──────────────────────
export interface SpeechServiceState {
  sttProvider: string | null;
  ttsProvider: string | null;
}

// ── Provider request envelope ────────────────────────────────────────────
export type SpeechRequest =
  | { kind: 'transcribe'; payload: DeepgramTranscribeParams }
  | { kind: 'synthesize'; payload: DeepgramSynthesizeParams }
  | { kind: 'transcribe'; payload: WhisperTranscribeParams }
  | { kind: 'synthesize'; payload: LocalTtsParams }
  | { kind: 'unknown'; errorMessage: string };

// ── Transcription (Deepgram) ─────────────────────────────────────────────
export interface DeepgramTranscribeParams {
  file: string; // base64 or local path
  model: string;
  smartFormat?: boolean;
}

// ── Transcription (Whisper) ──────────────────────────────────────────────
export interface WhisperTranscribeParams {
  file: string;
  model: string;
  language?: string;
}

// ── Synthesis (Deepgram) ─────────────────────────────────────────────────
export interface DeepgramSynthesizeParams {
  text: string;
  voice: string;
  format: string; // mp3, wav, ogg
  responseFormat?: string;
}

// ── Synthesis (Local / VoxCPM) ──────────────────────────────────────────
export interface LocalTtsParams {
  text: string;
  language: string;
}

// ── Response envelope ────────────────────────────────────────────────────
export interface SpeechResponse {
  provider: string;
  text?: string;
  audio?: string; // base64
  error?: string;
}

// ── Service entry points (server-side) ───────────────────────────────────
export class SpeechService {
  async transcribe(file: string, model: string, smartFormat = false): Promise<SpeechResponse> {
    const envelope: SpeechRequest = { kind: 'transcribe', payload: { file, model, smartFormat } };
    // Route here — provider-specific stubs live under speech/providers/
    return this.dispatch(envelope, 'transcribe');
  }

  async synthesize(text: string, voice: string, format: string): Promise<SpeechResponse> {
    const envelope: SpeechRequest = { kind: 'synthesize', payload: { text, voice, format } };
    return this.dispatch(envelope, 'synthesize');
  }

  private async dispatch(
    envelope: SpeechRequest,
    kind: keyof SpeechRequest,
  ): Promise<SpeechResponse> {
    // Provider selection happens here — reads settings chain and delegates.
    if (kind === 'transcribe') {
      const provider = await this.settings.sttProvider ?? 'openai-whisper';
      return this.dispatchToProvider(envelope as any, 'openai-whisper' as Extract<typeof envelope, { kind: 'transcribe' }>['payload']), provider);
    }
    if (kind === 'synthesize') {
      const provider = await this.settings.ttsProvider ?? 'openai-tts';
      return this.dispatchToProvider(envelope as any, 'openai-tts' as Extract<typeof envelope, { kind: 'synthesize' }>['payload']), provider);
    }
    return { provider: 'unknown', error: envelope.errorMessage };
  }
}
