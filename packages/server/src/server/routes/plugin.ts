import { FastifyInstance } from "fastify"
import { z } from "zod"
import type { VoiceModeStateResponse } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { EventBus } from "../../events/bus"
import type { Logger } from "../../logger"
import { PluginChannelManager } from "../../plugins/channel"
import { buildPingEvent, handlePluginEvent } from "../../plugins/handlers"
import { VoiceModeManager } from "../../plugins/voice-mode"
import { createJevToolGate, type JevToolGate } from "../../lib/jev/index.js"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
  channel: PluginChannelManager
  voiceModeManager: VoiceModeManager
  /** Lazily created so the TypeSafe credential is only read when the gate is used. */
  jevToolGate?: JevToolGate
}

const PluginEventSchema = z.object({
  type: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
})

const VoiceModeStateSchema = z.object({
  enabled: z.boolean(),
  clientId: z.string().trim().min(1),
  connectionId: z.string().trim().min(1),
})

/** One pending tool action, as reported by the OpenCode plugin hooks. */
const JevGateRequestSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  target: z.union([z.string(), z.array(z.string())]).optional(),
  title: z.string().max(2000).optional(),
  detail: z.string().max(4000).optional(),
  sessionId: z.string().max(128).optional(),
  /** Status the harness already decided. The gate may restrict, never relax it. */
  baseline: z.enum(["allow", "ask", "deny"]).optional(),
})

export function registerPluginRoutes(app: FastifyInstance, deps: RouteDeps) {
  // One gate per server process: the answer cache and the shadow counters must
  // survive across requests, and the TypeSafe credential must be read once.
  let gateInstance: JevToolGate | undefined = deps.jevToolGate
  const jevToolGate = (): JevToolGate => {
    if (!gateInstance) gateInstance = createJevToolGate({ logger: deps.logger })
    return gateInstance
  }
  app.get<{ Params: { id: string } }>("/workspaces/:id/plugin/events", (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.flushHeaders?.()
    reply.hijack()

    const registration = deps.channel.register(request.params.id, reply)
    deps.voiceModeManager.syncInstance(request.params.id)

    const heartbeat = setInterval(() => {
      deps.channel.send(request.params.id, buildPingEvent())
    }, 15000)

    const close = () => {
      clearInterval(heartbeat)
      registration.close()
      reply.raw.end?.()
    }

    request.raw.on("close", close)
    request.raw.on("error", close)
  })

  app.post<{ Params: { id: string }; Body: VoiceModeStateResponse }>("/workspaces/:id/plugin/voice-mode", (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const payload = VoiceModeStateSchema.parse(request.body ?? {})
    const applied = deps.voiceModeManager.setEnabled(
      request.params.id,
      { clientId: payload.clientId, connectionId: payload.connectionId },
      payload.enabled,
    )

    if (payload.enabled && !applied) {
      reply.code(409).send({ error: "Client connection not active for voice mode enable" })
      return
    }

    return { enabled: payload.enabled }
  })

  /**
   * POST /workspaces/:id/plugin/jev/tool-gate
   *
   * Classifies one pending tool action. Always 200 with a verdict — the caller must
   * be able to tell `ok` from `degraded`, and a degraded verdict must never look like
   * a clean pass. The gate never throws upstream at the plugin.
   */
  app.post<{ Params: { id: string } }>("/workspaces/:id/plugin/jev/tool-gate", async (request, reply) => {
    const workspaceId = request.params.id
    const workspace = deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const parsed = JevGateRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.code(400).send({ error: "Invalid tool-gate request", detail: parsed.error.issues })
      return
    }

    const gate = jevToolGate()
    const { kind, target, title, detail, sessionId, baseline } = parsed.data
    const verdict = await gate.evaluate({ kind, target, title, detail, sessionId }, baseline)

    return {
      status: verdict.status,
      action: verdict.action,
      enforced: verdict.enforced,
      reason: verdict.reason,
      degradedReason: verdict.degradedReason ?? null,
      scores: verdict.scores,
      latencyMs: verdict.latencyMs,
      model: verdict.model ?? null,
      cached: verdict.cached ?? false,
    }
  })

  /** GET /workspaces/:id/plugin/jev/metrics — shadow-mode counters. */
  app.get<{ Params: { id: string } }>("/workspaces/:id/plugin/jev/metrics", async (request, reply) => {
    const workspaceId = request.params.id
    const workspace = deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const gate = jevToolGate()
    return { mode: gate.config.mode, enabled: gate.isEnabled(), metrics: gate.metrics() }
  })

  const handleWildcard = async (request: any, reply: any) => {
    const workspaceId = request.params.id as string
    const workspace = deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const suffix = (request.params["*"] as string | undefined) ?? ""
    const normalized = suffix.replace(/^\/+/, "")

    if (normalized === "event" && request.method === "POST") {
      const parsed = PluginEventSchema.parse(request.body ?? {})
      handlePluginEvent(workspaceId, parsed, { workspaceManager: deps.workspaceManager, eventBus: deps.eventBus, logger: deps.logger })
      reply.code(204).send()
      return
    }

    reply.code(404).send({ error: "Unknown plugin endpoint" })
  }

  app.all("/workspaces/:id/plugin/*", handleWildcard)
  app.all("/workspaces/:id/plugin", handleWildcard)
}
