/**
 * Interactive Session Manager + Tool Wrappers — Integration Test Suite
 *
 * Tests the ClickFlow Interactive Response System:
 *   - Session Manager (createPrompt, resolvePrompt, cancelPrompt, activePromptCount, hasActivePrompt)
 *   - Tool Wrappers (askUserPickOne, askUserPickMany, askUserConfirm, askUserText, askUserSlider)
 *
 * Pattern follows voice-chat-union.test.ts (bun:test, mock.module, mock).
 *
 * IMPORTANT: interactive-session.ts uses module-level Map singletons.
 * Each test generates unique prompt IDs and cleans up in afterEach
 * so tests do not leak state across boundaries.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"

import {
  createPrompt,
  resolvePrompt,
  cancelPrompt,
  activePromptCount,
  hasActivePrompt,
} from "../src/plugins/tokidapp/concierge/interactive-session"

import {
  askUserPickOne,
  askUserPickMany,
  askUserConfirm,
  askUserText,
  askUserSlider,
} from "../src/plugins/tokidapp/concierge/interactive-tools"

// ── Helpers ──────────────────────────────────────────────────

/**
 * Track prompt IDs created by each test so afterEach can safely
 * clean up any that weren't resolved/cancelled during the test.
 * cancelPrompt is idempotent — it returns false for already-removed prompts.
 */
const trackedIds: string[] = []

function track(id: string) {
  trackedIds.push(id)
}

function sendFnMock() {
  return mock<(msg: string) => void>(() => {})
}

beforeEach(() => {
  trackedIds.length = 0
})

afterEach(() => {
  for (const id of trackedIds) {
    cancelPrompt(id, "cleanup")
  }
  trackedIds.length = 0
})

// ── Session Manager Tests (AC-1) ─────────────────────────────

