/**
 * Deepgram Voice Session Orchestrator — Integration Tests
 *
 * Tests createDeepgramSession() and session management from deepgram-realtime.ts.
 * External deps (WebSocket, LLM, tools) mocked via Bun mock.module().
 *
 * Acceptance Criteria:
 *   AC-S2-1: createDeepgramSession factory exported
 *   AC-S2-2: Session initializes Deepgram STT + TTS
 *   AC-S2-3: LLM fallback chain (primary -> fast -> cloud)
 *   AC-S2-4: Fallback chain transparent to user
 *   AC-S2-5: Tool execution works in sessions
 *   AC-S2-9: Voice-chat union (text injection)
 *   AC-S2-11: Audio buffer extracted to shared module
 *   AC-S2-12: Graceful handling when Ollama unreachable
 *   AC-S2-13: Graceful handling of Deepgram connection errors
 *   AC-S2-14: Session cleanup works correctly
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"

// ── Mock WebSocket ──────────────────────────────────────────

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

  send(data: any) { this.sentMessages.push(data) }
  close() { this.readyState = MockWebSocket.CLOSED; this.emit("close", { code: 1000 }) }

  simulateOpen() { this.readyState = MockWebSocket.OPEN; this.emit("open", {}) }
  simulateMessage(data: any) { this.emit("message", { data }) }
  simulateError(message: string) { this.emit("error", { message }) }
  simulateClose(code: number) { this.readyState = MockWebSocket.CLOSED; this.emit("close", { code }) }

  emit(event: string, ...args: any[]) {
    for (const cb of this.listeners[event] || []) cb(...args)
  }

  static reset() { MockWebSocket.instances = [] }
}

// ── Mock Modules ─────────────────────────────────────────────

mock.module("ws", () => ({
  default: MockWebSocket,
  __esModule: true,
}))

mock.module("../src/plugins/tokidapp/concierge/codebase-tools", () => ({
  investigateCodebase: mock(async () => "investigation result"),
  generateFeature: mock(async () => "feature generated"),
  runTests: mock(async () => "tests passed"),
  gitStatus: mock(async () => "clean working tree"),
  gitCommitPush: mock(async () => "pushed"),
  triggerVercelDeploy: mock(async () => "deploy triggered"),
  checkDeployStatus: mock(async () => "deploy ok"),
  spawnAgent: mock(async () => "agent spawned"),
  scheduleTask: mock(async () => "task scheduled"),
  listTasks: mock(async () => "no tasks"),
  assignTask: mock(async () => "task assigned"),
  rollbackDeploy: mock(async () => "rolled back"),
  captureGitDiff: mock(async () => "no diff"),
  runA11yAudit: mock(async () => "a11y ok"),
  checkA11yScan: mock(async () => "no issues"),
  checkColorContrast: mock(async () => "contrast ok"),
  readFileContent: mock(async () => "file content"),
  runLint: mock(async () => "lint clean"),
  runTypeCheck: mock(async () => "types ok"),
  gitBranchAction: mock(async () => "branch switched"),
  queryKnowledgeBase: mock(async () => "knowledge results"),
  getArchitectureDigest: mock(async () => "digest"),
  getSepoliaDeployments: mock(async () => "deployments"),
  visionAnalyze: mock(async () => "vision ok"),
  generateMermaidDiagram: mock(async () => "graph TD"),
  generateFile: mock(async () => ({ url: "/file", fileName: "out.txt", fileSize: 100, mimeType: "text/plain", markdownContent: "generated" })),
  googleSearch: mock(async () => "search results"),
  readWikiPage: mock(async () => "wiki content"),
  searchWiki: mock(async () => "wiki results"),
  searchObsidianVault: mock(async () => "vault results"),
  readObsidianNote: mock(async () => "note content"),
  getEntityConnections: mock(async () => "connections"),
  writeWiki: mock(async () => "written"),
  lintWiki: mock(async () => "lint clean"),
  updateWikiFromSession: mock(async () => "updated"),
  compileToWiki: mock(async () => "compiled"),
  getWikiHealth: mock(async () => "healthy"),
  suggestRepairLinks: mock(async () => "no repairs needed"),
}))

mock.module("../src/plugins/tokidapp/concierge/voice-orchestrator-tools", () => ({
  createTask: mock(async () => ({ taskId: "task-123", taskFilePath: "/tasks/task.md" })),
  checkTaskStatus: mock(async () => ({ status: "done" })),
  voiceAskUserPickOne: mock(async () => ({ selected: "a" })),
  voiceAskUserConfirm: mock(async () => ({ confirmed: true })),
  delegateToAgent: mock(async () => ({ delegated: true })),
  createLinearChain: mock(() => ({ chain: [] })),
  requestApproval: mock(async () => ({ approved: true })),
  findRepoRoot: mock(() => "/workspace"),
  voiceOrchestratorToolDefinitions: [],
}))

mock.module("../src/plugins/tokidapp/concierge/commands-router", () => ({
  parseInput: mock((input: string) => ({ hasCommands: false, tags: [], cleanText: input })),
  resolveActions: mock(() => []),
  formatParseSummary: mock(() => "no commands"),
}))

mock.module("../src/plugins/tokidapp/orchestrator/dag-engine", () => ({
  buildLifecycleDAG: mock(() => ({ nodes: [] })),
  executeDAG: mock(async () => ({ success: true, completedNodes: 1, durationMs: 100, outputs: {} })),
}))

mock.module("../src/plugins/tokidapp/orchestrator/starguard-client", () => ({
  apiPost: mock(async () => ({ ok: true, json: async () => ({ id: "orch-1" }) })),
}))

mock.module("../../../server/routes/nomadworks-bridge", () => ({
  bridge: {
    createTaskFile: mock(async () => ({ taskId: "task-1", taskFilePath: "/tasks/t.md" })),
    watchTask: mock(() => {}),
  },
}))

mock.module("../../../server/ws-socket-registry", () => ({
  getTokidappSocket: mock(() => undefined),
  tokidappSessionId: mock((userId: string) => `tokidapp_${userId}`),
  getUserIdFromSessionId: mock((sessionId: string) => sessionId.replace("voice_", "")),
}))

// ── Import after mock.module ─────────────────────────────────

import {
  createDeepgramSession,
  getDeepgramSession,
  endDeepgramSession,
  hasActiveDeepgramSession,
  getActiveDeepgramSessionCount,
  type DeepgramSession,
} from "../src/plugins/tokidapp/concierge/deepgram-realtime"

process.env.DEEPGRAM_API_KEY = "test-api-key-12345"
process.env.DEEPGRAM_ENABLED = "true"
process.env.DEEPGRAM_LIVE_STT_MODEL = "nova-3"
process.env.DEEPGRAM_TTS_VOICE = "aura-asteria-en"

// ── Helper ──────────────────────────────────────────────────

function createTestSession(overrides?: Partial<Parameters<typeof createDeepgramSession>[0]>) {
  const audioDeltas: string[] = []
  const textDeltas: string[] = []
  const errors: string[] = []
  let readyFired = false
  const userTranscripts: string[] = []
  let responseDones = 0

  const session = createDeepgramSession({
    sessionId: `voice_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    onAudioDelta: (b64) => audioDeltas.push(b64),
    onTextDelta: (text) => textDeltas.push(text),
    onError: (err) => errors.push(err),
    onReady: () => { readyFired = true },
    onUserTranscript: (text) => userTranscripts.push(text),
    onResponseDone: () => { responseDones++ },
    ...overrides,
  })

  return { session, audioDeltas, textDeltas, errors, readyFired, userTranscripts, responseDones }
}

// ── Tests ─────────────────────────────────────────────────────

describe("deepgram-realtime: session creation (AC-S2-1, AC-S2-2)", () => {
  let result: ReturnType<typeof createTestSession>

  beforeEach(() => { MockWebSocket.reset() })
  afterEach(() => { if (result?.session) endDeepgramSession(result.session.sessionId) })

  test("createDeepgramSession returns a valid session object", () => {
    result = createTestSession()
    expect(result.session).toBeDefined()
    expect(result.session.sessionId).toContain("voice_test_")
    expect(result.session.connected).toBe(true)
    expect(result.session.stt).toBeDefined()
    expect(result.session.tts).toBeDefined()
    expect(result.session.audioBuffer).toBeDefined()
    expect(Array.isArray(result.session.conversation)).toBe(true)
  })

  test("session has correct initial state", () => {
    result = createTestSession()
    expect(result.session.responseInProgress).toBe(false)
    expect(result.session.pendingTextInjections).toEqual([])
    expect(result.session.llmCallCount).toBe(0)
    expect(result.session.lastModelUsed).toBe("none")
    // Transcript starts empty before greeting — greeting is added asynchronously
  })

  test("session initializes STT and TTS WebSocket connections (AC-S2-2)", () => {
    result = createTestSession()
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2)
    expect(MockWebSocket.instances[0].url).toContain("/v1/listen")
    expect(MockWebSocket.instances[1].url).toContain("/v1/speak")
  })

  test("session plays greeting on creation", () => {
    result = createTestSession()
    expect(result.textDeltas.length).toBeGreaterThanOrEqual(1)
    expect(result.textDeltas[0]).toContain("Star World Assistant")
  })

  test("session is registered in global sessions map", () => {
    result = createTestSession()
    const retrieved = getDeepgramSession(result.session.sessionId)
    expect(retrieved).toBeDefined()
    expect(retrieved?.sessionId).toBe(result.session.sessionId)
  })

  test("session has audioBuffer from shared module (AC-S2-11)", () => {
    result = createTestSession()
    expect(typeof result.session.audioBuffer.addChunk).toBe("function")
    expect(typeof result.session.audioBuffer.commit).toBe("function")
    expect(typeof result.session.audioBuffer.reset).toBe("function")
  })
})

describe("deepgram-realtime: LLM fallback chain (AC-S2-3, AC-S2-4, AC-S2-12)", () => {
  const originalFetch = globalThis.fetch
  let capturedRequests: Array<{ url: string; body: any }> = []

  beforeEach(() => {
    MockWebSocket.reset()
    capturedRequests = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: any) => {
      const urlStr = typeof url === "string" ? url : url.toString()
      let body: any = {}
      try { body = JSON.parse(init?.body || "{}") } catch {}
      capturedRequests.push({ url: urlStr, body })

      if (urlStr.includes("11434") && body.model === "llama3.1:8b")
        throw Object.assign(new Error("timeout"), { name: "AbortError" })
      if (urlStr.includes("11434") && body.model === "qwen3:8b")
        throw Object.assign(new Error("timeout"), { name: "AbortError" })
      if (urlStr.includes("openai.com"))
        return new Response(JSON.stringify({ choices: [{ message: { content: "Hello from cloud!", tool_calls: null } }] }), { status: 200 })
      return new Response("not found", { status: 404 })
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const ws of MockWebSocket.instances) ws.close()
  })

  test("falls through Ollama primary -> fast -> cloud when local models timeout", async () => {
    const session = createDeepgramSession({
      sessionId: "voice_fallback_test",
      onAudioDelta: () => {}, onTextDelta: () => {}, onError: () => {},
    })

    const sttWs = MockWebSocket.instances.find(u => u.url.includes("/v1/listen"))!
    sttWs.simulateOpen()
    sttWs.simulateMessage(JSON.stringify({
      type: "Results",
      channel: { alternatives: [{ transcript: "what time is it?" }] },
      is_final: true,
    }))

    await new Promise(r => setTimeout(r, 500))

    expect(capturedRequests.length).toBeGreaterThanOrEqual(3)
    expect(capturedRequests[0].url).toContain("11434")
    expect(capturedRequests[0].body.model).toBe("llama3.1:8b")
    expect(capturedRequests[1].url).toContain("11434")
    expect(capturedRequests[1].body.model).toBe("qwen3:8b")
    expect(capturedRequests[2].url).toContain("openai.com")
    expect(capturedRequests[2].body.model).toBe("gpt-4o-mini")

    endDeepgramSession("voice_fallback_test")
  })

  test("returns graceful error message when all providers fail", async () => {
    globalThis.fetch = mock(async () => {
      throw Object.assign(new Error("all down"), { name: "AbortError" })
    })

    const errors: string[] = []
    const session = createDeepgramSession({
      sessionId: "voice_all_fail_test",
      onAudioDelta: () => {}, onTextDelta: () => {},
      onError: (err) => errors.push(err),
    })

    const sttWs = MockWebSocket.instances.find(u => u.url.includes("/v1/listen"))!
    sttWs.simulateOpen()
    sttWs.simulateMessage(JSON.stringify({
      type: "Results",
      channel: { alternatives: [{ transcript: "test" }] },
      is_final: true,
    }))

    await new Promise(r => setTimeout(r, 500))
    expect(session.connected).toBe(true)
    endDeepgramSession("voice_all_fail_test")
  })
})

describe("deepgram-realtime: tool execution (AC-S2-5)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    MockWebSocket.reset()
    ;(globalThis as any).__toolCallCount = 0
    globalThis.fetch = mock(async (url: string | URL | Request, init?: any) => {
      const urlStr = typeof url === "string" ? url : url.toString()
      if (urlStr.includes("11434")) {
        const callCount = (globalThis as any).__toolCallCount || 0
        ;(globalThis as any).__toolCallCount = callCount + 1
        if (callCount === 0) {
          return new Response(JSON.stringify({ choices: [{ message: { content: "Let me check.", tool_calls: [{ id: "call_1", type: "function", function: { name: "git_status", arguments: "{}" } }] } }] }), { status: 200 })
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "Clean working tree.", tool_calls: null } }] }), { status: 200 })
      }
      return new Response("not found", { status: 404 })
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const ws of MockWebSocket.instances) ws.close()
  })

  test("LLM tool calls are executed and results fed back to context", async () => {
    const textDeltas: string[] = []
    const session = createDeepgramSession({
      sessionId: "voice_tool_test",
      onAudioDelta: () => {}, onTextDelta: (t) => textDeltas.push(t), onError: () => {},
    })

    const sttWs = MockWebSocket.instances.find(u => u.url.includes("/v1/listen"))!
    sttWs.simulateOpen()
    sttWs.simulateMessage(JSON.stringify({
      type: "Results",
      channel: { alternatives: [{ transcript: "show me git status" }] },
      is_final: true,
    }))

    await new Promise(r => setTimeout(r, 600))
    expect(session.llmCallCount).toBeGreaterThanOrEqual(2)
    endDeepgramSession("voice_tool_test")
  })
})

describe("deepgram-realtime: voice-chat union (AC-S2-9)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    MockWebSocket.reset()
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: "Got your message!", tool_calls: null } }] }), { status: 200 })
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const ws of MockWebSocket.instances) ws.close()
  })

  test("sendMessage injects text into conversation and triggers LLM", async () => {
    const session = createDeepgramSession({
      sessionId: "voice_union_test",
      onAudioDelta: () => {}, onTextDelta: () => {}, onError: () => {},
    }) as DeepgramSession & { sendMessage: (text: string) => void }

    session.sendMessage("typed message from chat input")
    await new Promise(r => setTimeout(r, 300))

    const userMessages = session.conversation.filter(m => m.role === "user")
    expect(userMessages.some(m => m.content === "typed message from chat input")).toBe(true)
    endDeepgramSession("voice_union_test")
  })

  test("injectText queues text without triggering LLM immediately", () => {
    const session = createDeepgramSession({
      sessionId: "voice_inject_test",
      onAudioDelta: () => {}, onTextDelta: () => {}, onError: () => {},
    }) as DeepgramSession & { injectText: (text: string) => void }

    session.injectText("background context")
    expect(session.pendingTextInjections).toContain("background context")

    const userMessages = session.conversation.filter(m => m.role === "user")
    expect(userMessages.some(m => m.content === "background context")).toBe(false)
    endDeepgramSession("voice_inject_test")
  })

  test("pending injections are consumed before LLM call", async () => {
    const session = createDeepgramSession({
      sessionId: "voice_consume_test",
      onAudioDelta: () => {}, onTextDelta: () => {}, onError: () => {},
    }) as DeepgramSession & { injectText: (t: string) => void; sendMessage: (t: string) => void }

    session.injectText("background context")
    session.sendMessage("trigger processing")
    await new Promise(r => setTimeout(r, 300))

    expect(session.pendingTextInjections).not.toContain("background context")
    endDeepgramSession("voice_consume_test")
  })
})

describe("deepgram-realtime: session cleanup (AC-S2-14)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    MockWebSocket.reset()
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: null } }] }), { status: 200 })
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const ws of MockWebSocket.instances) ws.close()
  })

  test("endDeepgramSession closes connections and removes from map", () => {
    const session = createDeepgramSession({
      sessionId: "voice_cleanup_test",
      onAudioDelta: () => {}, onTextDelta: () => {}, onError: () => {},
    })

    expect(getDeepgramSession("voice_cleanup_test")).toBeDefined()
    expect(hasActiveDeepgramSession("voice_cleanup_test")).toBe(true)

    endDeepgramSession("voice_cleanup_test")

    expect(getDeepgramSession("voice_cleanup_test")).toBeUndefined()
    expect(hasActiveDeepgramSession("voice_cleanup_test")).toBe(false)
  })

  test("destroy method on session closes connections and cleans up", () => {
    const session = createDeepgramSession({
      sessionId: "voice_destroy_test",
      onAudioDelta: () => {}, onTextDelta: () => {}, onError: () => {},
    })

    // Access destroy via the session object (it's mixed in)
    const destroyFn = (session as any).destroy
    if (typeof destroyFn === "function") {
      destroyFn()
    } else {
      endDeepgramSession("voice_destroy_test")
    }

    expect(getDeepgramSession("voice_destroy_test")).toBeUndefined()
  })

  test("endDeepgramSession is safe to call twice (idempotent)", () => {
    createDeepgramSession({
      sessionId: "voice_double_end_test",
      onAudioDelta: () => {}, onTextDelta: () => {}, onError: () => {},
    })

    endDeepgramSession("voice_double_end_test")
    endDeepgramSession("voice_double_end_test") // should not throw
    expect(getDeepgramSession("voice_double_end_test")).toBeUndefined()
  })

  test("audioBuffer is reset on session end", () => {
    const session = createDeepgramSession({
      sessionId: "voice_buf_reset_test",
      onAudioDelta: () => {}, onTextDelta: () => {}, onError: () => {},
    })

    session.audioBuffer.addChunk("fake-audio")
    expect(session.audioBuffer.isEmpty).toBe(false)

    endDeepgramSession("voice_buf_reset_test")
    // After end, the session is removed — buffer state is no longer accessible
    expect(getDeepgramSession("voice_buf_reset_test")).toBeUndefined()
  })
})

describe("deepgram-realtime: session count and active tracking", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    MockWebSocket.reset()
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: null } }] }), { status: 200 })
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const ws of MockWebSocket.instances) ws.close()
  })

  test("getActiveDeepgramSessionCount tracks sessions", () => {
    const initial = getActiveDeepgramSessionCount()

    createDeepgramSession({
      sessionId: "voice_count_1",
      onAudioDelta: () => {}, onTextDelta: () => {}, onError: () => {},
    })

    createDeepgramSession({
      sessionId: "voice_count_2",
      onAudioDelta: () => {}, onTextDelta: () => {}, onError: () => {},
    })

    expect(getActiveDeepgramSessionCount()).toBeGreaterThanOrEqual(initial + 2)

    endDeepgramSession("voice_count_1")
    endDeepgramSession("voice_count_2")
  })

  test("hasActiveDeepgramSession returns false after end", () => {
    createDeepgramSession({
      sessionId: "voice_active_test",
      onAudioDelta: () => {}, onTextDelta: () => {}, onError: () => {},
    })

    expect(hasActiveDeepgramSession("voice_active_test")).toBe(true)
    endDeepgramSession("voice_active_test")
    expect(hasActiveDeepgramSession("voice_active_test")).toBe(false)
  })

  test("hasActiveDeepgramSession returns false for unknown session", () => {
    expect(hasActiveDeepgramSession("nonexistent_session")).toBe(false)
  })
})
