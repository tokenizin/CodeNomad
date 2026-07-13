/**
 * Local TTS (Piper) — Unit Tests
 *
 * Tests Piper TTS connection lifecycle, sentence splitting,
 * audio generation, and process management.
 *
 * Acceptance Criteria:
 *   AC-S6-4: TTS generation and fallback work
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"

// ── Mock ChildProcess ──────────────────────────────────────────

class MockChildProcess {
  static instances: MockChildProcess[] = []

  pid = Math.floor(Math.random() * 10000)
  killed = false
  stdin: any
  stdout: any
  stderr: any
  listeners: Record<string, Function[]> = {}

  constructor() {
    MockChildProcess.instances.push(this)

    this.stdin = {
      writable: true,
      write: mock(() => true),
      end: mock(() => {}),
    }

    this.stdout = {
      setEncoding: mock(() => {}),
      on: mock((event: string, cb: Function) => {
        if (!this.stdout._listeners) this.stdout._listeners = {}
        if (!this.stdout._listeners[event]) this.stdout._listeners[event] = []
        this.stdout._listeners[event].push(cb)
      }),
      _listeners: {} as Record<string, Function[]>,
    }

    this.stderr = {
      setEncoding: mock(() => {}),
      on: mock(() => {}),
    }
  }

  on(event: string, cb: Function) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(cb)
  }

  emit(event: string, ...args: any[]) {
    for (const cb of this.listeners[event] || []) cb(...args)
  }

  kill(signal?: string) {
    this.killed = true
  }

  simulateStdoutLine(line: string) {
    const listeners = this.stdout._listeners?.["data"] || []
    for (const cb of listeners) cb(line + "\n")
  }

  simulateClose(code: number) {
    this.emit("close", code)
  }

  simulateError(message: string) {
    this.emit("error", new Error(message))
  }

  static reset() {
    MockChildProcess.instances = []
  }
}

mock.module("node:child_process", () => ({
  spawn: mock((...args: any[]) => new MockChildProcess()),
}))

// ── Import After Mocks ─────────────────────────────────────────

import { createLocalTTSConnection, splitSentences } from "../local-tts"

// ── Tests ──────────────────────────────────────────────────────

describe("splitSentences", () => {
  test("splits at period boundaries", () => {
    const result = splitSentences("Hello world. How are you?")
    expect(result).toEqual(["Hello world.", "How are you?"])
  })

  test("splits at exclamation", () => {
    const result = splitSentences("Stop! Wait there.")
    expect(result).toEqual(["Stop!", "Wait there."])
  })

  test("splits at semicolon", () => {
    const result = splitSentences("First part; second part.")
    expect(result).toEqual(["First part;", "second part."])
  })

  test("returns single sentence when no delimiters", () => {
    const result = splitSentences("Just one sentence")
    expect(result).toEqual(["Just one sentence"])
  })

  test("handles empty string", () => {
    const result = splitSentences("")
    expect(result).toEqual([""])
  })

  test("trims whitespace from sentences", () => {
    const result = splitSentences("Hello.   World!  ")
    expect(result).toEqual(["Hello.", "World!"])
  })
})

describe("createLocalTTSConnection — lifecycle (AC-S6-4)", () => {
  beforeEach(() => {
    MockChildProcess.instances = []
  })

  afterEach(() => {
    // Close all open connections
    for (const proc of MockChildProcess.instances) {
      if (!proc.killed) proc.kill()
    }
  })

  test("returns a LocalTTSConnection handle", () => {
    const conn = createLocalTTSConnection()
    expect(conn).toBeDefined()
    expect(typeof conn.speak).toBe("function")
    expect(typeof conn.flush).toBe("function")
    expect(typeof conn.close).toBe("function")
    expect(typeof conn.ready).toBe("boolean")
  })

  test("spawns python3 child process", () => {
    createLocalTTSConnection()
    expect(MockChildProcess.instances.length).toBeGreaterThanOrEqual(1)
  })

  test("ready becomes true after 'ready' message", () => {
    const conn = createLocalTTSConnection()
    const proc = MockChildProcess.instances[0]

    expect(conn.ready).toBe(false)
    proc.simulateStdoutLine(JSON.stringify({ type: "ready" }))
    expect(conn.ready).toBe(true)
    conn.close()
  })

  test("fires onFlushed when 'flushed' message received", () => {
    let flushed = false
    const conn = createLocalTTSConnection(undefined, {
      onFlushed: () => { flushed = true },
    })

    const proc = MockChildProcess.instances[0]
    proc.simulateStdoutLine(JSON.stringify({ type: "flushed" }))
    expect(flushed).toBe(true)
    conn.close()
  })

  test("fires onError when 'error' message received", () => {
    const errors: string[] = []
    const conn = createLocalTTSConnection(undefined, {
      onError: (err) => errors.push(err.message),
    })

    const proc = MockChildProcess.instances[0]
    proc.simulateStdoutLine(JSON.stringify({ type: "error", message: "synthesis failed" }))
    expect(errors).toContain("synthesis failed")
    conn.close()
  })

  test("fires onAudio when audio chunk received", () => {
    const audioChunks: string[] = []
    const conn = createLocalTTSConnection(undefined, {
      onAudio: (chunk) => audioChunks.push(chunk),
    })

    const proc = MockChildProcess.instances[0]
    proc.simulateStdoutLine(JSON.stringify({ audio: "base64-audio-data" }))
    expect(audioChunks).toContain("base64-audio-data")
    conn.close()
  })
})

describe("speak", () => {
  beforeEach(() => MockChildProcess.instances = [])

  test("sends text to python process stdin", () => {
    const conn = createLocalTTSConnection()
    const proc = MockChildProcess.instances[0]

    conn.speak("Hello world")
    expect(proc.stdin.write).toHaveBeenCalled()
    conn.close()
  })

  test("splits multi-sentence text into multiple requests", () => {
    const conn = createLocalTTSConnection()
    const proc = MockChildProcess.instances[0]

    conn.speak("First sentence. Second sentence.")
    // Should be called at least 2 times (one per sentence)
    expect(proc.stdin.write.mock.calls.length).toBeGreaterThanOrEqual(2)
    conn.close()
  })

  test("does not send empty text", () => {
    const conn = createLocalTTSConnection()
    const proc = MockChildProcess.instances[0]

    conn.speak("   ")
    expect(proc.stdin.write).not.toHaveBeenCalled()
    conn.close()
  })
})

describe("flush", () => {
  beforeEach(() => MockChildProcess.instances = [])

  test("sends flush signal to python process", () => {
    const conn = createLocalTTSConnection()
    const proc = MockChildProcess.instances[0]

    conn.flush()
    expect(proc.stdin.write).toHaveBeenCalled()
    conn.close()
  })
})

describe("close", () => {
  beforeEach(() => MockChildProcess.instances = [])

  test("kills the python process", () => {
    const conn = createLocalTTSConnection()
    const proc = MockChildProcess.instances[0]

    conn.close()
    expect(proc.killed).toBe(true)
  })

  test("sets ready to false", () => {
    const conn = createLocalTTSConnection()
    const proc = MockChildProcess.instances[0]
    proc.simulateStdoutLine(JSON.stringify({ type: "ready" }))

    conn.close()
    expect(conn.ready).toBe(false)
  })

  test("is safe to call twice (idempotent)", () => {
    const conn = createLocalTTSConnection()
    conn.close()
    conn.close() // Should not throw
  })
})

describe("error handling", () => {
  beforeEach(() => MockChildProcess.instances = [])

  test("fires onError on process error", () => {
    const errors: string[] = []
    const conn = createLocalTTSConnection(undefined, {
      onError: (err) => errors.push(err.message),
    })

    const proc = MockChildProcess.instances[0]
    proc.simulateError("spawn failed")

    expect(errors.length).toBeGreaterThanOrEqual(1)
  })

  test("fires onClose when process exits", () => {
    let closeCode: number | undefined
    const conn = createLocalTTSConnection(undefined, {
      onClose: (code) => { closeCode = code },
    })

    const proc = MockChildProcess.instances[0]
    proc.simulateClose(0)

    expect(closeCode).toBe(0)
  })
})
