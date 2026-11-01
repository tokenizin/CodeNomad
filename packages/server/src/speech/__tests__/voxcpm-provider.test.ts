import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { SpeechService } from "../service"
import { discoverVoxCpmApiKey } from "../../plugins/tokidapp/concierge/voxcpm-client"
import { sanitizeConfigOwner } from "../../settings/public-config"

const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger } }
const serviceWith = (speech: Record<string, unknown> | undefined) =>
  new SpeechService({ getOwner: () => (speech ? { speech } : {}) } as any, logger)

describe("VoxCPM2 speech provider", () => {
  test("is the default when no provider is saved", () => {
    const caps = serviceWith(undefined).getCapabilities()
    expect(caps.provider).toBe("voxcpm")
    expect(caps.supportsTts).toBe(true)
    expect(caps.ttsModel).toBe("voxcpm2")
  })

  test("Deepgram/OpenAI voice names fall back to the sidecar default voice", () => {
    const caps = serviceWith({ provider: "voxcpm", ttsVoice: "aura-asteria-en" }).getCapabilities()
    expect(caps.ttsVoice).toBe("concierge")
    expect(serviceWith({ provider: "voxcpm", ttsVoice: "marin" }).getCapabilities().ttsVoice).toBe("marin")
  })

  test("sends voice and delivery settings to the sidecar", async () => {
    const calls: Array<{ url: string; body: any; auth?: string }> = []
    const fakeFetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as any
    const original = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      const service = serviceWith({
        provider: "voxcpm",
        ttsVoice: "marin",
        ttsFormat: "wav",
        voxcpm: { baseUrl: "http://studio:9972/", apiKey: "k1", style: "calm", quality: "high", speed: 1.2, instructions: "warm", seed: 7 },
      })
      const out = await service.synthesize({ text: "Hello there" })
      expect(out.mimeType).toBe("audio/wav")
      expect(calls[0].url).toBe("http://studio:9972/v1/audio/speech")
      expect(calls[0].auth).toBe("Bearer k1")
      expect(calls[0].body).toMatchObject({ input: "Hello there", voice: "marin", style: "calm", quality: "high", speed: 1.2, instructions: "warm", seed: 7, response_format: "wav", stream: false })
    } finally {
      globalThis.fetch = original
    }
  })

  test("fields stored as null mean 'not set' (no 500)", () => {
    const caps = serviceWith({ provider: "voxcpm", voxcpm: { baseUrl: null, style: null, speed: null, seed: null, sttSource: null } }).getCapabilities()
    expect(caps.baseUrl).toBe("http://127.0.0.1:9972")
  })

  test("transcription goes to the chosen source", () => {
    expect(serviceWith({ provider: "voxcpm" }).getCapabilities().supportsStt).toBe(true)
    const deepgram = serviceWith({ provider: "voxcpm", voxcpm: { sttSource: "deepgram", sttApiKey: "dg" } }).getCapabilities()
    expect(deepgram.sttModel).toBe("nova-3")
  })

  test("status reports health and voices", async () => {
    const fakeFetch = (async (url: string) => {
      if (url.endsWith("/health")) return Response.json({ ready: true, status: "ok", device: "mps", formats: ["wav", "mp3"] })
      return Response.json({ voices: [{ id: "marin", name: "Marin", builtin: true }, { id: "lib1", name: "Mine", builtin: false }], styles: ["calm"], qualities: ["fast"] })
    }) as any
    const status = await serviceWith({ provider: "voxcpm", voxcpm: { apiKey: "k" } }).voxcpmStatus(fakeFetch)
    expect(status).toMatchObject({ reachable: true, ready: true, device: "mps", hasKey: true, styles: ["calm"] })
    expect(status.voices.map((v) => v.id)).toEqual(["marin", "lib1"])
    const down = await serviceWith({ provider: "voxcpm" }).voxcpmStatus((async () => { throw new Error("ECONNREFUSED") }) as any)
    expect(down.reachable).toBe(false)
    expect(down.error).toContain("unreachable")
  })
})

test("finds the sidecar's .api-key in the starworld repo", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starworld-"))
  const dir = path.join(root, "scripts", "voxcpm-server", "engine-data")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, ".api-key"), "secret-key\n")
  expect(discoverVoxCpmApiKey({ STARWORLD: root } as any, "/")).toBe("secret-key")
  expect(discoverVoxCpmApiKey({} as any, path.join(root, "CodeNomad", "packages", "server"))).toBe("secret-key")
})

test("VoxCPM2 secrets never reach the browser", () => {
  const out = sanitizeConfigOwner("server", { speech: { provider: "voxcpm", voxcpm: { apiKey: "a", sttApiKey: "", style: "calm" } } }) as any
  expect(out.speech.voxcpm).toEqual({ style: "calm", hasApiKey: true, hasSttApiKey: false })
})

test("mp3 without ffmpeg on the sidecar falls back to WAV instead of failing", async () => {
  const formats: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body)
    formats.push(body.response_format)
    if (body.response_format === "mp3") {
      return Response.json({ detail: "response_format must be one of ['wav', 'pcm', 'flac']" }, { status: 400 })
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
  }) as any
  try {
    const out = await serviceWith({ provider: "voxcpm", ttsFormat: "mp3" }).synthesize({ text: "Hello" })
    expect(formats).toEqual(["mp3", "wav"])
    expect(out.mimeType).toBe("audio/wav")
  } finally {
    globalThis.fetch = original
  }
})

