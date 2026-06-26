import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EventEmitter } from 'events'
import type { EventBus } from '../../../events/bus'
import { createNotifyFromOrchestratorLog } from '../orchestrator'

// ==================== Mock EventBus ====================

class MockEventBus extends EventEmitter {
  published: unknown[] = []

  publish(event: unknown): boolean {
    this.published.push(event)
    return true
  }
}

// ==================== Tests ====================

describe('createNotifyFromOrchestratorLog', () => {
  it('maps NODE_FAILED to category "error"', () => {
    const bus = new MockEventBus()
    const result = createNotifyFromOrchestratorLog('NODE_FAILED', 'ERROR', 'Build step failed', undefined, 'inst-1', bus as unknown as EventBus)

    assert.equal(bus.published.length, 1)
    assert.equal(result.category, 'error')
  })

  it('maps ERROR event type to category "error"', () => {
    const bus = new MockEventBus()
    const result = createNotifyFromOrchestratorLog('ERROR', 'CRITICAL', 'Deadlock detected', undefined, 'inst-1', bus as unknown as EventBus)

    assert.equal(bus.published.length, 1)
    assert.equal(result.category, 'error')
  })

  it('maps NODE_COMPLETED to category "success_progress"', () => {
    const bus = new MockEventBus()
    const result = createNotifyFromOrchestratorLog('NODE_COMPLETED', 'INFO', 'Lint step passed', undefined, 'inst-1', bus as unknown as EventBus)

    assert.equal(bus.published.length, 1)
    assert.equal(result.category, 'success_progress')
  })

  it('maps WORKFLOW_COMPLETED to category "success_progress"', () => {
    const bus = new MockEventBus()
    const result = createNotifyFromOrchestratorLog('WORKFLOW_COMPLETED', 'INFO', 'Full pipeline done', undefined, 'inst-1', bus as unknown as EventBus)

    assert.equal(bus.published.length, 1)
    assert.equal(result.category, 'success_progress')
  })

  it('maps NODE_RETRY to category "workaround_suggested"', () => {
    const bus = new MockEventBus()
    const result = createNotifyFromOrchestratorLog('NODE_RETRY', 'WARN', 'Retrying deploy step', undefined, 'inst-1', bus as unknown as EventBus)

    assert.equal(bus.published.length, 1)
    assert.equal(result.category, 'workaround_suggested')
  })

  it('maps HEALING_ACTION to category "mitigation_applied"', () => {
    const bus = new MockEventBus()
    const result = createNotifyFromOrchestratorLog('HEALING_ACTION', 'WARN', 'Rolling back deploy', undefined, 'inst-1', bus as unknown as EventBus)

    assert.equal(bus.published.length, 1)
    assert.equal(result.category, 'mitigation_applied')
  })

  it('maps CRITICAL severity to NotifySeverity "critical"', () => {
    const bus = new MockEventBus()
    const result = createNotifyFromOrchestratorLog('ERROR', 'CRITICAL', 'Fatal error', undefined, 'inst-1', bus as unknown as EventBus)

    assert.equal(bus.published.length, 1)
    assert.equal(result.severity, 'critical')
  })

  it('includes error from metadata in message', () => {
    const bus = new MockEventBus()
    const metadata = { error: 'Connection timeout', nodeTitle: 'deploy' }
    const result = createNotifyFromOrchestratorLog('NODE_FAILED', 'ERROR', 'Deploy failed', metadata, 'inst-1', bus as unknown as EventBus)

    assert.ok(result.message.includes('Connection timeout'))
    assert.deepEqual(result.metadata, metadata)
  })

  it('publishes via eventBus with correct envelope structure', () => {
    const bus = new MockEventBus()
    createNotifyFromOrchestratorLog('NODE_STARTED', 'INFO', 'Running migration', undefined, 'inst-1', bus as unknown as EventBus)

    assert.equal(bus.published.length, 1)

    const envelope = bus.published[0] as any
    assert.equal(envelope.type, 'instance.event')
    assert.equal(envelope.instanceId, 'inst-1')
    assert.equal(envelope.event.type, 'notify.create')
    assert.ok(envelope.event.properties.event)
    assert.equal(envelope.event.properties.event.eventType, 'NODE_STARTED')
  })

  it('generates a valid event with id, createdAt, and schemaVersion', () => {
    const bus = new MockEventBus()
    const result = createNotifyFromOrchestratorLog('WORKFLOW_COMPLETED', 'INFO', 'Pipeline complete', undefined, 'inst-1', bus as unknown as EventBus)

    assert.equal(typeof result.id, 'string')
    assert.ok(result.id.length > 0)
    assert.equal(typeof result.createdAt, 'number')
    assert.ok(result.createdAt > 0)
    assert.equal(result.schemaVersion, 1)
  })

  it('maps NODE_STARTED to category "task_status"', () => {
    const bus = new MockEventBus()
    const result = createNotifyFromOrchestratorLog('NODE_STARTED', 'INFO', 'Starting build', undefined, 'inst-1', bus as unknown as EventBus)

    assert.equal(result.category, 'task_status')
  })

  it('maps BROADCAST_SENT to category "broadcast"', () => {
    const bus = new MockEventBus()
    const result = createNotifyFromOrchestratorLog('BROADCAST_SENT', 'INFO', 'Broadcast message', undefined, 'inst-1', bus as unknown as EventBus)

    assert.equal(result.category, 'broadcast')
  })
})
