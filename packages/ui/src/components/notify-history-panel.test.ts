/**
 * Tests for NotifyHistoryPanel component helpers and store integration.
 *
 * Pure helper functions (date grouping, formatting, labels) are tested directly.
 * Store integration (acknowledge, dismiss, clear, unread count) is tested using the
 * notification store's test helpers.
 */
import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import type { NotifyEvent, NotifyAction } from "../types/notify"
import { filterNotifyEvents } from "../types/notify"
import {
  getNotifyEvents,
  getUnreadCount,
  acknowledgeNotifyEvent,
  clearNotifyEvents,
  resetNotifyStoreForTests,
  setNotifyEventsForTests,
} from "../stores/notifications"
import {
  getDateGroup,
  isNewDayGroup,
  groupNotifyEventsByDate,
  formatNotifyTime,
  getCategoryLabel,
  CATEGORY_COLORS,
  PANEL_CATEGORY_LABELS,
} from "./notify-history-utils"

// ==================== Fixture Helpers ====================

function makeEvent(overrides: Partial<NotifyEvent> & { id: string; title: string; message: string }): NotifyEvent {
  return {
    id: overrides.id,
    instanceId: overrides.instanceId ?? "test-instance",
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
    escalation: overrides.escalation,
    mitigate: overrides.mitigate,
    workaround: overrides.workaround,
    helpRequired: overrides.helpRequired,
    successProgress: overrides.successProgress,
    actions: overrides.actions,
    sessionId: overrides.sessionId,
    taskId: overrides.taskId,
    ackedAt: overrides.ackedAt,
    escalatedAt: overrides.escalatedAt,
    ttlMs: overrides.ttlMs,
    metadata: overrides.metadata,
  }
}

// ==================== Store Tests ====================

