import { describe, test, expect } from "bun:test"
import {
  Decimator2,
  LinearResampler,
  Pcm16Aligner,
  createTo24kResampler,
  int16ToPcm16Bytes,
  pcm16BytesToInt16,
} from "../pcm-resample"

function sine(freq: number, rate: number, seconds: number, amp = 10000): Int16Array {
  const out = new Int16Array(Math.floor(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate))
  return out
}

function rms(x: Int16Array, from = 0): number {
  let s = 0
  for (let i = from; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(x.length - from, 1))
}

/** Goertzel magnitude at `freq` — avoids pulling in an FFT. */
function toneLevel(x: Int16Array, freq: number, rate: number): number {
  const w = (2 * Math.PI * freq) / rate
  const c = 2 * Math.cos(w)
  let s0 = 0, s1 = 0, s2 = 0
  for (let i = 0; i < x.length; i++) {
    s0 = x[i] + c * s1 - s2
    s2 = s1
    s1 = s0
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / x.length * 2
}

function run(d: Decimator2, x: Int16Array, chunk = x.length): Int16Array {
  const parts: Int16Array[] = []
  for (let i = 0; i < x.length; i += chunk) parts.push(d.push(x.subarray(i, i + chunk)))
  parts.push(d.end())
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

describe("pcm16 byte helpers", () => {
  test("round-trips signed 16-bit little-endian", () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 12345])
    expect(Array.from(pcm16BytesToInt16(int16ToPcm16Bytes(samples)))).toEqual(Array.from(samples))
  })

  test("aligner re-joins a sample split across chunks and loses no bytes", () => {
    const a = new Pcm16Aligner()
    const all: number[] = []
    let pushed = 0
    for (const n of [1, 3, 2, 5, 1, 4]) {
      const chunk = Uint8Array.from({ length: n }, (_, i) => (pushed + i) % 251)
      pushed += n
      const out = a.push(chunk)
      expect(out.length % 2).toBe(0)
      all.push(...out)
    }
    expect(all.length).toBe(pushed - (pushed % 2))
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i % 251))
  })
})

describe("Decimator2 (48 kHz → 24 kHz)", () => {
  test("halves the sample count (± filter edge)", () => {
    const out = run(new Decimator2(), sine(1000, 48000, 1))
    expect(Math.abs(out.length - 24000)).toBeLessThanOrEqual(2)
  })

  test("passes a 1 kHz voice-band tone at ~unity gain", () => {
    const out = run(new Decimator2(), sine(1000, 48000, 1))
    expect(toneLevel(out, 1000, 24000)).toBeGreaterThan(9500)
    expect(toneLevel(out, 1000, 24000)).toBeLessThan(10500)
  })

  test("removes content above the 12 kHz output Nyquist instead of aliasing it", () => {
    // 20 kHz at 48 kHz would fold to 4 kHz at 24 kHz if samples were simply dropped.
    const naive = new Int16Array(24000)
    const src = sine(20000, 48000, 1)
    for (let i = 0; i < naive.length; i++) naive[i] = src[i * 2]
    const out = run(new Decimator2(), src)
    expect(toneLevel(naive, 4000, 24000)).toBeGreaterThan(8000) // proves the test would catch aliasing
    expect(toneLevel(out, 4000, 24000)).toBeLessThan(150)
  })

  test("chunked streaming equals one-shot processing exactly", () => {
    const src = sine(440, 48000, 0.5)
    const whole = run(new Decimator2(), src)
    for (const chunk of [1, 7, 480, 4801]) {
      expect(Array.from(run(new Decimator2(), src, chunk))).toEqual(Array.from(whole))
    }
  })

  test("silence in, silence out; full-scale input is clamped not wrapped", () => {
    expect(rms(run(new Decimator2(), new Int16Array(4800)))).toBe(0)
    const loud = new Int16Array(4800).fill(32767)
    const out = run(new Decimator2(), loud)
    expect(Math.max(...out)).toBeLessThanOrEqual(32767)
    expect(Math.min(...out.subarray(40, out.length - 40))).toBeGreaterThan(32000)
  })
})

describe("createTo24kResampler", () => {
  test("24 kHz passes through untouched", () => {
    const x = Int16Array.from([1, 2, 3])
    expect(createTo24kResampler(24000).push(x)).toBe(x)
  })

  test("other rates use linear interpolation to the right length", () => {
    const out = createTo24kResampler(16000).push(sine(440, 16000, 1))
    expect(Math.abs(out.length - 24000)).toBeLessThanOrEqual(2)
    expect(toneLevel(out, 440, 24000)).toBeGreaterThan(9000)
  })

  test("linear resampler is stateful across chunks", () => {
    const src = sine(300, 44100, 0.5)
    const one = new LinearResampler(44100, 24000).push(src)
    const r = new LinearResampler(44100, 24000)
    const parts = [r.push(src.subarray(0, 1000)), r.push(src.subarray(1000, 5000)), r.push(src.subarray(5000))]
    const joined = Int16Array.from(parts.flatMap((p) => Array.from(p)))
    expect(Array.from(joined)).toEqual(Array.from(one))
  })
})
