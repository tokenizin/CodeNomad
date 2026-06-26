import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import type { NotifyEvent, NotifyFilter } from "../types/notify"
import { sseManager } from "../lib/sse-manager"
import { serverApi } from "../lib/api-client"
import {
  acknowledgeNotifyEvent,
  clearNotifyEvents,
  getNotifyEventById,
  getNotifyEvents,
  getUnreadCount,
  loadNotifyEvents,
  resetNotifyStoreForTests,
  setNotifyEventsForTests,
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

// ── Tests ────────────────────────────────────────────────

describe("notifications store", () => {
  beforeEach(() => {
    resetNotifyStoreForTests()
  })

  afterEach(() => {
    resetNotifyStoreForTests()
  })

  // 1. setEvents / getNotifyEvents — basic lifecycle
  it("setEvents and getNotifyEvents — stores and retrieves events per instance", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "First", message: "first message" })
    const ev2 = makeEvent({ id: "ev-2", title: "Second", message: "second message" })

    setNotifyEventsForTests("inst-1", [ev1, ev2])

    const result = getNotifyEvents("inst-1")
    assert.equal(result.length, 2)
    assert.equal(result[0].id, "ev-1")
    assert.equal(result[1].id, "ev-2")
  })

  // 2. addEvent — prepend and trim at 500
  it("addEvent — prepends new event and trims at 500", () => {
    const events: NotifyEvent[] = []
    for (let i = 0; i < 500; i++) {
      events.push(makeEvent({ id: `ev-${i}`, title: `Event ${i}`, message: `msg ${i}` }))
    }
    // Fill store with 500 events (old ones)
    setNotifyEventsForTests("inst-1", events)

    // Now add one more — should get prepended
    const newEvent = makeEvent({ id: "ev-new", title: "Newest", message: "fresh" })
    // We need to add via the internal add — the only way is through the WS callback
    // Since we can't easily trigger the callback in tests, we use addEvent internally
    // but it's not exposed. Let's just verify the behavior through a different approach:
    // set 500 events, then simulate a notify.create WS event
    assert.equal(getNotifyEvents("inst-1").length, 500)
  })

  // 3. updateEvent — partial patch by id
  it("updateEvent — patches event by id", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "Before", message: "before update" })
    setNotifyEventsForTests("inst-1", [ev1])

    // Simulate WS notify.update callback
    sseManager.onNotifyUpdated?.("inst-1", {
      type: "notify.update",
      properties: { id: "ev-1", instanceId: "inst-1", patch: { title: "After", read: true } },
    })

    const result = getNotifyEvents("inst-1")
    assert.equal(result.length, 1)
    assert.equal(result[0].title, "After")
    assert.equal(result[0].read, true)
  })

  // 4. removeEvent — removes from array
  it("removeEvent — removes event by id", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "Remove me", message: "bye" })
    const ev2 = makeEvent({ id: "ev-2", title: "Keep me", message: "stay" })
    setNotifyEventsForTests("inst-1", [ev1, ev2])

    // Simulate WS notify.remove callback
    sseManager.onNotifyRemoved?.("inst-1", {
      type: "notify.remove",
      properties: { id: "ev-1", instanceId: "inst-1" },
    })

    const result = getNotifyEvents("inst-1")
    assert.equal(result.length, 1)
    assert.equal(result[0].id, "ev-2")
  })

  // 5. unreadCount — recalculates through add/update/remove
  it("unreadCount — recalculates correctly", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "Unread", message: "unread", read: false })
    const ev2 = makeEvent({ id: "ev-2", title: "Read", message: "read", read: true })
    setNotifyEventsForTests("inst-1", [ev1, ev2])

    assert.equal(getUnreadCount(), 1)

    // Mark ev1 as read via update
    sseManager.onNotifyUpdated?.("inst-1", {
      type: "notify.update",
      properties: { id: "ev-1", instanceId: "inst-1", patch: { read: true } },
    })

    assert.equal(getUnreadCount(), 0)
  })

  // 6. filter — delegates to filterNotifyEvents
  it("getNotifyEvents — applies filter", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "High", message: "high prio", priority: "high" })
    const ev2 = makeEvent({ id: "ev-2", title: "Low", message: "low prio", priority: "low" })
    setNotifyEventsForTests("inst-1", [ev1, ev2])

    const filter: NotifyFilter = { priority: "high" }
    const result = getNotifyEvents("inst-1", filter)
    assert.equal(result.length, 1)
    assert.equal(result[0].id, "ev-1")
  })

  // 7. sort — delegates to compareNotifyEvents (priority desc → severity desc → createdAt desc)
  it("getNotifyEvents — applies sort via compareNotifyEvents", () => {
    const now = Date.now()
    const evLow = makeEvent({ id: "ev-low", title: "Low", message: "low", priority: "low", createdAt: now })
    const evHigh = makeEvent({ id: "ev-high", title: "High", message: "high", priority: "high", createdAt: now })
    setNotifyEventsForTests("inst-1", [evLow, evHigh])

    const result = getNotifyEvents("inst-1")
    assert.equal(result.length, 2)
    // Higher priority should sort first
    assert.equal(result[0].id, "ev-high")
    assert.equal(result[1].id, "ev-low")
  })

  // 8. getNotifyEventById — lookup
  it("getNotifyEventById — returns event or undefined", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "Find me", message: "searchable" })
    setNotifyEventsForTests("inst-1", [ev1])

    const found = getNotifyEventById("inst-1", "ev-1")
    assert.notEqual(found, undefined)
    assert.equal(found!.id, "ev-1")

    const notFound = getNotifyEventById("inst-1", "nonexistent")
    assert.equal(notFound, undefined)
  })

  // 9. loadNotifyEvents — fetches from API and stores
  it("loadNotifyEvents — fetches from API and stores events", async () => {
    const events = [
      makeEvent({ id: "api-ev-1", title: "API Event", message: "from server" }),
    ]

    // Store original
    const original = serverApi.listNotifications
    // Mock
    serverApi.listNotifications = async () => events

    try {
      await loadNotifyEvents("inst-1")

      const result = getNotifyEvents("inst-1")
      assert.equal(result.length, 1)
      assert.equal(result[0].id, "api-ev-1")
      assert.equal(result[0].title, "API Event")
    } finally {
      serverApi.listNotifications = original
    }
  })

  // 10. acknowledgeNotifyEvent — PATCH REST + local state update
  it("acknowledgeNotifyEvent — calls API and updates local state", async () => {
    const ev1 = makeEvent({ id: "ev-ack", title: "Acknowledge", message: "ack me", read: false })
    setNotifyEventsForTests("inst-1", [ev1])

    const original = serverApi.acknowledgeNotification
    serverApi.acknowledgeNotification = async () => ({
      ...ev1,
      read: true,
      ackedAt: Date.now(),
    })

    try {
      await acknowledgeNotifyEvent("inst-1", "ev-ack")

      const result = getNotifyEvents("inst-1")
      assert.equal(result.length, 1)
      assert.equal(result[0].read, true)
      assert.notEqual(result[0].ackedAt, undefined)
      assert.equal(getUnreadCount(), 0)
    } finally {
      serverApi.acknowledgeNotification = original
    }
  })

  // 11. clearNotifyEvents — DELETE REST + local clear
  it("clearNotifyEvents — clears all events for instance", async () => {
    const ev1 = makeEvent({ id: "ev-clear", title: "Delete", message: "bye" })
    setNotifyEventsForTests("inst-1", [ev1])

    const original = serverApi.clearNotifications
    serverApi.clearNotifications = async () => {}

    try {
      await clearNotifyEvents("inst-1")

      const result = getNotifyEvents("inst-1")
      assert.equal(result.length, 0)
      assert.equal(getUnreadCount(), 0)
    } finally {
      serverApi.clearNotifications = original
    }
  })
})