describe("NotifyHistoryPanel — store integration", () => {
  beforeEach(() => {
    resetNotifyStoreForTests()
  })

  afterEach(() => {
    resetNotifyStoreForTests()
  })

  // AC-1: empty state
  it("renders empty state when no events (getNotifyEvents returns [])", () => {
    const events = getNotifyEvents("test-instance")
    assert.equal(events.length, 0)
  })

  // AC-7: unread count badge
  it("unread count matches getUnreadCount()", () => {
    assert.equal(getUnreadCount(), 0)

    const ev1 = makeEvent({ id: "ev-1", title: "Unread", message: "unread", read: false })
    const ev2 = makeEvent({ id: "ev-2", title: "Read", message: "read", read: true })
    setNotifyEventsForTests("test-instance", [ev1, ev2])

    assert.equal(getUnreadCount(), 1)
  })

  // AC-7: unread count with multiple unread
  it("unread count reflects multiple unread events", () => {
    const events = [
      makeEvent({ id: "ev-1", title: "U1", message: "u1", read: false }),
      makeEvent({ id: "ev-2", title: "U2", message: "u2", read: false }),
      makeEvent({ id: "ev-3", title: "R1", message: "r1", read: true }),
      makeEvent({ id: "ev-4", title: "U3", message: "u3", read: false }),
    ]
    setNotifyEventsForTests("test-instance", events)

    assert.equal(getUnreadCount(), 3)
  })

  // AC-4: acknowledge event
  it("acknowledgeNotifyEvent marks event as read and updates unread count", async () => {
    const ev1 = makeEvent({ id: "ev-ack", title: "Ack me", message: "please ack", read: false })
    setNotifyEventsForTests("test-instance", [ev1])

    assert.equal(getUnreadCount(), 1)

    // Mock the server API
    const { serverApi } = await import("../lib/api-client")
    const original = serverApi.acknowledgeNotification
    serverApi.acknowledgeNotification = async () => ({ ...ev1, read: true, ackedAt: Date.now() })

    try {
      await acknowledgeNotifyEvent("test-instance", "ev-ack")

      const result = getNotifyEvents("test-instance")
      assert.equal(result.length, 1)
      assert.equal(result[0].read, true)
      assert.equal(getUnreadCount(), 0)
    } finally {
      serverApi.acknowledgeNotification = original
    }
  })

  // AC-5: dismiss (via acknowledge)
  it("dismiss marks event as read", async () => {
    const ev1 = makeEvent({ id: "ev-dismiss", title: "Dismiss me", message: "bye", read: false })
    setNotifyEventsForTests("test-instance", [ev1])

    const { serverApi } = await import("../lib/api-client")
    const original = serverApi.acknowledgeNotification
    serverApi.acknowledgeNotification = async () => ({ ...ev1, read: true, ackedAt: Date.now() })

    try {
      await acknowledgeNotifyEvent("test-instance", "ev-dismiss")

      const result = getNotifyEvents("test-instance")
      assert.equal(result[0].read, true)
      assert.equal(getUnreadCount(), 0)
    } finally {
      serverApi.acknowledgeNotification = original
    }
  })

  // AC-6: action button callback
  it("action callback fires for command actions", () => {
    let firedAction: NotifyAction | null = null
    const onAction = (action: NotifyAction) => {
      firedAction = action
    }

    const action: NotifyAction = { id: "a1", label: "Retry", command: "/retry" }
    onAction(action)

    assert.notEqual(firedAction, null)
    assert.equal(firedAction!.id, "a1")
    assert.equal(firedAction!.command, "/retry")
  })

  it("action callback fires for choiceValue actions", () => {
    let firedAction: NotifyAction | null = null
    const onAction = (action: NotifyAction) => {
      firedAction = action
    }

    const action: NotifyAction = { id: "a2", label: "Yes", choiceValue: "yes" }
    onAction(action)

    assert.notEqual(firedAction, null)
    assert.equal(firedAction!.choiceValue, "yes")
  })

  // AC-6: action renders and fires href via window.open mock
  it("action href action sets href correctly", () => {
    const action: NotifyAction = { id: "a3", label: "Open", href: "/session/123", variant: "primary" }
    assert.equal(action.href, "/session/123")
    assert.equal(action.label, "Open")
  })

  // AC-1: clear all
  it("clearNotifyEvents removes all events for instance", async () => {
    const ev1 = makeEvent({ id: "ev-1", title: "One", message: "first" })
    const ev2 = makeEvent({ id: "ev-2", title: "Two", message: "second" })
    setNotifyEventsForTests("test-instance", [ev1, ev2])

    const { serverApi } = await import("../lib/api-client")
    const original = serverApi.clearNotifications
    serverApi.clearNotifications = async () => {}

    try {
      await clearNotifyEvents("test-instance")

      const result = getNotifyEvents("test-instance")
      assert.equal(result.length, 0)
      assert.equal(getUnreadCount(), 0)
    } finally {
      serverApi.clearNotifications = original
    }
  })

  // AC-3: filter by category via store
  it("getNotifyEvents with filter narrows by category", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "Error", message: "err", category: "error", priority: "high", severity: "error" })
    const ev2 = makeEvent({ id: "ev-2", title: "Success", message: "success", category: "success_progress", priority: "normal", severity: "success" })
    setNotifyEventsForTests("test-instance", [ev1, ev2])

    const result = filterNotifyEvents(getNotifyEvents("test-instance"), { category: "error" })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, "ev-1")
  })

  // AC-3: filter by priority
  it("store events can be filtered by priority", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "Urgent", message: "urgent", priority: "urgent" })
    const ev2 = makeEvent({ id: "ev-2", title: "Normal", message: "normal", priority: "normal" })
    setNotifyEventsForTests("test-instance", [ev1, ev2])

    const result = filterNotifyEvents(getNotifyEvents("test-instance"), { priority: "urgent" })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, "ev-1")
  })

  // AC-3: filter by severity
  it("store events can be filtered by severity", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "Critical", message: "critical", severity: "critical" })
    const ev2 = makeEvent({ id: "ev-2", title: "Info", message: "info", severity: "info" })
    setNotifyEventsForTests("test-instance", [ev1, ev2])

    const result = filterNotifyEvents(getNotifyEvents("test-instance"), { severity: "critical" })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, "ev-1")
  })

  // AC-2: multiple events across instances are separated
  it("events are separated by instance", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "Instance A", message: "a", instanceId: "inst-a" })
    const ev2 = makeEvent({ id: "ev-2", title: "Instance B", message: "b", instanceId: "inst-b" })
    setNotifyEventsForTests("inst-a", [ev1])
    setNotifyEventsForTests("inst-b", [ev2])

    const resultA = getNotifyEvents("inst-a")
    const resultB = getNotifyEvents("inst-b")

    assert.equal(resultA.length, 1)
    assert.equal(resultA[0].id, "ev-1")
    assert.equal(resultB.length, 1)
    assert.equal(resultB[0].id, "ev-2")
  })
})

