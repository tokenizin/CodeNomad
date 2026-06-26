/**
 * Notifications API routes — REST catch-up and CRUD for NotifyEvent.
 *
 * Primary endpoint: `GET /api/notifications?instanceId=...` for reload recovery.
 * Also exposes POST/PATCH/DELETE for direct HTTP-based producers.
 *
 * Wired into http-server.ts alongside other route registrations.
 */

import { FastifyInstance } from 'fastify'
import type { NotifyRegistry } from '../../notify/registry'
import type { NotifyFilter, NotifyEvent } from '../../notify/types'

// ==================== Route Dependencies ====================

export interface NotificationRouteDeps {
  notifyRegistry: NotifyRegistry
}

// ==================== Query Schema Helpers ====================

interface ListQuery {
  instanceId: string
  since?: string
  category?: string
  priority?: string
  severity?: string
  eventType?: string
  eventTypePattern?: string
  source?: string
  helpRequired?: string
  escalationOnly?: string
  unreadOnly?: string
  limit?: string
  offset?: string
}

interface UpdateQuery {
  instanceId: string
}

function parseListQuery(query: ListQuery): { instanceId: string; filter?: NotifyFilter } {
  const filter: NotifyFilter = {}

  if (query.since) {
    const since = parseInt(query.since, 10)
    if (!isNaN(since)) filter.since = since
  }

  if (query.category) {
    const parts = query.category.split(',')
    filter.category = parts as any
  }

  if (query.priority) {
    const parts = query.priority.split(',')
    filter.priority = parts as any
  }

  if (query.severity) {
    const parts = query.severity.split(',')
    filter.severity = parts as any
  }

  if (query.eventType) {
    filter.eventType = query.eventType
  }

  if (query.eventTypePattern) {
    filter.eventTypePattern = query.eventTypePattern
  }

  if (query.source) {
    const parts = query.source.split(',')
    filter.source = parts as any
  }

  if (query.helpRequired !== undefined) {
    filter.helpRequired = query.helpRequired === 'true'
  }

  if (query.escalationOnly !== undefined) {
    filter.escalationOnly = query.escalationOnly === 'true'
  }

  if (query.unreadOnly !== undefined) {
    filter.unreadOnly = query.unreadOnly === 'true'
  }

  if (query.limit) {
    const limit = parseInt(query.limit, 10)
    if (!isNaN(limit) && limit > 0) filter.limit = limit
  }

  if (query.offset) {
    const offset = parseInt(query.offset, 10)
    if (!isNaN(offset) && offset > 0) filter.offset = offset
  }

  return { instanceId: query.instanceId, filter: Object.keys(filter).length > 0 ? filter : undefined }
}

// ==================== Route Registration ====================

export function registerNotificationRoutes(app: FastifyInstance, deps: NotificationRouteDeps): void {
  const { notifyRegistry } = deps

  // ---- List / catch-up ----
  app.get('/api/notifications', (request, reply) => {
    const query = request.query as ListQuery

    if (!query.instanceId) {
      reply.code(400).send({ error: 'Missing required query parameter: instanceId' })
      return
    }

    const { instanceId, filter } = parseListQuery(query)
    const events = notifyRegistry.list(instanceId, filter)
    reply.send(events)
  })

  // ---- Get single ----
  app.get<{ Params: { id: string } }>('/api/notifications/:id', (request, reply) => {
    const query = request.query as UpdateQuery

    if (!query.instanceId) {
      reply.code(400).send({ error: 'Missing required query parameter: instanceId' })
      return
    }

    const event = notifyRegistry.get(query.instanceId, request.params.id)
    if (!event) {
      reply.code(404).send({ error: 'Notification not found' })
      return
    }

    reply.send(event)
  })

  // ---- Create ----
  app.post('/api/notifications', (request, reply) => {
    const body = request.body as Record<string, unknown>

    if (!body || typeof body !== 'object' || !body.instanceId || !body.title || !body.message) {
      reply.code(400).send({ error: 'Missing required fields: instanceId, title, message' })
      return
    }

    const event = notifyRegistry.register(body as any)
    reply.code(201).send(event)
  })

  // ---- Update (patch) ----
  app.patch<{ Params: { id: string } }>('/api/notifications/:id', (request, reply) => {
    const query = request.query as UpdateQuery

    if (!query.instanceId) {
      reply.code(400).send({ error: 'Missing required query parameter: instanceId' })
      return
    }

    const patch = request.body as Record<string, unknown>
    if (!patch || typeof patch !== 'object') {
      reply.code(400).send({ error: 'Request body must be a JSON object' })
      return
    }

    const updated = notifyRegistry.update(query.instanceId, request.params.id, patch as Partial<NotifyEvent>)
    if (!updated) {
      reply.code(404).send({ error: 'Notification not found' })
      return
    }

    reply.send(updated)
  })

  // ---- Delete single ----
  app.delete<{ Params: { id: string } }>('/api/notifications/:id', (request, reply) => {
    const query = request.query as UpdateQuery

    if (!query.instanceId) {
      reply.code(400).send({ error: 'Missing required query parameter: instanceId' })
      return
    }

    const removed = notifyRegistry.remove(query.instanceId, request.params.id)
    if (!removed) {
      reply.code(404).send({ error: 'Notification not found' })
      return
    }

    reply.code(204).send()
  })

  // ---- Clear instance ----
  app.delete('/api/notifications', (request, reply) => {
    const query = request.query as { instanceId?: string }

    if (!query.instanceId) {
      reply.code(400).send({ error: 'Missing required query parameter: instanceId' })
      return
    }

    notifyRegistry.clear(query.instanceId)
    reply.code(204).send()
  })
}
