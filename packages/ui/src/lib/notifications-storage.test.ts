import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'

import { generateNotifyId, type NotifyEvent, type NotifySeverity, type NotifyPriority } from '../types/notify'
import {
  addStoredNotification,
  ackStoredNotification,
  clearStoredNotifications,
  escalateStoredNotification,
  loadNotifications,
  NOTIFY_DEFAULT_TTL_MS,
  NOTIFY_EVENT_PRIORITY,
  NOTIFY_EVENT_SEVERITY,
  NOTIFY_STORAGE_CAP,
  NOTIFY_STORAGE_SCHEMA_VERSION,
  NOTIFY_STORAGE_KEY_PREFIX,
  queryStoredNotifications,
  removeExpired,
  removeStoredNotification,
  saveNotifications,
  storageKeyForInstance,
  trimToCapacity,
  updateStoredNotification,
} from './notifications-storage'

// ==================== Mock localStorage ====================

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  ;(globalThis as any).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
      get length() { return store.size },
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
    },
  }
})

afterEach(() => {
  delete (globalThis as any).window
})

// ==================== Fixture Helpers ====================

function makeEvent(overrides: Partial<NotifyEvent> = {}): NotifyEvent {
  return {
    id: generateNotifyId(),
    instanceId: 'test-instance',
    source: 'manual',
    category: 'session',
    priority: 'normal',
    severity: 'info',
    eventType: 'TEST_EVENT',
    title: 'Test Notification',
    message: 'This is a test notification.',
    createdAt: Date.now(),
    read: false,
    schemaVersion: NOTIFY_STORAGE_SCHEMA_VERSION,
    ...overrides,
  }
}

// ==================== Storage Key ====================

describe('storageKeyForInstance', () => {
  it('builds key with prefix and instance id', () => {
    assert.equal(storageKeyForInstance('my-instance'), `${NOTIFY_STORAGE_KEY_PREFIX}my-instance`)
  })
})

// ==================== Pure Utility Tests (no localStorage needed) ====================

describe('trimToCapacity', () => {
  it('keeps all events under cap', () => {
    const events = Array.from({ length: 10 }, (_, i) => makeEvent({ id: String(i), createdAt: i * 1000 }))
    const result = trimToCapacity(events, 500)
    assert.equal(result.length, 10)
  })

  it('trims to cap when over limit', () => {
    const events = Array.from({ length: 100 }, (_, i) => makeEvent({ id: String(i), createdAt: i * 1000 }))
    const result = trimToCapacity(events, 10)
    assert.equal(result.length, 10)
  })

  it('keeps newest events when trimming', () => {
    const events = Array.from({ length: 20 }, (_, i) => makeEvent({ id: String(i), createdAt: i * 1000 }))
    const result = trimToCapacity(events, 5)
    assert.equal(result.length, 5)
    // Should keep highest createdAt values
    const ids = result.map((e) => Number(e.id)).sort((a, b) => a - b)
    assert.deepEqual(ids, [15, 16, 17, 18, 19])
  })

  it('defaults to NOTIFY_STORAGE_CAP', () => {
    const events = Array.from({ length: NOTIFY_STORAGE_CAP + 50 }, (_, i) => makeEvent({ id: String(i), createdAt: i * 1000 }))
    const result = trimToCapacity(events)
    assert.equal(result.length, NOTIFY_STORAGE_CAP)
  })
})

describe('removeExpired', () => {
  it('removes events past their ttlMs', () => {
    const now = 1_000_000_000
    const fresh = makeEvent({ id: 'fresh', ttlMs: 60_000, createdAt: now - 30_000 })
    const stale = makeEvent({ id: 'stale', ttlMs: 60_000, createdAt: now - 120_000 })
    const result = removeExpired([fresh, stale], now)
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'fresh')
  })

  it('keeps events with no ttlMs', () => {
    const event = makeEvent()
    const result = removeExpired([event])
    assert.equal(result.length, 1)
  })
})

describe('NOTIFY_EVENT_SEVERITY', () => {
  it('provides defaults for common event types', () => {
    assert.equal(NOTIFY_EVENT_SEVERITY['SESSION_ERROR'], 'error')
    assert.equal(NOTIFY_EVENT_SEVERITY['NODE_FAILED'], 'error')
    assert.equal(NOTIFY_EVENT_SEVERITY['WORKFLOW_COMPLETED'], 'success')
    assert.equal(NOTIFY_EVENT_SEVERITY['ESCALATION_RECOMMENDED'], 'critical')
  })
})

