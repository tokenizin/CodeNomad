// Refresh models route — re-fetches available models from provider APIs
import { FastifyInstance } from "fastify";

export function registerRefreshModelsRoutes(app: FastifyInstance) {
  app.post("/api/models/refresh", async (_request, reply) => {
    // Trigger model refresh — implementation pending
    reply.send({ ok: true, message: "Model refresh not yet implemented" });
  });
}
