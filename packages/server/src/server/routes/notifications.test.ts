import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import Fastify from 'fastify'
import { registerNotificationRoutes } from './notifications'
import { NotifyRegistry } from '../../notify/registry'

// ==================== Setup ====================

function createApp() {
  const app = Fastify({ logger: false })
  const notifyRegistry = new NotifyRegistry({ cap: 50, defaultTtlMs: 86_400_000 })
  registerNotificationRoutes(app, { notifyRegistry })

  return { app, notifyRegistry }
}

// ==================== Tests ====================

describe('GET /api/notifications', () => {
  let app: ReturnType<typeof createApp>['app']
  let registry: ReturnType<typeof createApp>['notifyRegistry']

  beforeEach(() => {
    const created = createApp()
    app = created.app
    registry = created.notifyRegistry
  })

  it('returns 400 when instanceId is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications' })
    assert.equal(res.statusCode, 400)
    assert.ok(res.json().error.includes('instanceId'))
    await app.close()
  })

  it('returns empty array for unknown instance', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=nonexistent' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [])
    await app.close()
  })

  it('lists all events for an instance', async () => {
    registry.register({ instanceId: 'inst-1', title: 'A', message: 'msg A' })
    registry.register({ instanceId: 'inst-1', title: 'B', message: 'msg B' })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1' })
    assert.equal(res.statusCode, 200)
    const events = res.json()
    assert.equal(events.length, 2)
    assert.equal(events[0].title, 'B') // newest first
    await app.close()
  })

  it('filters by since', async () => {
    const oldTs = Date.now() - 10_000
    registry.register({ instanceId: 'inst-1', title: 'Old', message: '', createdAt: oldTs })
    registry.register({ instanceId: 'inst-1', title: 'New', message: '' })

    const res = await app.inject({ method: 'GET', url: `/api/notifications?instanceId=inst-1&since=${Date.now() - 5_000}` })
    assert.equal(res.statusCode, 200)
    const events = res.json()
    assert.equal(events.length, 1)
    assert.equal(events[0].title, 'New')
    await app.close()
  })

  it('filters by category', async () => {
    registry.register({ instanceId: 'inst-1', title: 'Task', message: '', category: 'task' })
    registry.register({ instanceId: 'inst-1', title: 'Session', message: '', category: 'session' })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&category=session' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 1)
    assert.equal(res.json()[0].title, 'Session')
    await app.close()
  })

  it('filters by multiple categories (comma-separated)', async () => {
    registry.register({ instanceId: 'inst-1', title: 'Task', message: '', category: 'task' })
    registry.register({ instanceId: 'inst-1', title: 'Session', message: '', category: 'session' })
    registry.register({ instanceId: 'inst-1', title: 'System', message: '', category: 'system' })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&category=task,system' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 2)
    await app.close()
  })

  it('filters by priority', async () => {
    registry.register({ instanceId: 'inst-1', title: 'High', message: '', priority: 'high' })
    registry.register({ instanceId: 'inst-1', title: 'Low', message: '', priority: 'low' })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&priority=high' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 1)
    await app.close()
  })

  it('filters by severity', async () => {
    registry.register({ instanceId: 'inst-1', title: 'Error', message: '', severity: 'error' })
    registry.register({ instanceId: 'inst-1', title: 'Info', message: '', severity: 'info' })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&severity=error' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 1)
    await app.close()
  })

  it('filters by source', async () => {
    registry.register({ instanceId: 'inst-1', title: 'Orch', message: '', source: 'orchestrator' })
    registry.register({ instanceId: 'inst-1', title: 'Manual', message: '', source: 'manual' })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&source=orchestrator' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 1)
    await app.close()
  })

  it('filters by eventType', async () => {
    registry.register({ instanceId: 'inst-1', title: 'Failed', message: '', eventType: 'NODE_FAILED' })
    registry.register({ instanceId: 'inst-1', title: 'Started', message: '', eventType: 'NODE_STARTED' })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&eventType=NODE_FAILED' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 1)
    await app.close()
  })

  it('filters by eventTypePattern', async () => {
    registry.register({ instanceId: 'inst-1', title: 'A', message: '', eventType: 'NODE_FAILED' })
    registry.register({ instanceId: 'inst-1', title: 'B', message: '', eventType: 'NODE_STARTED' })
    registry.register({ instanceId: 'inst-1', title: 'C', message: '', eventType: 'TASK_DONE' })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&eventTypePattern=^NODE' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 2)
    await app.close()
  })

  it('filters by unreadOnly', async () => {
    const e = registry.register({ instanceId: 'inst-1', title: 'Read', message: '' })
    registry.register({ instanceId: 'inst-1', title: 'Unread', message: '' })
    registry.update('inst-1', e.id, { read: true })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&unreadOnly=true' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 1)
    assert.equal(res.json()[0].title, 'Unread')
    await app.close()
  })

  it('filters by escalationOnly', async () => {
    registry.register({ instanceId: 'inst-1', title: 'Normal', message: '' })
    registry.register({ instanceId: 'inst-1', title: 'Esc', message: '', escalation: { level: 1, reason: 'test' } })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&escalationOnly=true' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 1)
    assert.equal(res.json()[0].title, 'Esc')
    await app.close()
  })

  it('filters by helpRequired', async () => {
    registry.register({ instanceId: 'inst-1', title: 'Help', message: '', helpRequired: true })
    registry.register({ instanceId: 'inst-1', title: 'NoHelp', message: '' })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&helpRequired=true' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 1)
    await app.close()
  })

  it('applies limit', async () => {
    registry.register({ instanceId: 'inst-1', title: 'A', message: '' })
    registry.register({ instanceId: 'inst-1', title: 'B', message: '' })
    registry.register({ instanceId: 'inst-1', title: 'C', message: '' })

    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&limit=2' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 2)
    await app.close()
  })

  it('applies offset', async () => {
    registry.register({ instanceId: 'inst-1', title: 'A', message: '' })
    registry.register({ instanceId: 'inst-1', title: 'B', message: '' })
    registry.register({ instanceId: 'inst-1', title: 'C', message: '' })

    // Newest first: C, B, A. Offset 1 → B, A
    const res = await app.inject({ method: 'GET', url: '/api/notifications?instanceId=inst-1&offset=1' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 2)
    assert.equal(res.json()[0].title, 'B')
    await app.close()
  })
})

