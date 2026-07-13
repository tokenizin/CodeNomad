/**
 * Whisper STT — Unit Tests
 *
 * Tests whisper.cpp WebSocket connection lifecycle, audio sending,
 * batch transcription, and error handling.
 *
 * Acceptance Criteria:
 *   AC-S6-3: Session lifecycle events fire correctly
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"

// ── Mock WebSocket ──────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3

  readyState = 0
  url: string
  options: any
  listeners: Record<string, Function[]> = {}
  sentMessages: any[] = []

  constructor(url: string, options?: any) {
    this.url = url
    this.options = options
    MockWebSocket.instances.push(this)
  }

  addEventListener(event: string, cb: Function) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(cb)
  }

  send(data: any) {
    this.sentMessages.push(data)
  }

  close(code?: number) {
    this.readyState = MockWebSocket.CLOSED
    this.emit("close", { code: code ?? 1000 })
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this.emit("open", {})
  }

  simulateMessage(data: any) {
    this.emit("message", { data: typeof data === "string" ? data : JSON.stringify(data) })
  }

  simulateError(message: string) {
    this.emit("error", { message })
  }

  simulateClose(code: number) {
    this.readyState = MockWebSocket.CLOSED
    this.emit("close", { code })
  }

  emit(event: string, ...args: any[]) {
    for (const cb of this.listeners[event] || []) cb(...args)
  }

  static reset() {
    MockWebSocket.instances = []
  }
}

mock.module("ws", () => ({
  default: MockWebSocket,
  __esModule: true,
}))

// ── Mock fetch for batch transcription ──────────────────────────

const originalFetch = globalThis.fetch

// ── Import After Mocks ─────────────────────────────────────────

import {
  createWhisperSTTConnection,
  batchTranscribe,
  checkHealth,
} from "../whisper-stt"

// ── Tests ──────────────────────────────────────────────────────

describe("createWhisperSTTConnection — lifecycle (AC-S6-3)", () => {
  beforeEach(() => {
    MockWebSocket.reset()
  })

  afterEach(() => {
    // Clean up any open connections
    for (const ws of MockWebSocket.instances) {
      if (ws.readyState === MockWebSocket.OPEN) ws.close()
    }
  })

  test("returns a WhisperSTTConnection handle", () => {
    const conn = createWhisperSTTConnection()
    expect(conn).toBeDefined()
    expect(typeof conn.sendAudio).toBe("function")
    expect(typeof conn.transcribe).toBe("function")
    expect(typeof conn.close).toBe("function")
    expect(typeof conn.isReady).toBe("boolean")
    expect(typeof conn.isClosed).toBe("boolean")
  })

  test("connects to whisper server WebSocket", () => {
    createWhisperSTTConnection()
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1)
    const ws = MockWebSocket.instances[0]
    expect(ws.url).toContain("/stream")
  })

  test("fires onReady when WebSocket opens", () => {
    let readyFired = false
    const conn = createWhisperSTTConnection({
      onReady: () => { readyFired = true },
    })

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    expect(readyFired).toBe(true)
    expect(conn.isReady).toBe(true)
    conn.close()
  })

  test("fires onTranscript with final transcript", () => {
    const transcripts: Array<{ text: string; isFinal: boolean }> = []
    const conn = createWhisperSTTConnection({
      onTranscript: (text, isFinal) => transcripts.push({ text, isFinal }),
    })

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ text: "hello world", is_final: true })

    expect(transcripts.length).toBeGreaterThanOrEqual(1)
    expect(transcripts.some((t) => t.text === "hello world" && t.isFinal === true)).toBe(true)
    conn.close()
  })

  test("fires onTranscript with partial transcript", () => {
    const transcripts: Array<{ text: string; isFinal: boolean }> = []
    const conn = createWhisperSTTConnection({
      onTranscript: (text, isFinal) => transcripts.push({ text, isFinal }),
    })

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ text: "hello", is_final: false })

    expect(transcripts.some((t) => t.text === "hello" && t.isFinal === false)).toBe(true)
    conn.close()
  })

  test("fires onUtteranceEnd on VAD event", () => {
    let utteranceEndFired = false
    const conn = createWhisperSTTConnection({
      onUtteranceEnd: () => { utteranceEndFired = true },
    })

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateMessage({ type: "vad" })

    expect(utteranceEndFired).toBe(true)
    conn.close()
  })

  test("fires onClose when WebSocket closes", () => {
    let closeCode: number | undefined
    const conn = createWhisperSTTConnection({
      onClose: (code) => { closeCode = code },
    })

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateClose(1000)

    expect(closeCode).toBe(1000)
  })

  test("isClosed becomes true after close()", () => {
    const conn = createWhisperSTTConnection()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    expect(conn.isClosed).toBe(false)
    conn.close()
    expect(conn.isClosed).toBe(true)
  })
})

describe("sendAudio", () => {
  beforeEach(() => MockWebSocket.reset())

  test("sends audio chunk when connection is open", () => {
    const conn = createWhisperSTTConnection()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()

    conn.sendAudio(Buffer.from("fake-audio"))
    expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1)
    conn.close()
  })

  test("drops audio when connection is closed", () => {
    const conn = createWhisperSTTConnection()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    conn.close()

    // Should not throw, just warn
    conn.sendAudio(Buffer.from("dropped"))
  })
})

describe("error handling", () => {
  beforeEach(() => MockWebSocket.reset())

  test("fires onError on WebSocket error", () => {
    const errors: string[] = []
    const conn = createWhisperSTTConnection({
      onError: (err) => errors.push(err.message),
    })

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    ws.simulateError("connection lost")

    expect(errors.length).toBeGreaterThanOrEqual(1)
    conn.close()
  })
})

describe("batchTranscribe", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("sends multipart POST and returns transcription", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({ text: "batch transcription result", language: "en" }),
        { status: 200 }
      )
    })

    const result = await batchTranscribe(
      "http://127.0.0.1:8090",
      Buffer.from("fake-audio-data"),
      "large-v3",
      "en"
    )

    expect(result.text).toBe("batch transcription result")
    expect(result.language).toBe("en")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("throws on HTTP error", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("server error", { status: 500 })
    })

    try {
      await batchTranscribe("http://127.0.0.1:8090", Buffer.from("data"))
      expect(true).toBe(false) // Should not reach
    } catch (err) {
      expect((err as Error).message).toContain("500")
    }
  })
})

describe("checkHealth", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("returns health status from whisper server", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({ status: "ok", model: "large-v3", cores: 8 }),
        { status: 200 }
      )
    })

    const status = await checkHealth("http://127.0.0.1:8090")
    expect(status.status).toBe("ok")
    expect(status.model).toBe("large-v3")
    expect(status.cores).toBe(8)
  })

  test("throws on non-200 response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("not found", { status: 404 })
    })

    try {
      await checkHealth("http://127.0.0.1:8090")
      expect(true).toBe(false)
    } catch (err) {
      expect((err as Error).message).toContain("404")
    }
  })
})
