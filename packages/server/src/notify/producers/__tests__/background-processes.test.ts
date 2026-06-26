import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EventEmitter } from 'events'
import type { EventBus } from '../../../events/bus'
import type { BackgroundProcess } from '../../../api-types'
import { maybeNotifyOnProcessEvent } from '../background-processes'

// ==================== Mock EventBus ====================

/**
 * We can't directly instantiate EventBus (it needs a logger),
 * so we use EventEmitter with a matching publish signature.
 */
class MockEventBus extends EventEmitter {
  published: unknown[] = []

  publish(event: unknown): boolean {
    this.published.push(event)
    return true
  }
}

// ==================== Fixtures ====================

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

// ==================== Tests ====================

describe('maybeNotifyOnProcessEvent', () => {
  it('publishes notify.create with category "success_progress" on completed process', () => {
    const bus = new MockEventBus()
    const process = makeProcess({
      status: 'stopped',
      terminalReason: 'finished',
    })

    maybeNotifyOnProcessEvent(process, 'ws-1', bus as unknown as EventBus)
    assert.equal(bus.published.length, 1)

    const event = bus.published[0] as any
    assert.equal(event.type, 'instance.event')
    assert.equal(event.instanceId, 'ws-1')
    assert.equal(event.event.type, 'notify.create')
    assert.equal(event.event.properties.event.category, 'success_progress')
  })

  it('publishes notify.create with priority "high" on failed process', () => {
    const bus = new MockEventBus()
    const process = makeProcess({
      status: 'error',
      terminalReason: 'failed',
    })

    maybeNotifyOnProcessEvent(process, 'ws-1', bus as unknown as EventBus)
    assert.equal(bus.published.length, 1)

    const event = bus.published[0] as any
    assert.equal(event.event.properties.event.priority, 'high')
  })

  it('publishes notify.create with severity "critical" on failed process', () => {
    const bus = new MockEventBus()
    const process = makeProcess({
      status: 'error',
      terminalReason: 'failed',
    })

    maybeNotifyOnProcessEvent(process, 'ws-1', bus as unknown as EventBus)
    assert.equal(bus.published.length, 1)

    const event = bus.published[0] as any
    assert.equal(event.event.properties.event.severity, 'critical')
  })

  it('publishes notify.create with category "task_status" on cancelled process', () => {
    const bus = new MockEventBus()
    const process = makeProcess({
      status: 'stopped',
      terminalReason: 'user_stopped',
    })

    maybeNotifyOnProcessEvent(process, 'ws-1', bus as unknown as EventBus)
    assert.equal(bus.published.length, 1)

    const event = bus.published[0] as any
    assert.equal(event.event.properties.event.category, 'task_status')
  })

  it('does not publish for non-terminal status (running)', () => {
    const bus = new MockEventBus()
    const process = makeProcess({
      status: 'running',
      terminalReason: undefined,
    })

    maybeNotifyOnProcessEvent(process, 'ws-1', bus as unknown as EventBus)
    assert.equal(bus.published.length, 0)
  })

  it('publishes event with valid id, timestamp, and schemaVersion', () => {
    const bus = new MockEventBus()
    const process = makeProcess({
      status: 'stopped',
      terminalReason: 'finished',
    })

    maybeNotifyOnProcessEvent(process, 'ws-1', bus as unknown as EventBus)
    assert.equal(bus.published.length, 1)

    const event = (bus.published[0] as any).event.properties.event
    assert.equal(typeof event.id, 'string')
    assert.ok(event.id.length > 0)
    assert.equal(typeof event.createdAt, 'number')
    assert.ok(event.createdAt > 0)
    assert.equal(event.schemaVersion, 1)
  })

  it('publishes event with process title and descriptive message', () => {
    const bus = new MockEventBus()
    const process = makeProcess({
      title: 'Deploy to Production',
      status: 'stopped',
      terminalReason: 'finished',
    })

    maybeNotifyOnProcessEvent(process, 'ws-1', bus as unknown as EventBus)
    assert.equal(bus.published.length, 1)

    const event = (bus.published[0] as any).event.properties.event
    assert.equal(event.title, 'Deploy to Production')
    assert.ok(event.message.includes('Deploy to Production'))
    assert.ok(event.message.includes('stopped'))
    assert.ok(event.message.includes('finished'))
  })
})
