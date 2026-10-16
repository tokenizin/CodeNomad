import type { FastifyInstance } from "fastify"
import { handleModelSyncRoutes } from "../../model-sync/routes"

export function registerModelSyncRoutes(app: FastifyInstance) {
  app.all("/api/model-sync/*", async (request, reply) => {
    const path = request.raw.url?.split("?")[0] ?? ""

    // Bridge Fastify request to Web API Request shape
    // Fastify already parses the body — wrap it so handlers can call .json()
    const fakeRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      json: async () => request.body ?? {},
      text: async () => (typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {})),
    } as unknown as Request

    const response = await handleModelSyncRoutes(fakeRequest, path) as unknown as Response
    if (response) {
      const body = await response.json()
      reply.status(response.status).send(body)
    } else {
      reply.code(404).send({ error: "Not found" })
    }
  })
}