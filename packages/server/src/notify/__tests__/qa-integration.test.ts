/**
 * Slice 7 — QA Matrix & Integration Tests
 *
 * Covers server-side integration points across the full notification system:
 *   - AC-1: WS roundtrip broadcast
 *   - AC-2: Cross-instance isolation
 *   - AC-3: LRU eviction
 *   - AC-4: TTL expiry
 *   - AC-5: Combined REST filter
 *   - AC-7: ChoiceBar lifecycle (asked → replied)
 *   - AC-8: ChoiceBar lifecycle (asked → expired)
 *   - AC-9: Orchestrator producer mapping
 *   - AC-10: Background process producer mapping
 *   - AC-11: REST POST validation errors
 *   - AC-12: REST PATCH/DELETE not found
 *   - AC-13: REST DELETE non-existent instance
 */

import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import { EventEmitter } from 'node:events'
import Fastify from 'fastify'

import { NotifyRegistry } from '../registry'
import type { EventBus } from '../../events/bus'
import type { BackgroundProcess } from '../../api-types'
import { registerNotificationRoutes } from '../../server/routes/notifications'
import { registerChoiceRoutes } from '../../server/routes/choices'
import { createNotifyFromOrchestratorLog } from '../producers/orchestrator'
import { maybeNotifyOnProcessEvent } from '../producers/background-processes'
import { publishChoiceAsked, publishChoiceExpired } from '../producers/choices'

// ==================== Mock EventBus ====================

class MockEventBus extends EventEmitter {
  published: unknown[] = []

  publish(event: unknown): boolean {
    this.published.push(event)
    return true
  }
}

/** Access MockEventBus.published without TS errors (bus is cast to EventBus elsewhere). */
function getPublished(bus: unknown): any[] {
  return (bus as MockEventBus).published
}

// ==================== Fixture Helpers ====================