// ==================== GET /api/notifications/:id ====================

describe('GET /api/notifications/:id', () => {
  it('gets a single notification by id', async () => {
    const { app, notifyRegistry } = createApp()
    const event = notifyRegistry.register({ instanceId: 'inst-1', title: 'Single', message: 'test' })

    const res = await app.inject({ method: 'GET', url: `/api/notifications/${event.id}?instanceId=inst-1` })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().id, event.id)
    assert.equal(res.json().title, 'Single')
    await app.close()
  })

  it('returns 404 for unknown id', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'GET', url: '/api/notifications/nonexistent?instanceId=inst-1' })
    assert.equal(res.statusCode, 404)
    await app.close()
  })

  it('returns 400 when instanceId is missing', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'GET', url: '/api/notifications/some-id' })
    assert.equal(res.statusCode, 400)
    await app.close()
  })
})

// ==================== POST /api/notifications ====================

describe('POST /api/notifications', () => {
  it('creates a notification and returns 201', async () => {
    const { app } = createApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications',
      payload: { instanceId: 'inst-1', title: 'Created', message: 'via POST' },
    })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().title, 'Created')
    assert.equal(res.json().instanceId, 'inst-1')
    await app.close()
  })

  it('returns 400 when title is missing', async () => {
    const { app } = createApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications',
      payload: { instanceId: 'inst-1', message: 'no title' },
    })
    assert.equal(res.statusCode, 400)
    await app.close()
  })

  it('returns 400 when body is empty', async () => {
    const { app } = createApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications',
      payload: {},
    })
    assert.equal(res.statusCode, 400)
    await app.close()
  })
})

// ==================== PATCH /api/notifications/:id ====================

describe('PATCH /api/notifications/:id', () => {
  it('updates a notification', async () => {
    const { app, notifyRegistry } = createApp()
    const event = notifyRegistry.register({ instanceId: 'inst-1', title: 'Before', message: 'test' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/${event.id}?instanceId=inst-1`,
      payload: { title: 'After', read: true },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().title, 'After')
    assert.equal(res.json().read, true)
    await app.close()
  })

  it('returns 404 for unknown id', async () => {
    const { app } = createApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/nonexistent?instanceId=inst-1',
      payload: { title: 'Nope' },
    })
    assert.equal(res.statusCode, 404)
    await app.close()
  })

  it('returns 400 when instanceId is missing', async () => {
    const { app } = createApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/some-id',
      payload: { title: 'Nope' },
    })
    assert.equal(res.statusCode, 400)
    await app.close()
  })
})

// ==================== DELETE /api/notifications/:id ====================

describe('DELETE /api/notifications/:id', () => {
  it('removes a notification', async () => {
    const { app, notifyRegistry } = createApp()
    const event = notifyRegistry.register({ instanceId: 'inst-1', title: 'Delete me', message: 'test' })

    const res = await app.inject({ method: 'DELETE', url: `/api/notifications/${event.id}?instanceId=inst-1` })
    assert.equal(res.statusCode, 204)

    const list = notifyRegistry.list('inst-1')
    assert.equal(list.length, 0)
    await app.close()
  })

  it('returns 404 for unknown id', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/notifications/nonexistent?instanceId=inst-1' })
    assert.equal(res.statusCode, 404)
    await app.close()
  })

  it('returns 400 when instanceId is missing', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/notifications/some-id' })
    assert.equal(res.statusCode, 400)
    await app.close()
  })
})

// ==================== DELETE /api/notifications ====================

describe('DELETE /api/notifications (clear instance)', () => {
  it('clears all notifications for an instance', async () => {
    const { app, notifyRegistry } = createApp()
    notifyRegistry.register({ instanceId: 'inst-1', title: 'A', message: '' })
    notifyRegistry.register({ instanceId: 'inst-1', title: 'B', message: '' })

    const res = await app.inject({ method: 'DELETE', url: '/api/notifications?instanceId=inst-1' })
    assert.equal(res.statusCode, 204)
    assert.equal(notifyRegistry.list('inst-1').length, 0)
    await app.close()
  })

  it('returns 400 when instanceId is missing', async () => {
    const { app } = createApp()
    const res = await app.inject({ method: 'DELETE', url: '/api/notifications' })
    assert.equal(res.statusCode, 400)
    await app.close()
  })
})
