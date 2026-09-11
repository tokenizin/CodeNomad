import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"

// Mock the starguard-client apiPost
const apiPostMock = mock(async () => new Response('{}', { status: 200 }))
mock.module("../src/plugins/tokidapp/orchestrator/starguard-client.js", () => ({
  apiPost: apiPostMock,
  STARGUARD_BASE: 'https://test.example',
}))

// Import after mock
const { checkAgentReputation, _resetDailyCounter } = await import("../src/plugins/tokidapp/concierge/reputation-checker.js")

function mockFetch(response: Response | Error) {
  const m = mock()
  if (response instanceof Error) {
    m.mockRejectedValue(response)
  } else {
    m.mockResolvedValue(response)
  }
  globalThis.fetch = m as unknown as typeof globalThis.fetch
  return m
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe("checkAgentReputation", () => {
  beforeEach(() => {
    _resetDailyCounter()
    apiPostMock.mockClear()
    process.env.THREE_WS_API_KEY = 'test-key'
    process.env.THREE_WS_API_BASE = 'https://api.three.ws'
    process.env.REPUTATION_CHECK_MAX_DAILY = '50'
    process.env.REPUTATION_TRUST_THRESHOLD = '5000'
  })

  afterEach(() => {
    delete process.env.THREE_WS_API_KEY
    delete process.env.THREE_WS_API_BASE
    delete process.env.REPUTATION_CHECK_MAX_DAILY
    delete process.env.REPUTATION_TRUST_THRESHOLD
  })

  it("returns a formatted reputation summary for a valid agent", async () => {
    mockFetch(jsonResponse({
      score: 7500,
      completed_tasks: 42,
      disputes: 1,
      staked: 5000,
    }))

    const result = await checkAgentReputation('agent_abc')

    expect(result).toContain('agent_abc')
    expect(result).toContain('7500')
    expect(result).toContain('TRUSTED')
    expect(result).toContain('42')
  })

  it("returns NOT TRUSTED for a low-score agent", async () => {
    mockFetch(jsonResponse({
      score: 2000,
      completed_tasks: 5,
      disputes: 3,
      staked: 100,
    }))

    const result = await checkAgentReputation('agent_low')

    expect(result).toContain('NOT TRUSTED')
    expect(result).toContain('2000')
  })

  it("returns a clear message when the agent is not found", async () => {
    mockFetch(jsonResponse({ error: 'not found' }, 404))

    const result = await checkAgentReputation('agent_missing')

    expect(result).toContain('not found')
  })

  it("returns a configuration message when THREE_WS_API_KEY is not set", async () => {
    delete process.env.THREE_WS_API_KEY
    const fetchMock = mockFetch(jsonResponse({}))

    const result = await checkAgentReputation('agent_any')

    expect(result).toContain('not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("enforces a per-day call ceiling", async () => {
    process.env.REPUTATION_CHECK_MAX_DAILY = '2'
    mockFetch(jsonResponse({ score: 5000 }))

    await checkAgentReputation('agent_1')
    await checkAgentReputation('agent_2')

    const result = await checkAgentReputation('agent_3')

    expect(result).toContain('limit reached')
    expect(result).toContain('2')
  })

  it("handles network errors gracefully", async () => {
    mockFetch(new Error('connection refused'))

    const result = await checkAgentReputation('agent_err')

    expect(result).toContain('error')
    expect(result).toContain('connection refused')
  })

  it("rejects empty agent identifiers", async () => {
    const fetchMock = mockFetch(jsonResponse({}))

    const result = await checkAgentReputation('')

    expect(result).toContain('provide an agent identifier')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})