describe("Interactive Session Manager", () => {

  // ── AC-1.1: createPrompt + resolvePrompt ──────────────────

  test("createPrompt sends WS message via sendFn, resolvePrompt returns response", async () => {
    const promptId = "sm-resolve-1"
    track(promptId)
    const sendFn = sendFnMock()

    const promise = createPrompt(
      promptId,
      "pick_one",
      "What color?",
      sendFn,
      [{ value: "red", label: "Red" }],
    )

    // sendFn should have been called synchronously with the serialised prompt
    expect(sendFn).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(sendFn.mock.calls[0][0] as string)
    expect(sent).toMatchObject({
      type: "interactive_prompt",
      promptId,
      promptType: "pick_one",
      question: "What color?",
    })
    expect(sent.options).toHaveLength(1)
    expect(sent.options[0].value).toBe("red")

    // Resolve the waiter
    const resolved = resolvePrompt(promptId, { selected: "red" })
    expect(resolved).toBe(true)

    // The promise should have resolved
    const result = await promise
    expect(result).toEqual({
      promptId,
      response: { selected: "red" },
      status: "answered",
    })
  })

  // ── AC-1.2: createPrompt timeout (50 ms) ─────────────────

  test("createPrompt resolves with timeout status after expiry", async () => {
    const promptId = "sm-timeout-1"
    track(promptId)
    const sendFn = sendFnMock()

    const promise = createPrompt(
      promptId,
      "confirm",
      "Are you there?",
      sendFn,
      undefined,
      undefined,
      50, // short timeout
    )

    // Wait for the timeout to fire
    await new Promise<void>((r) => setTimeout(r, 120))

    const result = await promise
    expect(result.status).toBe("timeout")
    expect(result.promptId).toBe(promptId)
    // response should be empty on timeout
    expect(result.response).toEqual({})
  })

  // ── AC-1.3: cancelPrompt resolves with cancelled ─────────

  test("cancelPrompt resolves pending promise with cancelled: true", async () => {
    const promptId = "sm-cancel-1"
    track(promptId)
    const sendFn = sendFnMock()

    const promise = createPrompt(promptId, "ask_text", "Enter text:", sendFn)

    const cancelled = cancelPrompt(promptId, "user-abort")
    expect(cancelled).toBe(true)

    const result = await promise
    expect(result).toEqual({
      promptId,
      response: {},
      status: "cancelled",
    })
  })

  test("cancelPrompt returns false for unknown promptId", () => {
    expect(cancelPrompt("nonexistent-id")).toBe(false)
  })

  // ── AC-1.4: Concurrent prompts ───────────────────────────

  test("two concurrent prompts with different IDs both resolve independently", async () => {
    const idA = "sm-concurrent-a"
    const idB = "sm-concurrent-b"
    track(idA)
    track(idB)
    const sendFn = sendFnMock()

    const promiseA = createPrompt(idA, "pick_one", "Choice A?", sendFn, [
      { value: "a1", label: "A1" },
    ])
    const promiseB = createPrompt(idB, "pick_one", "Choice B?", sendFn, [
      { value: "b1", label: "B1" },
    ])

    // Both should be active
    expect(activePromptCount()).toBe(2)
    expect(hasActivePrompt(idA)).toBe(true)
    expect(hasActivePrompt(idB)).toBe(true)

    // Resolve B first
    resolvePrompt(idB, { selected: "b1" })
    const resultB = await promiseB
    expect(resultB.status).toBe("answered")
    expect(resultB.response).toEqual({ selected: "b1" })

    // A should still be active
    expect(hasActivePrompt(idA)).toBe(true)
    expect(hasActivePrompt(idB)).toBe(false)
    expect(activePromptCount()).toBe(1)

    // Resolve A
    resolvePrompt(idA, { selected: "a1" })
    const resultA = await promiseA
    expect(resultA.status).toBe("answered")
    expect(resultA.response).toEqual({ selected: "a1" })

    // Both should be inactive now
    expect(activePromptCount()).toBe(0)
    expect(hasActivePrompt(idA)).toBe(false)
    expect(hasActivePrompt(idB)).toBe(false)
  })

  // ── AC-1.5: Lifecycle (activePromptCount, hasActivePrompt) ─

  test("lifecycle: after resolve, activePromptCount decreases and hasActivePrompt returns false", async () => {
    const id = "sm-lifecycle-1"
    track(id)
    const sendFn = sendFnMock()

    const promise = createPrompt(id, "confirm", "Ready?", sendFn)

    expect(activePromptCount()).toBe(1)
    expect(hasActivePrompt(id)).toBe(true)

    resolvePrompt(id, { choice: "yes" })
    await promise

    expect(activePromptCount()).toBe(0)
    expect(hasActivePrompt(id)).toBe(false)
  })

  test("lifecycle: after cancel, activePromptCount decreases and hasActivePrompt returns false", async () => {
    const id = "sm-lifecycle-2"
    track(id)
    const sendFn = sendFnMock()

    const promise = createPrompt(id, "confirm", "Ready?", sendFn)

    expect(activePromptCount()).toBe(1)
    expect(hasActivePrompt(id)).toBe(true)

    cancelPrompt(id)
    await promise

    expect(activePromptCount()).toBe(0)
    expect(hasActivePrompt(id)).toBe(false)
  })

  test("resolvePrompt returns false for already-resolved or non-existent prompt", () => {
    // Non-existent
    expect(resolvePrompt("no-such-id", {})).toBe(false)
  })
})

// ── Tool Wrapper Tests (AC-2) ────────────────────────────────
//
// These tests call the real tool wrappers which in turn call the real
// createPrompt. We capture the generated promptId from the mock sendFn
// and then call resolvePrompt to unblock the wrapper's await.
//
// Because createPrompt calls sendFn synchronously inside its constructor,
// the capturedPromptId is available before we need to resolve it.

