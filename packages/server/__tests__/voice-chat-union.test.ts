import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import type { RealtimeSession } from "../src/plugins/tokidapp/concierge/openai-realtime"

// ── Helpers (imported before any mocked modules) ──────────────

import {
  buildRealtimeContentItems,
  extractFileTexts,
  stripFileMetadata,
  scheduleRealtimeInjection,
} from "../src/server/routes/tokidapp"

// ── Mocked openai-realtime module ─────────────────────────────

const mockSessionForUser = mock<(sessionId: string) => RealtimeSession | undefined>(() => undefined)
const mockCancelResponse = mock<(sessionId: string) => void>((sessionId: string) => {
  const s = mockSessionForUser(sessionId)
  if (s) s.responseInProgress = false
})

mock.module("../src/plugins/tokidapp/concierge/openai-realtime", () => ({
  getRealtimeSessionForUser: (sessionId: string) => mockSessionForUser(sessionId),
  cancelRealtimeResponse: (sessionId: string) => mockCancelResponse(sessionId),
  getRealtimeSession: () => undefined,
  getRealtimeSessionVoice: () => undefined,
  ensureSingleUserSession: () => true,
  createRealtimeSession: () => ({ connected: false } as unknown as RealtimeSession),
  sendAudioChunk: () => true,
  commitAudioBuffer: () => true,
  resetInputAudio: () => {},
  hasEnoughInputAudio: () => false,
  clearAudioBuffer: () => false,
  endVoiceSession: () => {},
}))

// ── Tests ─────────────────────────────────────────────────────

describe("voice-chat-union content helpers", () => {
  test("extractFileTexts parses per-file extracted blocks", () => {
    const content = `[File attachment: report.pdf (url)]

Extracted file contents:
[report.pdf (application/pdf)]:
This is the extracted text.

[notes.txt (text/plain)]:
More text here.`

    const texts = extractFileTexts(content)
    expect(texts["report.pdf"]).toBe("This is the extracted text.")
    expect(texts["notes.txt"]).toBe("More text here.")
  })

  test("stripFileMetadata removes attachment header and extracted section", () => {
    const content = `[File attachment: img.png (url)]

Extracted file contents:
[img.png (image/png)]:
hello`

    expect(stripFileMetadata(content)).toBe("")
  })

  test("text-only message becomes a single input_text item", () => {
    const items = buildRealtimeContentItems("Hello assistant", [])
    expect(items).toEqual([{ type: "input_text", text: "Hello assistant" }])
  })

  test("image attachment becomes input_image with absolute proxy URL", () => {
    const items = buildRealtimeContentItems("[File attachment: pic.png (/proxy?blobUrl=abc)]", [
      { fileName: "pic.png", mimeType: "image/png", blobUrl: "blob:abc" },
    ])

    expect(items).toHaveLength(1)
    expect(items[0].type).toBe("input_image")
    const imageUrl = (items[0] as any).image_url as string
    expect(imageUrl).toContain("/api/tokidapp/files/proxy?blobUrl=blob%3Aabc")
  })

  test("PDF attachment becomes input_text with extracted content", () => {
    const content = `[File attachment: report.pdf (url)]

Extracted file contents:
[report.pdf (application/pdf)]:
This is the report.`

    const items = buildRealtimeContentItems(content, [
      { fileName: "report.pdf", mimeType: "application/pdf", blobUrl: "blob:pdf" },
    ])

    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      type: "input_text",
      text: "[report.pdf]\nThis is the report.",
    })
  })

  test("multiple files batch into one mixed content array", () => {
    const content = `[File attachment: a.png (url1), b.pdf (url2)]

Extracted file contents:
[b.pdf (application/pdf)]:
PDF text.`

    const items = buildRealtimeContentItems(content, [
      { fileName: "a.png", mimeType: "image/png", blobUrl: "blob:a" },
      { fileName: "b.pdf", mimeType: "application/pdf", blobUrl: "blob:b" },
    ])

    expect(items).toHaveLength(2)
    expect(items[0].type).toBe("input_image")
    expect(items[1]).toEqual({ type: "input_text", text: "[b.pdf]\nPDF text." })
  })

  test("image injection is limited to 3 images", () => {
    const attachments = Array.from({ length: 5 }, (_, i) => ({
      fileName: `img${i}.png`,
      mimeType: "image/png",
      blobUrl: `blob:${i}`,
    }))

    const items = buildRealtimeContentItems("", attachments)
    const images = items.filter((i) => i.type === "input_image")
    expect(images).toHaveLength(3)
  })
})

