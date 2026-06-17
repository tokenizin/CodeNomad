import { z } from "zod"
import type { Readable } from "node:stream"
import type { Logger } from "../logger"
import type { SpeechCapabilitiesResponse, SpeechTranscriptionResponse, SpeechSynthesisResponse, SpeechSynthesisStreamResponse, TranscribeAudioInput, SynthesizeSpeechInput, SpeechProvider, NormalizedSpeechSettings } from "./service";

const OLLAMA_BASE_URL = "http://localhost:11434/api";
const defaultModelId = "gemma4:latest"; // The specific model we are integrating

/**
 * Implementation of the SpeechProvider interface using the Ollama API endpoint.
 * This adapter centralizes all communication with a locally running Ollama instance.
 */
export class OllamaSpeechProvider implements SpeechProvider {
  public readonly settings: NormalizedSpeechSettings;
  private logger: Logger;

  constructor(settings: NormalizedSpeechSettings, private loggerInstance: Logger) {
    this.settings = settings;
    this.logger = this.loggerInstance.child({ provider: "ollama" });
  }

  /**
   * Fetches the capabilities supported by the configured Ollama model.
   */
  getCapabilities(): Promise<SpeechCapabilitiesResponse> {
    // Note: Since Ollama provides general chat/generate endpoints, we simulate
    // detailed capability fetching for standard response structure adherence.
    this.logger.info(
      "Fetching simulated capabilities from Ollama.", {}
    );

    return Promise.resolve({
      sttModel: this.settings.sttModel || defaultModelId,
      ttsModel: this.settings.ttsModel || defaultModelId,
      ttsVoice: this.settings.ttsVoice || "gemma", // Adjust to a base voice if needed
      // We can't validate all features without full API schema knowledge, use defaults/placeholders.
    })
  }

  /**
   * Transcribes audio using the configured Ollama model for STT.
   * @param input Transcription data including audio.
   */
  async transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse> {
    this.logger.info("Attempting to transcribe audio via Ollama.");

    // Implement actual fetch call to /api/embeddings or /api/generate with context for STT
    const response = await this.callOllamaAPI(
      { endpoint: "transcribe", payload: input }
    );

    return { transcriptText: response.text, error?: string };
  }

  /**
   * Synthesizes speech using the configured Ollama model for TTS.
   */
  async synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    this.logger.info("Attempting to synthesize speech via Ollama.");
    // In a real implementation, this would hit a text-to-speech endpoint or use OpenAI-compatible formatting.
    // For simulation: Assume the API returns base64 encoded audio directly on success.
    const response = await this.callOllamaAPI(
      { endpoint: "synthesize", payload: input }
    );

    return { audioBase64: response.base64, mimeType: "audio/mp3" }; // Simulation return structure
  }

  /**
   * Streams speech synthesis output using Ollama's streaming capabilities (if exposed).
   */
  async synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    this.logger.warn("Streaming synthesize functionality for Ollama is complex and mocked.");
    // Real implementation would proxy the stream from the Ollama API endpoint or using node-fetch streaming capabilities.

    // Mock a readable stream for type conformance
    const mockStream = new Readable({
      read() {
        this.push(Buffer.from("mock audio chunk\n"));
        setTimeout(() => this.push(null), 10); // Signal end of stream
      }
    });

    return { stream: mockStream, mimeType: "audio/mp3" };
  }

  /**
   * Generic handler for making calls to the local Ollama API structure.
   * This method must be updated if the public Ollama API changes.
   */
  private async callOllamaAPI({ endpoint, payload }: { endpoint: string; payload: any }): Promise<any> {
    this.logger.debug("Calling generic Ollama API endpoint", { endpoint });

    try {
      // Base URL /api/generate is the most common pattern for generation tasks
      const url = `${OLLAMA_BASE_URL}/generate`; 
      
      const body: Record<string, any> = {
        model: this.settings.ttsModel || defaultModelId, // Use TTS model as a fallback context guide for API call
        prompt: JSON.stringify(payload), 
        stream: false,
      };
      
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
         throw new Error(`Ollama API call failed (${endpoint}): ${response.statusText}`);
      }

      return await response.json();

    } catch (e) {
      this.logger.error("Failed to communicate with Ollama.", e);
      throw new Error("Could not connect to local LLM inference service (Ollama). Ensure it is running.");
    }
  }
}