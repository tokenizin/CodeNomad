import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  compareNotifyEvents,
  filterNotifyEvents,
  generateNotifyId,
  isNotifyEventExpired,
  NOTIFY_PRIORITY_ORDER,
  NOTIFY_SEVERITY_ORDER,
  type NotifyEvent,
  type NotifyPriority,
  type NotifySeverity,
} from './notify.ts'

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
    schemaVersion: 1,
    ...overrides,
  }
}

// ==================== Schema Tests ====================

describe('NotifyEvent schema', () => {
  it('creates a minimal event with required fields', () => {
    const event = makeEvent()
    assert.equal(typeof event.id, 'string')
    assert.equal(event.instanceId, 'test-instance')
    assert.equal(event.source, 'manual')
    assert.equal(event.category, 'session')
    assert.equal(event.priority, 'normal')
    assert.equal(event.severity, 'info')
    assert.equal(event.eventType, 'TEST_EVENT')
    assert.equal(event.title, 'Test Notification')
    assert.equal(event.message, 'This is a test notification.')
    assert.equal(typeof event.createdAt, 'number')
    assert.equal(event.read, false)
    assert.equal(event.schemaVersion, 1)
  })

  it('accepts all NotifyPriority values', () => {
    for (const p of ['low', 'normal', 'high', 'urgent'] as NotifyPriority[]) {
      const event = makeEvent({ priority: p })
      assert.equal(event.priority, p)
    }
  })

  it('accepts all NotifySeverity values', () => {
    for (const s of ['info', 'success', 'warning', 'error', 'critical'] as NotifySeverity[]) {
      const event = makeEvent({ severity: s })
      assert.equal(event.severity, s)
    }
  })

  it('accepts escalation metadata', () => {
    const event = makeEvent({
      escalation: {
        level: 2,
        fromAgent: 'agent-alpha',
        toAgent: 'agent-beta',
        reason: 'Retries exhausted',
        ttlMs: 300_000,
      },
    })
    assert.equal(event.escalation?.level, 2)
    assert.equal(event.escalation?.fromAgent, 'agent-alpha')
    assert.equal(event.escalation?.toAgent, 'agent-beta')
    assert.equal(event.escalation?.reason, 'Retries exhausted')
    assert.equal(event.escalation?.ttlMs, 300_000)
  })

  it('accepts actions', () => {
    const event = makeEvent({
      actions: [
        { id: 'a1', label: 'Open', href: '/session/123', variant: 'primary' },
        { id: 'a2', label: 'Dismiss', command: '/dismiss', variant: 'secondary' },
        { id: 'a3', label: 'Yes', choiceValue: 'yes' },
      ],
    })
    assert.equal(event.actions?.length, 3)
    assert.equal(event.actions![0].href, '/session/123')
    assert.equal(event.actions![1].command, '/dismiss')
    assert.equal(event.actions![2].choiceValue, 'yes')
  })

  it('accepts successProgress', () => {
    const event = makeEvent({
      successProgress: { current: 3, total: 5, unit: 'steps' },
    })
    assert.equal(event.successProgress?.current, 3)
    assert.equal(event.successProgress?.total, 5)
    assert.equal(event.successProgress?.unit, 'steps')
  })

  it('accepts helpRequired flag', () => {
    const event = makeEvent({ helpRequired: true })
    assert.equal(event.helpRequired, true)
  })

  it('accepts mitigate and workaround strings', () => {
    const event = makeEvent({
      mitigate: 'Restart the process',
      workaround: 'Use the fallback endpoint',
    })
    assert.equal(event.mitigate, 'Restart the process')
    assert.equal(event.workaround, 'Use the fallback endpoint')
  })

  it('accepts ackedAt and escalatedAt timestamps', () => {
    const now = Date.now()
    const event = makeEvent({ ackedAt: now, escalatedAt: now + 1000 })
    assert.equal(event.ackedAt, now)
    assert.equal(event.escalatedAt, now + 1000)
  })

  it('accepts ttlMs', () => {
    const event = makeEvent({ ttlMs: 60_000 })
    assert.equal(event.ttlMs, 60_000)
  })
})