function makeProcess(overrides: Partial<BackgroundProcess> = {}): BackgroundProcess {
  return {
    id: 'proc-123',
    workspaceId: 'ws-1',
    title: 'Test Build',
    command: 'npm run build',
    cwd: '/project',
    status: 'running',
    startedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ==================== AC-1: WS Roundtrip ====================

describe('AC-1: WS roundtrip — registry broadcast', () => {
  let registry: NotifyRegistry
  const envelopes: unknown[] = []

  beforeEach(() => {
    envelopes.length = 0
    registry = new NotifyRegistry({ cap: 50, defaultTtlMs: 86_400_000 })
    registry.setBroadcast((e) => envelopes.push(e))
  })

  it('broadcasts notify.create envelope when event is registered', () => {
    const event = registry.register({ instanceId: 'inst-1', title: 'Test', message: 'msg' })

    assert.equal(envelopes.length, 1)
    const envelope = envelopes[0] as any
    assert.equal(envelope.type, 'notify.create')
    assert.equal(envelope.properties.event.id, event.id)
    assert.equal(envelope.properties.event.title, 'Test')
    assert.equal(envelope.properties.event.instanceId, 'inst-1')
  })

  it('broadcast envelope contains full NotifyEvent payload', () => {
    registry.register({ instanceId: 'inst-1', title: 'Full', message: 'check', category: 'error', priority: 'high', severity: 'critical' })

    const envelope = envelopes[0] as any
    const ev = envelope.properties.event
    assert.equal(ev.category, 'error')
    assert.equal(ev.priority, 'high')
    assert.equal(ev.severity, 'critical')
    assert.equal(typeof ev.id, 'string')
    assert.equal(typeof ev.createdAt, 'number')
    assert.equal(ev.schemaVersion, 1)
  })

  it('broadcasts notify.update on update', () => {
    const event = registry.register({ instanceId: 'inst-1', title: 'Before', message: 'msg' })
    envelopes.length = 0 // clear create

    registry.update('inst-1', event.id, { read: true, title: 'After' })

    assert.equal(envelopes.length, 1)
    assert.equal((envelopes[0] as any).type, 'notify.update')
    assert.equal((envelopes[0] as any).properties.id, event.id)
  })

  it('broadcasts notify.remove on remove', () => {
    const event = registry.register({ instanceId: 'inst-1', title: 'Bye', message: 'msg' })
    envelopes.length = 0 // clear create

    registry.remove('inst-1', event.id)

    assert.equal(envelopes.length, 1)
    assert.equal((envelopes[0] as any).type, 'notify.remove')
    assert.equal((envelopes[0] as any).properties.id, event.id)
  })

  it('no broadcast when callback is null', () => {
    registry.setBroadcast(null)
    registry.register({ instanceId: 'inst-1', title: 'Silent', message: 'msg' })

    assert.equal(envelopes.length, 0)
  })
})

// ==================== AC-2: Cross-Instance Isolation ====================

describe('AC-2: Cross-instance isolation', () => {
  let registry: NotifyRegistry

  beforeEach(() => {
    registry = new NotifyRegistry({ cap: 100, defaultTtlMs: 86_400_000 })
  })

  it('list("a") returns only instance "a" events', () => {
    registry.register({ instanceId: 'a', title: 'A1', message: '' })
    registry.register({ instanceId: 'a', title: 'A2', message: '' })
    registry.register({ instanceId: 'a', title: 'A3', message: '' })

    const aEvents = registry.list('a')
    assert.equal(aEvents.length, 3)
  })

  it('list("b") returns only instance "b" events', () => {
    registry.register({ instanceId: 'b', title: 'B1', message: '' })
    registry.register({ instanceId: 'b', title: 'B2', message: '' })

    const bEvents = registry.list('b')
    assert.equal(bEvents.length, 2)
  })

  it('instance "a" does not see instance "b" events', () => {
    registry.register({ instanceId: 'a', title: 'A1', message: '' })
    registry.register({ instanceId: 'b', title: 'B1', message: '' })
    registry.register({ instanceId: 'b', title: 'B2', message: '' })

    const aEvents = registry.list('a')
    assert.equal(aEvents.length, 1)
    assert.equal(aEvents[0].title, 'A1')
  })

  it('instance "b" does not see instance "a" events', () => {
    registry.register({ instanceId: 'a', title: 'A1', message: '' })
    registry.register({ instanceId: 'b', title: 'B1', message: '' })

    const bEvents = registry.list('b')
    assert.equal(bEvents.length, 1)
    assert.equal(bEvents[0].title, 'B1')
  })

  it('empty instance returns empty list', () => {
    assert.deepEqual(registry.list('nonexistent'), [])
  })
})

// ==================== AC-3: LRU Eviction ====================

describe('AC-3: LRU eviction', () => {
  it('evicts oldest events when cap is exceeded', () => {
    const registry = new NotifyRegistry({ cap: 5 })

    // Register 6 events; oldest (A) should be evicted
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const ev = registry.register({ instanceId: 'inst-1', title: `Event ${i}`, message: `msg ${i}` })
      ids.push(ev.id)
    }

    const events = registry.list('inst-1')
    assert.equal(events.length, 5)

    // The oldest (first registered) should be gone
    const idsPresent = events.map((e) => e.id)
    assert.ok(!idsPresent.includes(ids[0]), 'oldest event should be evicted')
    // All newer events should be present
    for (let i = 1; i < 6; i++) {
      assert.ok(idsPresent.includes(ids[i]), `event ${i} should be present`)
    }
  })

  it('exact cap is preserved (no eviction when under cap)', () => {
    const registry = new NotifyRegistry({ cap: 5 })

    for (let i = 0; i < 5; i++) {
      registry.register({ instanceId: 'inst-1', title: `Event ${i}`, message: `msg ${i}` })
    }

    assert.equal(registry.list('inst-1').length, 5)
  })

  it('eviction preserves per-instance isolation', () => {
    const registry = new NotifyRegistry({ cap: 3 })

    // Fill instance a to cap
    registry.register({ instanceId: 'a', title: 'A1', message: '' })
    registry.register({ instanceId: 'a', title: 'A2', message: '' })
    registry.register({ instanceId: 'a', title: 'A3', message: '' })
    registry.register({ instanceId: 'a', title: 'A4', message: '' }) // evicts A1

    // Instance b should be untouched
    registry.register({ instanceId: 'b', title: 'B1', message: '' })
    registry.register({ instanceId: 'b', title: 'B2', message: '' })

    assert.equal(registry.list('a').length, 3)
    assert.equal(registry.list('b').length, 2)
  })
})

// ==================== AC-4: TTL Expiry ====================

describe('AC-4: TTL expiry', () => {
  it('excludes expired events from list', () => {
    const registry = new NotifyRegistry({ defaultTtlMs: 86_400_000 })

    // Register an event with very short TTL
    registry.register({ instanceId: 'inst-1', title: 'Forever', message: '', ttlMs: 86_400_000 })
    registry.register({ instanceId: 'inst-1', title: 'Expiring', message: '', ttlMs: 5 })

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const events = registry.list('inst-1')
        assert.equal(events.length, 1)
        assert.equal(events[0].title, 'Forever')
        resolve()
      }, 30)
    })
  })

  it('returns expired event via direct get (expiry is for listings)', () => {
    const registry = new NotifyRegistry({ defaultTtlMs: 86_400_000 })
    const event = registry.register({ instanceId: 'inst-1', title: 'Expiring', message: '', ttlMs: 5 })

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Direct get should still return the event (no hard delete)
        const found = registry.get('inst-1', event.id)
        assert.ok(found)
        assert.equal(found!.title, 'Expiring')
        resolve()
      }, 30)
    })
  })

  it('immediate list includes event before TTL expiry', () => {
    const registry = new NotifyRegistry({ defaultTtlMs: 86_400_000 })
    registry.register({ instanceId: 'inst-1', title: 'Fresh', message: '', ttlMs: 30_000 })

    const events = registry.list('inst-1')
    assert.equal(events.length, 1)
    assert.equal(events[0].title, 'Fresh')
  })
})

