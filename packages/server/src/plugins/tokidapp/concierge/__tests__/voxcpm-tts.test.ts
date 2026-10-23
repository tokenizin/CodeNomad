import { describe, test, expect } from "bun:test"
import {
  chunkForSidecar,
  createVoxCpmTTSConnection,
  defaultLocalTtsVoice,
  isVoxCpmVoice,
  pickVoxCpmVoiceForLocale,
  toSidecarVoiceId,
} from "../voxcpm-tts"
import { pcm16BytesToInt16 } from "../pcm-resample"

/** A 48 kHz 1 kHz tone as the sidecar would stream it, split at awkward byte boundaries. */
function toneBytes(seconds: number): Uint8Array {
  const n = Math.floor(48000 * seconds)
  const buf = new Uint8Array(n * 2)
  const dv = new DataView(buf.buffer)
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(10000 * Math.sin((2 * Math.PI * 1000 * i) / 48000)), true)
  return buf
}

function streamResponse(bytes: Uint8Array, splits: number[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let at = 0
      for (const s of [...splits, bytes.length]) {
        controller.enqueue(bytes.slice(at, Math.min(s, bytes.length)))
        at = Math.min(s, bytes.length)
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "x-sample-rate": "48000", ...headers } })
}

function harness(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  const audio: string[] = []
  const events: string[] = []
  const failures: unknown[] = []
  const conn = createVoxCpmTTSConnection(
    { voice: "concierge", baseUrl: "http://sidecar.test", apiKey: "k", fetchImpl },
    {
      onAudio: (b) => { audio.push(b); events.push("audio") },
      onFlushed: () => events.push("flushed"),
      onError: (e) => events.push(`error:${e.message}`),
      onUtteranceFailed: extra.noFailureHook ? undefined : (f) => { failures.push(f); events.push("failed") },
    },
  )
  return { conn, audio, events, failures }
}

const settle = () => new Promise((r) => setTimeout(r, 30))

describe("voice id helpers", () => {
  test("recognises prefixed ids and strips the prefix", () => {
    expect(isVoxCpmVoice("voxcpm-marin")).toBe(true)
    expect(toSidecarVoiceId("voxcpm-host-bali")).toBe("host-bali")
    for (const bad of ["marin", "piper-en-female-lessac", "voxcpm-", "voxcpm-A", "voxcpm-../x", undefined, null, ""]) {
      expect(isVoxCpmVoice(bad as string)).toBe(false)
      expect(toSidecarVoiceId(bad as string)).toBeUndefined()
    }
  })

  test("default voice: explicit env wins, backend flag selects VoxCPM2, otherwise Piper", () => {
    expect(defaultLocalTtsVoice({ LOCAL_TTS_VOICE: "piper-en-male-ryan", LOCAL_TTS_BACKEND: "voxcpm" } as NodeJS.ProcessEnv)).toBe("piper-en-male-ryan")
    expect(defaultLocalTtsVoice({ LOCAL_TTS_BACKEND: "VoxCPM" } as NodeJS.ProcessEnv)).toBe("voxcpm-concierge")
    expect(defaultLocalTtsVoice({} as NodeJS.ProcessEnv)).toBe("piper-en-female-professional")
  })

  test("locale swaps only the stock concierge pair", () => {
    expect(pickVoxCpmVoiceForLocale("concierge", "id")).toBe("concierge-id")
    expect(pickVoxCpmVoiceForLocale("concierge-id", "en")).toBe("concierge")
    expect(pickVoxCpmVoiceForLocale("marin", "id")).toBe("marin")
  })
})

describe("chunkForSidecar", () => {
  test("short text is one piece; empty is none", () => {
    expect(chunkForSidecar("Hello there.")).toEqual(["Hello there."])
    expect(chunkForSidecar("   ")).toEqual([])
  })

  test("long text splits under the cap without losing words", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join(" ")
    const parts = chunkForSidecar(text, 500)
    expect(parts.length).toBeGreaterThan(5)
    expect(parts.every((p) => p.length <= 500)).toBe(true)
    expect(parts.join(" ")).toBe(text)
  })

  test("a single run-on sentence is still cut under the cap", () => {
    const parts = chunkForSidecar(Array(2000).fill("word").join(" "), 500)
    expect(parts.every((p) => p.length <= 500)).toBe(true)
    expect(parts.join(" ").split(" ").length).toBe(2000)
  })
})