describe('NOTIFY_EVENT_PRIORITY', () => {
  it('provides defaults for common event types', () => {
    assert.equal(NOTIFY_EVENT_PRIORITY['SESSION_IDLE'], 'low')
    assert.equal(NOTIFY_EVENT_PRIORITY['SESSION_ERROR'], 'high')
    assert.equal(NOTIFY_EVENT_PRIORITY['ESCALATION_RECOMMENDED'], 'urgent')
  })
})

// ==================== Persistence Tests (with mock localStorage) ====================

describe('saveNotifications / loadNotifications', () => {
  it('stores and retrieves events', () => {
    const event = makeEvent()
    saveNotifications('test-instance', [event])
    const loaded = loadNotifications('test-instance')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, event.id)
  })

  it('returns empty array when no data stored', () => {
    const loaded = loadNotifications('missing-instance')
    assert.equal(loaded.length, 0)
  })

  it('drops data on schema version mismatch', () => {
    const key = storageKeyForInstance('test-instance')
    const badPayload = JSON.stringify({
      schemaVersion: 999,
      instanceId: 'test-instance',
      events: [makeEvent()],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    window.localStorage.setItem(key, badPayload)

    const loaded = loadNotifications('test-instance')
    assert.equal(loaded.length, 0)
    // Key should be removed
    assert.equal(window.localStorage.getItem(key), null)
  })

  it('removes expired events on load', () => {
    const stale = makeEvent({ id: 'stale', ttlMs: 60_000, createdAt: Date.now() - 120_000 })
    const fresh = makeEvent({ id: 'fresh', ttlMs: NOTIFY_DEFAULT_TTL_MS, createdAt: Date.now() })
    saveNotifications('test-instance', [stale, fresh])

    // Time-travel so stale has expired
    const loaded = loadNotifications('test-instance')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, 'fresh')
  })

  it('survives JSON parse errors gracefully', () => {
    const key = storageKeyForInstance('test-instance')
    window.localStorage.setItem(key, 'not-json')
    const loaded = loadNotifications('test-instance')
    assert.equal(loaded.length, 0)
  })
})

describe('addStoredNotification', () => {
  it('adds an event and persists it', () => {
    const event = makeEvent()
    addStoredNotification('test-instance', event)
    const loaded = loadNotifications('test-instance')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, event.id)
  })

  it('pre-pends events (newest first)', () => {
    const a = makeEvent({ id: 'a', createdAt: 100 })
    const b = makeEvent({ id: 'b', createdAt: 200 })
    addStoredNotification('test-instance', b)
    addStoredNotification('test-instance', a)
    const loaded = loadNotifications('test-instance')
    assert.equal(loaded[0].id, 'a')
    assert.equal(loaded[1].id, 'b')
  })
})

describe('updateStoredNotification', () => {
  it('updates an existing event', () => {
    const event = makeEvent()
    addStoredNotification('test-instance', event)

    const updated = updateStoredNotification('test-instance', event.id, { title: 'Updated Title', read: true })
    assert.equal(updated?.title, 'Updated Title')
    assert.equal(updated?.read, true)
    assert.equal(updated?.id, event.id) // id unchanged

    // Verify persistence
    const loaded = loadNotifications('test-instance')
    assert.equal(loaded[0].title, 'Updated Title')
  })

  it('returns undefined for missing id', () => {
    const result = updateStoredNotification('test-instance', 'nonexistent', { title: 'Nope' })
    assert.equal(result, undefined)
  })
})

describe('removeStoredNotification', () => {
  it('removes an event by id', () => {
    const a = makeEvent({ id: 'a' })
    const b = makeEvent({ id: 'b' })
    addStoredNotification('test-instance', a)
    addStoredNotification('test-instance', b)

    const removed = removeStoredNotification('test-instance', 'a')
    assert.equal(removed, true)

    const loaded = loadNotifications('test-instance')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, 'b')
  })

  it('returns false for missing id', () => {
    assert.equal(removeStoredNotification('test-instance', 'nonexistent'), false)
  })
})

describe('ackStoredNotification', () => {
  it('marks event as read with ackedAt', () => {
    const event = makeEvent()
    addStoredNotification('test-instance', event)

    const acked = ackStoredNotification('test-instance', event.id)
    assert.equal(acked?.read, true)
    assert.equal(typeof acked?.ackedAt, 'number')

    const loaded = loadNotifications('test-instance')
    assert.equal(loaded[0].read, true)
    assert.equal(typeof loaded[0].ackedAt, 'number')
  })

  it('returns undefined for missing id', () => {
    assert.equal(ackStoredNotification('test-instance', 'nonexistent'), undefined)
  })
})

