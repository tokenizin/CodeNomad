import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { DictationSegmenter, encodeWav, frameLevel } from "./dictation"

// 4096 samples at 24 kHz ≈ 171 ms, like the browser capture.
const FRAME = 4096
const speech = () => Int16Array.from({ length: FRAME }, (_, i) => Math.round(Math.sin(i / 5) * 8000))
const quiet = () => new Int16Array(FRAME)

function feed(seg: DictationSegmenter, frames: Int16Array[]) {
  return frames.flatMap((f) => seg.push(f))
}

describe("dictation segmenter", () => {
  it("cuts an utterance at a short pause and sends after 4 s of quiet", () => {
    const seg = new DictationSegmenter()
    const events = feed(seg, [...Array(6)].map(speech).concat([...Array(5)].map(quiet)))
    assert.equal(events.filter((e) => e.type === "segment").length, 1)
    assert.equal(events.some((e) => e.type === "autosend"), false)

    const later = feed(seg, [...Array(20)].map(quiet))
    assert.deepEqual(later.map((e) => e.type), ["autosend"])
    // Only once per burst of speech.
    assert.deepEqual(feed(seg, [...Array(30)].map(quiet)), [])
  })

  it("a long pause after several utterances sends once; noise alone never sends", () => {
    const seg = new DictationSegmenter()
    const events = feed(seg, [
      ...[...Array(4)].map(speech), ...[...Array(5)].map(quiet),
      ...[...Array(4)].map(speech), ...[...Array(30)].map(quiet),
    ])
    assert.equal(events.filter((e) => e.type === "segment").length, 2)
    assert.equal(events.filter((e) => e.type === "autosend").length, 1)

    const blip = new DictationSegmenter()
    assert.deepEqual(feed(blip, [speech(), ...[...Array(30)].map(quiet)]).filter((e) => e.type !== "segment"), [])
  })

  it("cuts very long speech without waiting for a pause", () => {
    const seg = new DictationSegmenter()
    const events = feed(seg, [...Array(100)].map(speech))
    assert.ok(events.filter((e) => e.type === "segment").length >= 1)
  })

  it("flush returns the utterance in progress", () => {
    const seg = new DictationSegmenter()
    feed(seg, [...Array(3)].map(speech))
    assert.equal(seg.flush()?.length, 3 * FRAME)
    assert.equal(seg.flush(), null)
  })

  it("encodes a 24 kHz mono WAV", () => {
    const wav = encodeWav(Int16Array.from([1, -1]))
    const view = new DataView(wav.buffer)
    assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF")
    assert.equal(view.getUint32(24, true), 24000)
    assert.equal(view.getInt16(46, true), -1)
    assert.ok(frameLevel(speech()) > frameLevel(quiet()))
  })
})
