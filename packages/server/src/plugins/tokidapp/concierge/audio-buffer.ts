/**
 * Shared Audio Buffer — PCM 24kHz mono audio buffering for Deepgram and OpenAI paths.
 *
 * Provides a reusable buffer class that accumulates audio chunks during
 * speech capture, supports commit (flush to STT) and reset (discard).
 * Used by both the Deepgram pipeline (STT input) and the OpenAI Realtime
 * path (input_audio_buffer management).
 *
 * Format: PCM 16-bit linear16, 24kHz mono (matches Deepgram & OpenAI expectations).
 *
 * @module audio-buffer
 */

// ── Configuration ──────────────────────────────────────────────

/** PCM 16-bit mono at 24kHz → 2 bytes per sample → 48000 bytes/sec.
 *  100ms minimum = 4800 bytes. */
const BYTES_PER_SECOND = 48000
const DEFAULT_MIN_AUDIO_BYTES = 4800 // 100ms

/** Maximum chunks to buffer before auto-flushing. */
const MAX_BUFFER_CHUNKS = 1024

// ── Types ──────────────────────────────────────────────────────

export interface AudioBufferOptions {
  /** Minimum audio bytes required to consider a commit valid. Default: 4800 (100ms). */
  minBytes?: number
  /** Maximum chunks before warning. Default: 1024. */
  maxChunks?: number
  /** Label for log messages. */
  label?: string
}

export interface AudioBufferStats {
  /** Total bytes accumulated since last reset. */
  bytes: number
  /** Number of chunks buffered. */
  chunkCount: number
  /** Duration in seconds (approximate). */
  durationSec: number
  /** Whether buffer has exceeded minimum threshold. */
  hasMinimum: boolean
}

// ── AudioBuffer Class ──────────────────────────────────────────

/**
 * Accumulates PCM audio chunks and provides commit/reset lifecycle.
 *
 * Usage:
 *   const buf = new AudioBuffer({ label: "deepgram-stt" })
 *   buf.addChunk(base64Chunk)   // accumulate
 *   buf.getBuffer()             // get all chunks
 *   buf.commit()                // flush and check minimum
 *   buf.reset()                 // clear for next utterance
 */
export class AudioBuffer {
  private chunks: string[] = []
  private totalBytes = 0
  private minBytes: number
  private maxChunks: number
  private label: string

  constructor(options?: AudioBufferOptions) {
    this.minBytes = options?.minBytes ?? DEFAULT_MIN_AUDIO_BYTES
    this.maxChunks = options?.maxChunks ?? MAX_BUFFER_CHUNKS
    this.label = options?.label ?? "audio-buffer"
  }

  /**
   * Add a base64-encoded PCM audio chunk to the buffer.
   * Each chunk is a segment of linear16 24kHz mono audio.
   *
   * @param base64Chunk - Base64-encoded audio data
   * @returns true if added, false if buffer is at capacity
   */
  addChunk(base64Chunk: string): boolean {
    if (this.chunks.length >= this.maxChunks) {
      console.warn(
        `[${this.label}] Buffer at capacity (${this.maxChunks} chunks, ${this.totalBytes} bytes). ` +
        `Dropping chunk. Consider committing or resetting.`
      )
      return false
    }

    this.chunks.push(base64Chunk)
    // Base64 encodes 3 bytes per 4 chars; approximate decoded size
    this.totalBytes += Math.floor(base64Chunk.length * 0.75)
    return true
  }

  /**
   * Commit the buffer — returns all accumulated chunks and resets internal state.
   * Caller is responsible for sending chunks to STT/LLM.
   *
   * @returns Array of base64-encoded audio chunks (empty if buffer was empty)
   */
  commit(): string[] {
    const committed = [...this.chunks]
    this.chunks = []
    this.totalBytes = 0
    return committed
  }

  /**
   * Peek at committed chunks without resetting.
   * Useful for checking buffer state before committing.
   *
   * @returns Shallow copy of current chunks
   */
  getBuffer(): string[] {
    return [...this.chunks]
  }

  /**
   * Discard all buffered audio without returning it.
   * Use when audio is invalid (silence, noise, etc.).
   */
  reset(): void {
    this.chunks = []
    this.totalBytes = 0
  }

  /**
   * Check whether the buffer has enough audio to be meaningful.
   *
   * @returns true if total bytes >= minBytes threshold
   */
  hasMinimum(): boolean {
    return this.totalBytes >= this.minBytes
  }

  /**
   * Get current buffer statistics.
   */
  getStats(): AudioBufferStats {
    return {
      bytes: this.totalBytes,
      chunkCount: this.chunks.length,
      durationSec: this.totalBytes / BYTES_PER_SECOND,
      hasMinimum: this.hasMinimum(),
    }
  }

  /**
   * Number of chunks currently buffered.
   */
  get length(): number {
    return this.chunks.length
  }

  /**
   * Total bytes currently buffered (approximate, from base64 length).
   */
  get byteLength(): number {
    return this.totalBytes
  }

  /**
   * Whether the buffer is empty.
   */
  get isEmpty(): boolean {
    return this.chunks.length === 0
  }
}

// ── Pre-Session Buffer (for chunks arriving before session creation) ──

/**
 * Manages pre-session audio chunks that arrive before a voice session
 * is fully initialized. Mirrors the preSessionAudio pattern from
 * openai-realtime.ts but extracted as a reusable component.
 */
export class PreSessionAudioManager {
  private buffers = new Map<string, string[]>()
  private maxPerSession: number

  constructor(maxPerSession = 256) {
    this.maxPerSession = maxPerSession
  }

  /**
   * Queue a chunk for a session that hasn't been created yet.
   *
   * @param sessionId - The session identifier
   * @param base64Chunk - Audio data to queue
   * @returns true if queued, false if at capacity
   */
  enqueue(sessionId: string, base64Chunk: string): boolean {
    const q = this.buffers.get(sessionId) ?? []
    if (q.length >= this.maxPerSession) return false
    q.push(base64Chunk)
    this.buffers.set(sessionId, q)
    return true
  }

  /**
   * Drain all queued chunks for a session and remove from manager.
   *
   * @param sessionId - The session identifier
   * @returns Array of queued chunks (empty if none)
   */
  drain(sessionId: string): string[] {
    const chunks = this.buffers.get(sessionId) ?? []
    this.buffers.delete(sessionId)
    return chunks
  }

  /**
   * Check if there are queued chunks for a session.
   */
  has(sessionId: string): boolean {
    const q = this.buffers.get(sessionId)
    return !!q && q.length > 0
  }

  /**
   * Discard queued chunks for a session without returning them.
   */
  discard(sessionId: string): void {
    this.buffers.delete(sessionId)
  }

  /**
   * Remove all entries. Call on server shutdown.
   */
  clear(): void {
    this.buffers.clear()
  }

  /**
   * Number of sessions with queued audio.
   */
  get size(): number {
    return this.buffers.size
  }
}
