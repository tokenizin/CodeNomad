import { FastifyInstance } from "fastify"
import { z } from "zod"
import { existsSync } from "fs"
import { open } from "fs/promises"
import path from "path"
import type { SideCarManager } from "../../sidecars/manager"

interface RouteDeps {
  sidecarManager: SideCarManager
}

/**
 * Resolve the log file path for a given sidecar ID.
 * Logs are written to `logs/<id>.log` relative to the project root.
 * The CodeNomad server runs from the project root, so we use a relative path.
 */
function resolveLogPath(id: string): string {
  return path.join(process.cwd(), "logs", `${id}.log`)
}

const SideCarCreateSchema = z.object({
  kind: z.literal("port").default("port"),
  name: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  insecure: z.boolean().default(false),
  prefixMode: z.enum(["strip", "preserve"]).default("strip"),
})

const SideCarUpdateSchema = SideCarCreateSchema.omit({ kind: true }).partial().refine((value) => Object.keys(value).length > 0, {
  message: "At least one field is required",
})

export function registerSideCarRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/sidecars", async () => {
    return { sidecars: await deps.sidecarManager.list() }
  })

  app.get<{ Params: { id: string } }>("/api/sidecars/:id", async (request, reply) => {
    const sidecar = await deps.sidecarManager.get(request.params.id)
    if (!sidecar) {
      reply.code(404)
      return { error: "SideCar not found" }
    }
    return sidecar
  })

  app.post("/api/sidecars", async (request, reply) => {
    try {
      const body = SideCarCreateSchema.parse(request.body ?? {})
      const sidecar = await deps.sidecarManager.create(body)
      reply.code(201)
      return sidecar
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to create SideCar" }
    }
  })

  app.put<{ Params: { id: string } }>("/api/sidecars/:id", async (request, reply) => {
    try {
      const body = SideCarUpdateSchema.parse(request.body ?? {})
      return await deps.sidecarManager.update(request.params.id, body)
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to update SideCar" }
    }
  })

  app.delete<{ Params: { id: string } }>("/api/sidecars/:id", async (request, reply) => {
    const removed = await deps.sidecarManager.delete(request.params.id)
    if (!removed) {
      reply.code(404)
      return { error: "SideCar not found" }
    }
    reply.code(204)
  })

  // ── Log tail SSE endpoint ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/sidecars/:id/logs", async (request, reply) => {
    const { id } = request.params
    const logPath = resolveLogPath(id)

    if (!existsSync(logPath)) {
      reply.code(404)
      return { error: `No log file found for sidecar '${id}'` }
    }

    // Set SSE headers
    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache, no-store, must-revalidate")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.setHeader("X-Accel-Buffering", "no")
    reply.raw.flushHeaders?.()
    reply.hijack()

    const file = await open(logPath, "r")
    let position = (await file.stat()).size

    // Send initial connection event
    reply.raw.write(`event: connected\ndata: {"status":"ok"}\n\n`)

    const tick = async () => {
      try {
        const stats = await file.stat()
        if (stats.size <= position) return

        const length = stats.size - position
        const buffer = Buffer.alloc(length)
        await file.read(buffer, 0, length, position)
        position = stats.size

        const content = buffer.toString("utf-8")
        const lines = content.split("\n").filter(Boolean)

        for (const line of lines) {
          // Parse log line into structured format
          const parsed = parseLogLine(line)
          reply.raw.write(`event: log\ndata: ${JSON.stringify(parsed)}\n\n`)
        }
      } catch (error) {
        console.warn("[sidecar-logs] Failed to tail log:", error)
      }
    }

    // Poll every 500ms for new log content
    const interval = setInterval(tick, 500)

    const close = () => {
      clearInterval(interval)
      file.close().catch(() => undefined)
      reply.raw.end?.()
    }

    reply.raw.on("close", close)
    reply.raw.on("error", close)
  })
}

// ─── Log line parser ────────────────────────────────────────────────

interface LogLine {
  timestamp: string
  level: "info" | "warn" | "error"
  message: string
}

function parseLogLine(line: string): LogLine {
  const now = new Date().toISOString()
  const trimmed = line.trimEnd()

  // Try to extract timestamp from common log formats
  const tsMatch = trimmed.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/)
  const timestamp = tsMatch?.[0] ?? now

  // Determine severity
  let level: LogLine["level"] = "info"
  if (/error|fail|critical|fatal|exception|stacktrace/i.test(trimmed)) {
    level = "error"
  } else if (/warn|warning|deprecated/i.test(trimmed)) {
    level = "warn"
  }

  // Strip timestamp prefix for cleaner message display
  let message = trimmed
  if (tsMatch) {
    message = trimmed.replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.,]\s*/, "")
  }

  return { timestamp, level, message }
}