describe('escalateStoredNotification', () => {
  it('sets escalation level 1 on first escalation', () => {
    const event = makeEvent()
    addStoredNotification('test-instance', event)

    const escalated = escalateStoredNotification('test-instance', event.id, 'Needs human review')
    assert.equal(escalated?.escalation?.level, 1)
    assert.equal(escalated?.escalation?.reason, 'Needs human review')
    assert.equal(typeof escalated?.escalatedAt, 'number')
  })

  it('increments escalation level on successive escalations', () => {
    const event = makeEvent({ escalation: { level: 2, reason: 'Initial reason' } })
    addStoredNotification('test-instance', event)

    const escalated = escalateStoredNotification('test-instance', event.id, 'Escalated again')
    assert.equal(escalated?.escalation?.level, 3)
    assert.equal(escalated?.escalation?.reason, 'Escalated again')
  })

  it('returns undefined for missing id', () => {
    assert.equal(escalateStoredNotification('test-instance', 'nonexistent', 'reason'), undefined)
  })
})

describe('clearStoredNotifications', () => {
  it('removes all stored data for an instance', () => {
    addStoredNotification('test-instance', makeEvent())
    clearStoredNotifications('test-instance')

    const loaded = loadNotifications('test-instance')
    assert.equal(loaded.length, 0)
  })
})

describe('queryStoredNotifications', () => {
  const baseEvents = [
    makeEvent({ id: '1', category: 'session', priority: 'low', severity: 'info', eventType: 'SESSION_IDLE', createdAt: 100 }),
    makeEvent({ id: '2', category: 'task', priority: 'high', severity: 'error', eventType: 'TASK_FAILED', createdAt: 200 }),
    makeEvent({ id: '3', category: 'milestone', priority: 'normal', severity: 'success', eventType: 'MILESTONE_REACHED', createdAt: 300 }),
  ]

  it('returns all events with no filter', () => {
    for (const e of baseEvents) addStoredNotification('test-instance', e)
    const result = queryStoredNotifications('test-instance')
    assert.equal(result.length, 3)
  })

  it('filters by category', () => {
    for (const e of baseEvents) addStoredNotification('test-instance', e)
    const result = queryStoredNotifications('test-instance', { category: 'task' })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, '2')
  })

  it('sorts by priority desc', () => {
    // Ensure no stale data from prior tests by using a fresh instance
    for (const e of baseEvents) addStoredNotification('test-query-sort', e)
    const result = queryStoredNotifications('test-query-sort')
    assert.equal(result[0].priority, 'high')  // task with high priority
    assert.equal(result[1].priority, 'normal') // milestone with normal
    assert.equal(result[2].priority, 'low')    // session with low
  })
})

// ==================== Integration Tests ====================

describe('notifications integration', () => {
  it('full lifecycle: create → ack → query → remove', () => {
    const event = makeEvent({ id: 'lifecycle-test' })
    addStoredNotification('test-int', event)

    // Query to confirm added
    let all = queryStoredNotifications('test-int')
    assert.equal(all.length, 1)

    // Ack
    const acked = ackStoredNotification('test-int', 'lifecycle-test')
    assert.equal(acked?.read, true)

    // Query unread only → empty
    const unread = queryStoredNotifications('test-int', { unreadOnly: true })
    assert.equal(unread.length, 0)

    // Remove
    const removed = removeStoredNotification('test-int', 'lifecycle-test')
    assert.equal(removed, true)

    // Query all → empty
    all = queryStoredNotifications('test-int')
    assert.equal(all.length, 0)
  })

  it('full lifecycle: create → escalate → query escalationOnly → remove', () => {
    const event = makeEvent({ id: 'escalation-test' })
    addStoredNotification('test-int-escalate', event)

    const escalated = escalateStoredNotification('test-int-escalate', 'escalation-test', 'Needs attention')
    assert.equal(escalated?.escalation?.level, 1)
    assert.equal(escalated?.helpRequired, undefined) // escalate doesn't set helpRequired

    // Query escalation only
    const escalations = queryStoredNotifications('test-int-escalate', { escalationOnly: true })
    assert.equal(escalations.length, 1)
  })
})
