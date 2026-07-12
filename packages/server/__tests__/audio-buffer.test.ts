/**
 * AudioBuffer + PreSessionAudioManager — Unit Tests
 *
 * Tests the shared PCM 24kHz mono audio buffering module used by both
 * Deepgram and OpenAI Realtime voice paths.
 *
 * No mocking required — pure logic module.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { AudioBuffer, PreSessionAudioManager } from "../src/plugins/tokidapp/concierge/audio-buffer"

// ── Helpers ──────────────────────────────────────────────────

/** Generate a fake base64 chunk of the given decoded byte size. */
let _chunkCounter = 0
function fakeChunk(decodedBytes: number): string {
  _chunkCounter++
  const b64Len = Math.ceil((decodedBytes * 4) / 3)
  // Use alternating chars so each chunk is unique
  return (_chunkCounter % 2 === 0 ? "A" : "B").repeat(b64Len)
}

// ── AudioBuffer Tests ────────────────────────────────────────

describe("AudioBuffer", () => {
  let buf: AudioBuffer

  beforeEach(() => {
    buf = new AudioBuffer({ label: "test-buffer" })
  })

  // ── AC-S2-11.1: addChunk accumulates audio data ───────────

  test("addChunk returns true and increments byte count", () => {
    const chunk = fakeChunk(960) // ~20ms at 24kHz 16-bit mono
    const added = buf.addChunk(chunk)

    expect(added).toBe(true)
    expect(buf.length).toBe(1)
    expect(buf.byteLength).toBeGreaterThan(0)
    expect(buf.isEmpty).toBe(false)
  })

  test("addChunk accumulates multiple chunks", () => {
    buf.addChunk(fakeChunk(4800))
    buf.addChunk(fakeChunk(4800))
    buf.addChunk(fakeChunk(4800))

    expect(buf.length).toBe(3)
    expect(buf.byteLength).toBeGreaterThan(0)
  })

  // ── AC-S2-11.2: commit returns all chunks and resets ──────

  test("commit returns all buffered chunks and resets internal state", () => {
    buf.addChunk(fakeChunk(4800))
    buf.addChunk(fakeChunk(4800))

    const committed = buf.commit()

    expect(committed).toHaveLength(2)
    expect(committed[0]).toBe(fakeChunk(4800))
    expect(committed[1]).toBe(fakeChunk(4800))

    // Buffer is now empty
    expect(buf.length).toBe(0)
    expect(buf.byteLength).toBe(0)
    expect(buf.isEmpty).toBe(true)
  })

  test("commit returns empty array when buffer is empty", () => {
    const committed = buf.commit()
    expect(committed).toEqual([])
  })

  // ── AC-S2-11.3: reset clears buffer ───────────────────────

  test("reset clears all buffered data", () => {
    buf.addChunk(fakeChunk(4800))
    buf.addChunk(fakeChunk(4800))
    buf.addChunk(fakeChunk(4800))

    buf.reset()

    expect(buf.length).toBe(0)
    expect(buf.byteLength).toBe(0)
    expect(buf.isEmpty).toBe(true)
  })

  test("reset on empty buffer is a no-op", () => {
    buf.reset()
    expect(buf.isEmpty).toBe(true)
    expect(buf.length).toBe(0)
  })

  // ── AC-S2-11.4: getBuffer returns committed audio ─────────

  test("getBuffer returns a copy of current chunks (not the internal array)", () => {
    buf.addChunk(fakeChunk(4800))
    buf.addChunk(fakeChunk(4800))

    const buffer = buf.getBuffer()
    expect(buffer).toHaveLength(2)

    // Mutating the returned array should not affect the internal state
    buffer.push("extra-chunk")
    expect(buf.length).toBe(2)
  })

  test("getBuffer returns empty array for empty buffer", () => {
    expect(buf.getBuffer()).toEqual([])
  })

  // ── hasMinimum() ──────────────────────────────────────────

  test("hasMinimum returns false when below threshold", () => {
    // Default threshold: 4800 bytes (100ms)
    // Add a tiny chunk (~960 bytes)
    buf.addChunk(fakeChunk(960))
    expect(buf.hasMinimum()).toBe(false)
  })

  test("hasMinimum returns true when at or above threshold", () => {
    // Add a chunk that exceeds 4800 bytes
    buf.addChunk(fakeChunk(4800))
    expect(buf.hasMinimum()).toBe(true)
  })

  test("hasMinimum with custom minBytes", () => {
    const custom = new AudioBuffer({ minBytes: 960 })
    custom.addChunk(fakeChunk(960))
    expect(custom.hasMinimum()).toBe(true)
  })

  // ── getStats() ────────────────────────────────────────────

  test("getStats returns correct statistics", () => {
    buf.addChunk(fakeChunk(4800))
    buf.addChunk(fakeChunk(4800))

    const stats = buf.getStats()
    expect(stats.chunkCount).toBe(2)
    expect(stats.bytes).toBeGreaterThan(0)
    expect(stats.durationSec).toBeGreaterThan(0)
    expect(stats.hasMinimum).toBe(true)
  })

  // ── Capacity limit ────────────────────────────────────────

  test("addChunk returns false when buffer exceeds maxChunks", () => {
    const small = new AudioBuffer({ maxChunks: 3 })
    expect(small.addChunk(fakeChunk(100))).toBe(true)
    expect(small.addChunk(fakeChunk(100))).toBe(true)
    expect(small.addChunk(fakeChunk(100))).toBe(true)
    expect(small.addChunk(fakeChunk(100))).toBe(false) // at capacity
  })

  // ── Custom options ────────────────────────────────────────

  test("constructor respects custom label and minBytes", () => {
    const custom = new AudioBuffer({ label: "custom", minBytes: 100 })
    custom.addChunk(fakeChunk(100))
    expect(custom.hasMinimum()).toBe(true)
    expect(custom.getStats().hasMinimum).toBe(true)
  })

  // ── commit + add interplay ────────────────────────────────

  test("add after commit starts fresh accumulation", () => {
    buf.addChunk(fakeChunk(4800))
    const first = buf.commit()
    expect(first).toHaveLength(1)

    buf.addChunk(fakeChunk(4800))
    const second = buf.commit()
    expect(second).toHaveLength(1)

    // Each commit only returns what was added since last commit
    expect(second[0]).not.toEqual(first[0])
  })
})