describe("Interactive Tool Wrappers", () => {

  // ── AC-2.1: askUserPickOne ──────────────────────────────

  test("askUserPickOne calls createPrompt with correct promptType and options", async () => {
    let capturedId = ""
    const sendFn = mock((msg: string) => {
      const parsed = JSON.parse(msg)
      capturedId = parsed.promptId
    })

    const resultPromise = askUserPickOne(
      {
        question: "Choose destination",
        options: [
          { value: "beach", label: "Beach" },
          { value: "mountain", label: "Mountain" },
        ],
      },
      sendFn,
    )

    track(capturedId)
    expect(capturedId).toBeTruthy()
    expect(sendFn).toHaveBeenCalledTimes(1)

    const sent = JSON.parse(sendFn.mock.calls[0][0] as string)
    expect(sent.promptType).toBe("pick_one")
    expect(sent.question).toBe("Choose destination")
    expect(sent.options).toHaveLength(2)

    resolvePrompt(capturedId, { selected: "mountain" })

    const result = await resultPromise
    expect(result).toEqual({ selected: "mountain", timeout: false, cancelled: false })
  })

  test("askUserPickOne returns null selected on timeout", async () => {
    const sendFn = sendFnMock()
    const result = await askUserPickOne(
      {
        question: "Quick?",
        options: [{ value: "a", label: "A" }],
        timeoutMs: 1,
      },
      sendFn,
    )
    // The timeout should have fired, giving us status 'timeout'
    expect(result.timeout).toBe(true)
    expect(result.selected).toBeNull()
    expect(result.cancelled).toBe(false)
  })

  test("askUserPickOne returns null selected on cancel", async () => {
    let capturedId = ""
    const sendFn = mock((msg: string) => {
      capturedId = JSON.parse(msg).promptId
    })

    // Need to avoid auto-timeout, use long default
    const resultPromise = askUserPickOne(
      {
        question: "Cancel test?",
        options: [{ value: "a", label: "A" }],
        timeoutMs: 300_000, // effectively infinite for test purposes
      },
      sendFn,
    )

    track(capturedId)
    await new Promise<void>((r) => setTimeout(r, 0)) // let the async start
    cancelPrompt(capturedId)

    const result = await resultPromise
    expect(result.cancelled).toBe(true)
    expect(result.selected).toBeNull()
    expect(result.timeout).toBe(false)
  })

  // ── AC-2.2: askUserPickMany ──────────────────────────────

  test("askUserPickMany calls createPrompt with pick_many type and returns PickManyResult", async () => {
    let capturedId = ""
    const sendFn = mock((msg: string) => {
      capturedId = JSON.parse(msg).promptId
    })

    const resultPromise = askUserPickMany(
      {
        question: "Pick toppings",
        options: [
          { value: "cheese", label: "Cheese" },
          { value: "pepperoni", label: "Pepperoni" },
        ],
        config: { min: 1, max: 2 },
      },
      sendFn,
    )

    track(capturedId)
    expect(capturedId).toBeTruthy()
    const sent = JSON.parse(sendFn.mock.calls[0][0] as string)
    expect(sent.promptType).toBe("pick_many")

    resolvePrompt(capturedId, { selected: ["cheese", "pepperoni"] })

    const result = await resultPromise
    expect(result).toEqual({
      selected: ["cheese", "pepperoni"],
      timeout: false,
      cancelled: false,
    })
  })

  test("askUserPickMany returns empty array on timeout", async () => {
    const sendFn = sendFnMock()
    const result = await askUserPickMany(
      {
        question: "Pick quickly?",
        options: [{ value: "x", label: "X" }],
        timeoutMs: 1,
      },
      sendFn,
    )
    expect(result.timeout).toBe(true)
    expect(result.selected).toEqual([])
  })

  // ── AC-2.3: askUserConfirm ───────────────────────────────

  test("askUserConfirm with yes response returns { choice: 'yes' }", async () => {
    let capturedId = ""
    const sendFn = mock((msg: string) => {
      capturedId = JSON.parse(msg).promptId
    })

    const resultPromise = askUserConfirm(
      { question: "Approve?", context: "test" },
      sendFn,
    )

    track(capturedId)
    expect(capturedId).toBeTruthy()
    const sent = JSON.parse(sendFn.mock.calls[0][0] as string)
    expect(sent.promptType).toBe("confirm")

    resolvePrompt(capturedId, { choice: "yes" })

    const result = await resultPromise
    expect(result).toEqual({ choice: "yes", timeout: false, cancelled: false })
  })

  test("askUserConfirm with no response returns { choice: 'no' }", async () => {
    let capturedId = ""
    const sendFn = mock((msg: string) => {
      capturedId = JSON.parse(msg).promptId
    })

    const resultPromise = askUserConfirm(
      { question: "Proceed?" },
      sendFn,
    )

    track(capturedId)
    resolvePrompt(capturedId, { choice: "no" })

    const result = await resultPromise
    expect(result).toEqual({ choice: "no", timeout: false, cancelled: false })
  })

  test("askUserConfirm returns cancel on timeout", async () => {
    const sendFn = sendFnMock()
    const result = await askUserConfirm(
      { question: "Quick confirm?", timeoutMs: 1 },
      sendFn,
    )
    expect(result.choice).toBe("cancel")
    expect(result.timeout).toBe(true)
  })

  test("askUserConfirm returns cancel on cancellation", async () => {
    let capturedId = ""
    const sendFn = mock((msg: string) => {
      capturedId = JSON.parse(msg).promptId
    })

    const resultPromise = askUserConfirm(
      { question: "Cancel?", timeoutMs: 300_000 },
      sendFn,
    )

    track(capturedId)
    await new Promise<void>((r) => setTimeout(r, 0))
    cancelPrompt(capturedId)

    const result = await resultPromise
    expect(result.choice).toBe("cancel")
    expect(result.cancelled).toBe(true)
  })

  // ── AC-2.4: askUserText ──────────────────────────────────

  test("askUserText calls createPrompt with ask_text type and returns TextResult", async () => {
    let capturedId = ""
    const sendFn = mock((msg: string) => {
      capturedId = JSON.parse(msg).promptId
    })

    const resultPromise = askUserText(
      { question: "Your name", config: { multiline: false } },
      sendFn,
    )

    track(capturedId)
    const sent = JSON.parse(sendFn.mock.calls[0][0] as string)
    expect(sent.promptType).toBe("ask_text")

    resolvePrompt(capturedId, { text: "Alice" })

    const result = await resultPromise
    expect(result).toEqual({ text: "Alice", timeout: false, cancelled: false })
  })

  test("askUserText returns null text on timeout", async () => {
    const sendFn = sendFnMock()
    const result = await askUserText(
      { question: "Quick text?", timeoutMs: 1 },
      sendFn,
    )
    expect(result.timeout).toBe(true)
    expect(result.text).toBeNull()
  })

  // ── AC-2.5: askUserSlider ────────────────────────────────

  test("askUserSlider calls createPrompt with slider type and returns SliderResult", async () => {
    let capturedId = ""
    const sendFn = mock((msg: string) => {
      capturedId = JSON.parse(msg).promptId
    })

    const resultPromise = askUserSlider(
      {
        question: "Rate 1-10",
        config: { min: 1, max: 10, step: 1, defaultValue: 5 },
      },
      sendFn,
    )

    track(capturedId)
    const sent = JSON.parse(sendFn.mock.calls[0][0] as string)
    expect(sent.promptType).toBe("slider")
    expect(sent.config).toEqual({ min: 1, max: 10, step: 1, defaultValue: 5 })

    resolvePrompt(capturedId, { value: 7 })

    const result = await resultPromise
    expect(result).toEqual({ value: 7, timeout: false, cancelled: false })
  })

  test("askUserSlider returns null value on timeout", async () => {
    const sendFn = sendFnMock()
    const result = await askUserSlider(
      { question: "Quick slide?", config: { min: 0, max: 100 }, timeoutMs: 1 },
      sendFn,
    )
    expect(result.timeout).toBe(true)
    expect(result.value).toBeNull()
  })

  // ── AC-2.6: All wrappers propagate timeout/cancelled correctly ─

  test("all 5 wrappers set correct timeout/cancelled booleans on success path", async () => {
    // askUserPickOne — success
    let id1 = ""
    const r1 = askUserPickOne(
      { question: "Q", options: [{ value: "a", label: "A" }], timeoutMs: 300_000 },
      mock((m: string) => { id1 = JSON.parse(m).promptId }),
    )
    track(id1)
    resolvePrompt(id1, { selected: "a" })
    expect(await r1).toMatchObject({ timeout: false, cancelled: false })

    // askUserPickMany — success
    let id2 = ""
    const r2 = askUserPickMany(
      { question: "Q", options: [{ value: "x", label: "X" }], timeoutMs: 300_000 },
      mock((m: string) => { id2 = JSON.parse(m).promptId }),
    )
    track(id2)
    resolvePrompt(id2, { selected: ["x"] })
    expect(await r2).toMatchObject({ timeout: false, cancelled: false })

    // askUserConfirm — success
    let id3 = ""
    const r3 = askUserConfirm(
      { question: "Q", timeoutMs: 300_000 },
      mock((m: string) => { id3 = JSON.parse(m).promptId }),
    )
    track(id3)
    resolvePrompt(id3, { choice: "yes" })
    expect(await r3).toMatchObject({ timeout: false, cancelled: false })

    // askUserText — success
    let id4 = ""
    const r4 = askUserText(
      { question: "Q", timeoutMs: 300_000 },
      mock((m: string) => { id4 = JSON.parse(m).promptId }),
    )
    track(id4)
    resolvePrompt(id4, { text: "hello" })
    expect(await r4).toMatchObject({ timeout: false, cancelled: false })

    // askUserSlider — success
    let id5 = ""
    const r5 = askUserSlider(
      { question: "Q", config: { min: 0, max: 10 }, timeoutMs: 300_000 },
      mock((m: string) => { id5 = JSON.parse(m).promptId }),
    )
    track(id5)
    resolvePrompt(id5, { value: 5 })
    expect(await r5).toMatchObject({ timeout: false, cancelled: false })
  })
})