// ==================== AC-5: Combined REST Filter ====================

describe('AC-5: Combined REST filter', () => {
  function createApp() {
    const app = Fastify({ logger: false })
    const notifyRegistry = new NotifyRegistry({ cap: 100, defaultTtlMs: 86_400_000 })
    registerNotificationRoutes(app, { notifyRegistry })
    return { app, notifyRegistry }
  }

  it('filters by category + priority + severity combined', async () => {
    const { app, notifyRegistry } = createApp()

    notifyRegistry.register({ instanceId: 'inst-1', title: 'Error High Critical', message: '', category: 'error', priority: 'high', severity: 'critical' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'Error High Error', message: '', category: 'error', priority: 'high', severity: 'error' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'Error Low Info', message: '', category: 'error', priority: 'low', severity: 'info' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'Session High Error', message: '', category: 'session', priority: 'high', severity: 'error' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'Task Normal Info', message: '', category: 'task', priority: 'normal', severity: 'info' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications?instanceId=inst-1&category=error&priority=high&severity=critical',
    })
    assert.equal(res.statusCode, 200)
    const events = res.json()
    assert.equal(events.length, 1)
    assert.equal(events[0].title, 'Error High Critical')

    await app.close()
  })

  it('filters by category + severity combined', async () => {
    const { app, notifyRegistry } = createApp()

    notifyRegistry.register({ instanceId: 'inst-1', title: 'Error Critical', message: '', category: 'error', severity: 'critical' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'Error Error', message: '', category: 'error', severity: 'error' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'Task Critical', message: '', category: 'task', severity: 'critical' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'Session Info', message: '', category: 'session', severity: 'info' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications?instanceId=inst-1&category=error&severity=critical',
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 1)
    assert.equal(res.json()[0].title, 'Error Critical')

    await app.close()
  })

  it('filters by priority + severity combined', async () => {
    const { app, notifyRegistry } = createApp()

    notifyRegistry.register({ instanceId: 'inst-1', title: 'Urgent Critical', message: '', priority: 'urgent', severity: 'critical' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'Urgent Info', message: '', priority: 'urgent', severity: 'info' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'Normal Critical', message: '', priority: 'normal', severity: 'critical' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'Low Info', message: '', priority: 'low', severity: 'info' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications?instanceId=inst-1&priority=urgent&severity=critical',
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 1)
    assert.equal(res.json()[0].title, 'Urgent Critical')

    await app.close()
  })

  it('returns empty for combined filter that matches nothing', async () => {
    const { app, notifyRegistry } = createApp()

    notifyRegistry.register({ instanceId: 'inst-1', title: 'Normal', message: '', category: 'session', priority: 'normal', severity: 'info' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications?instanceId=inst-1&category=error&priority=high&severity=critical',
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 0)

    await app.close()
  })

  it('returns all events when no filter params provided', async () => {
    const { app, notifyRegistry } = createApp()

    notifyRegistry.register({ instanceId: 'inst-1', title: 'A', message: '', category: 'error', priority: 'high', severity: 'critical' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'B', message: '', category: 'session', priority: 'low', severity: 'info' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'C', message: '', category: 'task', priority: 'normal', severity: 'warning' })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 3)

    await app.close()
  })
})

// ==================== AC-7: ChoiceBar — asked → replied ====================

describe('AC-7: ChoiceBar lifecycle — asked → replied', () => {
  it('POST /api/choices/reply broadcasts chat.choice.replied via EventBus', async () => {
    const bus = new MockEventBus() as unknown as EventBus
    const app = Fastify({ logger: false })
    registerChoiceRoutes(app, { eventBus: bus })

    // First publish the asked event
    const choiceId = publishChoiceAsked('inst-1', [
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ], bus)

    assert.equal(getPublished(bus).length, 1)
    const askedEvent = getPublished(bus)[0]
    assert.equal(askedEvent.event.type, 'chat.choice.asked')
    assert.equal(askedEvent.event.properties.payload.id, choiceId)

    // Now POST the reply
    const res = await app.inject({
      method: 'POST',
      url: '/api/choices/reply',
      payload: { instanceId: 'inst-1', id: choiceId, value: 'yes' },
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true })

    // Verify the EventBus received the replied event
    assert.equal(getPublished(bus).length, 2)
    const repliedEvent = getPublished(bus)[1]
    assert.equal(repliedEvent.type, 'instance.event')
    assert.equal(repliedEvent.instanceId, 'inst-1')
    assert.equal(repliedEvent.event.type, 'chat.choice.replied')
    assert.equal(repliedEvent.event.properties.payload.id, choiceId)
    assert.equal(repliedEvent.event.properties.payload.value, 'yes')

    await app.close()
  })

  it('POST /api/choices/reply with array value broadcasts correct shape', async () => {
    const bus = new MockEventBus() as unknown as EventBus
    const app = Fastify({ logger: false })
    registerChoiceRoutes(app, { eventBus: bus })

    const res = await app.inject({
      method: 'POST',
      url: '/api/choices/reply',
      payload: { instanceId: 'inst-1', id: 'multi-choice', value: ['email', 'sms'] },
    })

    assert.equal(res.statusCode, 200)
    assert.equal(getPublished(bus).length, 1)
    const repliedEvent = getPublished(bus)[0]
    assert.equal(repliedEvent.event.properties.payload.id, 'multi-choice')
    assert.deepEqual(repliedEvent.event.properties.payload.value, ['email', 'sms'])

    await app.close()
  })

  it('reply payload has correct {id, value} shape', async () => {
    const bus = new MockEventBus() as unknown as EventBus
    const app = Fastify({ logger: false })
    registerChoiceRoutes(app, { eventBus: bus })

    await app.inject({
      method: 'POST',
      url: '/api/choices/reply',
      payload: { instanceId: 'inst-1', id: 'shape-test', value: 'yes' },
    })

    const payload = getPublished(bus)[0].event.properties.payload
    assert.equal(typeof payload.id, 'string')
    assert.equal(typeof payload.value, 'string')
    assert.ok('id' in payload)
    assert.ok('value' in payload)

    await app.close()
  })
})

// ==================== AC-8: ChoiceBar — asked → expired ====================

describe('AC-8: ChoiceBar lifecycle — asked → expired', () => {
  it('publishChoiceExpired broadcasts chat.choice.expired via EventBus', () => {
    const bus = new MockEventBus() as unknown as EventBus

    publishChoiceExpired('inst-1', 'choice-exp-1', bus)

    assert.equal(getPublished(bus).length, 1)
    const event = getPublished(bus)[0]
    assert.equal(event.type, 'instance.event')
    assert.equal(event.instanceId, 'inst-1')
    assert.equal(event.event.type, 'chat.choice.expired')
    assert.equal(event.event.properties.payload.id, 'choice-exp-1')
  })

  it('expired payload has correct {id} shape', () => {
    const bus = new MockEventBus() as unknown as EventBus

    publishChoiceExpired('inst-1', 'shape-check', bus)

    const payload = getPublished(bus)[0].event.properties.payload
    assert.equal(typeof payload.id, 'string')
    assert.ok('id' in payload)
    assert.ok(!('value' in payload)) // expired has no value field
  })
})

// ==================== AC-9: Orchestrator Producer Mapping ====================

describe('AC-9: Orchestrator producer mapping', () => {
  it('NODE_FAILED → error category', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const result = createNotifyFromOrchestratorLog('NODE_FAILED', 'ERROR', 'Build failed', undefined, 'inst-1', bus)
    assert.equal(result.category, 'error')
  })

  it('NODE_FAILED → high priority', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const result = createNotifyFromOrchestratorLog('NODE_FAILED', 'ERROR', 'Build failed', undefined, 'inst-1', bus)
    assert.equal(result.priority, 'high')
  })

  it('ERROR event type → error category', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const result = createNotifyFromOrchestratorLog('ERROR', 'CRITICAL', 'Fatal', undefined, 'inst-1', bus)
    assert.equal(result.category, 'error')
  })

  it('NODE_COMPLETED → success_progress category', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const result = createNotifyFromOrchestratorLog('NODE_COMPLETED', 'INFO', 'Done', undefined, 'inst-1', bus)
    assert.equal(result.category, 'success_progress')
  })

  it('NODE_RETRY → workaround_suggested category', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const result = createNotifyFromOrchestratorLog('NODE_RETRY', 'WARN', 'Retrying', undefined, 'inst-1', bus)
    assert.equal(result.category, 'workaround_suggested')
  })

  it('HEALING_ACTION → mitigation_applied category', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const result = createNotifyFromOrchestratorLog('HEALING_ACTION', 'WARN', 'Healing', undefined, 'inst-1', bus)
    assert.equal(result.category, 'mitigation_applied')
  })

  it('BROADCAST_SENT → broadcast category', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const result = createNotifyFromOrchestratorLog('BROADCAST_SENT', 'INFO', 'Broadcast', undefined, 'inst-1', bus)
    assert.equal(result.category, 'broadcast')
  })

  it('WORKFLOW_COMPLETED → success_progress category', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const result = createNotifyFromOrchestratorLog('WORKFLOW_COMPLETED', 'INFO', 'Pipeline done', undefined, 'inst-1', bus)
    assert.equal(result.category, 'success_progress')
  })

  it('NODE_STARTED → task_status category', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const result = createNotifyFromOrchestratorLog('NODE_STARTED', 'INFO', 'Starting', undefined, 'inst-1', bus)
    assert.equal(result.category, 'task_status')
  })

  it('publishes via eventBus with correct envelope structure', () => {
    const bus = new MockEventBus() as unknown as EventBus
    createNotifyFromOrchestratorLog('NODE_COMPLETED', 'SUCCESS', 'All good', undefined, 'inst-1', bus)

    assert.equal(getPublished(bus).length, 1)
    const envelope = getPublished(bus)[0]
    assert.equal(envelope.type, 'instance.event')
    assert.equal(envelope.instanceId, 'inst-1')
    assert.equal(envelope.event.type, 'notify.create')
  })

  it('CRITICAL severity maps correctly', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const result = createNotifyFromOrchestratorLog('ERROR', 'CRITICAL', 'Fatal', undefined, 'inst-1', bus)
    assert.equal(result.severity, 'critical')
  })

  it('includes error from metadata in message', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const metadata = { error: 'Connection timeout' }
    const result = createNotifyFromOrchestratorLog('NODE_FAILED', 'ERROR', 'Deploy failed', metadata, 'inst-1', bus)
    assert.ok(result.message.includes('Connection timeout'))
  })
})

