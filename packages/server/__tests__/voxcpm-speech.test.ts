/**
 * /api/speech with provider "local": faster-whisper STT + VoxCPM2 TTS.
 *
 * - pcm-transcode runs the real ffmpeg (tests skip if it is not installed)
 * - VoxCpmSynthesizer runs against a mocked sidecar
 * - the last block goes through the real Fastify routes + SpeechService to prove provider selection and HTTP status mapping
 */

import { describe, test, expect, mock } from "bun:test"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Readable } from "node:stream"

mock.module("../src/plugins/tokidapp/concierge/local-stt", () => ({
  createLocalSTTConnection: mock(() => ({ sendAudio: () => {}, flush: () => {}, close: () => {} })),
}))

import Fastify from "fastify"
import { VoxCpmSynthesizer } from "../src/speech/providers/voxcpm-synth"
import { transcodePcmStream, ffmpegAvailable } from "../src/speech/pcm-transcode"
import { resolveSpeechVoice, resolveOrnithVoxVoice } from "../src/plugins/tokidapp/concierge/voxcpm-tts"
import { SpeechService } from "../src/speech/service"
import { registerSpeechRoutes } from "../src/server/routes/speech"

const HAS_FFMPEG = ffmpegAvailable()
const ffmpegTest = HAS_FFMPEG ? test : test.skip

const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger } }

/** 1 s of a 440 Hz tone, 16-bit mono PCM at 48 kHz, in awkward chunk sizes. */
function pcmSource(seconds = 1, rate = 48000): Readable {
  const n = Math.floor(rate * seconds)
  const buf = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2)
  const chunks: Buffer[] = []
  for (let at = 0; at < buf.length; at += 7001) chunks.push(buf.subarray(at, Math.min(at + 7001, buf.length)))
  return Readable.from(chunks)
}

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of stream) parts.push(Buffer.from(c))
  return Buffer.concat(parts)
}

function probeSeconds(file: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file])
  return Number(r.stdout.toString().trim())
}

