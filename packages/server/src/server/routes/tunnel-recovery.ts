import fs from "node:fs/promises"
import path from "node:path"
import type { FastifyInstance } from "fastify"

const REPO_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()
const QUEUE_PATH = path.join(REPO_ROOT, "logs", "codenomad-host-restart.queue")

/** Same-origin queue for Mac host restart (avoids CORS to StarGuard from codenomad.tokenizin.com). */
export function registerTunnelRecoveryRoutes(app: FastifyInstance) {
  app.post("/api/tunnel/restart-request", async (request, reply) => {
    const body = (request.body ?? {}) as { reason?: string; source?: string }
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "ui_request"
    const source = typeof body.source === "string" ? body.source.trim().slice(0, 64) : "codenomad_ui"

    await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true })
    await fs.appendFile(QUEUE_PATH, `${Math.floor(Date.now() / 1000)} codenomad\n`)

    return reply.code(202).send({
      queued: true,
      reason,
      source,
      note: "Host launchd consumer drains logs/codenomad-host-restart.queue",
    })
  })
}