// ==================== AC-10: Background Process Producer Mapping ====================

describe('AC-10: Background process producer mapping', () => {
  it('process finished → success_progress category + normal priority + info severity', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const process = makeProcess({ status: 'stopped', terminalReason: 'finished' })

    const result = maybeNotifyOnProcessEvent(process, 'inst-1', bus)
    assert.ok(result)
    assert.equal(result!.category, 'success_progress')
    assert.equal(result!.priority, 'normal')
    assert.equal(result!.severity, 'info')
  })

  it('process error → error category + high priority + critical severity', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const process = makeProcess({ status: 'error', terminalReason: 'failed' })

    const result = maybeNotifyOnProcessEvent(process, 'inst-1', bus)
    assert.ok(result)
    assert.equal(result!.category, 'error')
    assert.equal(result!.priority, 'high')
    assert.equal(result!.severity, 'critical')
  })

  it('user_stopped → task_status category + low priority + warning severity', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const process = makeProcess({ status: 'stopped', terminalReason: 'user_stopped' })

    const result = maybeNotifyOnProcessEvent(process, 'inst-1', bus)
    assert.ok(result)
    assert.equal(result!.category, 'task_status')
    assert.equal(result!.priority, 'low')
    assert.equal(result!.severity, 'warning')
  })

  it('user_terminated → task_status category + low priority + warning severity', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const process = makeProcess({ status: 'stopped', terminalReason: 'user_terminated' })

    const result = maybeNotifyOnProcessEvent(process, 'inst-1', bus)
    assert.ok(result)
    assert.equal(result!.category, 'task_status')
    assert.equal(result!.priority, 'low')
    assert.equal(result!.severity, 'warning')
  })

  it('running process produces no notification', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const process = makeProcess({ status: 'running' })

    const result = maybeNotifyOnProcessEvent(process, 'inst-1', bus)
    assert.equal(result, undefined)
    assert.equal(getPublished(bus).length, 0)
  })

  it('publishes via eventBus with correct envelope structure', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const process = makeProcess({ status: 'stopped', terminalReason: 'finished' })

    maybeNotifyOnProcessEvent(process, 'inst-1', bus)
    assert.equal(getPublished(bus).length, 1)
    const envelope = getPublished(bus)[0]
    assert.equal(envelope.type, 'instance.event')
    assert.equal(envelope.instanceId, 'inst-1')
    assert.equal(envelope.event.type, 'notify.create')
  })

  it('event has source=background_process', () => {
    const bus = new MockEventBus() as unknown as EventBus
    const process = makeProcess({ status: 'stopped', terminalReason: 'finished' })

    const result = maybeNotifyOnProcessEvent(process, 'inst-1', bus)
    assert.equal(result!.source, 'background_process')
  })
})