// ==================== ID Generation ====================

describe('generateNotifyId', () => {
  it('returns a string', () => {
    const id = generateNotifyId()
    assert.equal(typeof id, 'string')
    assert.ok(id.length > 0)
  })

  it('returns unique values on successive calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateNotifyId())
    }
    assert.equal(ids.size, 100)
  })
})

// ==================== Expiry ====================

describe('isNotifyEventExpired', () => {
  it('returns false when no ttlMs is set', () => {
    const event = makeEvent()
    assert.equal(isNotifyEventExpired(event), false)
  })

  it('returns false when ttlMs has not elapsed', () => {
    const now = Date.now()
    const event = makeEvent({ ttlMs: 60_000, createdAt: now })
    assert.equal(isNotifyEventExpired(event, now), false)
  })

  it('returns true when ttlMs has elapsed', () => {
    const createdAt = Date.now() - 120_000
    const event = makeEvent({ ttlMs: 60_000, createdAt })
    assert.equal(isNotifyEventExpired(event, Date.now()), true)
  })
})

// ==================== Comparator ====================

describe('compareNotifyEvents', () => {
  it('sorts by priority descending', () => {
    const urgent = makeEvent({ priority: 'urgent', createdAt: 200 })
    const low = makeEvent({ priority: 'low', createdAt: 100 })
    assert.ok(compareNotifyEvents(urgent, low) < 0)
    assert.ok(compareNotifyEvents(low, urgent) > 0)
  })

  it('breaks ties by severity descending', () => {
    const highC = makeEvent({ priority: 'high', severity: 'critical', createdAt: 200 })
    const highW = makeEvent({ priority: 'high', severity: 'warning', createdAt: 100 })
    assert.ok(compareNotifyEvents(highC, highW) < 0)
    assert.ok(compareNotifyEvents(highW, highC) > 0)
  })

  it('breaks ties by createdAt descending', () => {
    const a = makeEvent({ priority: 'normal', severity: 'info', createdAt: 300 })
    const b = makeEvent({ priority: 'normal', severity: 'info', createdAt: 100 })
    assert.ok(compareNotifyEvents(a, b) < 0)
    assert.ok(compareNotifyEvents(b, a) > 0)
  })

  it('returns 0 for equal events', () => {
    const a = makeEvent({ priority: 'normal', severity: 'info', createdAt: 200 })
    const b = makeEvent({ priority: 'normal', severity: 'info', createdAt: 200 })
    assert.equal(compareNotifyEvents(a, b), 0)
  })
})

// ==================== Filter ====================

