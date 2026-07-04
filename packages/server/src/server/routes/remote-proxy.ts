import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { RemoteProxySessionCreateResponse } from "../../api-types"
import { isLoopbackAddress } from "../../auth/http-auth"
import type { Logger } from "../../logger"
import type { RemoteProxySessionManager } from "../remote-proxy"

interface RouteDeps {
  logger: Logger
  sessionManager: RemoteProxySessionManager
}

const CreateSessionSchema = z.object({
  baseUrl: z.string().min(1),
  skipTlsVerify: z.boolean().optional(),
})

const SessionParamsSchema = z.object({
  id: z.string().uuid(),
})

export function registerRemoteProxyRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.register(async (scoped) => {
    // Override JSON parser for the remote proxy scope to accept empty JSON bodies.
    // Fastify's default parser rejects POST with Content-Type: application/json and empty body,
    // which causes FST_ERR_CTP_EMPTY_JSON_BODY before the route handler can provide defaults.
    scoped.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      try {
        const raw = typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf-8") : ""
        const text = (raw ?? "").trim()
        if (!text || text === "{}") {
          done(null, {})
        } else {
          done(null, JSON.parse(text))
        }
      } catch (err) {
        done(err as Error, undefined)
      }
    })

    scoped.post("/api/remote-proxy/sessions", async (request, reply): Promise<RemoteProxySessionCreateResponse | { error: string }> => {
      try {
        const body = CreateSessionSchema.parse(request.body ?? {})
        return await deps.sessionManager.createSession(body.baseUrl, Boolean(body.skipTlsVerify))
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to create remote proxy session")
        reply.code(400)
        return { error: error instanceof Error ? error.message : "Failed to create remote proxy session" }
      }
    })

    scoped.delete("/api/remote-proxy/sessions/:id", async (request, reply): Promise<{ ok: boolean } | { error: string }> => {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        reply.code(404)
        return { error: "Not found" }
      }

      try {
        const params = SessionParamsSchema.parse(request.params ?? {})
        const deleted = await deps.sessionManager.deleteSession(params.id)
        if (!deleted) {
          reply.code(404)
          return { error: "Remote proxy session not found" }
        }
        return { ok: true }
      } catch (error) {
        deps.logger.warn({ err: error }, "Failed to delete remote proxy session")
        reply.code(400)
        return { error: error instanceof Error ? error.message : "Failed to delete remote proxy session" }
      }
    })
  })
}
