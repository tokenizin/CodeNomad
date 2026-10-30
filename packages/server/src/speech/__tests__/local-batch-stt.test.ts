import { afterEach, describe, expect, test } from "bun:test"
import { pcmFromWav, toPcm16Mono24k } from "../audio-to-pcm"
import { closeLocalBatchStt, transcribeLocally } from "../local-batch-stt"

function wav(pcm: Buffer, rate = 24000, channels = 1): Buffer {
  const h = Buffer.alloc(44)
  h.write("RIFF", 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write("WAVE", 8)
  h.write("fmt ", 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2 * channels, 28)
  h.writeUInt16LE(2 * channels, 32)
  h.writeUInt16LE(16, 34)
  h.write("data", 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

function fakeConnection(answer: (pcm: Buffer) => string, opts: { delayMs?: number } = {}) {
  const calls: Buffer[] = []
  let closed = false
  return {
    calls,
    factory: () => ({
      sendAudio() {},
      flush() {},
      reset() {},
      close() {
        closed = true
      },
      get isReady() {
        return true
      },
      get isClosed() {
        return closed
      },
      async transcribeOnce(b64: string) {
        const pcm = Buffer.from(b64, "base64")
        calls.push(pcm)
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
        return { text: answer(pcm), language: "en" }
      },
    }),
  }
}

afterEach(() => closeLocalBatchStt())

describe("audio to PCM", () => {
  test("a 24 kHz mono WAV is unwrapped without ffmpeg", async () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0])
    expect(pcmFromWav(wav(pcm))).toEqual(pcm)
    expect(await toPcm16Mono24k(wav(pcm), "audio/wav", (() => { throw new Error("no ffmpeg") }) as any)).toEqual(pcm)
  })

  test("other formats go through ffmpeg", async () => {
    expect(pcmFromWav(wav(Buffer.alloc(4), 48000))).toBeNull()
    const args: string[][] = []
    const { EventEmitter } = await import("node:events")
    const { PassThrough } = await import("node:stream")
    const spawnFake = ((_cmd: string, a: string[]) => {
      args.push(a)
      const proc: any = new EventEmitter()
      proc.stdout = new PassThrough()
      proc.stderr = new PassThrough()
      proc.stdin = new PassThrough()
      proc.stdin.on("finish", () => {
        proc.stdout.end(Buffer.from([9, 9]))
        setTimeout(() => proc.emit("close", 0), 5)
      })
      return proc
    }) as any
    expect(await toPcm16Mono24k(Buffer.from("webm"), "audio/webm;codecs=opus", spawnFake)).toEqual(Buffer.from([9, 9]))
    expect(args[0]).toContain("24000")
  })
})

describe("warm local transcription", () => {
  test("reuses one process and answers requests in order", async () => {
    let made = 0
    const fake = fakeConnection((pcm) => `clip ${pcm[0]}`, { delayMs: 10 })
    const factory = () => {
      made += 1
      return fake.factory()
    }
    const a = transcribeLocally({ audioBase64: wav(Buffer.from([1, 0])).toString("base64"), mimeType: "audio/wav", model: "m" }, factory)
    const b = transcribeLocally({ audioBase64: wav(Buffer.from([2, 0])).toString("base64"), mimeType: "audio/wav", model: "m" }, factory)
    expect((await a).text).toBe("clip 1")
    expect((await b).text).toBe("clip 2")
    expect(made).toBe(1)
    expect(fake.calls.map((c) => c[0])).toEqual([1, 2])
  })
})
