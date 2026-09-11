/**
 * Direct DB-backed routes for high-priority concierge endpoints.
 *
 * These routes bypass the :8548 sidecar entirely, using CodeNomad's own
 * Kysely DB connection + tokidapp-queries. Registered BEFORE the sidecar
 * proxy middleware so they take precedence.
 *
 * Routes handled here:
 *   GET    /api/tokidapp/sessions                  — list with pagination
 *   GET    /api/tokidapp/sessions/:id              — detail + counts + messages
 *   PATCH  /api/tokidapp/sessions/:id              — update title/status
 *   DELETE /api/tokidapp/sessions/:id              — hard delete
 *   POST   /api/tokidapp/sessions/purge-empty      — purge empty ACTIVE sessions
 *   POST   /api/tokidapp/sessions/:id/finalize     — end session + transcript
 *   GET    /api/tokidapp/attention                 — pending approvals/tasks
 *   POST   /api/tokidapp/messages                  — save messages
 *   GET    /api/tokidapp/messages                  — get messages by session
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import type { StarGuardJwtHandler, StarGuardPayload } from "../../auth/starguard-jwt"
import { getTokidappDb } from "../../lib/db"
import {
  findSessionsByUser,
  findSessionById,
  updateSession,
  deleteSession,
  purgeEmptySessions,
  finalizeSession,
  findMessagesBySessionPaginated,
  createMessages,
  setSessionTitleFromFirstMessage,
} from "../../lib/tokidapp-queries"

// ── Auth helper ──────────────────────────────────────────────

async function requireAuth(request: FastifyRequest, reply: FastifyReply, handler?: StarGuardJwtHandler): Promise<StarGuardPayload | null> {
  if (!handler) {
    reply.code(503)
    return null
  }
  const authHeader = (request.headers.authorization ?? "") as string
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
  if (!token) {
    reply.code(401)
    return null
  }
  const payload = await handler.verify(token)
  if (!payload) {
    reply.code(401)
    return null
  }
  return payload
}

// ── Role mapping ─────────────────────────────────────────────

const ROLE_MAP: Record<string, string> = {
  user: "USER",
  assistant: "ASSISTANT",
  system: "SYSTEM",
  tool_call: "TOOL_CALL",
  tool_result: "TOOL_RESULT",
  USER: "USER",
  ASSISTANT: "ASSISTANT",
  SYSTEM: "SYSTEM",
  TOOL_CALL: "TOOL_CALL",
  TOOL_RESULT: "TOOL_RESULT",
}

function mapRole(role: string): string {
  return ROLE_MAP[role] || "SYSTEM"
}

// ── Event enum guards ────────────────────────────────────────
// TokiDAPPEventType and TokiDAPPEventSeverity are Postgres enums —
// an unknown label raises 22P02, so unrecognised input is coerced
// to a valid member rather than passed through.

const VALID_EVENT_TYPES = new Set([
  "ORCHESTRATOR_CREATED", "ORCHESTRATOR_GREETED", "INTENT_CLASSIFIED",
  "DAG_BUILT", "NODE_STARTED", "NODE_COMPLETED", "NODE_FAILED",
  "NODE_RETRY", "NODE_SKIPPED", "APPROVAL_REQUESTED", "APPROVAL_APPROVED",
  "APPROVAL_REJECTED", "APPROVAL_EXPIRED", "BROADCAST_SENT",
  "LIFECYCLE_PHASE", "ERROR", "HEALING_ACTION", "WORKFLOW_COMPLETED",
])

const VALID_SEVERITIES = new Set(["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"])

function coerceEventType(raw: unknown): string {
  const v = String(raw ?? "").toUpperCase()
  return VALID_EVENT_TYPES.has(v) ? v : "LIFECYCLE_PHASE"
}

function coerceSeverity(raw: unknown): string {
  const v = String(raw ?? "").toUpperCase()
  return VALID_SEVERITIES.has(v) ? v : "INFO"
}

// ── Routes ───────────────────────────────────────────────────

export function registerTokidappDirectRoutes(app: FastifyInstance, starGuardJwtHandler?: StarGuardJwtHandler) {

  // ── Sessions list ──────────────────────────────────────────
  app.get("/api/tokidapp/sessions", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth || typeof auth !== "object") return auth
    const userId = auth.userId

    const query = request.query as Record<string, string>
    const limit = Math.min(parseInt(query.limit || "50"), 200)
    const offset = parseInt(query.offset || "0")
    const includeEmpty = query.includeEmpty === "1"
    const includeArchived = query.includeArchived === "1"
    const emptyOnly = query.emptyOnly === "1"

    const db = getTokidappDb()

    // Build where clause dynamically
    let baseQuery = db.selectFrom("TokiDAPPSession").where("userId", "=", userId)
    if (!includeArchived) {
      baseQuery = baseQuery.where("status", "=", "ACTIVE")
    }

    const sessions = await baseQuery
      .orderBy("createdAt", "desc")
      .limit(Math.min(offset + limit + 50, 250))
      .selectAll()
      .execute()

    const total = await db.selectFrom("TokiDAPPSession")
      .select(db.fn.countAll<number>().as("count"))
      .where("userId", "=", userId)
      .executeTakeFirst()

    // Enrich with counts
    const sessionsWithCounts = await Promise.all(
      sessions.map(async (s) => {
        const msgCount = await db.selectFrom("TokiDAPPMessage")
          .select(db.fn.countAll<number>().as("count"))
          .where("sessionId", "=", s.id)
          .executeTakeFirst()
        const recCount = await db.selectFrom("TokiDAPPAudioRecording")
          .select(db.fn.countAll<number>().as("count"))
          .where("sessionId", "=", s.id)
          .executeTakeFirst()
        const taskCount = await db.selectFrom("TokiDAPPTask")
          .select(db.fn.countAll<number>().as("count"))
          .where("sessionId", "=", s.id)
          .executeTakeFirst()
        const pendingTasks = await db.selectFrom("TokiDAPPTask")
          .select("status")
          .where("sessionId", "=", s.id)
          .execute()
        const pendingTaskCount = pendingTasks.filter((t) =>
          ["PENDING", "ASSIGNED", "IN_PROGRESS"].includes(String(t.status || "").toUpperCase())
        ).length
        const lastMsg = await db.selectFrom("TokiDAPPMessage")
          .select("createdAt")
          .where("sessionId", "=", s.id)
          .orderBy("createdAt", "desc")
          .limit(1)
          .executeTakeFirst()
        const lastActivityAt = lastMsg?.createdAt || s.updatedAt

        return {
          ...s,
          lastActivityAt,
          pendingTaskCount,
          attentionNeeded: pendingTaskCount > 0,
          _count: {
            messages: msgCount?.count ?? 0,
            audioRecordings: recCount?.count ?? 0,
            tasks: taskCount?.count ?? 0,
          },
        }
      })
    )

    // Filter
    const isEmpty = (s: typeof sessionsWithCounts[0]) =>
      s._count.messages === 0 && s._count.audioRecordings === 0 && s._count.tasks === 0 && !s.title

    let filtered = sessionsWithCounts
    if (emptyOnly) {
      filtered = sessionsWithCounts.filter(isEmpty)
    } else if (!includeEmpty) {
      filtered = sessionsWithCounts.filter((s) => !isEmpty(s))
    }

    const page = filtered.slice(offset, offset + limit)

    // Add summary
    const sessionsWithSummary = await Promise.all(
      page.map(async (s) => {
        const firstUserMsg = await db.selectFrom("TokiDAPPMessage")
          .select("content")
          .where("sessionId", "=", s.id)
          .where("role", "=", "USER")
          .orderBy("createdAt", "asc")
          .limit(1)
          .executeTakeFirst()
        return {
          id: s.id,
          userId: s.userId,
          status: s.status,
          title: s.title,
          summary: firstUserMsg ? firstUserMsg.content.slice(0, 200) : null,
          startedAt: s.createdAt,
          endedAt: s.endedAt,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          lastActivityAt: s.lastActivityAt,
          pendingTaskCount: s.pendingTaskCount,
          attentionNeeded: s.attentionNeeded,
          empty: isEmpty(s),
          _count: s._count,
        }
      })
    )

    const emptyCount = sessionsWithCounts.filter(isEmpty).length

    return {
      sessions: sessionsWithSummary,
      total: filtered.length,
      unfilteredTotal: total?.count ?? 0,
      emptyCount,
      limit,
      offset,
    }
  })

  // ── Session detail ─────────────────────────────────────────
  app.get("/api/tokidapp/sessions/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth || typeof auth !== "object") return auth
    const { id } = request.params as Record<string, string>

    const db = getTokidappDb()
    const session = await db.selectFrom("TokiDAPPSession")
      .where("id", "=", id)
      .selectAll()
      .executeTakeFirst()

    if (!session) {
      reply.code(404)
      return { error: "Session not found" }
    }

    // Ownership check
    if (session.userId !== auth.userId && auth.role !== "ADMIN" && auth.role !== "SUPER_ADMIN") {
      reply.code(403)
      return { error: "Forbidden" }
    }

    // Get counts
    const [msgCount, recCount, taskCount, workspaceCount, messages] = await Promise.all([
      db.selectFrom("TokiDAPPMessage").select(db.fn.countAll<number>().as("count")).where("sessionId", "=", id).executeTakeFirst(),
      db.selectFrom("TokiDAPPAudioRecording").select(db.fn.countAll<number>().as("count")).where("sessionId", "=", id).executeTakeFirst(),
      db.selectFrom("TokiDAPPTask").select(db.fn.countAll<number>().as("count")).where("sessionId", "=", id).executeTakeFirst(),
      db.selectFrom("TokiDAPPWorkspace").select(db.fn.countAll<number>().as("count")).where("sessionId", "=", id).executeTakeFirst(),
      db.selectFrom("TokiDAPPMessage").where("sessionId", "=", id).orderBy("createdAt", "asc").limit(1000).selectAll().execute(),
    ])

    return {
      ...session,
      messageCount: msgCount?.count ?? 0,
      recordingCount: recCount?.count ?? 0,
      taskCount: taskCount?.count ?? 0,
      workspaceCount: workspaceCount?.count ?? 0,
      messages,
    }
  })

  // ── Session update ─────────────────────────────────────────
  app.patch("/api/tokidapp/sessions/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth || typeof auth !== "object") return auth
    const { id } = request.params as Record<string, string>
    const body = (request.body ?? {}) as Record<string, unknown>

    const db = getTokidappDb()
    const session = await db.selectFrom("TokiDAPPSession").select("userId").where("id", "=", id).executeTakeFirst()
    if (!session) {
      reply.code(404)
      return { error: "Session not found" }
    }
    if (session.userId !== auth.userId && auth.role !== "ADMIN" && auth.role !== "SUPER_ADMIN") {
      reply.code(403)
      return { error: "Forbidden" }
    }

    const data: Record<string, unknown> = { updatedAt: new Date() }
    if (typeof body.title === "string") data.title = body.title
    if (typeof body.status === "string") data.status = body.status

    await updateSession(id, data)
    return { ok: true }
  })

  // ── Session delete ─────────────────────────────────────────
  app.delete("/api/tokidapp/sessions/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth || typeof auth !== "object") return auth
    const { id } = request.params as Record<string, string>

    const db = getTokidappDb()
    const session = await db.selectFrom("TokiDAPPSession").select("userId").where("id", "=", id).executeTakeFirst()
    if (!session) {
      reply.code(404)
      return { error: "Session not found" }
    }
    if (session.userId !== auth.userId && auth.role !== "ADMIN" && auth.role !== "SUPER_ADMIN") {
      reply.code(403)
      return { error: "Forbidden" }
    }

    const success = await deleteSession(id)
    if (!success) {
      reply.code(500)
      return { error: "Failed to delete session" }
    }
    return { ok: true }
  })

  // ── Purge empty sessions ───────────────────────────────────
  app.post("/api/tokidapp/sessions/purge-empty", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth || typeof auth !== "object") return auth
    const body = (request.body ?? {}) as Record<string, unknown>
    const ids = Array.isArray(body.ids) ? body.ids as string[] : undefined

    const emptied = await purgeEmptySessions(auth.userId, ids)
    return { purged: emptied, count: emptied.length }
  })

  // ── Session finalize ───────────────────────────────────────
  app.post("/api/tokidapp/sessions/:id/finalize", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth || typeof auth !== "object") return auth
    const { id } = request.params as Record<string, string>

    const db = getTokidappDb()
    const session = await db.selectFrom("TokiDAPPSession").select(["userId", "endedAt"]).where("id", "=", id).executeTakeFirst()
    if (!session) {
      reply.code(404)
      return { error: "Session not found" }
    }
    if (session.userId !== auth.userId && auth.role !== "ADMIN" && auth.role !== "SUPER_ADMIN") {
      reply.code(403)
      return { error: "Forbidden" }
    }

    // Idempotent
    if (session.endedAt) {
      return { alreadyFinalized: true, endedAt: session.endedAt }
    }

    const result = await finalizeSession(id)
    if (!result) {
      reply.code(500)
      return { error: "Failed to finalize" }
    }

    return { ok: true, endedAt: result.endedAt, transcriptLength: result.transcript.length }
  })

  // ── Messages (POST — save messages) ────────────────────────
  app.post("/api/tokidapp/messages", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth || typeof auth !== "object") return auth
    const body = (request.body ?? {}) as Record<string, unknown>

    const inputs = Array.isArray(body) ? body : [body]
    if (inputs.length === 0) {
      reply.code(400)
      return { error: "No messages provided" }
    }

    const sessionId = inputs[0].sessionId
    if (!sessionId || typeof sessionId !== "string") {
      reply.code(400)
      return { error: "sessionId is required" }
    }

    const db = getTokidappDb()
    const now = new Date()
    const saved: string[] = []
    let hasFirstUserMessage = false

    for (const input of inputs) {
      try {
        const id = crypto.randomUUID()
        await db.insertInto("TokiDAPPMessage")
          .values({
            id,
            sessionId: String(input.sessionId),
            role: mapRole(String(input.role)),
            content: String(input.content),
            toolCallId: input.toolCallId ? String(input.toolCallId) : null,
            toolName: input.toolName ? String(input.toolName) : null,
            toolStatus: input.toolStatus ? String(input.toolStatus) : null,
            metadata: input.metadata ? JSON.stringify(input.metadata) : null,
            createdAt: input.createdAt ? new Date(String(input.createdAt)) : now,
            contentType: input.contentType ? String(input.contentType) : "text",
          })
          .execute()
        saved.push(id)
        if (mapRole(String(input.role)) === "USER") {
          hasFirstUserMessage = true
        }
      } catch (err) {
        console.error("[direct-messages] Failed to save:", err)
      }
    }

    // Auto-set title from first user message
    if (hasFirstUserMessage && saved.length > 0) {
      await setSessionTitleFromFirstMessage(sessionId)
    }

    return { saved: saved.length, total: inputs.length }
  })

  // ── Messages (GET — retrieve by session) ───────────────────
  app.get("/api/tokidapp/messages", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth || typeof auth !== "object") return auth
    const query = request.query as Record<string, string>
    const sessionId = query.sessionId

    if (!sessionId) {
      return { messages: [], total: 0 }
    }

    const limit = Math.min(parseInt(query.limit || "500"), 1000)
    const offset = parseInt(query.offset || "0")

    const result = await findMessagesBySessionPaginated(sessionId, limit, offset)
    return result
  })

  // ── Attention — pending approvals/tasks ────────────────────
  app.get("/api/tokidapp/attention", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth || typeof auth !== "object") return auth
    const userId = auth.userId

    const db = getTokidappDb()
    const query = request.query as Record<string, string>
    const sessionFilter = query.sessionId

    // Get user's active sessions
    let sessionsQuery = db.selectFrom("TokiDAPPSession")
      .select(["id", "title"])
      .where("userId", "=", userId)
      .where("status", "=", "ACTIVE")
    if (sessionFilter) {
      sessionsQuery = sessionsQuery.where("id", "=", sessionFilter)
    }
    const sessions = await sessionsQuery.execute()

    const items: Array<{
      id: string
      kind: string
      title: string
      sessionId?: string
      source: string
      status: string
    }> = []

    // For each session, get orchestrator approvals and tasks
    for (const session of sessions) {
      // Get orchestrators for this session
      const orchestrators = await db.selectFrom("TokiDAPPOrchestratorSession")
        .select("id")
        .where("sessionId", "=", session.id)
        .execute()

      for (const orch of orchestrators) {
        const approvals = await db.selectFrom("TokiDAPPApprovalRequest")
          .select(["id", "title", "status"])
          .where("orchestratorId", "=", orch.id)
          .where("status", "=", "PENDING")
          .execute()

        for (const approval of approvals) {
          items.push({
            id: approval.id,
            kind: "approve",
            title: approval.title || "Approval required",
            sessionId: session.id,
            source: "approval",
            status: approval.status || "PENDING",
          })
        }
      }

      // Get pending tasks
      const tasks = await db.selectFrom("TokiDAPPTask")
        .select(["id", "title", "status"])
        .where("sessionId", "=", session.id)
        .execute()

      for (const task of tasks) {
        const status = String(task.status || "").toUpperCase()
        if (["PENDING", "ASSIGNED", "IN_PROGRESS"].includes(status)) {
          items.push({
            id: task.id,
            kind: "continue",
            title: task.title || "Task pending",
            sessionId: session.id,
            source: "task",
            status: task.status || "PENDING",
          })
        }
      }
    }

    return { items, total: items.length }
  })

  // ── Events (GET — list) ─────────────────────────────────────
  app.get("/api/tokidapp/events", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    // Admin-only check
    if (auth.role !== "ADMIN" && auth.role !== "SUPER_ADMIN") {
      reply.code(403)
      return { error: "Admin access required" }
    }

    const query = request.query as Record<string, string>
    const orchestratorId = query.orchestratorId
    const eventType = query.eventType
    const severity = query.severity
    const limit = Math.min(parseInt(query.limit || "100"), 500)

    const db = getTokidappDb()
    let baseQuery = db.selectFrom("TokiDAPPEventLog").orderBy("createdAt", "desc").limit(limit)
    if (orchestratorId) baseQuery = baseQuery.where("orchestratorId", "=", orchestratorId)
    if (eventType) baseQuery = baseQuery.where("eventType", "=", eventType)
    if (severity) baseQuery = baseQuery.where("severity", "=", severity)

    const events = await baseQuery.selectAll().execute()
    return events
  })

  // ── Events (POST — create) ──────────────────────────────────
  app.post("/api/tokidapp/events", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const body = (request.body ?? {}) as Record<string, unknown>
    const { orchestratorId, eventType, title, severity, description, metadata, nodeId } = body

    // TokiDAPPEventLog.orchestratorId is NOT NULL — an event always belongs
    // to an orchestrator run, so a missing id is a 400 rather than a 500.
    if (!orchestratorId) {
      reply.code(400)
      return { error: "orchestratorId is required" }
    }
    if (!eventType || !title) {
      reply.code(400)
      return { error: "eventType and title required" }
    }

    const db = getTokidappDb()
    const id = crypto.randomUUID()
    await db.insertInto("TokiDAPPEventLog")
      .values({
        id,
        orchestratorId: String(orchestratorId),
        nodeId: nodeId ? String(nodeId) : null,
        eventType: coerceEventType(eventType),
        severity: coerceSeverity(severity),
        title: String(title),
        description: description ? String(description) : null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        correlationId: null,
        source: "codenomad-direct",
        createdAt: new Date(),
      })
      .execute()

    return { id }
  })

  // ── Tasks (GET — list) ──────────────────────────────────────
  app.get("/api/tokidapp/tasks", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const query = request.query as Record<string, string>
    const sessionId = query.sessionId
    const status = query.status

    const db = getTokidappDb()
    let baseQuery = db.selectFrom("TokiDAPPTask").orderBy("createdAt", "desc")
    if (sessionId) baseQuery = baseQuery.where("sessionId", "=", sessionId)
    if (status) baseQuery = baseQuery.where("status", "=", status)

    const tasks = await baseQuery.selectAll().execute()
    return { tasks }
  })

  // ── Tasks (POST — create) ───────────────────────────────────
  app.post("/api/tokidapp/tasks", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const body = (request.body ?? {}) as Record<string, unknown>
    const { sessionId, title, description, agentType, priority, scheduledFor, assignedToUserId } = body

    if (!sessionId || !title) {
      reply.code(400)
      return { error: "sessionId and title required" }
    }

    const db = getTokidappDb()
    const id = crypto.randomUUID()
    await db.insertInto("TokiDAPPTask")
      .values({
        id,
        sessionId: String(sessionId),
        userId: auth.userId,
        title: String(title),
        description: description ? String(description) : null,
        agentType: agentType ? String(agentType) : "OPENCODE",
        priority: typeof priority === "number" ? priority : 0,
        status: assignedToUserId ? "ASSIGNED" : "PENDING",
        assignedToUserId: assignedToUserId ? String(assignedToUserId) : null,
        scheduledFor: scheduledFor ? new Date(String(scheduledFor)) : null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()

    return { id }
  })

  // ── Tasks (GET — by ID) ─────────────────────────────────────
  app.get("/api/tokidapp/tasks/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const { id } = request.params as Record<string, string>
    const db = getTokidappDb()
    const task = await db.selectFrom("TokiDAPPTask").where("id", "=", id).selectAll().executeTakeFirst()

    if (!task) {
      reply.code(404)
      return { error: "Not found" }
    }
    return task
  })

  // ── Tasks (PUT — update) ────────────────────────────────────
  app.put("/api/tokidapp/tasks/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const { id } = request.params as Record<string, string>
    const body = (request.body ?? {}) as Record<string, unknown>

    const db = getTokidappDb()
    const existing = await db.selectFrom("TokiDAPPTask").select("id").where("id", "=", id).executeTakeFirst()
    if (!existing) {
      reply.code(404)
      return { error: "Not found" }
    }

    const data: Record<string, unknown> = { updatedAt: new Date() }
    if (body.title !== undefined) data.title = String(body.title)
    if (body.status !== undefined) data.status = String(body.status)
    if (body.assignedToUserId !== undefined) data.assignedToUserId = body.assignedToUserId ? String(body.assignedToUserId) : null

    // Auto-set completedAt for terminal statuses
    const status = String(body.status || "").toUpperCase()
    if (["COMPLETED", "FAILED"].includes(status)) {
      data.completedAt = new Date()
    }

    await db.updateTable("TokiDAPPTask").set(data).where("id", "=", id).execute()
    return { ok: true }
  })

  // ── Tasks (POST — assign) ───────────────────────────────────
  app.post("/api/tokidapp/tasks/:id/assign", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const { id } = request.params as Record<string, string>
    const body = (request.body ?? {}) as Record<string, unknown>
    const { assignedToUserId } = body

    const db = getTokidappDb()
    const existing = await db.selectFrom("TokiDAPPTask").select("id").where("id", "=", id).executeTakeFirst()
    if (!existing) {
      reply.code(404)
      return { error: "Not found" }
    }

    await db.updateTable("TokiDAPPTask")
      .set({
        assignedToUserId: assignedToUserId ? String(assignedToUserId) : null,
        status: assignedToUserId ? "ASSIGNED" : "PENDING",
        updatedAt: new Date(),
      })
      .where("id", "=", id)
      .execute()

    return { ok: true }
  })

  // ── Causal Graph (GET — list) ───────────────────────────────
  app.get("/api/tokidapp/causal-graph", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const query = request.query as Record<string, string>
    const sessionId = query.sessionId
    const orchestratorId = query.orchestratorId

    if (!sessionId && !orchestratorId) {
      reply.code(400)
      return { error: "sessionId or orchestratorId required" }
    }

    const db = getTokidappDb()
    let nodeQuery = db.selectFrom("CausalNodeRecord").orderBy("createdAt", "asc")
    if (sessionId) nodeQuery = nodeQuery.where("sessionId", "=", sessionId)
    if (orchestratorId) nodeQuery = nodeQuery.where("orchestratorId", "=", orchestratorId)

    const nodes = await nodeQuery.selectAll().execute()

    // Fetch edges for each node
    const nodesWithEdges = await Promise.all(
      nodes.map(async (node) => {
        const outgoingEdges = await db.selectFrom("CausalEdgeRecord")
          .where("sourceNodeId", "=", node.id)
          .selectAll()
          .execute()
        const incomingEdges = await db.selectFrom("CausalEdgeRecord")
          .where("targetNodeId", "=", node.id)
          .selectAll()
          .execute()
        return { ...node, outgoingEdges, incomingEdges }
      })
    )

    return { nodes: nodesWithEdges, total: nodesWithEdges.length }
  })

  // ── Context System Prompt (PUT) ─────────────────────────────
  app.put("/api/tokidapp/context/system-prompt", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const body = (request.body ?? {}) as Record<string, unknown>
    const { sessionId, systemPrompt, reset } = body

    if (!sessionId) {
      reply.code(400)
      return { error: "sessionId required" }
    }

    const db = getTokidappDb()
    const session = await db.selectFrom("TokiDAPPSession")
      .select(["id", "metadata"])
      .where("id", "=", String(sessionId))
      .executeTakeFirst()

    if (!session) {
      reply.code(404)
      return { error: "Session not found" }
    }

    // Parse existing metadata
    let metadata: Record<string, unknown> = {}
    if (session.metadata) {
      try {
        metadata = JSON.parse(String(session.metadata))
      } catch {
        metadata = {}
      }
    }

    if (reset || !systemPrompt) {
      delete metadata.systemPromptOverride
    } else {
      metadata.systemPromptOverride = String(systemPrompt)
    }

    await db.updateTable("TokiDAPPSession")
      .set({ metadata: JSON.stringify(metadata), updatedAt: new Date() })
      .where("id", "=", String(sessionId))
      .execute()

    return { ok: true }
  })

  // ── Approvals (POST — create) ───────────────────────────────
  app.post("/api/tokidapp/approvals", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const body = (request.body ?? {}) as Record<string, unknown>
    const { orchestratorId, title, description, assignedToUserId } = body

    if (!orchestratorId || !title) {
      reply.code(400)
      return { error: "orchestratorId and title required" }
    }

    const db = getTokidappDb()
    const id = crypto.randomUUID()
    await db.insertInto("TokiDAPPApprovalRequest")
      .values({
        id,
        orchestratorId: String(orchestratorId),
        nodeId: null,
        title: String(title),
        description: description ? String(description) : null,
        status: "PENDING",
        priority: 0,
        assignedToUserId: assignedToUserId ? String(assignedToUserId) : null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute()

    return { id, status: "PENDING" }
  })

  // ── Approvals (GET — by ID) ─────────────────────────────────
  app.get("/api/tokidapp/approvals/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const { id } = request.params as Record<string, string>
    const db = getTokidappDb()
    const approval = await db.selectFrom("TokiDAPPApprovalRequest")
      .where("id", "=", id)
      .selectAll()
      .executeTakeFirst()

    if (!approval) {
      reply.code(404)
      return { error: "Not found" }
    }
    return approval
  })

  // ── Approvals (PUT — update decision) ───────────────────────
  app.put("/api/tokidapp/approvals/:id", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const { id } = request.params as Record<string, string>
    const body = (request.body ?? {}) as Record<string, unknown>
    const { status, comment } = body

    if (!status || !["APPROVED", "REJECTED", "CANCELLED"].includes(String(status))) {
      reply.code(400)
      return { error: "status must be APPROVED, REJECTED, or CANCELLED" }
    }

    const db = getTokidappDb()
    const existing = await db.selectFrom("TokiDAPPApprovalRequest")
      .select(["id", "status", "orchestratorId"])
      .where("id", "=", id)
      .executeTakeFirst()

    if (!existing) {
      reply.code(404)
      return { error: "Not found" }
    }

    if (existing.status !== "PENDING") {
      reply.code(409)
      return { error: `Approval already ${existing.status}` }
    }

    const decidedAt = new Date()
    await db.updateTable("TokiDAPPApprovalRequest")
      .set({
        status: String(status),
        decision: String(status),
        comment: comment ? String(comment) : null,
        decidedByUserId: auth.userId,
        decidedAt,
        updatedAt: decidedAt,
      })
      .where("id", "=", id)
      .execute()

    // Log the decision event. orchestratorId is NOT NULL, so it comes from the
    // approval row rather than being left null.
    await db.insertInto("TokiDAPPEventLog")
      .values({
        id: crypto.randomUUID(),
        orchestratorId: existing.orchestratorId,
        nodeId: null,
        eventType: String(status) === "APPROVED"
          ? "APPROVAL_APPROVED"
          : String(status) === "REJECTED"
            ? "APPROVAL_REJECTED"
            : "APPROVAL_EXPIRED",
        severity: "INFO",
        title: `Approval ${status}`,
        description: comment ? String(comment) : null,
        metadata: JSON.stringify({ approvalId: id, status, comment, decidedBy: auth.userId }),
        correlationId: id,
        source: "codenomad-direct",
        createdAt: decidedAt,
      })
      .execute()

    return { ok: true, status }
  })

  // ── Models (GET — list) ─────────────────────────────────────
  app.get("/api/tokidapp/models", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const db = getTokidappDb()
    const providers = await db.selectFrom("AiProvider")
      .select(["id", "kind", "label"])
      .where("enabled", "=", true)
      .execute()

    const providerMap = new Map(providers.map((p: { id: string; kind: string; label: string }) => [p.id, { kind: p.kind, label: p.label }]))

    const models = await db.selectFrom("AiModel")
      .select(["modelId", "name", "providerId", "capabilities", "contextWindow"])
      .where("enabled", "=", true)
      .execute()

    const enriched = models
      .filter((m: { providerId: string }) => providerMap.has(m.providerId))
      .map((m: { modelId: string; name: string; providerId: string; capabilities: string[] | null; contextWindow: number | null }) => {
        const provider = providerMap.get(m.providerId)!
        return {
          id: m.modelId,
          label: m.name,
          hint: provider.label,
          providerKind: provider.kind,
          capabilities: m.capabilities || [],
          contextWindow: m.contextWindow || null,
          reasoning: (m.capabilities || []).includes("reasoning"),
        }
      })
      .sort((a, b) => {
        const kindCmp = a.providerKind.localeCompare(b.providerKind)
        return kindCmp !== 0 ? kindCmp : a.label.localeCompare(b.label)
      })

    return { models: enriched }
  })

  // ── Deploy Status (GET) ─────────────────────────────────────
  app.get("/api/tokidapp/deploy-status", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    const query = request.query as Record<string, string>
    const sessionId = query.sessionId
    const limit = Math.min(parseInt(query.limit || "10"), 50)

    const db = getTokidappDb()
    let baseQuery = db.selectFrom("TokiDAPPDeployment")
      .orderBy("startedAt", "desc")
      .limit(limit)

    if (sessionId) {
      baseQuery = baseQuery.where("sessionId", "=", sessionId)
    } else {
      // Only show deployments for user's sessions
      const userSessionIds = await db.selectFrom("TokiDAPPSession")
        .select("id")
        .where("userId", "=", auth.userId)
        .execute()
      const sessionIds = userSessionIds.map((s) => s.id)
      if (sessionIds.length === 0) {
        return { status: "ok", deployments: [] }
      }
      baseQuery = baseQuery.where("sessionId", "in", sessionIds)
    }

    const deployments = await baseQuery.selectAll().execute()
    return { status: "ok", deployments }
  })

  // ── Workflows DAG (GET/POST) ────────────────────────────────
  app.get("/api/tokidapp/workflows/:slug/dag", async (request, reply) => {
    const auth = await requireAuth(request, reply, starGuardJwtHandler)
    if (!auth) return

    if (auth.role !== "ADMIN" && auth.role !== "SUPER_ADMIN") {
      reply.code(403)
      return { error: "Admin access required" }
    }

    const { slug } = request.params as Record<string, string>
    const db = getTokidappDb()

    const definition = await db.selectFrom("TokiDAPPWorkflowDefinition")
      .where("slug", "=", slug)
      .selectAll()
      .executeTakeFirst()

    if (!definition) {
      reply.code(404)
      return { error: "Workflow not found" }
    }

    const steps = await db.selectFrom("TokiDAPPWorkflowStepDefinition")
      .where("workflowId", "=", definition.id)
      .where("isActive", "=", true)
      .orderBy("order", "asc")
      .selectAll()
      .execute()

    const nodes = steps.map((s) => ({
      order: s.order,
      title: s.title,
      nodeType: s.nodeType ?? "tool_exec",
      parallelGroup: s.parallelGroup ?? null,
      dependencies: s.dependencies || [],
      agentType: s.agentType ?? null,
      assistantScript: s.assistantScript ?? null,
      toolActionHint: s.toolActionHint ?? null,
    }))

    return { slug, name: definition.name, voiceProfileId: definition.voiceProfileId ?? null, nodes }
  })
}
