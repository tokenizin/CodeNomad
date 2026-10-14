import type { FastifyInstance } from "fastify"
import { handleModelSyncRoutes } from "../../model-sync/routes"

export function registerModelSyncRoutes(app: FastifyInstance) {
  app.all("/api/model-sync/*", async (request, reply) => {
    const path = request.raw.url?.split("?")[0] ?? ""
    const response = await handleModelSyncRoutes(request as unknown as Request, path) as unknown as Response
    if (response) {
      reply.status(response.status).send(await response.json())
    } else {
      reply.code(404).send({ error: "Not found" })
    }
  })
}