// ==================== AC-11: REST Error — POST Validation ====================

describe('AC-11: REST error handling — POST validation', () => {
  function createApp() {
    const app = Fastify({ logger: false })
    const notifyRegistry = new NotifyRegistry({ cap: 50, defaultTtlMs: 86_400_000 })
    registerNotificationRoutes(app, { notifyRegistry })
    return { app }
  }

  it('POST with empty body returns 400', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'POST', url: '/api/notifications', payload: {} })
    assert.equal(res.statusCode, 400)
    await app.close()
  })

  it('POST with missing title returns 400', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'POST', url: '/api/notifications', payload: { instanceId: 'inst-1', message: 'no title' } })
    assert.equal(res.statusCode, 400)
    assert.ok(res.json().error.includes('title'))
    await app.close()
  })

  it('POST with missing instanceId returns 400', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'POST', url: '/api/notifications', payload: { title: 'T', message: 'M' } })
    assert.equal(res.statusCode, 400)
    assert.ok(res.json().error.includes('instanceId'))
    await app.close()
  })

  it('POST with missing message returns 400', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'POST', url: '/api/notifications', payload: { instanceId: 'inst-1', title: 'T' } })
    assert.equal(res.statusCode, 400)
    assert.ok(res.json().error.includes('message'))
    await app.close()
  })
})

