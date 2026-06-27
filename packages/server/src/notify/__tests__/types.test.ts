import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'

import type {
  NotifyEvent,
  NotifyCategory,
  NotifyPriority,
  NotifySeverity,
  NotifySource,
  NotifyWsEnvelope,
} from '../types'

// ==================== Fixture Helpers ====================

function makeEvent(overrides: Partial<NotifyEvent> = {}): NotifyEvent {
  return {
    id: randomUUID(),
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

describe('NotifyEvent schema (server)', () => {
  it('creates a minimal event with required fields', () => {
    const event = makeEvent()
    assert.equal(typeof event.id, 'string')
    assert.equal(event.instanceId, 'test-instance')
    assert.equal(event.schemaVersion, 1)
  })

  it('accepts all NotifyCategory values', () => {
    const categories: NotifyCategory[] = [
      'session',
      'task',
      'milestone',
      'permission',
      'help_required',
      'escalation',
      'broadcast',
      'question',
      'system',
    ]
    for (const cat of categories) {
      const event = makeEvent({ category: cat })
      assert.equal(event.category, cat)
    }
  })

  it('accepts all NotifyPriority values', () => {
    for (const p of ['low', 'normal', 'high', 'urgent'] as NotifyPriority[]) {
      assert.equal(makeEvent({ priority: p }).priority, p)
    }
  })

  it('accepts all NotifySeverity values', () => {
    for (const s of ['info', 'success', 'warning', 'error', 'critical'] as NotifySeverity[]) {
      assert.equal(makeEvent({ severity: s }).severity, s)
    }
  })

  it('accepts all NotifySource values', () => {
    const sources: NotifySource[] = [
      'orchestrator',
      'background_process',
      'session',
      'permission',
      'manual',
      'tui',
      'system',
    ]
    for (const src of sources) {
      assert.equal(makeEvent({ source: src }).source, src)
    }
  })

  it('accepts full event with all fields', () => {
    const event = makeEvent({
      sessionId: 'sess-1',
      taskId: 'task-1',
      escalation: { level: 2, fromAgent: 'alpha', toAgent: 'beta', reason: 'Retries exhausted', ttlMs: 300_000 },
      mitigate: 'Restart the service',
      workaround: 'Use fallback endpoint',
      helpRequired: true,
      successProgress: { current: 3, total: 5, unit: 'steps' },
      actions: [{ id: 'a1', label: 'Open', href: '/session/123', variant: 'primary' }],
      metadata: { key: 'value' },
      ackedAt: 1000,
      escalatedAt: 2000,
      ttlMs: 60_000,
      read: true,
    })
    assert.equal(event.sessionId, 'sess-1')
    assert.equal(event.taskId, 'task-1')
    assert.equal(event.escalation?.level, 2)
    assert.equal(event.mitigate, 'Restart the service')
    assert.equal(event.workaround, 'Use fallback endpoint')
    assert.equal(event.helpRequired, true)
    assert.equal(event.successProgress?.current, 3)
    assert.equal(event.actions?.length, 1)
    assert.equal(event.metadata?.key, 'value')
    assert.equal(event.ackedAt, 1000)
    assert.equal(event.ttlMs, 60_000)
    assert.equal(event.read, true)
  })
})

// ==================== WS Envelope Tests ====================

describe('NotifyWsEnvelope', () => {
  it('produces a notify.create envelope', () => {
    const event = makeEvent()
    const envelope: NotifyWsEnvelope = { type: 'notify.create', properties: { event } }
    assert.equal(envelope.type, 'notify.create')
    assert.equal(envelope.properties.event.id, event.id)
  })

  it('produces a notify.update envelope', () => {
    const envelope: NotifyWsEnvelope = {
      type: 'notify.update',
      properties: { id: 'evt-1', instanceId: 'test', patch: { read: true } },
    }
    assert.equal(envelope.type, 'notify.update')
    assert.equal(envelope.properties.patch.read, true)
  })

  it('produces a notify.remove envelope', () => {
    const envelope: NotifyWsEnvelope = {
      type: 'notify.remove',
      properties: { id: 'evt-1', instanceId: 'test' },
    }
    assert.equal(envelope.type, 'notify.remove')
    assert.equal(envelope.properties.id, 'evt-1')
  })
})
