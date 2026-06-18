import type { FastifyInstance } from "fastify"
import { listLocalLlmModels } from "../../local-llm/service"

export function registerLocalLlmRoutes(app: FastifyInstance) {
  app.get("/api/local-llm/models", async () => listLocalLlmModels())
}
