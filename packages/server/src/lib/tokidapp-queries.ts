import { getTokidappDb } from './db'

// ─── Sessions ────────────────────────────────────────────────

export interface SessionRow {
  id: string
  createdAt: Date
  updatedAt: Date
  userId: string
  title: string | null
  status: string | null
  messageCount?: number
}

export async function findSessionsByUser(userId: string): Promise<SessionRow[]> {
  const db = getTokidappDb()
  const sessions = await db.selectFrom('TokiDAPPSession')
    .where('userId', '=', userId)
    .orderBy('createdAt', 'desc')
    .selectAll()
    .execute()

  // Get message counts
  const sessionIds = sessions.map(s => s.id)
  if (sessionIds.length === 0) return sessions

  const counts = await db.selectFrom('TokiDAPPMessage')
    .select(['sessionId', db.fn.countAll<number>().as('count')])
    .where('sessionId', 'in', sessionIds)
    .groupBy('sessionId')
    .execute()

  const countMap = new Map(counts.map(c => [c.sessionId, c.count]))
  return sessions.map(s => ({
    ...s,
    messageCount: countMap.get(s.id) ?? 0,
  }))
}

export async function findSessionById(id: string): Promise<SessionRow | null> {
  const db = getTokidappDb()
  const session = await db.selectFrom('TokiDAPPSession')
    .where('id', '=', id)
    .selectAll()
    .executeTakeFirst()
  if (!session) return null

  const count = await db.selectFrom('TokiDAPPMessage')
    .where('sessionId', '=', id)
    .select(db.fn.countAll<number>().as('count'))
    .executeTakeFirst()

  return { ...session, messageCount: count?.count ?? 0 }
}

/** Generate a cuid-like id (c + base36 timestamp + random suffix). */
function generateCuid(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).substring(2, 10)
  return `c${ts}${rand}`
}