describe("createVoxCpmTTSConnection", () => {
  test("posts a streaming PCM request with auth and the chosen voice", async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const { conn } = harness((async (url: string, init: RequestInit) => {
      seen = { url, init }
      return streamResponse(toneBytes(0.1), [])
    }) as unknown as typeof fetch)
    conn.speak("Hello", { voice: "marin", style: "calm" })
    await settle()
    expect(seen!.url).toBe("http://sidecar.test/v1/audio/speech")
    const headers = seen!.init.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer k")
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      input: "Hello", voice: "marin", stream: true, response_format: "pcm", style: "calm",
    })
  })

  test("emits 24 kHz PCM16 (half the 48 kHz sample count) even when network chunks split samples", async () => {
    const bytes = toneBytes(0.5)
    const { conn, audio } = harness((async () => streamResponse(bytes, [1, 4801, 4802, 9999])) as unknown as typeof fetch)
    conn.speak("tone")
    await settle()
    const samples = audio.flatMap((b) => Array.from(pcm16BytesToInt16(Buffer.from(b, "base64"))))
    expect(Math.abs(samples.length - 12000)).toBeLessThanOrEqual(2)
    const peak = Math.max(...samples.slice(100, -100))
    expect(peak).toBeGreaterThan(9000)
    expect(peak).toBeLessThan(11000)
  })

  test("utterances play in order, one request at a time, and flush fires once after the last", async () => {
    const order: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const { conn, events } = harness((async (_u: string, init: RequestInit) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      order.push(JSON.parse(init.body as string).input)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return streamResponse(toneBytes(0.05), [])
    }) as unknown as typeof fetch)
    conn.speak("one")
    conn.speak("two")
    conn.speak("three")
    conn.flush()
    await new Promise((r) => setTimeout(r, 150))
    expect(order).toEqual(["one", "two", "three"])
    expect(maxInFlight).toBe(1)
    expect(events.filter((e) => e === "flushed")).toHaveLength(1)
    expect(events.at(-1)).toBe("flushed")
  })

  test("flush with nothing queued still reports flushed (asynchronously)", async () => {
    const { conn, events } = harness((async () => streamResponse(toneBytes(0.01), [])) as unknown as typeof fetch)
    conn.flush()
    expect(events).toEqual([])
    await settle()
    expect(events).toEqual(["flushed"])
  })

  test("a sidecar error is reported per utterance with its context and the queue keeps going", async () => {
    let calls = 0
    const { conn, events, failures } = harness((async () => {
      calls++
      return calls === 1
        ? new Response('{"detail":"model is still loading"}', { status: 503 })
        : streamResponse(toneBytes(0.05), [])
    }) as unknown as typeof fetch)
    conn.speakWithContext("first", {}, { tag: "ctx1" })
    conn.speakWithContext("second", {}, { tag: "ctx2" })
    conn.flush()
    await settle()
    expect(failures).toHaveLength(1)
    expect((failures[0] as any).text).toBe("first")
    expect((failures[0] as any).context).toEqual({ tag: "ctx1" })
    expect((failures[0] as any).audioEmitted).toBe(false)
    expect((failures[0] as any).error.message).toContain("503")
    // Failure first, then the second sentence's audio (one or more chunks), then a single flush.
    expect(events[0]).toBe("failed")
    expect(events.at(-1)).toBe("flushed")
    expect(events.slice(1, -1).length).toBeGreaterThan(0)
    expect(events.slice(1, -1).every((e) => e === "audio")).toBe(true)
  })

  test("a stream that dies mid-way is flagged audioEmitted so it is not replayed", async () => {
    const { conn, failures } = harness((async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(toneBytes(0.2)) },
        pull() { throw new Error("socket hang up") },
      })
      return new Response(body, { status: 200, headers: { "x-sample-rate": "48000" } })
    }) as unknown as typeof fetch)
    conn.speak("partial")
    await settle()
    expect(failures).toHaveLength(1)
    expect((failures[0] as any).audioEmitted).toBe(true)
  })

  test("without an onUtteranceFailed hook, failures surface as onError", async () => {
    const { conn, events } = harness((async () => { throw new TypeError("fetch failed") }) as unknown as typeof fetch, { noFailureHook: true })
    conn.speak("x")
    await settle()
    expect(events).toEqual(["error:fetch failed"])
  })

  test("close() aborts the in-flight request and drops the queue without reporting a failure", async () => {
    let aborted = false
    const { conn, events } = harness(((_u: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal!.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")) })
      })) as unknown as typeof fetch)
    conn.speak("long one")
    conn.speak("queued")
    await new Promise((r) => setTimeout(r, 5))
    conn.close()
    await settle()
    expect(aborted).toBe(true)
    expect(events).toEqual([])
    conn.speak("after close")
    expect(events).toEqual(["error:Cannot speak — connection is closed"])
  })

  test("honours a non-48 kHz sample-rate header", async () => {
    const n = 16000
    const buf = new Uint8Array(n * 2)
    const { conn, audio } = harness((async () => streamResponse(buf, [], { "x-sample-rate": "16000" })) as unknown as typeof fetch)
    conn.speak("rate")
    await settle()
    const total = audio.reduce((s, b) => s + Buffer.from(b, "base64").length / 2, 0)
    expect(Math.abs(total - 24000)).toBeLessThanOrEqual(2)
  })
})