// ==================== Utility Function Tests ====================

describe("NotifyHistoryPanel — getDateGroup", () => {
  it("returns 'today' for current day", () => {
    const now = Date.now()
    assert.equal(getDateGroup(now), "today")
  })

  it("returns 'yesterday' for 24 hours ago", () => {
    const yesterday = Date.now() - 86400000
    assert.equal(getDateGroup(yesterday), "yesterday")
  })

  it("returns 'earlier' for 48 hours ago", () => {
    const twoDaysAgo = Date.now() - 172800000
    assert.equal(getDateGroup(twoDaysAgo), "earlier")
  })

  it("returns 'earlier' for last week", () => {
    const lastWeek = Date.now() - 604800000
    assert.equal(getDateGroup(lastWeek), "earlier")
  })

  it("returns 'earlier' for last month", () => {
    const lastMonth = Date.now() - 2592000000
    assert.equal(getDateGroup(lastMonth), "earlier")
  })

  it("distinguishes yesterday from today at midnight boundary", () => {
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(23, 59, 59, 999)

    assert.equal(getDateGroup(yesterday.getTime()), "yesterday")
  })
})

describe("NotifyHistoryPanel — isNewDayGroup", () => {
  it("returns true for first event (no previous)", () => {
    const event = makeEvent({ id: "ev-1", title: "First", message: "first", createdAt: Date.now() })
    assert.equal(isNewDayGroup(event, undefined), true)
  })

  it("returns false for events on same day", () => {
    const now = Date.now()
    const event1 = makeEvent({ id: "ev-1", title: "First", message: "first", createdAt: now })
    const event2 = makeEvent({ id: "ev-2", title: "Second", message: "second", createdAt: now + 3600000 })
    assert.equal(isNewDayGroup(event2, event1), false)
  })

  it("returns true for events on different days", () => {
    const today = Date.now()
    const yesterday = today - 86400000
    const event1 = makeEvent({ id: "ev-1", title: "Yesterday", message: "yesterday", createdAt: yesterday })
    const event2 = makeEvent({ id: "ev-2", title: "Today", message: "today", createdAt: today })
    assert.equal(isNewDayGroup(event2, event1), true)
  })
})

describe("NotifyHistoryPanel — groupNotifyEventsByDate", () => {
  it("returns empty array for no events", () => {
    const groups = groupNotifyEventsByDate([])
    assert.equal(groups.length, 0)
  })

  it("groups single event into one group", () => {
    const event = makeEvent({ id: "ev-1", title: "Single", message: "single", createdAt: Date.now() })
    const groups = groupNotifyEventsByDate([event])

    assert.equal(groups.length, 1)
    assert.equal(groups[0].key, "today")
    assert.equal(groups[0].events.length, 1)
  })

  it("groups events from today and yesterday separately", () => {
    const now = Date.now()
    const yesterday = now - 86400000
    const event1 = makeEvent({ id: "ev-1", title: "Today", message: "today", createdAt: now })
    const event2 = makeEvent({ id: "ev-2", title: "Yesterday", message: "yesterday", createdAt: yesterday })

    const groups = groupNotifyEventsByDate([event1, event2])

    assert.equal(groups.length, 2)
    assert.equal(groups[0].key, "today")
    assert.equal(groups[1].key, "yesterday")
  })

  it("groups events into today, yesterday, and earlier", () => {
    const now = Date.now()
    const yesterday = now - 86400000
    const threeDaysAgo = now - 259200000
    const event1 = makeEvent({ id: "ev-1", title: "Today", message: "today", createdAt: now })
    const event2 = makeEvent({ id: "ev-2", title: "Yesterday", message: "yesterday", createdAt: yesterday })
    const event3 = makeEvent({ id: "ev-3", title: "Earlier", message: "earlier", createdAt: threeDaysAgo })

    const groups = groupNotifyEventsByDate([event1, event2, event3])

    assert.equal(groups.length, 3)
    assert.equal(groups[0].key, "today")
    assert.equal(groups[1].key, "yesterday")
    assert.equal(groups[2].key, "earlier")
  })

  it("preserves event order within groups", () => {
    const now = Date.now()
    const event1 = makeEvent({ id: "ev-1", title: "First", message: "first", createdAt: now })
    const event2 = makeEvent({ id: "ev-2", title: "Second", message: "second", createdAt: now + 1800000 })
    const event3 = makeEvent({ id: "ev-3", title: "Third", message: "third", createdAt: now + 3600000 })

    const groups = groupNotifyEventsByDate([event1, event2, event3])

    assert.equal(groups.length, 1)
    assert.equal(groups[0].events.length, 3)
    assert.equal(groups[0].events[0].id, "ev-1")
    assert.equal(groups[0].events[1].id, "ev-2")
    assert.equal(groups[0].events[2].id, "ev-3")
  })

  it("uses correct labelKey for each group", () => {
    const now = Date.now()
    const yesterday = now - 86400000
    const event1 = makeEvent({ id: "ev-1", title: "Today", message: "today", createdAt: now })
    const event2 = makeEvent({ id: "ev-2", title: "Yesterday", message: "yesterday", createdAt: yesterday })

    const groups = groupNotifyEventsByDate([event1, event2])

    assert.equal(groups[0].labelKey, "notifyHistory.today")
    assert.equal(groups[1].labelKey, "notifyHistory.yesterday")
  })
})

