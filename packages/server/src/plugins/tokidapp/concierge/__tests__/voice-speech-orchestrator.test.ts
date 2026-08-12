/**
 * Voice Speech Orchestrator — Unit Tests
 *
 * Tests engine routing, LLM fallback chain, and session management
 * for the unified VoiceSession interface.
 *
 * Acceptance Criteria:
 *   AC-S6-2: Engine routing dispatches correctly
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"

// ── Mock Dependencies ──────────────────────────────────────────

// Track which engine was used
let lastOpenAIArgs: any = null
let lastDeepgramArgs: any = null
let lastLocalSTTArgs: any = null
let lastLocalTTSArgs: any = null

mock.module("../openai-realtime", () => ({
  createRealtimeSession: mock((...args: any[]) => {
    lastOpenAIArgs = args
    return {
      connected: true,
      sessionId: args[0],
    }
  }),
  endVoiceSession: mock(() => {}),
}))

mock.module("../deepgram-realtime", () => ({
  createDeepgramSession: mock((args: any) => {
    lastDeepgramArgs = args
    return {
      connected: true,
      sessionId: args.sessionId,
      stt: {},
      tts: {},
      audioBuffer: { addChunk: () => {}, commit: () => {}, reset: () => {}, isEmpty: true },
      conversation: [],
      responseInProgress: false,
      pendingTextInjections: [],
      llmCallCount: 0,
      lastModelUsed: "none",
    }
  }),
  endDeepgramSession: mock(() => {}),
}))

mock.module("../local-stt", () => ({
  createLocalSTTConnection: mock((callbacks: any) => {
    lastLocalSTTArgs = callbacks
    return {
      sendAudio: mock(() => {}),
      close: mock(() => {}),
      isReady: true,
    }
  }),
}))

mock.module("../local-tts", () => ({
  createLocalTTSConnection: mock((voice: any, callbacks: any) => {
    lastLocalTTSArgs = { voice, callbacks }
    return {
      speak: mock(() => {}),
      flush: mock(() => {}),
      close: mock(() => {}),
      ready: true,
    }
  }),
}))

mock.module("../audio-buffer", () => ({
  AudioBuffer: mock(function (this: any, opts: any) {
    this.label = opts?.label
    this.minBytes = opts?.minBytes
    this.addChunk = mock(() => {})
    this.commit = mock(() => {})
    this.reset = mock(() => {})
    this.isEmpty = true
  }),
  PreSessionAudioManager: mock(function (this: any, max: number) {
    this.maxSize = max
    this.add = mock(() => {})
    this.drain = mock(() => [])
    this.clear = mock(() => {})
  }),
}))

mock.module("../speech-sanitize", () => ({
  sanitizeAsrText: mock((text: string) => text),
  sanitizeSpeechText: mock((text: string) => text),
  stripThinkingContent: mock((text: string) => text),
  isFillerTranscript: mock(() => false),
  VOICE_INSTRUCTIONS: "You are Star World Assistant.",
}))

mock.module("../voice-session-end", () => ({
  onVoiceSessionEnd: mock(() => {}),
}))

// ── Import After Mocks ─────────────────────────────────────────

import {
  createVoiceSession,
  createAndRegisterVoiceSession,
  getVoiceSession,
  endVoiceSession,
  getActiveVoiceSessionCount,
  hasActiveVoiceSession,
  isEngineAvailable,
  getAvailableEngines,
  buildProviderChain,
  callLLMWithFallback,
} from "../voice-speech-orchestrator"

// ── Tests ──────────────────────────────────────────────────────

describe("createVoiceSession — engine routing (AC-S6-2)", () => {
  beforeEach(() => {
    lastOpenAIArgs = null
    lastDeepgramArgs = null
    lastLocalSTTArgs = null
    lastLocalTTSArgs = null
  })

  test("engine: 'openai' routes to OpenAI Realtime", async () => {
    const session = await createVoiceSession({
      engine: "openai",
      sessionId: "voice_test_openai",
    })
    expect(session.engine).toBe("openai")
    expect(session.sessionId).toBe("voice_test_openai")
    expect(lastOpenAIArgs).not.toBeNull()
    expect(lastOpenAIArgs[0]).toBe("voice_test_openai")
  })

  test("engine: 'local' routes to whisper-stt + local-tts", async () => {
    const session = await createVoiceSession({
      engine: "local",
      sessionId: "voice_test_local",
    })
    expect(session.engine).toBe("local")
    expect(session.sessionId).toBe("voice_test_local")
    expect(lastLocalSTTArgs).not.toBeNull()
    expect(lastLocalTTSArgs).not.toBeNull()
  })

  test("engine: 'deepgram' routes to Deepgram Realtime", async () => {
    const session = await createVoiceSession({
      engine: "deepgram",
      sessionId: "voice_test_deepgram",
    })
    expect(session.engine).toBe("deepgram")
    expect(session.sessionId).toBe("voice_test_deepgram")
    expect(lastDeepgramArgs).not.toBeNull()
    expect(lastDeepgramArgs.sessionId).toBe("voice_test_deepgram")
  })

  test("unknown engine throws error", async () => {
    await expect(
      createVoiceSession({
        engine: "unknown" as any,
        sessionId: "voice_test_bad",
      }),
    ).rejects.toThrow("Unknown engine")
  })
})

describe("VoiceSession — unified interface", () => {
  test("openai session has all VoiceSession methods", async () => {
    const session = await createVoiceSession({
      engine: "openai",
      sessionId: "voice_iface_openai",
    })
    expect(typeof session.sendAudio).toBe("function")
    expect(typeof session.speak).toBe("function")
    expect(typeof session.stop).toBe("function")
    expect(typeof session.destroy).toBe("function")
    expect(typeof session.onTranscript).toBe("function")
    expect(typeof session.onResponse).toBe("function")
    expect(typeof session.onAudio).toBe("function")
    expect(typeof session.onCommand).toBe("function")
    expect(typeof session.onStatus).toBe("function")
    expect(typeof session.onError).toBe("function")
  })

  test("local session has all VoiceSession methods", async () => {
    const session = await createVoiceSession({
      engine: "local",
      sessionId: "voice_iface_local",
    })
    expect(typeof session.sendAudio).toBe("function")
    expect(typeof session.speak).toBe("function")
    expect(typeof session.stop).toBe("function")
    expect(typeof session.destroy).toBe("function")
  })

  test("deepgram session has all VoiceSession methods", async () => {
    const session = await createVoiceSession({
      engine: "deepgram",
      sessionId: "voice_iface_deepgram",
    })
    expect(typeof session.sendAudio).toBe("function")
    expect(typeof session.speak).toBe("function")
    expect(typeof session.stop).toBe("function")
    expect(typeof session.destroy).toBe("function")
  })
})

describe("session management", () => {
  beforeEach(() => {
    lastOpenAIArgs = null
    lastDeepgramArgs = null
    lastLocalSTTArgs = null
    lastLocalTTSArgs = null
  })

  test("createAndRegisterVoiceSession registers and returns session", async () => {
    const session = await createAndRegisterVoiceSession({
      engine: "openai",
      sessionId: "voice_reg_1",
    })
    expect(session).toBeDefined()
    expect(getVoiceSession("voice_reg_1")).toBe(session)
    endVoiceSession("voice_reg_1")
  })

  test("endVoiceSession destroys and removes session", async () => {
    await createAndRegisterVoiceSession({
      engine: "openai",
      sessionId: "voice_end_1",
    })
    expect(hasActiveVoiceSession("voice_end_1")).toBe(true)
    endVoiceSession("voice_end_1")
    expect(getVoiceSession("voice_end_1")).toBeUndefined()
  })

  test("getActiveVoiceSessionCount tracks sessions", async () => {
    const initial = getActiveVoiceSessionCount()
    await createAndRegisterVoiceSession({
      engine: "openai",
      sessionId: "voice_count_a",
    })
    await createAndRegisterVoiceSession({
      engine: "deepgram",
      sessionId: "voice_count_b",
    })
    expect(getActiveVoiceSessionCount()).toBeGreaterThanOrEqual(initial + 2)
    endVoiceSession("voice_count_a")
    endVoiceSession("voice_count_b")
  })

  test("replacing session with same ID destroys old one", async () => {
    await createAndRegisterVoiceSession({
      engine: "openai",
      sessionId: "voice_dup",
    })
    const second = await createAndRegisterVoiceSession({
      engine: "deepgram",
      sessionId: "voice_dup",
    })
    expect(second.engine).toBe("deepgram")
    endVoiceSession("voice_dup")
  })
})

describe("isEngineAvailable", () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...origEnv }
  })

  test("openai available when OPENAI_API_KEY set", () => {
    process.env.OPENAI_API_KEY = "sk-test"
    expect(isEngineAvailable("openai")).toBe(true)
  })

  test("openai unavailable when OPENAI_API_KEY missing", () => {
    delete process.env.OPENAI_API_KEY
    expect(isEngineAvailable("openai")).toBe(false)
  })

  test("deepgram available when DEEPGRAM_ENABLED=true and key set", () => {
    process.env.DEEPGRAM_ENABLED = "true"
    process.env.DEEPGRAM_API_KEY = "dg-test"
    expect(isEngineAvailable("deepgram")).toBe(true)
  })

  test("deepgram unavailable when DEEPGRAM_ENABLED not true", () => {
    delete process.env.DEEPGRAM_ENABLED
    process.env.DEEPGRAM_API_KEY = "dg-test"
    expect(isEngineAvailable("deepgram")).toBe(false)
  })

  test("local always available (on-device)", () => {
    expect(isEngineAvailable("local")).toBe(true)
  })
})

describe("getAvailableEngines", () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...origEnv }
  })

  test("returns local when no API keys configured", () => {
    delete process.env.OPENAI_API_KEY
    delete process.env.DEEPGRAM_API_KEY
    delete process.env.DEEPGRAM_ENABLED
    const engines = getAvailableEngines()
    expect(engines).toContain("local")
  })

  test("returns openai + local when OPENAI_API_KEY set", () => {
    process.env.OPENAI_API_KEY = "sk-test"
    delete process.env.DEEPGRAM_API_KEY
    delete process.env.DEEPGRAM_ENABLED
    const engines = getAvailableEngines()
    expect(engines).toContain("openai")
    expect(engines).toContain("local")
    expect(engines).not.toContain("deepgram")
  })
})

describe("buildProviderChain", () => {
  test("returns at least 2 providers (ollama primary + fallback)", () => {
    const chain = buildProviderChain()
    expect(chain.length).toBeGreaterThanOrEqual(2)
    expect(chain[0].name).toBe("ollama-primary")
    expect(chain[1].name).toBe("ollama-fallback")
  })

  test("includes cloud provider when OPENAI_API_KEY is set", () => {
    const origKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-test"
    const chain = buildProviderChain()
    const cloud = chain.find((p) => p.name === "cloud-openai")
    expect(cloud).toBeDefined()
    expect(cloud!.model).toBe("gpt-4o-mini")
    process.env.OPENAI_API_KEY = origKey
  })

  test("chain always has at least 2 ollama providers", () => {
    const chain = buildProviderChain()
    const ollamaPrimary = chain.find((p) => p.name === "ollama-primary")
    const ollamaFallback = chain.find((p) => p.name === "ollama-fallback")
    expect(ollamaPrimary).toBeDefined()
    expect(ollamaFallback).toBeDefined()
    expect(ollamaPrimary!.model.length).toBeGreaterThan(0)
    expect(ollamaFallback!.model.length).toBeGreaterThan(0)
  })

  test("cloud provider uses gpt-4o-mini model when present", () => {
    const chain = buildProviderChain()
    const cloud = chain.find((p) => p.name === "cloud-openai")
    // Cloud may or may not be present depending on env at module load time
    if (cloud) {
      expect(cloud.model).toBe("gpt-4o-mini")
      expect(cloud.baseUrl).toContain("openai.com")
    }
  })
})

describe("callLLMWithFallback", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("returns graceful error when all providers fail", async () => {
    globalThis.fetch = mock(async () => {
      throw Object.assign(new Error("all down"), { name: "AbortError" })
    })

    const response = await callLLMWithFallback([{ role: "user", content: "test" }])
    expect(response.content).toContain("trouble connecting")
    expect(response.model).toBe("none")
    expect(response.toolCalls).toEqual([])
  })

  test("returns first successful response", async () => {
    let callCount = 0
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      callCount++
      const urlStr = typeof url === "string" ? url : url.toString()
      if (urlStr.includes("11434")) {
        throw Object.assign(new Error("timeout"), { name: "AbortError" })
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Hello from cloud!", tool_calls: null } }],
        }),
        { status: 200 }
      )
    })

    const response = await callLLMWithFallback([{ role: "user", content: "test" }])
    expect(response.content).toBe("Hello from cloud!")
    expect(response.model).toBe("gpt-4o-mini")
  })
})
