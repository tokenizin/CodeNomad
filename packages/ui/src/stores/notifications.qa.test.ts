/**
 * Slice 7 — QA Matrix & Integration Tests (UI Side)
 *
 * Covers UI-side integration points:
 *   - AC-6: Combined filter at UI store layer
 *   - AC-14: Toast bridge fires for high/urgent priority and critical severity
 */

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import type { NotifyEvent } from "../types/notify"
import { sseManager } from "../lib/sse-manager"
import {
  getNotifyEvents,
  getUnreadCount,
  resetNotifyStoreForTests,
  setNotifyEventsForTests,
  addEvent,
  shouldShowToast,
} from "./notifications"

// ── Test Helpers ─────────────────────────────────────────

function makeEvent(overrides: Partial<NotifyEvent> & { id: string; title: string; message: string }): NotifyEvent {
  return {
    id: overrides.id,
    instanceId: overrides.instanceId ?? "test-instance",
    sessionId: overrides.sessionId,
    title: overrides.title,
    message: overrides.message,
    source: overrides.source ?? "system",
    category: overrides.category ?? "system",
    priority: overrides.priority ?? "normal",
    severity: overrides.severity ?? "info",
    eventType: overrides.eventType ?? "TEST_EVENT",
    createdAt: overrides.createdAt ?? Date.now(),
    read: overrides.read ?? false,
    schemaVersion: 1,
    ...overrides,
  }
}

// ── AC-6: Combined UI Store Filter ──────────────────────

describe("AC-6: Combined filter at UI store layer", () => {
  beforeEach(() => {
    resetNotifyStoreForTests()
  })

  afterEach(() => {
    resetNotifyStoreForTests()
  })

  it("filters by category + priority + severity combined", () => {
    const events = [
      makeEvent({ id: "e1", title: "Error High Critical", category: "error", priority: "high", severity: "critical" }),
      makeEvent({ id: "e2", title: "Error High Error", category: "error", priority: "high", severity: "error" }),
      makeEvent({ id: "e3", title: "Error Low Info", category: "error", priority: "low", severity: "info" }),
      makeEvent({ id: "e4", title: "Session High Error", category: "session", priority: "high", severity: "error" }),
      makeEvent({ id: "e5", title: "Task Normal Info", category: "task", priority: "normal", severity: "info" }),
    ]
    setNotifyEventsForTests("inst-1", events)

    const result = getNotifyEvents("inst-1", { category: "error", priority: "high", severity: "critical" })
    assert.equal(result.length, 1)
    assert.equal(result[0].title, "Error High Critical")
  })

  it("filters by category + severity combined", () => {
    const events = [
      makeEvent({ id: "e1", title: "Error Critical", category: "error", severity: "critical" }),
      makeEvent({ id: "e2", title: "Error Error", category: "error", severity: "error" }),
      makeEvent({ id: "e3", title: "Task Critical", category: "task", severity: "critical" }),
      makeEvent({ id: "e4", title: "Session Info", category: "session", severity: "info" }),
    ]
    setNotifyEventsForTests("inst-1", events)

    const result = getNotifyEvents("inst-1", { category: "error", severity: "critical" })
    assert.equal(result.length, 1)
    assert.equal(result[0].title, "Error Critical")
  })

  it("filters by priority + severity combined", () => {
    const events = [
      makeEvent({ id: "e1", title: "Urgent Critical", priority: "urgent", severity: "critical" }),
      makeEvent({ id: "e2", title: "Urgent Info", priority: "urgent", severity: "info" }),
      makeEvent({ id: "e3", title: "Normal Critical", priority: "normal", severity: "critical" }),
      makeEvent({ id: "e4", title: "Low Info", priority: "low", severity: "info" }),
    ]
    setNotifyEventsForTests("inst-1", events)

    const result = getNotifyEvents("inst-1", { priority: "urgent", severity: "critical" })
    assert.equal(result.length, 1)
    assert.equal(result[0].title, "Urgent Critical")
  })

  it("returns empty for combined filter that matches nothing", () => {
    const events = [
      makeEvent({ id: "e1", title: "Normal", category: "session", priority: "normal", severity: "info" }),
    ]
    setNotifyEventsForTests("inst-1", events)

    const result = getNotifyEvents("inst-1", { category: "error", priority: "high", severity: "critical" })
    assert.equal(result.length, 0)
  })

  it("returns all events when no filter provided", () => {
    const events = [
      makeEvent({ id: "e1", title: "A", category: "error", priority: "high", severity: "critical" }),
      makeEvent({ id: "e2", title: "B", category: "session", priority: "low", severity: "info" }),
      makeEvent({ id: "e3", title: "C", category: "task", priority: "normal", severity: "warning" }),
    ]
    setNotifyEventsForTests("inst-1", events)

    const result = getNotifyEvents("inst-1")
    assert.equal(result.length, 3)
  })

  it("combined filter results match server-side behavior (cross-layer consistency)", () => {
    // Same test scenario as server-side AC-5
    const events = [
      makeEvent({ id: "e1", title: "Error High Critical", category: "error", priority: "high", severity: "critical" }),
      makeEvent({ id: "e2", title: "Error High Error", category: "error", priority: "high", severity: "error" }),
      makeEvent({ id: "e3", title: "Error Low Info", category: "error", priority: "low", severity: "info" }),
      makeEvent({ id: "e4", title: "Session High Error", category: "session", priority: "high", severity: "error" }),
    ]
    setNotifyEventsForTests("inst-1", events)

    // Same filter as AC-5 server test: category=error, priority=high, severity=critical
    const result = getNotifyEvents("inst-1", { category: "error", priority: "high", severity: "critical" })
    assert.equal(result.length, 1)
    assert.equal(result[0].title, "Error High Critical")
  })
})