export async function createSession(data: {
  id: string
  userId: string
  title?: string
  status?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPSession')
    .values({
      id: data.id,
      userId: data.userId,
      title: data.title ?? null,
      status: data.status ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}

/**
 * Create a session row with an auto-generated id. Mirrors the sidecar's
 * `routes/session.ts` behavior: ensures the User row exists, then inserts.
 */
export async function createSessionAutoId(userId: string): Promise<string> {
  const db = getTokidappDb()
  const id = generateCuid()
  await db.insertInto('TokiDAPPSession')
    .values({
      id,
      userId,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
  return id
}

/**
 * Ensure a User row exists before creating a session (FK safety net).
 * Mirrors scripts/tokidapp-server/routes/session.ts → ensureUserExists().
 * Handles cross-environment JWTs whose userId may not exist locally.
 */
export async function ensureUserExists(
  userId: string,
  walletAddress?: string | null,
  role?: string | null,
  email?: string | null,
): Promise<void> {
  if (!userId) return
  const db = getTokidappDb()
  const walletAddr = (walletAddress || '').toLowerCase()

  try {
    const existing = await db.selectFrom('User').select('id').where('id', '=', userId).executeTakeFirst()
    if (existing) return
  } catch {
    return
  }

  if (walletAddr) {
    try {
      const byWallet = await db.selectFrom('User').select('id').where('walletAddress', '=', walletAddr).executeTakeFirst()
      if (byWallet && byWallet.id !== userId) {
        console.warn(`[tokidapp-queries] User exists under different id; JWT userId=%s != %s`, userId, byWallet.id)
        return
      }
    } catch {
      // non-fatal
    }
  }

  try {
    await db.insertInto('User')
      .values({
        id: userId,
        walletAddress: walletAddr || null,
        role: role || null,
        email: email || null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastLoginAt: new Date(),
      })
      .onConflict((oc) => oc.column('id').doUpdateSet({
        lastLoginAt: new Date(),
      }))
      .execute()
  } catch (err: any) {
    if (err?.code === '23505' && err?.constraint?.toLowerCase().includes('walletaddress')) {
      console.warn(`[tokidapp-queries] walletAddress unique collision; userId=%s wallet=%s`, userId, walletAddr)
    } else {
      console.warn('[tokidapp-queries] User upsert failed (non-critical):', err?.message || String(err))
    }
  }
}

export async function updateSession(id: string, data: {
  title?: string
  status?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.updateTable('TokiDAPPSession')
    .set({ ...data, updatedAt: new Date() })
    .where('id', '=', id)
    .execute()
}

// ─── Messages ────────────────────────────────────────────────

export interface MessageRow {
  id: string
  createdAt: Date
  sessionId: string
  role: string
  content: string
  contentType: string
  toolCallId: string | null
  toolName: string | null
  toolStatus: string | null
  tokenCount: number | null
  audioRecordingId: string | null
  metadata: unknown | null
}

export async function findMessagesBySession(sessionId: string): Promise<MessageRow[]> {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPMessage')
    .where('sessionId', '=', sessionId)
    .orderBy('createdAt', 'asc')
    .selectAll()
    .execute()
}

export async function createMessage(data: {
  id: string
  sessionId: string
  role: string
  content: string
  contentType?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPMessage')
    .values({
      id: data.id,
      sessionId: data.sessionId,
      role: data.role,
      content: data.content,
      contentType: data.contentType ?? 'text',
      createdAt: new Date(),
    })
    .execute()
}

export async function createMessages(data: Array<{
  id: string
  sessionId: string
  role: string
  content: string
  contentType?: string
}>): Promise<void> {
  if (data.length === 0) return
  const db = getTokidappDb()
  const now = new Date()
  await db.insertInto('TokiDAPPMessage')
    .values(data.map(d => ({
      id: d.id,
      sessionId: d.sessionId,
      role: d.role,
      content: d.content,
      contentType: d.contentType ?? 'text',
      createdAt: now,
    })))
    .execute()
}

// ─── Session title auto-set ──────────────────────────────────
/**
 * Auto-set session title from first user message.
 * Mirrors scripts/tokidapp-server/routes/messages.ts → POST.
 */
export async function setSessionTitleFromFirstMessage(sessionId: string): Promise<void> {
  const db = getTokidappDb()
  try {
    const session = await db.selectFrom('TokiDAPPSession')
      .select(['id', 'title'])
      .where('id', '=', sessionId)
      .executeTakeFirst()
    if (session && !session.title) {
      const firstUserMsg = await db.selectFrom('TokiDAPPMessage')
        .select('content')
        .where('sessionId', '=', sessionId)
        .where('role', '=', 'USER')
        .orderBy('createdAt', 'asc')
        .limit(1)
        .executeTakeFirst()
      if (firstUserMsg) {
        const title = firstUserMsg.content.slice(0, 120).replace(/\n/g, ' ')
        await db.updateTable('TokiDAPPSession')
          .set({ title, updatedAt: new Date() })
          .where('id', '=', sessionId)
          .execute()
      }
    }
  } catch {
    // non-critical
  }
}

// ─── Messages with pagination ────────────────────────────────
export async function findMessagesBySessionPaginated(
  sessionId: string,
  limit = 500,
  offset = 0,
): Promise<{ messages: MessageRow[]; total: number }> {
  const db = getTokidappDb()
  const [messages, totalRow] = await Promise.all([
    db.selectFrom('TokiDAPPMessage')
      .where('sessionId', '=', sessionId)
      .orderBy('createdAt', 'asc')
      .limit(limit)
      .offset(offset)
      .selectAll()
      .execute(),
    db.selectFrom('TokiDAPPMessage')
      .select(db.fn.countAll<number>().as('count'))
      .where('sessionId', '=', sessionId)
      .executeTakeFirst(),
  ])
  return { messages, total: totalRow?.count ?? 0 }
}

// ─── Session delete (cascade) ────────────────────────────────
export async function deleteSession(id: string): Promise<boolean> {
  const db = getTokidappDb()
  try {
    await db.deleteFrom('TokiDAPPSession')
      .where('id', '=', id)
      .execute()
    return true
  } catch {
    return false
  }
}

// ─── Session finalize ────────────────────────────────────────
/**
 * Finalize a session: set endedAt and status=ENDED.
 * Returns the transcript text for blob upload.
 */
export async function finalizeSession(id: string): Promise<{ transcript: string; endedAt: Date } | null> {
  const db = getTokidappDb()
  const session = await db.selectFrom('TokiDAPPSession')
    .where('id', '=', id)
    .selectAll()
    .executeTakeFirst()
  if (!session) return null

  // Build transcript from messages
  const messages = await db.selectFrom('TokiDAPPMessage')
    .select(['role', 'content'])
    .where('sessionId', '=', id)
    .orderBy('createdAt', 'asc')
    .execute()

  const transcript = messages
    .filter(m => m.content?.trim())
    .filter(m => {
      const r = m.role.toUpperCase()
      return r === 'USER' || r === 'ASSISTANT'
    })
    .map(m => {
      const label = m.role.toUpperCase() === 'USER' ? 'User' : 'Assistant'
      return `${label}: ${m.content.trim()}`
    })
    .join('\n\n')

  const endedAt = new Date()
  await db.updateTable('TokiDAPPSession')
    .set({ status: 'ARCHIVED', endedAt, updatedAt: endedAt })
    .where('id', '=', id)
    .execute()

  return { transcript, endedAt }
}

// ─── Purge empty sessions ───────────────────────────────────
export async function purgeEmptySessions(userId: string, ids?: string[]): Promise<string[]> {
  const db = getTokidappDb()
  const where: Record<string, unknown> = { userId, status: 'ACTIVE' }
  if (ids && ids.length > 0) {
    where.id = { in: ids }
  }
  // Use raw query for complex filtering
  const sessions = await db.selectFrom('TokiDAPPSession')
    .select('id')
    .where('userId', '=', userId)
    .where('status', '=', 'ACTIVE')
    .execute()

  const emptied: string[] = []
  for (const s of sessions) {
    const msgCount = await db.selectFrom('TokiDAPPMessage')
      .select(db.fn.countAll<number>().as('count'))
      .where('sessionId', '=', s.id)
      .executeTakeFirst()
    const recCount = await db.selectFrom('TokiDAPPAudioRecording')
      .select(db.fn.countAll<number>().as('count'))
      .where('sessionId', '=', s.id)
      .executeTakeFirst()
    if ((msgCount?.count ?? 0) === 0 && (recCount?.count ?? 0) === 0) {
      await db.deleteFrom('TokiDAPPSession').where('id', '=', s.id).execute()
      emptied.push(s.id)
    }
  }
  return emptied
}

// ─── Recordings ──────────────────────────────────────────────

export async function findRecordingsBySession(sessionId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPAudioRecording')
    .where('sessionId', '=', sessionId)
    .orderBy('createdAt', 'desc')
    .selectAll()
    .execute()
}

export async function findRecordingById(id: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPAudioRecording')
    .where('id', '=', id)
    .selectAll()
    .executeTakeFirst()
}

/**
 * Persist recording metadata.
 *
 * Column names here are the real ones (`durationMs`, `mimeType`) — an earlier
 * version wrote `duration`/`format`/`status`/`updatedAt`, none of which exist
 * on the table, so every insert raised 42703 and was swallowed by the caller's
 * catch. `userId` is NOT NULL; when the caller doesn't have one it is read
 * from the owning session rather than defaulted to null.
 */
export async function createRecording(data: {
  id: string
  sessionId: string
  blobUrl: string
  durationMs?: number
  mimeType?: string
  userId?: string
}): Promise<void> {
  const db = getTokidappDb()

  let userId = data.userId
  if (!userId) {
    const owner = await db
      .selectFrom('TokiDAPPSession')
      .select('userId')
      .where('id', '=', data.sessionId)
      .executeTakeFirst()
    userId = owner?.userId
  }
  if (!userId) {
    throw new Error(
      `createRecording: no userId for session ${data.sessionId} (TokiDAPPAudioRecording.userId is NOT NULL)`,
    )
  }

  await db.insertInto('TokiDAPPAudioRecording')
    .values({
      id: data.id,
      sessionId: data.sessionId,
      userId,
      blobUrl: data.blobUrl,
      durationMs: data.durationMs ?? null,
      mimeType: data.mimeType ?? 'audio/webm',
      createdAt: new Date(),
    })
    .execute()
}

// ─── Voice agent sessions ────────────────────────────────────
// One row per realtime voice connection. Settlement is per-session, so a voice
// session needs a row to attribute its tokens and audio milliseconds to.

/**
 * Open an agent-session row for a realtime voice connection.
 * Returns the row id, or null if it could not be written — callers treat a
 * missing row as "unattributed usage", never as a reason to drop the call.
 */
export type AgentSessionType =
  | 'FULL_CONCIERGE'
  | 'LIGHTWEIGHT'
  | 'BUILDMATE'
  | 'OPENCODE'
  | 'OPENCODER'
  | 'OPENAGENT'

/** Terminal states are ERROR and DISCONNECTED — there is no COMPLETED. */
export type AgentSessionStatus = 'ACTIVE' | 'IDLE' | 'ERROR' | 'DISCONNECTED'

export async function createAgentSession(data: {
  id: string
  tokidappSessionId: string
  agentType: AgentSessionType
  model?: string | null
  provider?: string | null
}): Promise<string | null> {
  try {
    const db = getTokidappDb()
    await db.insertInto('TokiDAPPAgentSession')
      .values({
        id: data.id,
        tokidappSessionId: data.tokidappSessionId,
        agentType: data.agentType,
        status: 'ACTIVE',
        model: data.model ?? null,
        provider: data.provider ?? null,
        connectedAt: new Date(),
      })
      .execute()
    return data.id
  } catch (err) {
    console.error('[tokidapp-queries] createAgentSession failed:', (err as Error).message)
    return null
  }
}

/**
 * Close an agent-session row. `disconnectedAt` is only ever set once — a
 * reconnect that re-ends the same id must not overwrite the first close.
 */
export async function endAgentSession(
  id: string,
  data: {
    status?: AgentSessionStatus
    audioInputMs?: number
    audioOutputMs?: number
  } = {},
): Promise<void> {
  try {
    const db = getTokidappDb()
    await db.updateTable('TokiDAPPAgentSession')
      .set({
        status: data.status ?? 'DISCONNECTED',
        disconnectedAt: new Date(),
        ...(data.audioInputMs != null ? { audioInputMs: data.audioInputMs } : {}),
        ...(data.audioOutputMs != null ? { audioOutputMs: data.audioOutputMs } : {}),
      })
      .where('id', '=', id)
      .where('disconnectedAt', 'is', null)
      .execute()
  } catch (err) {
    console.error('[tokidapp-queries] endAgentSession failed:', (err as Error).message)
  }
}

export async function deleteRecordingsBySession(sessionId: string): Promise<void> {
  const db = getTokidappDb()
  await db.deleteFrom('TokiDAPPAudioRecording')
    .where('sessionId', '=', sessionId)
    .execute()
}

// ─── Orchestrator Sessions ───────────────────────────────────

export async function findOrchestratorBySessionId(sessionId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPOrchestratorSession')
    .where('sessionId', '=', sessionId)
    .orderBy('createdAt', 'desc')
    .selectAll()
    .executeTakeFirst()
}

export async function findOrchestratorsBySessionId(sessionId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPOrchestratorSession')
    .where('sessionId', '=', sessionId)
    .orderBy('createdAt', 'desc')
    .selectAll()
    .execute()
}

export async function findOrchestratorById(id: string) {
  const db = getTokidappDb()
  const session = await db.selectFrom('TokiDAPPOrchestratorSession')
    .where('id', '=', id)
    .selectAll()
    .executeTakeFirst()
  if (!session) return null

  const [nodes, approvals, events, publishments] = await Promise.all([
    db.selectFrom('TokiDAPPOrchestratorNode')
      .where('orchestratorId', '=', id)
      .selectAll()
      .execute(),
    db.selectFrom('TokiDAPPApprovalRequest')
      .where('orchestratorId', '=', id)
      .selectAll()
      .execute(),
    db.selectFrom('TokiDAPPEventLog')
      .where('orchestratorId', '=', id)
      .selectAll()
      .execute(),
    db.selectFrom('TokiDAPPPublishment')
      .where('orchestratorId', '=', id)
      .selectAll()
      .execute(),
  ])

  return { ...session, nodes, approvals, events, publishments }
}

export async function createOrchestratorSession(data: {
  id: string
  sessionId: string
  status?: string
  lifecyclePhase?: string
  voiceMode?: boolean
  greetingPlayed?: boolean
  metadata?: unknown
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPOrchestratorSession')
    .values({
      id: data.id,
      sessionId: data.sessionId,
      status: data.status ?? 'active',
      lifecyclePhase: data.lifecyclePhase ?? null,
      voiceMode: data.voiceMode ?? true,
      greetingPlayed: data.greetingPlayed ?? false,
      currentDagId: null,
      metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}

export async function updateOrchestratorSession(id: string, data: {
  status?: string
  lifecyclePhase?: string
  currentDagId?: string
  greetingPlayed?: boolean
}): Promise<void> {
  const db = getTokidappDb()
  await db.updateTable('TokiDAPPOrchestratorSession')
    .set({ ...data, updatedAt: new Date() })
    .where('id', '=', id)
    .execute()
}

// ─── Tasks ───────────────────────────────────────────────────

export async function findTasksBySession(sessionId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPTask')
    .where('sessionId', '=', sessionId)
    .orderBy('createdAt', 'desc')
    .selectAll()
    .execute()
}

export async function findTaskById(id: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPTask')
    .where('id', '=', id)
    .selectAll()
    .executeTakeFirst()
}

export async function createTask(data: {
  id: string
  sessionId: string
  userId: string
  title: string
  description?: string
  agentType?: string
  status?: string
  priority?: number
  assignedToUserId?: string
  scheduledFor?: Date | null
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPTask')
    .values({
      id: data.id,
      sessionId: data.sessionId,
      userId: data.userId,
      title: data.title,
      description: data.description ?? null,
      agentType: data.agentType ?? 'OPENCODE',
      status: data.status ?? 'PENDING',
      priority: data.priority ?? 0,
      assignedToUserId: data.assignedToUserId ?? null,
      scheduledFor: data.scheduledFor ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}

export async function updateTask(id: string, data: {
  title?: string
  status?: string
  assignedToUserId?: string | null
  completedAt?: Date | null
}): Promise<void> {
  const db = getTokidappDb()
  await db.updateTable('TokiDAPPTask')
    .set({ ...data, updatedAt: new Date() })
    .where('id', '=', id)
    .execute()
}

// ─── Approvals ───────────────────────────────────────────────

export async function findApprovalsByOrchestrator(orchestratorId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPApprovalRequest')
    .where('orchestratorId', '=', orchestratorId)
    .orderBy('createdAt', 'desc')
    .selectAll()
    .execute()
}

export async function findApprovalById(id: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPApprovalRequest')
    .where('id', '=', id)
    .selectAll()
    .executeTakeFirst()
}

export async function createApproval(data: {
  id: string
  orchestratorId: string
  title: string
  description?: string
  status?: string
  priority?: number
  assignedToUserId?: string
  nodeId?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPApprovalRequest')
    .values({
      id: data.id,
      orchestratorId: data.orchestratorId,
      nodeId: data.nodeId ?? null,
      title: data.title,
      description: data.description ?? null,
      status: data.status ?? 'PENDING',
      priority: data.priority ?? 0,
      assignedToUserId: data.assignedToUserId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}

export async function updateApproval(id: string, data: {
  status?: string
  decision?: string
  comment?: string
  decidedByUserId?: string
  decidedAt?: Date
}): Promise<void> {
  const db = getTokidappDb()
  await db.updateTable('TokiDAPPApprovalRequest')
    .set({ ...data, updatedAt: new Date() })
    .where('id', '=', id)
    .execute()
}

// ─── Events ──────────────────────────────────────────────────

export async function findEventsByOrchestrator(orchestratorId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPEventLog')
    .where('orchestratorId', '=', orchestratorId)
    .orderBy('createdAt', 'desc')
    .selectAll()
    .execute()
}

export async function createEvent(data: {
  id: string
  orchestratorId?: string
  nodeId?: string
  eventType: string
  severity?: string
  title: string
  description?: string
  metadata?: unknown
  correlationId?: string
  source?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPEventLog')
    .values({
      id: data.id,
      orchestratorId: data.orchestratorId ?? null,
      nodeId: data.nodeId ?? null,
      eventType: data.eventType,
      severity: data.severity ?? 'INFO',
      title: data.title,
      description: data.description ?? null,
      metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      correlationId: data.correlationId ?? null,
      source: data.source ?? 'codenomad',
      createdAt: new Date(),
    })
    .execute()
}

// ─── Deployments ─────────────────────────────────────────────

export async function findDeploymentsBySession(sessionId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPDeployment')
    .where('sessionId', '=', sessionId)
    .orderBy('startedAt', 'desc')
    .selectAll()
    .execute()
}

export async function createDeployment(data: {
  id: string
  sessionId: string
  userId: string
  status?: string
  commitHash?: string
  commitMsg?: string
  branch?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPDeployment')
    .values({
      id: data.id,
      sessionId: data.sessionId,
      userId: data.userId,
      status: data.status ?? 'PENDING',
      commitHash: data.commitHash ?? null,
      commitMsg: data.commitMsg ?? null,
      branch: data.branch ?? null,
      startedAt: new Date(),
    })
    .execute()
}

// ─── Workflows ───────────────────────────────────────────────

export async function findWorkflows() {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPWorkflowDefinition')
    .selectAll()
    .orderBy('createdAt', 'desc')
    .execute()
}

export async function findWorkflowBySlug(slug: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPWorkflowDefinition')
    .where('slug', '=', slug)
    .selectAll()
    .executeTakeFirst()
}

export async function createWorkflow(data: {
  id: string
  slug: string
  name: string
  defaultModeId?: string
  toolExecutionMode?: string
  summaryForPrompt?: string
  isActive?: boolean
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPWorkflowDefinition')
    .values({
      id: data.id,
      slug: data.slug,
      name: data.name,
      defaultModeId: data.defaultModeId ?? 'default',
      toolExecutionMode: data.toolExecutionMode ?? 'auto',
      summaryForPrompt: data.summaryForPrompt ?? null,
      isActive: data.isActive ?? true,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}

// ─── File Artifacts ──────────────────────────────────────────

export async function findFileArtifactsBySession(sessionId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPFileArtifact')
    .where('sessionId', '=', sessionId)
    .orderBy('createdAt', 'desc')
    .selectAll()
    .execute()
}

export async function createFileArtifact(data: {
  id: string
  sessionId: string
  fileName?: string
  fileType?: string
  fileSize?: number
  blobUrl?: string
  extractedText?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPFileArtifact')
    .values({
      id: data.id,
      sessionId: data.sessionId,
      fileName: data.fileName ?? null,
      fileType: data.fileType ?? null,
      fileSize: data.fileSize ?? null,
      blobUrl: data.blobUrl ?? null,
      extractedText: data.extractedText ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}

// ─── Workflow Sessions ───────────────────────────────────────

export async function findWorkflowSessionsBySession(sessionId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPWorkflowSession')
    .where('sessionId', '=', sessionId)
    .orderBy('createdAt', 'desc')
    .selectAll()
    .execute()
}

export async function createWorkflowSession(data: {
  id: string
  sessionId: string
  workflowDefinitionId?: string
  status?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPWorkflowSession')
    .values({
      id: data.id,
      sessionId: data.sessionId,
      workflowDefinitionId: data.workflowDefinitionId ?? null,
      status: data.status ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}
