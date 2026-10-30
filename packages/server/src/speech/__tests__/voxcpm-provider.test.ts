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