test("a voice the sidecar doesn't have falls back to the default voice", async () => {
  const voices: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body)
    voices.push(body.voice)
    if (body.voice !== "concierge") return Response.json({ detail: `unknown voice '${body.voice}'` }, { status: 404 })
    return new Response(new Uint8Array([1]), { status: 200 })
  }) as any
  try {
    const out = await serviceWith({ provider: "voxcpm", ttsVoice: "alloy", ttsFormat: "wav" }).synthesize({ text: "Hi" })
    expect(voices).toEqual(["alloy", "concierge"])
    expect(out.mimeType).toBe("audio/wav")
  } finally {
    globalThis.fetch = original
  }
})

test("long text is split into chunks and joined into one WAV", async () => {
  const { splitForSpeech } = await import("../providers/voxcpm-synth")
  const sentence = "This is a sentence that is spoken by the assistant. "
  const text = sentence.repeat(120) // ~6200 chars
  const chunks = splitForSpeech(text.trim(), 1500)
  expect(chunks.length).toBeGreaterThan(3)
  expect(chunks.every((c) => c.length <= 1500)).toBe(true)
  expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.trim().replace(/\s+/g, " "))

  const bodies: any[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body))
    return new Response(new Uint8Array([0, 0, 1, 0]), { status: 200, headers: { "x-sample-rate": "24000" } })
  }) as any
  try {
    const out = await serviceWith({ provider: "voxcpm", ttsFormat: "mp3" }).synthesize({ text })
    expect(bodies.length).toBe(chunks.length)
    expect(bodies.every((b) => b.response_format === "pcm")).toBe(true)
    expect(out.mimeType).toBe("audio/wav")
    const wav = Buffer.from(out.audioBase64, "base64")
    expect(wav.subarray(0, 4).toString()).toBe("RIFF")
    expect(wav.readUInt32LE(24)).toBe(24000)
    expect(wav.readUInt32LE(40)).toBe(4 * chunks.length)
  } finally {
    globalThis.fetch = original
  }
})

test("long text streams every chunk in order", async () => {
  const inputs: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body)
    inputs.push(body.input)
    return new Response(new Uint8Array([inputs.length]), { status: 200, headers: { "x-sample-rate": "48000" } })
  }) as any
  try {
    const service = serviceWith({ provider: "voxcpm", ttsFormat: "wav" })
    const out = await service.synthesizeStream({ text: "Hello there. ".repeat(300), format: "wav" })
    const parts: Buffer[] = []
    for await (const piece of out.stream as any) parts.push(Buffer.from(piece))
    const all = Buffer.concat(parts)
    expect(all.subarray(0, 4).toString()).toBe("RIFF")
    expect([...all.subarray(44)]).toEqual(inputs.map((_, i) => i + 1))
    expect(inputs.length).toBeGreaterThan(1)
  } finally {
    globalThis.fetch = original
  }
})

test("text beyond the limit is refused clearly", async () => {
  await expect(serviceWith({ provider: "voxcpm" }).synthesize({ text: "a ".repeat(15_000) })).rejects.toThrow(/too long to speak/)
})

test("the sidecar's key is found the way its launcher picks it (.env.local first)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starworld-"))
  fs.mkdirSync(path.join(root, "scripts", "voxcpm-server", "engine-data"), { recursive: true })
  fs.writeFileSync(path.join(root, "scripts", "voxcpm-server", "engine-data", ".api-key"), "file-key\n")
  expect(discoverVoxCpmApiKey({ STARWORLD: root } as any, "/")).toBe("file-key")
  fs.writeFileSync(path.join(root, ".env.local"), 'OTHER=1\nVOXCPM_API_KEY="env-key"\n')
  expect(discoverVoxCpmApiKey({ STARWORLD: root } as any, "/")).toBe("env-key")
})

test("a wrong saved key falls back to the sidecar's own key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "starworld-"))
  fs.mkdirSync(path.join(root, "scripts", "voxcpm-server", "engine-data"), { recursive: true })
  fs.writeFileSync(path.join(root, "scripts", "voxcpm-server", "engine-data", ".api-key"), "right")
  const auths: string[] = []
  const original = globalThis.fetch
  const prev = process.env.STARWORLD
  process.env.STARWORLD = root
  globalThis.fetch = (async (_url: string, init: any) => {
    auths.push(init.headers.authorization)
    if (init.headers.authorization !== "Bearer right") return Response.json({ detail: "bad key" }, { status: 401 })
    return new Response(new Uint8Array([1]), { status: 200 })
  }) as any
  try {
    const service = serviceWith({ provider: "voxcpm", ttsFormat: "wav", voxcpm: { apiKey: "wrong" } })
    await service.synthesize({ text: "Hi" })
    expect(auths).toEqual(["Bearer wrong", "Bearer right"])

    const status = await service.voxcpmStatus((async (url: string, init: any) => {
      if (url.endsWith("/health")) return Response.json({ ready: true })
      if (init?.headers?.authorization !== "Bearer right") return new Response("", { status: 401 })
      return Response.json({ voices: [{ id: "concierge", name: "Concierge", builtin: true }] })
    }) as any)
    expect(status.voices.length).toBe(1)
    expect(status.error).toMatch(/saved Sidecar API key is wrong/)
  } finally {
    globalThis.fetch = original
    if (prev === undefined) delete process.env.STARWORLD
    else process.env.STARWORLD = prev
  }
})