describe("voice-chat-union injection scheduling", () => {
  beforeEach(() => {
    mockSessionForUser.mockClear()
    mockCancelResponse.mockClear()
  })

  afterEach(() => {
    mockSessionForUser.mockClear()
    mockCancelResponse.mockClear()
  })

  test("injects text into active Realtime session after debounce", async () => {
    const sent: string[] = []
    const session = {
      connected: true,
      responseInProgress: false,
      ws: { send: (msg: string) => sent.push(msg) },
      pendingResponseQueue: [] as Array<() => void>,
    } as unknown as RealtimeSession

    mockSessionForUser.mockImplementation(() => session)

    scheduleRealtimeInjection("tokidapp_123", "hello", [])

    expect(sent).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 350))

    expect(sent).toHaveLength(2)
    const itemCreate = JSON.parse(sent[0])
    expect(itemCreate.type).toBe("conversation.item.create")
    expect(itemCreate.item.role).toBe("user")
    expect(itemCreate.item.content).toEqual([{ type: "input_text", text: "hello" }])

    const responseCreate = JSON.parse(sent[1])
    expect(responseCreate.type).toBe("response.create")
  })

  test("cancels current response before injecting when assistant is speaking", async () => {
    const sent: string[] = []
    const session = {
      connected: true,
      responseInProgress: true,
      ws: { send: (msg: string) => sent.push(msg) },
      pendingResponseQueue: [] as Array<() => void>,
    } as unknown as RealtimeSession

    mockSessionForUser.mockImplementation(() => session)

    scheduleRealtimeInjection("tokidapp_123", "interrupt", [])
    await new Promise((r) => setTimeout(r, 350))

    // Now sends cancel directly to WS instead of calling cancelRealtimeResponse
    expect(sent).toHaveLength(3)
    const cancelMsg = JSON.parse(sent[0])
    expect(cancelMsg.type).toBe("conversation.item.create")
    const cancelMsg2 = JSON.parse(sent[1])
    expect(cancelMsg2.type).toBe("response.cancel")
    const responseMsg = JSON.parse(sent[2])
    expect(responseMsg.type).toBe("response.create")
  })

  test("no injection when Realtime session is not connected", async () => {
    mockSessionForUser.mockImplementation(() => undefined)

    scheduleRealtimeInjection("tokidapp_123", "orphan", [])
    await new Promise((r) => setTimeout(r, 350))

    expect(mockCancelResponse).not.toHaveBeenCalled()
  })

  test("rapid inputs collapse to the latest message", async () => {
    const sent: string[] = []
    const session = {
      connected: true,
      responseInProgress: false,
      ws: { send: (msg: string) => sent.push(msg) },
      pendingResponseQueue: [] as Array<() => void>,
    } as unknown as RealtimeSession

    mockSessionForUser.mockImplementation(() => session)

    scheduleRealtimeInjection("tokidapp_123", "first", [])
    scheduleRealtimeInjection("tokidapp_123", "second", [])
    scheduleRealtimeInjection("tokidapp_123", "third", [])

    await new Promise((r) => setTimeout(r, 450))

    expect(sent).toHaveLength(2)
    const itemCreate = JSON.parse(sent[0])
    expect(itemCreate.item.content[0].text).toBe("third")
  })
})
