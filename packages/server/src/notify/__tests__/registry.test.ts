import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { NotifyRegistry } from '../registry'
import type { NotifyEvent } from '../types'

// ==================== Fixtures ====================

function makeEvent(instanceId: string, overrides: Partial<NotifyEvent> = {}): Partial<NotifyEvent> & { instanceId: string; title: string; message: string } {
  return {
    instanceId,
    title: 'Test Event',
    message: 'A test notification event',
    source: 'manual',
    category: 'session',
    priority: 'normal' as const,
    severity: 'info' as const,
    eventType: 'TEST_EVENT',
    ...overrides,
  }
}

// ==================== Registry Tests ====================

describe('NotifyRegistry', () => {
  let registry: NotifyRegistry

  beforeEach(() => {
    registry = new NotifyRegistry({ cap: 10, defaultTtlMs: 86_400_000 })
  })

  // ---- register ----

  it('registers an event with auto-filled fields', () => {
    const event = registry.register(makeEvent('inst-1'))
    assert.equal(typeof event.id, 'string')
    assert.equal(event.instanceId, 'inst-1')
    assert.equal(event.schemaVersion, 1)
    assert.equal(event.read, false)
    assert.ok(event.createdAt > 0)
  })

  it('registers an event with explicit fields preserved', () => {
    const event = registry.register(makeEvent('inst-1', {
      sessionId: 'sess-abc',
      taskId: 'task-xyz',
      source: 'orchestrator',
      category: 'task',
      priority: 'high',
      severity: 'error',
      eventType: 'NODE_FAILED',
      helpRequired: true,
      mitigate: 'Restart the service',
      workaround: 'Use fallback endpoint',
      escalation: { level: 2, fromAgent: 'alpha', toAgent: 'beta', reason: 'Retries exhausted' },
      successProgress: { current: 3, total: 5, unit: 'steps' },
      actions: [{ id: 'a1', label: 'Open', href: '/session/123', variant: 'primary' }],
      metadata: { key: 'value' },
    }))

    assert.equal(event.sessionId, 'sess-abc')
    assert.equal(event.taskId, 'task-xyz')
    assert.equal(event.source, 'orchestrator')
    assert.equal(event.category, 'task')
    assert.equal(event.priority, 'high')
    assert.equal(event.severity, 'error')
    assert.equal(event.eventType, 'NODE_FAILED')
    assert.equal(event.helpRequired, true)
    assert.equal(event.mitigate, 'Restart the service')
    assert.equal(event.workaround, 'Use fallback endpoint')
    assert.equal(event.escalation?.level, 2)
    assert.equal(event.successProgress?.current, 3)
    assert.equal(event.actions?.length, 1)
    assert.equal(event.metadata?.key, 'value')
  })

  it('assigns default severity and priority from eventType', () => {
    // Omit severity/priority from makeEvent defaults so registry derives them
    const event = registry.register({
      instanceId: 'inst-1',
      title: 'Test',
      message: 'Test',
      eventType: 'NODE_FAILED',
    })
    assert.equal(event.severity, 'error')
    assert.equal(event.priority, 'high')
  })

  it('falls back to defaults for unknown event types', () => {
    const event = registry.register(makeEvent('inst-1', { eventType: 'CUSTOM_EVENT' }))
    assert.equal(event.severity, 'info')
    assert.equal(event.priority, 'normal')
  })

  it('prefers explicit severity/priority over eventType defaults', () => {
    const event = registry.register(makeEvent('inst-1', {
      eventType: 'NODE_FAILED',
      severity: 'critical',
      priority: 'urgent',
    }))
    assert.equal(event.severity, 'critical')
    assert.equal(event.priority, 'urgent')
  })

  it('uses the provided id when given', () => {
    const customId = randomUUID()
    const event = registry.register(makeEvent('inst-1', { id: customId }))
    assert.equal(event.id, customId)
  })

  it('allows optional createdAt to be provided', () => {
    const pastTs = Date.now() - 10_000
    const event = registry.register(makeEvent('inst-1', { createdAt: pastTs }))
    assert.equal(event.createdAt, pastTs)
  })

  it('assigns default TTL when not provided', () => {
    const event = registry.register(makeEvent('inst-1'))
    assert.equal(event.ttlMs, 86_400_000)
  })

  it('respects explicit ttlMs', () => {
    const event = registry.register(makeEvent('inst-1', { ttlMs: 5_000 }))
    assert.equal(event.ttlMs, 5_000)
  })

  it('auto-assigns source=manual and category=session when not provided', () => {
    const event = registry.register(makeEvent('inst-1', { source: undefined, category: undefined } as any))
    assert.equal(event.source, 'manual')
    assert.equal(event.category, 'session')
  })

  // ---- update ----

  it('updates an event by id', () => {
    const created = registry.register(makeEvent('inst-1'))
    const updated = registry.update('inst-1', created.id, { read: true, ackedAt: Date.now() })
    assert.ok(updated)
    assert.equal(updated!.read, true)
    assert.ok(updated!.ackedAt)
  })

  it('returns undefined when updating non-existent event', () => {
    const result = registry.update('inst-1', 'nonexistent', { read: true })
    assert.equal(result, undefined)
  })

  it('returns undefined when updating non-existent instance', () => {
    const result = registry.update('no-such-instance', 'some-id', { read: true })
    assert.equal(result, undefined)
  })

  // ---- remove ----

  it('removes an event by id', () => {
    const created = registry.register(makeEvent('inst-1'))
    const removed = registry.remove('inst-1', created.id)
    assert.equal(removed, true)
    assert.equal(registry.list('inst-1').length, 0)
  })

  it('returns false when removing non-existent event', () => {
    const result = registry.remove('inst-1', 'nonexistent')
    assert.equal(result, false)
  })

  it('returns false when removing from non-existent instance', () => {
    const result = registry.remove('no-such-instance', 'some-id')
    assert.equal(result, false)
  })

  // ---- list ----

  it('lists events for an instance in priority desc, createdAt desc order', () => {
    registry.register(makeEvent('inst-1', { priority: 'low', title: 'Low' }))
    registry.register(makeEvent('inst-1', { priority: 'urgent', title: 'Urgent' }))
    registry.register(makeEvent('inst-1', { priority: 'high', title: 'High' }))

    const events = registry.list('inst-1')
    assert.equal(events.length, 3)
    assert.equal(events[0].title, 'Urgent')
    assert.equal(events[1].title, 'High')
    assert.equal(events[2].title, 'Low')
  })

  it('filters by category', () => {
    registry.register(makeEvent('inst-1', { category: 'task', eventType: 'TASK_COMPLETED' }))
    registry.register(makeEvent('inst-1', { category: 'session', eventType: 'SESSION_IDLE' }))

    const tasks = registry.list('inst-1', { category: 'task' })
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].category, 'task')
  })

  it('filters by priority', () => {
    registry.register(makeEvent('inst-1', { priority: 'high' }))
    registry.register(makeEvent('inst-1', { priority: 'low' }))

    const high = registry.list('inst-1', { priority: 'high' })
    assert.equal(high.length, 1)
  })

  it('filters by severity', () => {
    registry.register(makeEvent('inst-1', { severity: 'error' }))
    registry.register(makeEvent('inst-1', { severity: 'info' }))

    const errors = registry.list('inst-1', { severity: 'error' })
    assert.equal(errors.length, 1)
  })

  it('filters by source', () => {
    registry.register(makeEvent('inst-1', { source: 'orchestrator' }))
    registry.register(makeEvent('inst-1', { source: 'manual' }))

    const orch = registry.list('inst-1', { source: 'orchestrator' })
    assert.equal(orch.length, 1)
  })

  it('filters by unreadOnly', () => {
    const e1 = registry.register(makeEvent('inst-1', { title: 'Unread' }))
    registry.register(makeEvent('inst-1', { title: 'Read' }))
    registry.update('inst-1', e1.id, { read: true })

    const unread = registry.list('inst-1', { unreadOnly: true })
    assert.equal(unread.length, 1)
    assert.equal(unread[0].title, 'Read') // second registered is newer
  })

  it('filters by escalationOnly', () => {
    registry.register(makeEvent('inst-1', { title: 'Normal' }))
    registry.register(makeEvent('inst-1', { title: 'Escalated', escalation: { level: 1, reason: 'test' } }))

    const escalated = registry.list('inst-1', { escalationOnly: true })
    assert.equal(escalated.length, 1)
    assert.equal(escalated[0].title, 'Escalated')
  })

  it('filters by helpRequired', () => {
    registry.register(makeEvent('inst-1', { title: 'Needs Help', helpRequired: true }))
    registry.register(makeEvent('inst-1', { title: 'OK' }))

    const help = registry.list('inst-1', { helpRequired: true })
    assert.equal(help.length, 1)
  })

  it('filters by eventType exact match', () => {
    registry.register(makeEvent('inst-1', { eventType: 'NODE_FAILED' }))
    registry.register(makeEvent('inst-1', { eventType: 'TASK_COMPLETED' }))

    const failed = registry.list('inst-1', { eventType: 'NODE_FAILED' })
    assert.equal(failed.length, 1)
  })

  it('filters by eventTypePattern regex', () => {
    registry.register(makeEvent('inst-1', { eventType: 'NODE_FAILED' }))
    registry.register(makeEvent('inst-1', { eventType: 'NODE_STARTED' }))
    registry.register(makeEvent('inst-1', { eventType: 'TASK_COMPLETED' }))

    const nodeEvents = registry.list('inst-1', { eventTypePattern: '^NODE' })
    assert.equal(nodeEvents.length, 2)
  })

  it('filters by since', () => {
    const before = Date.now() - 5_000
    registry.register(makeEvent('inst-1', { title: 'Old', createdAt: before }))
    registry.register(makeEvent('inst-1', { title: 'New' }))

    const recent = registry.list('inst-1', { since: Date.now() - 1_000 })
    assert.equal(recent.length, 1)
    assert.equal(recent[0].title, 'New')
  })

  it('filters by until', () => {
    const before = Date.now() - 5_000
    registry.register(makeEvent('inst-1', { title: 'Old', createdAt: before }))
    registry.register(makeEvent('inst-1', { title: 'New' }))

    const old = registry.list('inst-1', { until: Date.now() - 1_000 })
    assert.equal(old.length, 1)
    assert.equal(old[0].title, 'Old')
  })

  it('applies limit and offset', () => {
    registry.register(makeEvent('inst-1', { title: 'A' }))
    registry.register(makeEvent('inst-1', { title: 'B' }))
    registry.register(makeEvent('inst-1', { title: 'C' }))

    // Order is newest-first: C, B, A
    const page = registry.list('inst-1', { limit: 2, offset: 1 })
    assert.equal(page.length, 2)
    assert.equal(page[0].title, 'B')
    assert.equal(page[1].title, 'A')
  })

  it('returns empty array for empty instance', () => {
    const events = registry.list('no-such-instance')
    assert.deepEqual(events, [])
  })

  // ---- get ----

  it('gets a single event by id', () => {
    const created = registry.register(makeEvent('inst-1'))
    const found = registry.get('inst-1', created.id)
    assert.ok(found)
    assert.equal(found!.id, created.id)
  })

  it('returns undefined for non-existent event', () => {
    const found = registry.get('inst-1', 'nonexistent')
    assert.equal(found, undefined)
  })

  // ---- clear ----

  it('clears all events for an instance', () => {
    registry.register(makeEvent('inst-1'))
    registry.register(makeEvent('inst-1'))
    assert.equal(registry.list('inst-1').length, 2)
    registry.clear('inst-1')
    assert.equal(registry.list('inst-1').length, 0)
  })

  // ---- cap / eviction ----

  it('trims to cap when exceeded', () => {
    const small = new NotifyRegistry({ cap: 3 })
    small.register(makeEvent('inst-1', { title: 'A' }))
    small.register(makeEvent('inst-1', { title: 'B' }))
    small.register(makeEvent('inst-1', { title: 'C' }))
    small.register(makeEvent('inst-1', { title: 'D' }))
    small.register(makeEvent('inst-1', { title: 'E' }))

    assert.equal(small.list('inst-1').length, 3)
    // Newest ones should survive
    const titles = small.list('inst-1').map((e) => e.title)
    assert.ok(titles.includes('E'))
    assert.ok(titles.includes('D'))
    assert.ok(titles.includes('C'))
  })

  // ---- TTL expiry ----

  it('prunes expired events on list', () => {
    const shortTtl = new NotifyRegistry({ defaultTtlMs: 10 })
    shortTtl.register(makeEvent('inst-1', { title: 'Expired', ttlMs: 1 }))
    shortTtl.register(makeEvent('inst-1', { title: 'Forever', ttlMs: 86_400_000 }))

    // Wait for expiry
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const events = shortTtl.list('inst-1')
        assert.equal(events.length, 1)
        assert.equal(events[0].title, 'Forever')
        resolve()
      }, 20)
    })
  })

  // ---- broadcast ----

  it('does not broadcast when no callback set', () => {
    let broadcasted: any = null
    registry.setBroadcast((e) => { broadcasted = e })

    registry.register(makeEvent('inst-1'))
    assert.ok(broadcasted)
    assert.equal(broadcasted.type, 'notify.create')

    broadcasted = null
    registry.setBroadcast(null)
    registry.register(makeEvent('inst-1'))
    assert.equal(broadcasted, null)
  })

  it('broadcasts notify.create on register', () => {
    const envelopes: any[] = []
    registry.setBroadcast((e) => envelopes.push(e))

    const event = registry.register(makeEvent('inst-1'))
    assert.equal(envelopes.length, 1)
    assert.equal(envelopes[0].type, 'notify.create')
    assert.equal(envelopes[0].properties.event.id, event.id)
  })

  it('broadcasts notify.update on update', () => {
    const envelopes: any[] = []
    registry.setBroadcast((e) => envelopes.push(e))

    const event = registry.register(makeEvent('inst-1'))
    registry.update('inst-1', event.id, { read: true })

    assert.equal(envelopes.length, 2)
    assert.equal(envelopes[1].type, 'notify.update')
    assert.equal(envelopes[1].properties.id, event.id)
  })

  it('broadcasts notify.remove on remove', () => {
    const envelopes: any[] = []
    registry.setBroadcast((e) => envelopes.push(e))

    const event = registry.register(makeEvent('inst-1'))
    registry.remove('inst-1', event.id)

    assert.equal(envelopes.length, 2)
    assert.equal(envelopes[1].type, 'notify.remove')
    assert.equal(envelopes[1].properties.id, event.id)
  })

  it('broadcasts notify.remove for each event on clear', () => {
    const envelopes: any[] = []
    registry.setBroadcast((e) => envelopes.push(e))

    registry.register(makeEvent('inst-1', { title: 'A' }))
    registry.register(makeEvent('inst-1', { title: 'B' }))
    envelopes.length = 0 // reset

    registry.clear('inst-1')

    assert.equal(envelopes.length, 2)
    assert.equal(envelopes[0].type, 'notify.remove')
    assert.equal(envelopes[1].type, 'notify.remove')
  })

  // ---- metrics ----

  it('returns total event count across instances', () => {
    registry.register(makeEvent('inst-1'))
    registry.register(makeEvent('inst-1'))
    registry.register(makeEvent('inst-2'))
    assert.equal(registry.getTotalEventCount(), 3)
  })

  it('returns instance count', () => {
    registry.register(makeEvent('inst-1'))
    registry.register(makeEvent('inst-2'))
    assert.equal(registry.getInstanceCount(), 2)
  })

  // ---- known instances ----

  it('returns known instance IDs', () => {
    registry.register(makeEvent('inst-alpha'))
    registry.register(makeEvent('inst-beta'))
    const ids = registry.getKnownInstances()
    assert.ok(ids.includes('inst-alpha'))
    assert.ok(ids.includes('inst-beta'))
  })
})
