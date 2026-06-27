/**
 * WikiLint API route — runs `lintWiki()` from the concierge codebase tools
 * and returns the result as JSON for the WikiLint tab in the right panel.
 */

import { FastifyInstance } from 'fastify'
import { lintWiki } from '../../plugins/tokidapp/concierge/codebase-tools'

export function registerWikiLintRoutes(app: FastifyInstance): void {
  app.get('/api/wiki-lint', async (_request, reply) => {
    try {
      const raw = await lintWiki()
      const parsed = JSON.parse(raw)
      reply.send(parsed)
    } catch (err) {
      reply.code(500).send({ error: `WikiLint failed: ${(err as Error).message}` })
    }
  })
}