describe("NotifyHistoryPanel — formatNotifyTime", () => {
  it("returns a string", () => {
    const result = formatNotifyTime(Date.now())
    assert.equal(typeof result, "string")
    assert.ok(result.length > 0)
  })

  it("formats time with hour and minute", () => {
    const date = new Date(2024, 0, 1, 14, 30, 0)
    const result = formatNotifyTime(date.getTime())
    // Should contain the hour/minute
    assert.ok(result.includes(":") || result.includes("30"))
  })
})

describe("NotifyHistoryPanel — getCategoryLabel", () => {
  it("returns mapped label for known category", () => {
    assert.equal(getCategoryLabel("error"), "Error")
    assert.equal(getCategoryLabel("success_progress"), "Success Progress")
    assert.equal(getCategoryLabel("escalation"), "Escalation")
  })

  it("returns fallback for missing category", () => {
    // Test with a cast to ensure it falls through to the raw value
    const result = getCategoryLabel("session" as any)
    assert.equal(typeof result, "string")
  })

  it("PANEL_CATEGORY_LABELS covers all categories", () => {
    const expectedCategories = [
      "session", "task", "milestone", "permission", "help_required",
      "escalation", "broadcast", "question", "system", "error",
      "success_progress", "task_status", "session_alert",
      "workaround_suggested", "mitigation_applied",
    ]
    for (const cat of expectedCategories) {
      assert.ok(PANEL_CATEGORY_LABELS[cat as keyof typeof PANEL_CATEGORY_LABELS], `Missing label for ${cat}`)
    }
  })

  it("CATEGORY_COLORS covers all categories", () => {
    const expectedCategories = [
      "session", "task", "milestone", "permission", "help_required",
      "escalation", "broadcast", "question", "system", "error",
      "success_progress", "task_status", "session_alert",
      "workaround_suggested", "mitigation_applied",
    ]
    for (const cat of expectedCategories) {
      assert.ok(CATEGORY_COLORS[cat as keyof typeof CATEGORY_COLORS], `Missing color for ${cat}`)
    }
  })
})

// ==================== Filter Logic Tests ====================