// ── AC-14: Toast Bridge ─────────────────────────────────

describe("AC-14: Toast bridge fires for high/urgent priority and critical severity", () => {
  beforeEach(() => {
    resetNotifyStoreForTests()
  })

  afterEach(() => {
    resetNotifyStoreForTests()
  })

  it("shouldShowToast returns true for priority='urgent'", () => {
    const event = makeEvent({ id: "urgent", title: "Urgent", message: "urgent msg", priority: "urgent" })
    assert.equal(shouldShowToast(event), true)
  })

  it("shouldShowToast returns true for priority='high'", () => {
    const event = makeEvent({ id: "high", title: "High", message: "high msg", priority: "high" })
    assert.equal(shouldShowToast(event), true)
  })

  it("shouldShowToast returns true for severity='critical'", () => {
    const event = makeEvent({ id: "critical", title: "Critical", message: "critical msg", severity: "critical" })
    assert.equal(shouldShowToast(event), true)
  })

  it("shouldShowToast returns false for priority='low' + severity='info'", () => {
    const event = makeEvent({ id: "low", title: "Low", message: "low msg", priority: "low", severity: "info" })
    assert.equal(shouldShowToast(event), false)
  })

  it("shouldShowToast returns false for priority='normal' + severity='success'", () => {
    const event = makeEvent({ id: "normal", title: "Normal", message: "normal msg", priority: "normal", severity: "success" })
    assert.equal(shouldShowToast(event), false)
  })

  it("shouldShowToast returns true for priority='high' + severity='warning'", () => {
    const event = makeEvent({ id: "high-warn", title: "High", message: "high warning", priority: "high", severity: "warning" })
    assert.equal(shouldShowToast(event), true)
  })

  it("sseManager.onNotifyCreated adds event to store (toast bridge path)", () => {
    const event = makeEvent({ id: "toast-test", title: "Toast", message: "toast msg", priority: "urgent", severity: "critical" })
    assert.equal(shouldShowToast(event), true)

    // Simulate the WS callback (same path as the store's sseManager.onNotifyCreated)
    sseManager.onNotifyCreated?.("inst-1", {
      type: "notify.create",
      properties: { event },
    })

    // Verify the event was added to the store
    const events = getNotifyEvents("inst-1")
    assert.equal(events.length, 1)
    assert.equal(events[0].id, "toast-test")
  })

  it("multiple high-priority events are all added to store", () => {
    const events = [
      makeEvent({ id: "urgent-1", title: "Urgent 1", message: "u1", priority: "urgent" }),
      makeEvent({ id: "high-1", title: "High 1", message: "h1", priority: "high" }),
      makeEvent({ id: "critical-1", title: "Critical 1", message: "c1", severity: "critical" }),
    ]

    for (const ev of events) {
      assert.equal(shouldShowToast(ev), true)
      sseManager.onNotifyCreated?.("inst-1", {
        type: "notify.create",
        properties: { event: ev },
      })
    }

    assert.equal(getNotifyEvents("inst-1").length, 3)
  })

  it("non-toast events are still added to store but shouldShowToast is false", () => {
    const event = makeEvent({ id: "quiet", title: "Quiet", message: "quiet msg", priority: "low", severity: "info" })
    assert.equal(shouldShowToast(event), false)

    sseManager.onNotifyCreated?.("inst-1", {
      type: "notify.create",
      properties: { event },
    })

    const events = getNotifyEvents("inst-1")
    assert.equal(events.length, 1)
    assert.equal(events[0].id, "quiet")
  })

  it("unread count recalculates after adding toast-triggering events", () => {
    assert.equal(getUnreadCount(), 0)

    const ev = makeEvent({ id: "unread-urgent", title: "Urgent", message: "urgent", priority: "urgent", read: false })
    sseManager.onNotifyCreated?.("inst-1", {
      type: "notify.create",
      properties: { event: ev },
    })

    assert.equal(getUnreadCount(), 1)
  })
})
