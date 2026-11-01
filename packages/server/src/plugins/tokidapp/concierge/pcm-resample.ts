/**
 * Streaming PCM16 helpers for the local voice engine.
 *
 * The browser plays local-engine audio as 24 kHz mono PCM16; VoxCPM2 emits 48 kHz. Dropping every other
 * sample would alias everything above 12 kHz back into the voice band, so 48 → 24 kHz goes through a
 * windowed-sinc low-pass first. State carries across chunks, so streaming output is identical to
 * resampling the whole clip at once.
 *
 * @module pcm-resample
 */

/** Little-endian signed 16-bit bytes → samples. `bytes.length` must be even. */
export function pcm16BytesToInt16(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length >> 1)
  for (let i = 0; i < out.length; i++) {
    const lo = bytes[i * 2]
    const hi = bytes[i * 2 + 1]
    const v = (hi << 8) | lo
    out[i] = v & 0x8000 ? v - 0x10000 : v
  }
  return out
}

export function int16ToPcm16Bytes(samples: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2)
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], i * 2)
  return out
}

/** Network chunks can split a 2-byte sample; holds the odd byte until the next chunk completes it. */
export class Pcm16Aligner {
  private carry: Buffer | null = null

  push(chunk: Uint8Array): Buffer {
    let data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (this.carry) {
      data = Buffer.concat([this.carry, data])
      this.carry = null
    }
    if (data.length & 1) {
      this.carry = Buffer.from(data.subarray(data.length - 1))
      data = data.subarray(0, data.length - 1)
    }
    return data
  }
}

const TAPS = 63 // odd → symmetric, integer group delay
const HALF = (TAPS - 1) / 2

/** Low-pass at 0.23 × fs_in (≈11 kHz for 48 kHz input), Blackman window, unity DC gain. */
function buildHalfbandKernel(): Float64Array {
  const fc = 0.23
  const h = new Float64Array(TAPS)
  let sum = 0
  for (let n = 0; n < TAPS; n++) {
    const m = n - HALF
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m)
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (TAPS - 1))
    h[n] = sinc * w
    sum += h[n]
  }
  for (let n = 0; n < TAPS; n++) h[n] /= sum
  return h
}

const KERNEL = buildHalfbandKernel()

/** 2:1 decimator (48 kHz → 24 kHz). Feed chunks with `push`, then call `end()` once to drain the filter tail. */
export class Decimator2 {
  // Starts with HALF zeros so output sample 0 is centred on input sample 0 (no startup transient shift).
  private buf: Float64Array = new Float64Array(HALF)
  private pos = 0

  push(input: Int16Array): Int16Array {
    const merged = new Float64Array(this.buf.length + input.length)
    merged.set(this.buf, 0)
    for (let i = 0; i < input.length; i++) merged[this.buf.length + i] = input[i]
    return this.drain(merged)
  }

  /** Flush the trailing HALF samples of filter delay so the clip's last ~1 ms is not lost. */
  end(): Int16Array {
    return this.push(new Int16Array(HALF))
  }

  private drain(merged: Float64Array): Int16Array {
    const outLen = merged.length >= TAPS + this.pos ? Math.floor((merged.length - TAPS - this.pos) / 2) + 1 : 0
    const out = new Int16Array(outLen)
    for (let j = 0; j < outLen; j++) {
      let acc = 0
      const base = this.pos + j * 2
      for (let k = 0; k < TAPS; k++) acc += merged[base + k] * KERNEL[k]
      out[j] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc)
    }
    const consumed = this.pos + outLen * 2
    this.buf = merged.slice(consumed)
    this.pos = 0
    return out
  }
}

/** Linear-interpolation resampler for rates other than 48 kHz (not expected from VoxCPM2; keeps playback correct if it changes). */
export class LinearResampler {
  private prev = 0
  private frac = 0 // position of the next output sample, relative to `prev`, in input samples
  private have = false

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number,
  ) {}

  push(input: Int16Array): Int16Array {
    if (input.length === 0) return new Int16Array(0)
    const step = this.fromRate / this.toRate
    const out: number[] = []
    let i = 0
    if (!this.have) {
      this.prev = input[0]
      this.have = true
      this.frac = 0
      i = 1
      out.push(this.prev)
      this.frac = step
    }
    // Between `prev` (index -1 relative to the unread input) and input[i..]
    for (; i < input.length; i++) {
      const cur = input[i]
      while (this.frac <= 1) {
        out.push(Math.round(this.prev + (cur - this.prev) * this.frac))
        this.frac += step
      }
      this.frac -= 1
      this.prev = cur
    }
    return Int16Array.from(out)
  }
}

export interface PcmResampler {
  push(input: Int16Array): Int16Array
  end(): Int16Array
}

/** Resampler to the 24 kHz the browser expects. */
export function createTo24kResampler(fromRate: number): PcmResampler {
  if (fromRate === 24000) return { push: (x) => x, end: () => new Int16Array(0) }
  if (fromRate === 48000) {
    const d = new Decimator2()
    return { push: (x) => d.push(x), end: () => d.end() }
  }
  const r = new LinearResampler(fromRate, 24000)
  return { push: (x) => r.push(x), end: () => new Int16Array(0) }
}