// ── PreSessionAudioManager Tests ─────────────────────────────

describe("PreSessionAudioManager", () => {
  let manager: PreSessionAudioManager

  beforeEach(() => {
    manager = new PreSessionAudioManager(256)
  })

  test("enqueue queues chunks per session", () => {
    expect(manager.enqueue("s1", "chunk-a")).toBe(true)
    expect(manager.enqueue("s1", "chunk-b")).toBe(true)
    expect(manager.size).toBe(1)
  })

  test("enqueue returns false at capacity", () => {
    const small = new PreSessionAudioManager(2)
    expect(small.enqueue("s1", "a")).toBe(true)
    expect(small.enqueue("s1", "b")).toBe(true)
    expect(small.enqueue("s1", "c")).toBe(false) // at capacity
  })

  test("drain returns all queued chunks and removes session", () => {
    manager.enqueue("s1", "a")
    manager.enqueue("s1", "b")

    const chunks = manager.drain("s1")
    expect(chunks).toEqual(["a", "b"])
    expect(manager.has("s1")).toBe(false)
    expect(manager.size).toBe(0)
  })

  test("drain returns empty array for unknown session", () => {
    expect(manager.drain("unknown")).toEqual([])
  })

  test("has returns true when session has queued chunks", () => {
    manager.enqueue("s1", "a")
    expect(manager.has("s1")).toBe(true)
  })

  test("has returns false for empty or unknown session", () => {
    expect(manager.has("unknown")).toBe(false)
  })

  test("discard removes session without returning chunks", () => {
    manager.enqueue("s1", "a")
    manager.discard("s1")
    expect(manager.has("s1")).toBe(false)
  })

  test("clear removes all sessions", () => {
    manager.enqueue("s1", "a")
    manager.enqueue("s2", "b")
    expect(manager.size).toBe(2)

    manager.clear()
    expect(manager.size).toBe(0)
  })

  test("multiple sessions are isolated", () => {
    manager.enqueue("s1", "a1")
    manager.enqueue("s2", "b1")
    manager.enqueue("s1", "a2")

    const chunks1 = manager.drain("s1")
    expect(chunks1).toEqual(["a1", "a2"])

    const chunks2 = manager.drain("s2")
    expect(chunks2).toEqual(["b1"])
  })
})
