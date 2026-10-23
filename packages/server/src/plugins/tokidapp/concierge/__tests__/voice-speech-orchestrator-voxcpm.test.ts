/**
 * Local voice engine ↔ VoxCPM2 wiring — drives the real createLocalSession.
 *
 * Only the neighbours are mocked (STT, audio buffer, session-end, other engines) plus `fetch` for the sidecar and
 * `../local-tts` for Piper, so what is under test is the orchestrator's backend selection and fallback.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"

const piper = { created: [] as Array<{ options: any; speak: Array<[string, any]>; flush: number }> }

mock.module("../openai-realtime", () => ({ createRealtimeSession: mock(() => ({})), endVoiceSession: mock(() => {}) }))
mock.module("../deepgram-realtime", () => ({ createDeepgramSession: mock(() => ({})), endDeepgramSession: mock(() => {}) }))
mock.module("../local-stt", () => ({
  createLocalSTTConnection: mock(() => ({ sendAudio: mock(() => {}), close: mock(() => {}), flush: mock(() => {}), isReady: true })),
}))
mock.module("../local-tts", () => ({
  createLocalTTSConnection: mock((options: any) => {
    const rec = { options, speak: [] as Array<[string, any]>, flush: 0 }
    piper.created.push(rec)
    return {
      ready: true,
      voiceModel: "piper",
      speak: (t: string, o: any) => rec.speak.push([t, o]),
      flush: () => { rec.flush++ },
      close: () => {},
    }
  }),
  splitSentences: (t: string) => [t],
}))
mock.module("../audio-buffer", () => ({
  AudioBuffer: class {
    isEmpty = true
    addChunk() {}
    commit() {}
    reset() {}
  },
  PreSessionAudioManager: class {
    add() {}
    drain() { return [] }
    clear() {}
  },
}))
mock.module("../speech-sanitize", () => ({
  sanitizeAsrText: mock((t: string) => t),
  sanitizeSpeechText: mock((t: string) => t),
  stripThinkingContent: mock((t: string) => t),
  isFillerTranscript: mock(() => false),
  VOICE_INSTRUCTIONS: "You are Star World Assistant.",
}))
mock.module("../voice-session-end", () => ({ onVoiceSessionEnd: mock(() => {}) }))

import { createVoiceSession } from "../voice-speech-orchestrator"

const realFetch = globalThis.fetch
let requests: Array<{ url: string; body: any; headers: Record<string, string> }> = []
let sidecar: () => Response

function toneResponse(): Response {
  const bytes = new Uint8Array(4800 * 2) // 100 ms of 48 kHz silence
  return new Response(bytes, { status: 200, headers: { "x-sample-rate": "48000" } })
}

beforeEach(() => {
  piper.created.length = 0
  requests = []
  sidecar = toneResponse
  process.env.VOXCPM_SIDECAR_URL = "http://sidecar.test"
  process.env.VOXCPM_SIDECAR_API_KEY = "secret"
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> })
    return sidecar()
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.VOXCPM_SIDECAR_URL
  delete process.env.VOXCPM_SIDECAR_API_KEY
})

const GREETING_MS = 450 // the orchestrator greets 250 ms after creation
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function start(id: string, voice: string, locale: "en" | "id" = "en") {
  const audio: string[] = []
  const session = await createVoiceSession({ engine: "local", sessionId: id, chatSessionId: id, voice, localTtsVoice: voice, locale } as any)
  session.onAudio = (chunk: string) => audio.push(chunk)
  return { session, audio }
}

describe("local engine TTS backend selection", () => {
  test("a voxcpm-* voice speaks through the sidecar and never spawns Piper", async () => {
    const { session, audio } = await start("vox_sel_1", "voxcpm-marin")
    await wait(GREETING_MS)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe("http://sidecar.test/v1/audio/speech")
    expect(requests[0].headers.authorization).toBe("Bearer secret")
    expect(requests[0].body).toMatchObject({ voice: "marin", stream: true, response_format: "pcm" })
    expect(requests[0].body.input).toContain("local voice assistant")
    expect(piper.created).toHaveLength(0)
    expect(audio.length).toBeGreaterThan(0)
    session.destroy()
  })

  test("Indonesian replies swap the stock concierge voice for concierge-id", async () => {
    const { session } = await start("vox_sel_2", "voxcpm-concierge", "id")
    await wait(GREETING_MS)
    expect(requests[0].body.voice).toBe("concierge-id")
    expect(requests[0].body.input).toContain("Halo")
    session.destroy()
  })

  test("a library voice keeps its own voice in either language", async () => {
    const { session } = await start("vox_sel_3", "voxcpm-host-bali", "id")
    await wait(GREETING_MS)
    expect(requests[0].body.voice).toBe("host-bali")
    session.destroy()
  })

  test("sidecar down → the sentence is spoken by Piper in the locale's voice, Piper spawned lazily", async () => {
    sidecar = () => new Response('{"detail":"model is still loading"}', { status: 503 })
    const { session } = await start("vox_sel_4", "voxcpm-marin", "id")
    expect(piper.created).toHaveLength(0)
    await wait(GREETING_MS)
    expect(piper.created).toHaveLength(1)
    const [text, overrides] = piper.created[0].speak[0]
    expect(text).toContain("Halo")
    expect(overrides.voice).toBe("id_ID-news_tts-medium")
    expect(piper.created[0].flush).toBeGreaterThan(0)
    session.destroy()
  })

  test("a Piper voice is untouched: Piper spawns at creation with its own voice and the sidecar is never called", async () => {
    const { session } = await start("vox_sel_5", "piper-en-male-ryan")
    expect(piper.created).toHaveLength(1)
    expect(piper.created[0].options.voice).toBe("en_US-ryan-high")
    await wait(GREETING_MS)
    expect(requests).toHaveLength(0)
    expect(piper.created[0].speak[0][1].voice).toBe("en_US-ryan-high")
    session.destroy()
  })
})
