/**
 * Unified voice session-start hook — opening the accounting row.
 *
 * The invariant worth protecting: a voice conversation never fails to start
 * because the row could not be written. Everything else here is attribution.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test"

const createAgentSession = mock(async (data: { id: string }) => data.id)

mock.module("../../../../lib/tokidapp-queries", () => ({
  createAgentSession,
}))

import { openVoiceAgentSession } from "../voice-session-start"

describe("openVoiceAgentSession", () => {
  beforeEach(() => {
    createAgentSession.mockClear()
  })

  test("opens a row against the chat session", async () => {
    const id = await openVoiceAgentSession({
      chatSessionId: "tokidapp_1",
      engine: "openai",
      model: "gpt-realtime-2",
    })

    expect(createAgentSession).toHaveBeenCalledTimes(1)
    const arg = createAgentSession.mock.calls[0][0] as Record<string, unknown>
    expect(arg.tokidappSessionId).toBe("tokidapp_1")
    expect(arg.agentType).toBe("FULL_CONCIERGE")
    expect(arg.provider).toBe("openai")
    expect(arg.model).toBe("gpt-realtime-2")
    expect(id).toBe(arg.id as string)
  })

  test("maps each engine to its provider", async () => {
    const seen: Record<string, unknown> = {}
    for (const engine of ["openai", "deepgram", "ornith", "local"] as const) {
      createAgentSession.mockClear()
      await openVoiceAgentSession({ chatSessionId: "c", engine })
      seen[engine] = (createAgentSession.mock.calls[0][0] as Record<string, unknown>).provider
    }
    // ornith and local both run on Ollama — the engine is the transport, not the provider.
    expect(seen).toEqual({
      openai: "openai",
      deepgram: "deepgram",
      ornith: "ollama",
      local: "ollama",
    })
  })

  test("no chat session means nothing to attribute to — no row, no throw", async () => {
    expect(await openVoiceAgentSession({ engine: "openai" })).toBeNull()
    expect(await openVoiceAgentSession({ chatSessionId: "", engine: "local" })).toBeNull()
    expect(await openVoiceAgentSession({ chatSessionId: "   ", engine: "ornith" })).toBeNull()
    expect(createAgentSession).not.toHaveBeenCalled()
  })

  test("row ids are unique across concurrent sessions", async () => {
    const ids = await Promise.all(
      Array.from({ length: 50 }, () =>
        openVoiceAgentSession({ chatSessionId: "c", engine: "deepgram" }),
      ),
    )
    expect(new Set(ids).size).toBe(50)
  })

  test("a failed write yields null rather than breaking the call", async () => {
    createAgentSession.mockImplementationOnce(async () => null as never)
    expect(await openVoiceAgentSession({ chatSessionId: "c", engine: "openai" })).toBeNull()
  })

  test("model is omitted when the engine picks one per turn", async () => {
    await openVoiceAgentSession({ chatSessionId: "c", engine: "deepgram" })
    const arg = createAgentSession.mock.calls[0][0] as Record<string, unknown>
    expect(arg.model).toBeNull()
  })
})
