/**
 * Unified voice session-end hook — wiki + recording + idempotency.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test"

const updateWiki = mock(async () => "ok")
const createRecording = mock(async () => {})

mock.module("../codebase-tools", () => ({
  updateWikiFromSession: updateWiki,
}))

mock.module("../../../../lib/tokidapp-queries", () => ({
  createRecording,
}))

import {
  joinVoiceTranscript,
  onVoiceSessionEnd,
  resetVoiceSessionEndState,
} from "../voice-session-end"

describe("joinVoiceTranscript", () => {
  test("joins array lines", () => {
    expect(joinVoiceTranscript(["[user] hi", "[assistant] hello"])).toBe(
      "[user] hi\n[assistant] hello",
    )
  })

  test("trims a string", () => {
    expect(joinVoiceTranscript("  hello  ")).toBe("hello")
  })

  test("empty / null → empty string", () => {
    expect(joinVoiceTranscript(null)).toBe("")
    expect(joinVoiceTranscript(undefined)).toBe("")
    expect(joinVoiceTranscript([])).toBe("")
  })
})

describe("onVoiceSessionEnd", () => {
  beforeEach(() => {
    resetVoiceSessionEndState()
    updateWiki.mockClear()
    createRecording.mockClear()
  })

  test("writes wiki from transcript", () => {
    onVoiceSessionEnd({
      sessionId: "voice_a",
      engine: "openai",
      transcript: ["[user] hi", "[assistant] hello"],
    })
    expect(updateWiki).toHaveBeenCalledTimes(1)
    expect(updateWiki.mock.calls[0][0]).toBe("voice_a")
    expect(updateWiki.mock.calls[0][1]).toContain("[user] hi")
  })

  test("skips wiki when transcript is empty", () => {
    onVoiceSessionEnd({
      sessionId: "voice_empty",
      engine: "ornith",
      transcript: [],
    })
    expect(updateWiki).not.toHaveBeenCalled()
  })

  test("fallback reason skips wiki and recording", () => {
    onVoiceSessionEnd({
      sessionId: "voice_fb",
      engine: "openai",
      transcript: ["[user] hi"],
      chatSessionId: "chat_1",
      reason: "fallback",
    })
    expect(updateWiki).not.toHaveBeenCalled()
    expect(createRecording).not.toHaveBeenCalled()
  })

  test("wiki is idempotent per sessionId", () => {
    onVoiceSessionEnd({
      sessionId: "voice_once",
      engine: "openai",
      transcript: ["a"],
    })
    onVoiceSessionEnd({
      sessionId: "voice_once",
      engine: "deepgram",
      transcript: ["b"],
      reason: "socket-close",
    })
    expect(updateWiki).toHaveBeenCalledTimes(1)
  })

  test("creates recording metadata when chatSessionId is set", () => {
    onVoiceSessionEnd({
      sessionId: "voice_rec",
      engine: "deepgram",
      transcript: ["[user] hi"],
      chatSessionId: "tokidapp_1",
      userId: "user_1",
      durationMs: 12_000,
    })
    expect(createRecording).toHaveBeenCalledTimes(1)
    const arg = createRecording.mock.calls[0][0] as {
      sessionId: string
      userId?: string
      duration?: number
      status?: string
    }
    expect(arg.sessionId).toBe("tokidapp_1")
    expect(arg.userId).toBe("user_1")
    expect(arg.duration).toBe(12_000)
    expect(arg.status).toBe("voice-session")
  })

  test("recording is idempotent per sessionId", () => {
    onVoiceSessionEnd({
      sessionId: "voice_rec2",
      engine: "deepgram",
      chatSessionId: "chat_2",
    })
    onVoiceSessionEnd({
      sessionId: "voice_rec2",
      engine: "deepgram",
      chatSessionId: "chat_2",
    })
    expect(createRecording).toHaveBeenCalledTimes(1)
  })

  test("socket-close still writes wiki", () => {
    onVoiceSessionEnd({
      sessionId: "voice_close",
      engine: "local",
      transcript: "User: hi",
      reason: "socket-close",
    })
    expect(updateWiki).toHaveBeenCalledTimes(1)
  })
})