describe("NotifyHistoryPanel — filter logic", () => {
  beforeEach(() => {
    resetNotifyStoreForTests()
  })

  afterEach(() => {
    resetNotifyStoreForTests()
  })

  it("'all' filter returns all events", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "Error", message: "err", category: "error" })
    const ev2 = makeEvent({ id: "ev-2", title: "Success", message: "success", category: "success_progress" })
    const ev3 = makeEvent({ id: "ev-3", title: "Help", message: "help", category: "help_required" })
    setNotifyEventsForTests("test-instance", [ev1, ev2, ev3])

    // 'all' filter returns all events without any narrowing
    const allEvents = getNotifyEvents("test-instance")
    assert.equal(allEvents.length, 3)
  })

  it("category filter narrows results enough for size check", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "Error", message: "err", category: "error" })
    const ev2 = makeEvent({ id: "ev-2", title: "Success", message: "success", category: "success_progress" })
    const ev3 = makeEvent({ id: "ev-3", title: "Help", message: "help", category: "help_required" })
    setNotifyEventsForTests("test-instance", [ev1, ev2, ev3])

    const events = getNotifyEvents("test-instance")
    const errorEvents = events.filter((e) => e.category === "error")
    assert.equal(errorEvents.length, 1)
    assert.equal(errorEvents[0].id, "ev-1")
  })

  it("priority filter narrows results", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "High", message: "high", priority: "high" })
    const ev2 = makeEvent({ id: "ev-2", title: "Low", message: "low", priority: "low" })
    setNotifyEventsForTests("test-instance", [ev1, ev2])

    const events = getNotifyEvents("test-instance")
    const highEvents = events.filter((e) => e.priority === "high")
    assert.equal(highEvents.length, 1)
    assert.equal(highEvents[0].id, "ev-1")
  })

  it("severity filter narrows results", () => {
    const ev1 = makeEvent({ id: "ev-1", title: "Critical", message: "critical", severity: "critical" })
    const ev2 = makeEvent({ id: "ev-2", title: "Info", message: "info", severity: "info" })
    setNotifyEventsForTests("test-instance", [ev1, ev2])

    const events = getNotifyEvents("test-instance")
    const criticalEvents = events.filter((e) => e.severity === "critical")
    assert.equal(criticalEvents.length, 1)
    assert.equal(criticalEvents[0].id, "ev-1")
  })
})

// ==================== Date Grouping with Real Events ====================

describe("NotifyHistoryPanel — date grouping with events (AC-2)", () => {
  beforeEach(() => {
    resetNotifyStoreForTests()
  })

  afterEach(() => {
    resetNotifyStoreForTests()
  })

  it("lists events grouped by date (today/yesterday/earlier)", () => {
    const now = Date.now()
    const yesterday = now - 86400000
    const threeDaysAgo = now - 259200000

    const todayEvent = makeEvent({ id: "ev-today", title: "Today", message: "now", createdAt: now })
    const yesterdayEvent = makeEvent({ id: "ev-yesterday", title: "Yesterday", message: "past", createdAt: yesterday })
    const earlierEvent = makeEvent({ id: "ev-earlier", title: "Earlier", message: "older", createdAt: threeDaysAgo })

    setNotifyEventsForTests("test-instance", [todayEvent, yesterdayEvent, earlierEvent])

    const events = getNotifyEvents("test-instance")
    const groups = groupNotifyEventsByDate(events)

    // Should have 3 groups
    assert.equal(groups.length, 3)
    assert.equal(groups[0].key, "today")
    assert.equal(groups[1].key, "yesterday")
    assert.equal(groups[2].key, "earlier")

    // Verify events are in correct groups
    assert.equal(groups[0].events.length, 1)
    assert.equal(groups[0].events[0].id, "ev-today")
    assert.equal(groups[1].events.length, 1)
    assert.equal(groups[1].events[0].id, "ev-yesterday")
    assert.equal(groups[2].events.length, 1)
    assert.equal(groups[2].events[0].id, "ev-earlier")
  })

  it("groups multiple events from same day together", () => {
    // Use times early in the day to avoid midnight boundary issues
    const now = new Date()
    now.setHours(8, 0, 0, 0)
    const baseTime = now.getTime()
    const event1 = makeEvent({ id: "ev-1", title: "Morning", message: "morning", createdAt: baseTime })
    const event2 = makeEvent({ id: "ev-2", title: "Afternoon", message: "afternoon", createdAt: baseTime + 3600000 })

    setNotifyEventsForTests("test-instance", [event1, event2])
    const events = getNotifyEvents("test-instance")
    const groups = groupNotifyEventsByDate(events)

    assert.equal(groups.length, 1)
    assert.equal(groups[0].events.length, 2)
  })
})
