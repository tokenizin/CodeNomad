import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { authenticateAgentApiKey, hasScope, type AgentApiKeyAuth } from "../../lib/agent-api-key-auth.js"
import type { AgentApiKeyRecord } from "../../lib/db.js"
import { AgentSessionDispatcher } from "../../lib/agent-session-dispatch.js"
import type { Logger } from "../../logger.js"

const CreateSchema = z.object({
  agent: z.string().trim().min(1).max(100),
  prompt: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
})

function audit(logger: Logger, fields: Record<string, unknown>): void {
  logger.info({
    action: fields.action,
    keyId: fields.keyId ?? null,
    keyLabel: fields.keyLabel ?? null,
    agent: fields.agent ?? null,
    sessionId: fields.sessionId ?? null,
    threadId: fields.threadId ?? null,
    requestedBy: fields.requestedBy ?? null,
    status: fields.status ?? null,
    outcome: fields.outcome,
    timestamp: new Date().toISOString(),
  }, "agent session audit")
}

function safeMetadata(metadata: unknown): { threadId?: string; requestedBy?: string } {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {}
  const body = metadata as Record<string, unknown>
  const value = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : body
  return {
    ...(typeof value.threadId === "string" ? { threadId: value.threadId.slice(0, 500) } : {}),
    ...(typeof value.requestedBy === "string" ? { requestedBy: value.requestedBy.slice(0, 500) } : {}),
  }
}

async function requireKey(request: FastifyRequest, reply: FastifyReply, scope: string, logger: Logger, action: "create" | "read", lookup?: () => Promise<AgentApiKeyRecord[]>): Promise<AgentApiKeyAuth | null> {
  let key: AgentApiKeyAuth | null
  try {
    key = await authenticateAgentApiKey(request, lookup)
  } catch {
    audit(logger, { action, outcome: "credential_lookup_failure", ...safeMetadata(request.body) })
    reply.code(401).send({ error: "Unauthorized" }); return null
  }
  if (!key) {
    audit(logger, { action, outcome: "unauthorized", ...safeMetadata(request.body) })
    reply.code(401).send({ error: "Unauthorized" }); return null
  }
  if (!hasScope(key, scope)) {
    audit(logger, { action, keyId: key.id, keyLabel: key.label, outcome: "insufficient_scope", ...safeMetadata(request.body) })
    reply.code(403).send({ error: "scope not allowed" }); return null
  }
  return key
}

export function registerAgentSessionRoutes(app: FastifyInstance, deps: { dispatcher: AgentSessionDispatcher; logger: Logger; lookup?: () => Promise<AgentApiKeyRecord[]> }) {
  app.post("/api/agent-sessions", async (request, reply) => {
    const key = await requireKey(request, reply, "session:create", deps.logger, "create", deps.lookup)
    if (!key) return
    const parsed = CreateSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      audit(deps.logger, { action: "create", keyId: key.id, keyLabel: key.label, outcome: "invalid_body", ...safeMetadata(request.body) })
      reply.code(400).send({ error: "Invalid request body" }); return
    }
    if (!key.allowedAgents.includes(parsed.data.agent)) {
      audit(deps.logger, { action: "create", keyId: key.id, keyLabel: key.label, agent: parsed.data.agent, outcome: "agent_not_allowed", ...safeMetadata(parsed.data.metadata) })
      reply.code(403).send({ error: "agent not allowed for this key" }); return
    }
    try {
      const record = deps.dispatcher.create(parsed.data.agent, parsed.data.prompt, parsed.data.metadata)
      audit(deps.logger, { action: "create", keyId: key.id, keyLabel: key.label, agent: parsed.data.agent, sessionId: record.sessionId, status: record.status, outcome: "accepted", threadId: record.metadata.threadId, requestedBy: record.metadata.requestedBy })
      deps.dispatcher.enqueue(record, parsed.data.agent, parsed.data.prompt)
      reply.code(200).send({ sessionId: record.sessionId, status: "queued" })
    } catch {
      audit(deps.logger, { action: "create", keyId: key.id, keyLabel: key.label, agent: parsed.data.agent, outcome: "queue_failure", ...safeMetadata(parsed.data.metadata) })
      reply.code(400).send({ error: "Unable to queue agent session" })
    }
  })

  app.get<{ Params: { id: string } }>("/api/agent-sessions/:id", async (request, reply) => {
    const key = await requireKey(request, reply, "session:read", deps.logger, "read", deps.lookup)
    if (!key) return
    const record = deps.dispatcher.get(request.params.id)
    if (!record) {
      audit(deps.logger, { action: "read", keyId: key.id, keyLabel: key.label, sessionId: request.params.id, outcome: "unknown_session" })
      reply.code(404).send({ error: "Agent session not found" }); return
    }
    audit(deps.logger, { action: "read", keyId: key.id, keyLabel: key.label, sessionId: record.sessionId, status: record.status, outcome: "found", threadId: record.metadata.threadId, requestedBy: record.metadata.requestedBy })
    return { sessionId: record.sessionId, status: record.status, summary: record.summary, updatedAt: record.updatedAt }
  })
}