describe("pcm-transcode (real ffmpeg)", () => {
  ffmpegTest("PCM → mp3: valid, about the right duration, decodes", async () => {
    const out = await collect(transcodePcmStream(pcmSource(1), { sampleRate: 48000, format: "mp3" }))
    const dir = mkdtempSync(join(tmpdir(), "vox-"))
    try {
      writeFileSync(join(dir, "o.mp3"), out)
      expect(out.length).toBeGreaterThan(4000)
      expect(Math.abs(probeSeconds(join(dir, "o.mp3")) - 1)).toBeLessThan(0.15)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  ffmpegTest("PCM → aac (ADTS sync word) at 24 kHz input too", async () => {
    const out = await collect(transcodePcmStream(pcmSource(0.5, 24000), { sampleRate: 24000, format: "aac" }))
    expect(out[0]).toBe(0xff)
    expect(out[1] & 0xf0).toBe(0xf0)
    expect(out.length).toBeGreaterThan(1000)
  })

  ffmpegTest("closing the output early destroys the source (cancels the sidecar request) and stops ffmpeg", async () => {
    const source = new PassThrough()
    const out = transcodePcmStream(source, { sampleRate: 48000, format: "mp3" })
    source.write(Buffer.alloc(96000))
    await new Promise((r) => setTimeout(r, 100))
    out.destroy()
    await new Promise((r) => setTimeout(r, 200))
    expect(source.destroyed).toBe(true)
  })

  test("a source error surfaces on the output", async () => {
    const source = new PassThrough()
    const out = transcodePcmStream(source, { sampleRate: 48000, format: "mp3" })
    const failed = new Promise<Error>((resolve) => out.on("error", resolve))
    source.destroy(new Error("sidecar stream died"))
    expect((await failed).message).toBe("sidecar stream died")
  })

  test("a missing ffmpeg binary is reported clearly", async () => {
    // The real `spawn`, read from the CJS registry: bun's `mock.module("node:child_process", …)`
    // replaces the module process-wide, and this test needs the genuine "binary not found" error.
    const { spawn } = createRequire(import.meta.url)("node:child_process")
    const out = transcodePcmStream(pcmSource(0.1), {
      sampleRate: 48000,
      format: "mp3",
      spawnImpl: ((_cmd: string, args: string[], opts: any) => spawn("definitely-not-ffmpeg-xyz", args, opts)) as any,
    })
    const err = await new Promise<Error>((resolve) => out.on("error", resolve))
    expect(err.message).toContain("ffmpeg failed to start")
  })
})

describe("voice resolution", () => {
  test("speech voice: prefix stripped, bare sidecar ids kept, Piper/junk → default", () => {
    expect(resolveSpeechVoice("voxcpm-host-bali")).toBe("host-bali")
    expect(resolveSpeechVoice("marin")).toBe("marin")
    for (const v of ["piper-en-male-ryan", "en_US-lessac-high", "id_ID-news_tts-medium", "", "  ", undefined, "Bad Voice!", "a"]) {
      expect(resolveSpeechVoice(v as string)).toBe("concierge")
    }
  })

  test("ornith voice: explicit voxcpm wins, explicit Piper stays Piper, otherwise env decides", () => {
    const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv
    expect(resolveOrnithVoxVoice("voxcpm-marin", env({}))).toBe("marin")
    expect(resolveOrnithVoxVoice("voxcpm-marin", env({ LOCAL_TTS_BACKEND: "piper" }))).toBe("marin")
    expect(resolveOrnithVoxVoice("piper-en-male-ryan", env({ LOCAL_TTS_BACKEND: "voxcpm" }))).toBeUndefined()
    expect(resolveOrnithVoxVoice("en_US-ryan-high", env({ LOCAL_TTS_BACKEND: "voxcpm" }))).toBeUndefined()
    expect(resolveOrnithVoxVoice("ornith-default", env({}))).toBeUndefined()
    expect(resolveOrnithVoxVoice("ornith-default", env({ LOCAL_TTS_BACKEND: "voxcpm" }))).toBe("concierge")
    expect(resolveOrnithVoxVoice(undefined, env({ LOCAL_TTS_BACKEND: "VoxCPM" }))).toBe("concierge")
    expect(resolveOrnithVoxVoice("ornith-default", env({ LOCAL_TTS_VOICE: "voxcpm-sage" }))).toBe("sage")
  })
})

type Seen = { url: string; headers: Record<string, string>; body: any; signal: AbortSignal }

function synth(over: Partial<ConstructorParameters<typeof VoxCpmSynthesizer>[0]> & { respond?: (body: any) => Response } = {}) {
  const seen: Seen[] = []
  const s = new VoxCpmSynthesizer({
    voice: "voxcpm-concierge",
    defaultFormat: "mp3",
    logger,
    config: { baseUrl: "http://sidecar.test", apiKey: "k" },
    fetchImpl: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      seen.push({ url, headers: init.headers as any, body, signal: init.signal! })
      return (over.respond ?? (() => new Response(Buffer.from("AUDIOBYTES"), { status: 200, headers: { "x-sample-rate": "48000" } })))(body)
    }) as unknown as typeof fetch,
    ...over,
  })
  return { s, seen }
}

describe("VoxCpmSynthesizer", () => {
  test("capabilities advertise TTS + streaming with honest streamable formats", () => {
    const c = synth().s.capabilities()
    expect(c).toMatchObject({ supportsTts: true, supportsStreamingTts: true, ttsModel: "voxcpm2", ttsVoice: "concierge", baseUrl: "http://sidecar.test" })
    expect(c.streamingTtsFormats).toEqual(["wav", "mp3", "aac"])
    expect(c.ttsFormats).toContain("opus")
  })

  test("batch: asks the sidecar for the requested container and labels the result", async () => {
    const { s, seen } = synth()
    const wav = await s.synthesize({ text: "  Hello  ", format: "wav" })
    expect(seen[0].url).toBe("http://sidecar.test/v1/audio/speech")
    expect(seen[0].headers.authorization).toBe("Bearer k")
    expect(seen[0].body).toEqual({ input: "Hello", voice: "concierge", stream: false, response_format: "wav" })
    expect(wav).toEqual({ audioBase64: Buffer.from("AUDIOBYTES").toString("base64"), mimeType: "audio/wav" })

    expect((await s.synthesize({ text: "x" })).mimeType).toBe("audio/mpeg") // default format from settings
    expect((await s.synthesize({ text: "x", format: "opus" })).mimeType).toBe("audio/ogg")
    expect((await s.synthesize({ text: "x", format: "aac" })).mimeType).toBe("audio/aac")
  })

  test("input validation", async () => {
    const { s, seen } = synth()
    await expect(s.synthesize({ text: "   " })).rejects.toThrow("Text is required")
    // One request is refused: the whole reply is longer than the 20k ceiling.
    await expect(s.synthesize({ text: "a ".repeat(15_000) })).rejects.toThrow(/too long to speak/)
    expect(seen).toHaveLength(0)

    // Anything under the ceiling is chunked, not refused: one sidecar request per chunk.
    const chunked = synth()
    await chunked.s.synthesize({ text: "x".repeat(3501), format: "wav" })
    expect(chunked.seen.length).toBeGreaterThan(1)
    expect(chunked.seen.every((r) => r.body.input.length <= 1500)).toBe(true)
    expect(chunked.seen.every((r) => r.body.response_format === "pcm")).toBe(true)
  })

  test("sidecar errors map to messages the route turns into the right HTTP status", async () => {
    const loading = synth({ respond: () => new Response('{"detail":"model is still loading"}', { status: 503 }) }).s
    await expect(loading.synthesize({ text: "x" })).rejects.toThrow(/not configured or not ready: model is still loading/)
    const badKey = synth({ respond: () => new Response('{"detail":"invalid or missing API key"}', { status: 401 }) }).s
    await expect(badKey.synthesize({ text: "x" })).rejects.toThrow(/VOXCPM_SIDECAR_API_KEY/)
    // The sidecar cannot produce mp3 (no ffmpeg on its host): the request falls back to WAV.
    const badFormat = synth({
      respond: (body: any) =>
        body.response_format === "mp3"
          ? new Response('{"detail":"response_format must be one of [\'wav\', \'pcm\', \'flac\']"}', { status: 400 })
          : new Response(Buffer.from("AUDIOBYTES"), { status: 200, headers: { "x-sample-rate": "48000" } }),
    }).s
    expect((await badFormat.synthesize({ text: "x", format: "mp3" })).mimeType).toBe("audio/wav")
    // When even WAV is refused, the sidecar's complaint reaches the caller.
    const noFormat = synth({ respond: () => new Response('{"detail":"response_format must be one of [\'wav\', \'pcm\', \'flac\']"}', { status: 400 }) }).s
    await expect(noFormat.synthesize({ text: "x", format: "mp3" })).rejects.toThrow(/response_format must be one of/)
    const down = new VoxCpmSynthesizer({ voice: "marin", defaultFormat: "wav", logger, config: { baseUrl: "http://sidecar.test" }, fetchImpl: (async () => { throw new TypeError("fetch failed") }) as any })
    await expect(down.synthesize({ text: "x" })).rejects.toThrow(/unreachable at http:\/\/sidecar.test: fetch failed/)
  })

  test("stream wav: passed straight through, requested as a wav stream", async () => {
    const { s, seen } = synth({ respond: () => new Response(Buffer.from("RIFF-streaming-wav"), { status: 200 }) })
    const r = await s.synthesizeStream({ text: "Hi", format: "wav" })
    expect(r.mimeType).toBe("audio/wav")
    expect(seen[0].body).toMatchObject({ stream: true, response_format: "wav" })
    expect((await collect(r.stream)).toString()).toBe("RIFF-streaming-wav")
  })

  test("stream mp3/aac: sidecar asked for raw PCM, transcoded with the sidecar's sample rate", async () => {
    const calls: Array<{ sampleRate: number; format: string }> = []
    const { s, seen } = synth({
      ffmpegAvailable: () => true,
      respond: () => new Response(Buffer.alloc(100), { status: 200, headers: { "x-sample-rate": "44100" } }),
      transcode: ((src: Readable, o: any) => { calls.push(o); src.resume(); return Readable.from([Buffer.from("MP3")]) }) as any,
    })
    const mp3 = await s.synthesizeStream({ text: "Hi", format: "mp3" })
    expect(mp3.mimeType).toBe("audio/mpeg")
    expect(seen[0].body).toMatchObject({ stream: true, response_format: "pcm" })
    expect(calls[0]).toEqual({ sampleRate: 44100, format: "mp3" })
    expect((await s.synthesizeStream({ text: "Hi", format: "aac" })).mimeType).toBe("audio/aac")
  })

  test("stream errors surface before any bytes are sent", async () => {
    const { s } = synth({ ffmpegAvailable: () => false })
    await expect(s.synthesizeStream({ text: "x", format: "mp3" })).rejects.toThrow(/not configured: ffmpeg/)
    await expect(s.synthesizeStream({ text: "x", format: "opus" })).rejects.toThrow(/streams wav, mp3, aac/)
    const loading = synth({ respond: () => new Response('{"detail":"model is still loading"}', { status: 503 }) }).s
    await expect(loading.synthesizeStream({ text: "x", format: "wav" })).rejects.toThrow(/not ready/)
  })

  test("closing a stream aborts the sidecar request", async () => {
    const { s, seen } = synth({ respond: () => new Response(new ReadableStream({ start() {} }), { status: 200 }) })
    const r = await s.synthesizeStream({ text: "Hi", format: "wav" })
    expect(seen[0].signal.aborted).toBe(false)
    r.stream.destroy()
    await new Promise((res) => setTimeout(res, 50))
    expect(seen[0].signal.aborted).toBe(true)
  })
})

describe("/api/speech routes with provider=local", () => {
  async function app(speech: Record<string, unknown>, fetchImpl: typeof fetch) {
    const realFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    process.env.VOXCPM_SIDECAR_URL = "http://sidecar.test"
    process.env.VOXCPM_SIDECAR_API_KEY = "k"
    const settings: any = { getOwner: () => ({ speech: { provider: "local", ...speech } }) }
    const fastify = Fastify()
    registerSpeechRoutes(fastify as any, { speechService: new SpeechService(settings, logger) })
    return {
      fastify,
      restore: () => {
        globalThis.fetch = realFetch
        delete process.env.VOXCPM_SIDECAR_URL
        delete process.env.VOXCPM_SIDECAR_API_KEY
      },
    }
  }

  test("capabilities report local TTS + STT", async () => {
    const { fastify, restore } = await app({ ttsVoice: "voxcpm-marin" }, (async () => new Response("")) as any)
    try {
      const body = (await fastify.inject({ method: "GET", url: "/api/speech/capabilities" })).json()
      expect(body).toMatchObject({ provider: "local", supportsStt: true, supportsTts: true, supportsStreamingTts: true, ttsModel: "voxcpm2", ttsVoice: "marin" })
    } finally { restore() }
  })

  test("POST /synthesize returns base64 audio from the sidecar", async () => {
    const calls: any[] = []
    const { fastify, restore } = await app({ ttsVoice: "voxcpm-marin", ttsFormat: "wav" }, (async (url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string))
      return new Response(Buffer.from("WAVDATA"), { status: 200 })
    }) as any)
    try {
      const res = await fastify.inject({ method: "POST", url: "/api/speech/synthesize", payload: { text: "Hello" } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ audioBase64: Buffer.from("WAVDATA").toString("base64"), mimeType: "audio/wav" })
      expect(calls[0]).toMatchObject({ input: "Hello", voice: "marin", response_format: "wav" })
    } finally { restore() }
  })

  test("POST /synthesize/stream streams wav with the right headers", async () => {
    const { fastify, restore } = await app({ ttsFormat: "wav" }, (async () => new Response(Buffer.from("RIFFxxxx"), { status: 200 })) as any)
    try {
      const res = await fastify.inject({ method: "POST", url: "/api/speech/synthesize/stream", payload: { text: "Hello", format: "wav" } })
      expect(res.statusCode).toBe(200)
      expect(res.headers["content-type"]).toBe("audio/wav")
      expect(res.headers["cache-control"]).toBe("no-store")
      expect(res.body).toBe("RIFFxxxx")
    } finally { restore() }
  })

  ffmpegTest("POST /synthesize/stream as mp3 transcodes the sidecar's PCM end to end", async () => {
    const pcm = Buffer.alloc(48000 * 2) // 1 s of silence
    const { fastify, restore } = await app({}, (async () => new Response(pcm, { status: 200, headers: { "x-sample-rate": "48000" } })) as any)
    try {
      const res = await fastify.inject({ method: "POST", url: "/api/speech/synthesize/stream", payload: { text: "Hello", format: "mp3" } })
      expect(res.statusCode).toBe(200)
      expect(res.headers["content-type"]).toBe("audio/mpeg")
      expect(res.rawPayload.length).toBeGreaterThan(2000)
    } finally { restore() }
  })

  test("a loading model is HTTP 503; an unreachable sidecar is 502; empty text is 400", async () => {
    const loading = await app({}, (async () => new Response('{"detail":"model is still loading"}', { status: 503 })) as any)
    try {
      const res = await loading.fastify.inject({ method: "POST", url: "/api/speech/synthesize", payload: { text: "Hello" } })
      expect(res.statusCode).toBe(503)
      expect(res.json().error).toContain("model is still loading")
      expect((await loading.fastify.inject({ method: "POST", url: "/api/speech/synthesize", payload: { text: "  " } })).statusCode).toBe(400)
    } finally { loading.restore() }

    const down = await app({}, (async () => { throw new TypeError("fetch failed") }) as any)
    try {
      expect((await down.fastify.inject({ method: "POST", url: "/api/speech/synthesize", payload: { text: "Hello" } })).statusCode).toBe(502)
    } finally { down.restore() }
  })
})
