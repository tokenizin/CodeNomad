/**
 * Sidecar proxy middleware for CodeNomad.
 *
 * Catches all /api/tokidapp/* routes that CodeNomad doesn't serve directly
 * and proxies them to the tokidapp-server sidecar (:8548).
 *
 * When the sidecar is unreachable, returns graceful fallback responses
 * instead of hard failures. This makes the sidecar "optional" — CodeNomad
 * degrades gracefully rather than breaking completely.
 *
 * Routes served DIRECTLY by CodeNomad (defined before this middleware):
 *   - POST /api/tokidapp/session (direct DB call)
 *   - POST/GET/DELETE /api/tokidapp/orchestrator (direct DB call)
 *   - GET/POST/PUT /api/tokidapp/approvals (direct DB call)
 *   - GET /api/tokidapp/files/proxy (blob proxy)
 *   - POST/GET /api/tokidapp/recordings/* (local storage)
 *
 * All other /api/tokidapp/* routes proxy to the sidecar with fallback.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { proxyWithFallback, getFallback } from "./sidecar-fallback"

export function registerSidecarProxyMiddleware(app: FastifyInstance) {
  // Catch-all for /api/tokidapp/* routes not handled above
  app.all("/api/tokidapp/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const { method, url, body, headers } = request

    // Skip WebSocket upgrades
    if (headers.upgrade?.toLowerCase() === "websocket") {
      reply.code(426).send({ error: "Upgrade not supported via proxy" })
      return
    }

    // Extract path without query string for fallback lookup
    const path = url.split("?")[0]

    // Check if we have a fallback for this route
    const fallback = getFallback(method, path)

    // Try sidecar
    const result = await proxyWithFallback(method, path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: headers as Record<string, string>,
      fallback,
    })

    // Copy response headers
    result.headers.forEach((value, key) => {
      if (key.toLowerCase() === "transfer-encoding") return
      reply.header(key, value)
    })

    reply.code(result.status)

    // Get the response body (either proxied or fallback)
    const responseText = await result.text()
    reply.send(responseText)
  })
}
