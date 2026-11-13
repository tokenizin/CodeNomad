import { afterEach, describe, expect, it } from "bun:test"
import {
  clearActiveVoiceEngine,
  getActiveVoiceEngine,
  getNextFallbackEngine,
  setActiveVoiceEngine,
} from "../src/plugins/tokidapp/concierge/voice-fallback"
import {
  buildRealtimeInputAudioConfig,
  resolveRealtimeNoiseReduction,
  resolveTranscriptionLanguage,
} from "../src/plugins/tokidapp/concierge/openai-realtime"

// Regression cover for "voice connects but never transcribes": after a
// fallback, mic audio was still routed to the engine named in voice_start.

const SESSION = "voice_test-user"

afterEach(() => {
  clearActiveVoiceEngine(SESSION)
  delete process.env.OPENAI_REALTIME_NOISE_REDUCTION
})

describe("active voice engine", () => {
  it("is openai before any voice_start", () => {
    expect(getActiveVoiceEngine(SESSION)).toBe("openai")
  })

  it("follows the engine a descent lands on", () => {
    setActiveVoiceEngine(SESSION, "openai")

    const next = getNextFallbackEngine("openai", { isAvailable: (e) => e === "local" })
    expect(next).toBe("local")
    setActiveVoiceEngine(SESSION, next!)

    expect(getActiveVoiceEngine(SESSION)).toBe("local")
  })

  it("is per session", () => {
    setActiveVoiceEngine(SESSION, "deepgram")
    expect(getActiveVoiceEngine("voice_someone-else")).toBe("openai")
  })

  it("resets when the socket closes", () => {
    setActiveVoiceEngine(SESSION, "local")
    clearActiveVoiceEngine(SESSION)
    expect(getActiveVoiceEngine(SESSION)).toBe("openai")
  })
})

describe("Realtime input audio config", () => {
  it("applies far-field noise reduction by default", () => {
    expect(buildRealtimeInputAudioConfig().noise_reduction).toEqual({ type: "far_field" })
  })

  it("honours the noise reduction override", () => {
    expect(resolveRealtimeNoiseReduction("near_field")).toEqual({ type: "near_field" })
    expect(resolveRealtimeNoiseReduction("off")).toBeNull()
    process.env.OPENAI_REALTIME_NOISE_REDUCTION = "off"
    expect(buildRealtimeInputAudioConfig()).not.toHaveProperty("noise_reduction")
  })

  it("pins the transcription language only when the client names one", () => {
    expect(buildRealtimeInputAudioConfig({ transcriptionLanguage: "id" }).transcription).toEqual({
      model: "gpt-4o-mini-transcribe",
      language: "id",
    })
    expect(buildRealtimeInputAudioConfig().transcription).toEqual({ model: "gpt-4o-mini-transcribe" })
  })

  it("maps client locales to a language, leaving auto to the model", () => {
    expect(resolveTranscriptionLanguage("id")).toBe("id")
    expect(resolveTranscriptionLanguage("en")).toBe("en")
    expect(resolveTranscriptionLanguage("auto")).toBeUndefined()
    expect(resolveTranscriptionLanguage(undefined)).toBeUndefined()
  })

  it("keeps server VAD turn detection", () => {
    expect(buildRealtimeInputAudioConfig().turn_detection.type).toBe("server_vad")
  })
})
