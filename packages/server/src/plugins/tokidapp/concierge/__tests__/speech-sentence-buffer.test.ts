import { describe, test, expect } from "bun:test"
import { SentenceBuffer } from "../speech-sentence-buffer"

function feed(buf: SentenceBuffer, deltas: string[]): string[] {
  return deltas.flatMap((d) => buf.push(d))
}

describe("SentenceBuffer", () => {
  test("emits a sentence once the next token proves it ended, and keeps the tail for flush()", () => {
    const b = new SentenceBuffer({ minChars: 5 })
    const out = feed(b, ["Hello", " there", ".", " How", " are", " you", "?", " Fine", " thanks"])
    expect(out).toEqual(["Hello there.", "How are you?"])
    expect(b.flush()).toEqual(["Fine thanks"])
    expect(b.flush()).toEqual([])
  })

  test("a terminator at the very end waits: it may be a decimal point", () => {
    const b = new SentenceBuffer({ minChars: 5 })
    expect(feed(b, ["The", " price", " is", " 3", "."])).toEqual([])
    expect(feed(b, ["5", " dollars", ".", " Thanks"])).toEqual(["The price is 3.5 dollars."])
  })

  test("short fragments merge into the next sentence (Dr., OK.)", () => {
    const b = new SentenceBuffer({ minChars: 24 })
    const out = feed(b, ["OK", ".", " Let", " me", " check", " that", " for", " you", ".", " One", " moment"])
    expect(out).toEqual(["OK. Let me check that for you."])
    expect(b.flush()).toEqual(["One moment"])
  })

  test("newlines are boundaries", () => {
    const b = new SentenceBuffer({ minChars: 3 })
    expect(feed(b, ["First line", "\n", "Second line", "\n\n", "Third"])).toEqual(["First line", "Second line"])
    expect(b.flush()).toEqual(["Third"])
  })

  test("a run-on with no terminator is cut at a comma/space, never mid-word", () => {
    const b = new SentenceBuffer({ minChars: 10, maxChars: 60 })
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`)
    const out = feed(b, words.map((w, i) => (i ? ` ${w}` : w)))
    expect(out.length).toBeGreaterThan(2)
    expect(out.every((p) => p.length <= 60)).toBe(true)
    const rejoined = [...out, ...b.flush()].join(" ")
    expect(rejoined).toBe(words.join(" "))
  })

  test("CJK terminators and trailing quotes/brackets are handled", () => {
    const b = new SentenceBuffer({ minChars: 3 })
    expect(feed(b, ["He said \"go.\" ", "Then left. "])).toEqual(['He said "go."', "Then left."])
  })

  test("reset() drops pending text; many tiny tokens stay linear", () => {
    const b = new SentenceBuffer()
    b.push("half a sentence with no end")
    b.reset()
    expect(b.flush()).toEqual([])
    const big = Array.from({ length: 5000 }, (_, i) => (i % 7 === 6 ? " word. " : " word"))
    const t0 = Date.now()
    const out = feed(new SentenceBuffer({ minChars: 10 }), big)
    expect(out.length).toBeGreaterThan(100)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
