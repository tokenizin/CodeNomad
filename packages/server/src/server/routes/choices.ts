/**
 * Choice API routes — receive choice replies from the UI and broadcast them
 * as chat.choice.replied SSE events so the active agent can observe the response.
 *
 * Wired into http-server.ts alongside other route registrations.
 */

import { FastifyInstance } from 'fastify'
import type { EventBus } from '../../events/bus'

// ==================== Route Dependencies ====================

export interface ChoiceRouteDeps {
  eventBus: EventBus
}

// ==================== Route Registration ====================

export function registerChoiceRoutes(app: FastifyInstance, deps: ChoiceRouteDeps): void {
  const { eventBus } = deps

  /**
   * POST /api/choices/reply
   *
   * Accept a choice reply from the UI and broadcast it as a chat.choice.replied
   * event via the SSE stream for the specified instance.
   *
   * Body: { instanceId: string; id: string; value: string | string[] }
   */
  app.post('/api/choices/reply', (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined

    if (!body || typeof body !== 'object') {
      reply.code(400).send({ error: 'Request body must be a JSON object' })
      return
    }

    const { instanceId, id, value } = body

    if (!instanceId || typeof instanceId !== 'string') {
      reply.code(400).send({ error: 'Missing or invalid required field: instanceId' })
      return
    }

    if (!id || typeof id !== 'string') {
      reply.code(400).send({ error: 'Missing or invalid required field: id' })
      return
    }

    if (value === undefined || value === null) {
      reply.code(400).send({ error: 'Missing required field: value' })
      return
    }

    // Validate value is string or string[]
    if (typeof value !== 'string' && !Array.isArray(value)) {
      reply.code(400).send({ error: 'Field value must be a string or array of strings' })
      return
    }

    if (Array.isArray(value) && !value.every((v) => typeof v === 'string')) {
      reply.code(400).send({ error: 'Array value must contain only strings' })
      return
    }

    // Broadcast the reply event via SSE stream
    eventBus.publish({
      type: 'instance.event',
      instanceId: instanceId as string,
      event: {
        type: 'chat.choice.replied',
        properties: {
          payload: { id: id as string, value },
        },
      },
    })

    reply.code(200).send({ ok: true })
  })
}
