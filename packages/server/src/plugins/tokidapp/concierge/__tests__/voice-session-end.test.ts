/**
 * Unified voice session-end hook — wiki + recording + idempotency.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test"

const updateWiki = mock(async () => "ok")
const createRecording = mock(async () => {})
const endAgentSession = mock(async () => {})

mock.module("../codebase-tools", () => ({
  updateWikiFromSession: updateWiki,
}))

mock.module("../../../../lib/tokidapp-queries", () => ({
  createRecording,
  endAgentSession,
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
    endAgentSession.mockClear()
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
      durationMs?: number
      mimeType?: string
    }
    expect(arg.sessionId).toBe("tokidapp_1")
    expect(arg.userId).toBe("user_1")
    // Field names are the real column names. They previously read `duration`
    // and `format`/`status`, which the table has no columns for — every insert
    // raised 42703 and the caller's catch swallowed it.
    expect(arg.durationMs).toBe(12_000)
    expect(arg.mimeType).toBe("audio/pcm")
    expect(arg).not.toHaveProperty("status")
    expect(arg).not.toHaveProperty("duration")
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

/**
 * The agent-session row is what per-session settlement prices. Leaving it open
 * makes a finished session look live and its usage rows unsettleable.
 */
describe("onVoiceSessionEnd — agent session close", () => {
  beforeEach(() => {
    resetVoiceSessionEndState()
    updateWiki.mockClear()
    createRecording.mockClear()
    endAgentSession.mockClear()
  })

  test("closes the agent session and forwards audio milliseconds", () => {
    onVoiceSessionEnd({
      sessionId: "voice_a1",
      engine: "openai",
      agentSessionId: "agent_1",
      audioInputMs: 3100,
      audioOutputMs: 900,
    })
    expect(endAgentSession).toHaveBeenCalledTimes(1)
    expect(endAgentSession.mock.calls[0]).toEqual([
      "agent_1",
      { audioInputMs: 3100, audioOutputMs: 900 },
    ] as never)
  })

  test("closes on socket-close too — a dropped tab still ends the session", () => {
    onVoiceSessionEnd({
      sessionId: "voice_a2",
      engine: "deepgram",
      agentSessionId: "agent_2",
      reason: "socket-close",
    })
    expect(endAgentSession).toHaveBeenCalledTimes(1)
  })

  test("a fallback is not an end — the session continues on another engine", () => {
    onVoiceSessionEnd({
      sessionId: "voice_a3",
      engine: "ornith",
      agentSessionId: "agent_3",
      reason: "fallback",
    })
    expect(endAgentSession).not.toHaveBeenCalled()
  })

  test("idempotent per agentSessionId across repeated teardowns", () => {
    for (let i = 0; i < 3; i++) {
      onVoiceSessionEnd({
        sessionId: `voice_a4_${i}`,
        engine: "local",
        agentSessionId: "agent_4",
      })
    }
    expect(endAgentSession).toHaveBeenCalledTimes(1)
  })

  test("no agentSessionId is a no-op, not a crash", () => {
    onVoiceSessionEnd({ sessionId: "voice_a5", engine: "openai" })
    expect(endAgentSession).not.toHaveBeenCalled()
  })
})