// ==================== AC-12: REST Error — PATCH/DELETE Not Found ====================

describe('AC-12: REST error handling — PATCH/DELETE not found', () => {
  function createApp() {
    const app = Fastify({ logger: false })
    const notifyRegistry = new NotifyRegistry({ cap: 50, defaultTtlMs: 86_400_000 })
    registerNotificationRoutes(app, { notifyRegistry })
    return { app }
  }

  it('PATCH non-existent id returns 404', async () => {
    const { app } = createApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/nonexistent-id?instanceId=inst-1',
      payload: { read: true },
    })
    assert.equal(res.statusCode, 404)
    assert.ok(res.json().error.includes('not found'))
    await app.close()
  })

  it('DELETE non-existent id returns 404', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/notifications/nonexistent-id?instanceId=inst-1' })
    assert.equal(res.statusCode, 404)
    assert.ok(res.json().error.includes('not found'))
    await app.close()
  })

  it('PATCH on non-existent instance returns 404', async () => {
    const { app } = createApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/some-id?instanceId=nonexistent-instance',
      payload: { read: true },
    })
    assert.equal(res.statusCode, 404)
    await app.close()
  })
})

// ==================== AC-13: REST Error — DELETE Non-Existent Instance ====================

describe('AC-13: REST error handling — DELETE non-existent instance', () => {
  function createApp() {
    const app = Fastify({ logger: false })
    const notifyRegistry = new NotifyRegistry({ cap: 50, defaultTtlMs: 86_400_000 })
    registerNotificationRoutes(app, { notifyRegistry })
    return { app }
  }

  it('DELETE event from non-existent instance returns 404', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/notifications/some-id?instanceId=nonexistent-instance' })
    assert.equal(res.statusCode, 404)
    await app.close()
  })

  it('DELETE event without instanceId returns 400', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/notifications/some-id' })
    assert.equal(res.statusCode, 400)
    await app.close()
  })
})
