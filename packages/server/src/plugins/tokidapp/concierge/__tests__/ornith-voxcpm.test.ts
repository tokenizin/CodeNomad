/**
 * Ornith engine ↔ VoxCPM2: drives the real createOrnithSession. The Piper / local-STT
 * factories are injected (the real ones spawn processes) and `fetch` plays both Ollama
 * (/api/chat token stream) and the sidecar (/v1/audio/speech).
 *
 * The factories are injected rather than replaced with bun's `mock.module`: that mock is
 * process-wide, so it would leak into the other test files that exercise the real
 * `local-tts` / `local-stt` modules. Everything else (accounting, usage metering,
 * sanitising) runs for real and is fire-and-forget. Sessions are not torn down:
 * onVoiceSessionEnd would write wiki files.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"

import { createOrnithSession, handleOrnithMessage } from "../ornith-realtime"

const piper = { created: [] as Array<{ speak: Array<[string, any]> }> }

/** Fake Piper connection factory (the real one spawns a python process). */
const createPiper = mock(() => {
  const rec = { speak: [] as Array<[string, any]> }
  piper.created.push(rec)
  return { ready: true, voiceModel: "piper", speak: (t: string, o: any) => rec.speak.push([t, o]), flush() {}, close() {} }
})

/** Fake local STT connection (the real one spawns faster-whisper). */
const createStt = mock(() => ({ sendAudio() {}, flush() {}, close() {}, isReady: true }))

const localEngines = {
  createPiper: createPiper as any,
  createStt: createStt as any,
}

const realFetch = globalThis.fetch
let sidecarInputs: Array<{ input: string; voice: string; stream: boolean }> = []
let sidecarStatus = 200
let ids = 0

const ndjson = (deltas: string[]) =>
  new Response(
    [...deltas.map((content) => JSON.stringify({ message: { content }, done: false })), JSON.stringify({ message: { content: "" }, done: true })].join("\n") + "\n",
    { status: 200 },
  )

function mockNetwork(deltas: string[]) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/api/chat")) return ndjson(deltas)
    if (String(url) === "http://sidecar.test/v1/audio/speech") {
      sidecarInputs.push(JSON.parse(init.body as string))
      return sidecarStatus === 200
        ? new Response(new Uint8Array(960), { status: 200, headers: { "x-sample-rate": "48000" } })
        : new Response('{"detail":"model is still loading"}', { status: sidecarStatus })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as unknown as typeof fetch
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function converse(voiceId: string, locale: "en" | "id" = "en") {
  const sent: any[] = []
  const ws: any = { send: (m: string) => sent.push(JSON.parse(m)), readyState: 1, close() {} }
  const sessionId = `ornith_vox_${++ids}`
  const session = createOrnithSession(ws, sessionId, { voiceId, locale, sendToClient: () => {}, localEngines })
  await handleOrnithMessage(
    session,
    JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "What is the plan" }] } }),
  )
  await wait(100) // the router's sidecar requests are asynchronous
  return { session, sessionId, sent }
}

beforeEach(() => {
  piper.created.length = 0
  sidecarInputs = []
  sidecarStatus = 200
  process.env.VOXCPM_SIDECAR_URL = "http://sidecar.test"
  process.env.VOXCPM_SIDECAR_API_KEY = "k"
  delete process.env.LOCAL_TTS_BACKEND
  delete process.env.LOCAL_TTS_VOICE
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.VOXCPM_SIDECAR_URL
  delete process.env.VOXCPM_SIDECAR_API_KEY
})

const DELTAS = ["Hello", " there", ".", " How", " are", " you", " today", "?", " I", " am", " fine"]

describe("ornith engine TTS backend", () => {
  test("a voxcpm-* voice speaks sentences (not tokens) through the sidecar and never spawns Piper", async () => {
    mockNetwork(DELTAS)
    const { sessionId } = await converse("voxcpm-marin")
    expect(sidecarInputs.map((r) => r.input)).toEqual(["Hello there. How are you today?", "I am fine"])
    expect(sidecarInputs.every((r) => r.voice === "marin" && r.stream)).toBe(true)
    expect(piper.created).toHaveLength(0)
  })

  test("audio reaches the client as response.audio.delta chunks", async () => {
    mockNetwork(DELTAS)
    const { sessionId, sent } = await converse("voxcpm-marin")
    const audio = sent.filter((m) => m.type === "response.audio.delta")
    expect(audio.length).toBeGreaterThan(0)
    expect(typeof audio[0].delta).toBe("string")
  })

  test("a Piper voice is unchanged: spawned at creation, every delta spoken, sidecar never called", async () => {
    mockNetwork(DELTAS)
    const { sessionId } = await converse("piper-en-male-ryan")
    expect(sidecarInputs).toHaveLength(0)
    expect(piper.created).toHaveLength(1)
    // Existing behaviour: every delta is spoken as it arrives (whether the sanitizer trims it depends on the active mock).
    expect(piper.created[0].speak.map(([t]) => t.trim())).toEqual(DELTAS.map((d) => d.trim()))
    expect(piper.created[0].speak[0][1].voice).toBe("en_US-ryan-high")
  })

  test("LOCAL_TTS_BACKEND=voxcpm moves an Ornith-labelled voice to VoxCPM2 but leaves explicit Piper voices alone", async () => {
    process.env.LOCAL_TTS_BACKEND = "voxcpm"
    mockNetwork(DELTAS)
    const a = await converse("ornith-default")
    expect(sidecarInputs.length).toBeGreaterThan(0)
    expect(sidecarInputs[0].voice).toBe("concierge")

    sidecarInputs = []
    piper.created.length = 0
    const b = await converse("piper-en-male-ryan")
    expect(sidecarInputs).toHaveLength(0)
    expect(piper.created).toHaveLength(1)
  })

  test("sidecar not ready → the sentences are spoken by Piper in the fallback voice", async () => {
    sidecarStatus = 503
    mockNetwork(DELTAS)
    const { sessionId } = await converse("voxcpm-marin")
    expect(piper.created).toHaveLength(1)
    const spoken = piper.created[0].speak.map(([t]) => t).join(" ")
    expect(spoken).toContain("Hello there. How are you today?")
    expect(spoken).toContain("I am fine")
    expect(piper.created[0].speak[0][1].voice).toBe("en_US-lessac-high")
  })

  test("Indonesian (whole-reply) mode speaks the full reply once, with the Indonesian concierge swap", async () => {
    mockNetwork(["Halo", " dunia", ".", " Apa", " kabar", "?"])
    const { sessionId } = await converse("voxcpm-concierge", "id")
    expect(sidecarInputs).toHaveLength(1)
    expect(sidecarInputs[0].input).toBe("Halo dunia. Apa kabar?")
    expect(sidecarInputs[0].voice).toBe("concierge-id")
  })
})