describe('filterNotifyEvents', () => {
  const events = [
    makeEvent({ id: '1', category: 'session', priority: 'low', severity: 'info', eventType: 'SESSION_IDLE', createdAt: 100 }),
    makeEvent({ id: '2', category: 'task', priority: 'high', severity: 'error', eventType: 'TASK_FAILED', createdAt: 200 }),
    makeEvent({ id: '3', category: 'milestone', priority: 'normal', severity: 'success', eventType: 'MILESTONE_REACHED', createdAt: 300 }),
    makeEvent({ id: '4', category: 'escalation', priority: 'urgent', severity: 'critical', eventType: 'ESCALATED', createdAt: 400, escalation: { level: 1, reason: 'test' } }),
    makeEvent({ id: '5', category: 'help_required', priority: 'high', severity: 'warning', eventType: 'HELP_NEEDED', createdAt: 500, helpRequired: true }),
    makeEvent({ id: '6', category: 'session', priority: 'low', severity: 'info', eventType: 'SESSION_IDLE', createdAt: 600, read: true }),
  ]

  it('returns all events with no filter', () => {
    const result = filterNotifyEvents(events)
    assert.equal(result.length, 6)
  })

  it('filters by category (single)', () => {
    const result = filterNotifyEvents(events, { category: 'task' })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, '2')
  })

  it('filters by category (multi)', () => {
    const result = filterNotifyEvents(events, { category: ['session', 'task'] })
    assert.equal(result.length, 3)
    assert.ok(result.every((e) => e.category === 'session' || e.category === 'task'))
  })

  it('filters by priority', () => {
    const result = filterNotifyEvents(events, { priority: ['high', 'urgent'] })
    assert.equal(result.length, 3)
  })

  it('filters by severity', () => {
    const result = filterNotifyEvents(events, { severity: ['error', 'critical'] })
    assert.equal(result.length, 2)
  })

  it('filters by eventType exact match', () => {
    const result = filterNotifyEvents(events, { eventType: 'TASK_FAILED' })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, '2')
  })

  it('filters by eventTypePattern regex', () => {
    const result = filterNotifyEvents(events, { eventTypePattern: 'SESSION|MILESTONE' })
    assert.equal(result.length, 3)
  })

  it('filters unreadOnly', () => {
    const result = filterNotifyEvents(events, { unreadOnly: true })
    assert.equal(result.length, 5)
    assert.ok(result.every((e) => !e.read))
  })

  it('filters helpRequired', () => {
    const result = filterNotifyEvents(events, { helpRequired: true })
    assert.equal(result.length, 1)
  })

  it('filters escalationOnly', () => {
    const result = filterNotifyEvents(events, { escalationOnly: true })
    assert.equal(result.length, 1)
  })

  it('filters by since timestamp', () => {
    const result = filterNotifyEvents(events, { since: 400 })
    assert.ok(result.every((e) => e.createdAt >= 400))
  })

  it('filters by until timestamp', () => {
    const result = filterNotifyEvents(events, { until: 300 })
    assert.ok(result.every((e) => e.createdAt <= 300))
  })

  it('paginates with limit', () => {
    const result = filterNotifyEvents(events, { limit: 2 })
    assert.equal(result.length, 2)
  })

  it('paginates with offset', () => {
    const result = filterNotifyEvents(events, { offset: 4, limit: 10 })
    assert.equal(result.length, 2)
  })

  it('sorts by priority desc → severity desc → createdAt desc', () => {
    const result = filterNotifyEvents(events)
    // Highest priority first
    assert.equal(result[0].priority, 'urgent')
    assert.equal(result[1].priority, 'high')
    assert.equal(result[2].priority, 'high')
    assert.equal(result[3].priority, 'normal')
    assert.equal(result[4].priority, 'low')
    assert.equal(result[5].priority, 'low')
    // Among low priority, descending createdAt
    assert.ok(result[4].createdAt >= result[5].createdAt)
  })

  it('returns empty array when no events match', () => {
    const result = filterNotifyEvents(events, { eventType: 'NONEXISTENT' })
    assert.equal(result.length, 0)
  })

  it('handles combined filters', () => {
    // unread + category session
    const result = filterNotifyEvents(events, { category: 'session', unreadOnly: true })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, '1')
  })
})

// ==================== Lookup Table Integrity ====================

describe('lookup table integrity', () => {
  it('NOTIFY_PRIORITY_ORDER covers all priorities', () => {
    const expected: NotifyPriority[] = ['low', 'normal', 'high', 'urgent']
    for (const p of expected) {
      assert.equal(typeof NOTIFY_PRIORITY_ORDER[p], 'number')
    }
  })

  it('NOTIFY_SEVERITY_ORDER covers all severities', () => {
    const expected: NotifySeverity[] = ['info', 'success', 'warning', 'error', 'critical']
    for (const s of expected) {
      assert.equal(typeof NOTIFY_SEVERITY_ORDER[s], 'number')
    }
  })
})
