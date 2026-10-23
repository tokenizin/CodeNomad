/**
 * Turns a stream of LLM token deltas into sentence-sized utterances for TTS.
 *
 * Piper can speak token fragments as they arrive; VoxCPM2 cannot — every request is a full diffusion pass, so per-token
 * requests would flood the sidecar's queue and cut words mid-syllable. Sentences are emitted as soon as the *next* token
 * shows the sentence ended (a terminator followed by whitespace, or a newline), so "3.5" and "e.g." survive and the
 * listener hears sentence N while the model writes sentence N+1.
 *
 * @module speech-sentence-buffer
 */

export interface SentenceBufferOptions {
  /** A boundary only counts once the sentence is at least this long ("Dr." / "OK." merge into the next sentence). */
  minChars?: number
  /** Hard cap on latency: a run-on with no boundary is cut at the last comma/space before this length. */
  maxChars?: number
}

const BOUNDARY = /[.!?;。！？…]+["')\]]*\s|\n+/g

export class SentenceBuffer {
  private buf = ""
  private readonly minChars: number
  private readonly maxChars: number

  constructor(options: SentenceBufferOptions = {}) {
    this.minChars = options.minChars ?? 24
    this.maxChars = options.maxChars ?? 300
  }

  /** Add a delta; returns the complete utterances now ready to speak (usually none or one). */
  push(delta: string): string[] {
    this.buf += delta
    const out: string[] = []
    for (;;) {
      const piece = this.takeSentence() ?? this.takeRunOn()
      if (piece === null) break
      out.push(piece)
    }
    return out
  }

  /** End of response: whatever is left, even if it has no terminator. */
  flush(): string[] {
    const rest = this.buf.trim()
    this.buf = ""
    return rest ? [rest] : []
  }

  /** Drop pending text (response failed or session ended). */
  reset(): void {
    this.buf = ""
  }

  private takeSentence(): string | null {
    BOUNDARY.lastIndex = 0
    for (let m = BOUNDARY.exec(this.buf); m; m = BOUNDARY.exec(this.buf)) {
      const end = m.index + m[0].length
      const piece = this.buf.slice(0, end).trim()
      if (piece.length >= this.minChars) {
        this.buf = this.buf.slice(end)
        return piece
      }
    }
    return null
  }

  private takeRunOn(): string | null {
    if (this.buf.length <= this.maxChars) return null
    const window = this.buf.slice(0, this.maxChars)
    const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf(" "))
    const end = cut > this.minChars ? cut + 1 : this.maxChars
    const piece = this.buf.slice(0, end).trim()
    this.buf = this.buf.slice(end)
    return piece || null
  }
}
