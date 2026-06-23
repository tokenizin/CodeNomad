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
  sources: string | null
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
  sources?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPMessage')
    .values({
      id: data.id,
      sessionId: data.sessionId,
      role: data.role,
      content: data.content,
      sources: data.sources ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}

export async function createMessages(data: Array<{
  id: string
  sessionId: string
  role: string
  content: string
  sources?: string
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
      sources: d.sources ?? null,
      createdAt: now,
      updatedAt: now,
    })))
    .execute()
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

export async function createRecording(data: {
  id: string
  sessionId: string
  blobUrl: string
  duration?: number
  format?: string
  status?: string
  userId?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPAudioRecording')
    .values({
      id: data.id,
      sessionId: data.sessionId,
      blobUrl: data.blobUrl,
      duration: data.duration ?? null,
      format: data.format ?? null,
      status: data.status ?? null,
      userId: data.userId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
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
      .where('orchestratorSessionId', '=', id)
      .selectAll()
      .execute(),
    db.selectFrom('TokiDAPPApprovalRequest')
      .where('orchestratorSessionId', '=', id)
      .selectAll()
      .execute(),
    db.selectFrom('TokiDAPPEventLog')
      .where('sessionId', '=', session.sessionId)
      .selectAll()
      .execute(),
    db.selectFrom('TokiDAPPPublishment')
      .where('orchestratorSessionId', '=', id)
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
  metadata?: string
  nodes?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPOrchestratorSession')
    .values({
      id: data.id,
      sessionId: data.sessionId,
      status: data.status ?? null,
      lifecyclePhase: data.lifecyclePhase ?? null,
      metadata: data.metadata ?? null,
      nodes: data.nodes ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}

export async function updateOrchestratorSession(id: string, data: {
  status?: string
  lifecyclePhase?: string
  metadata?: string
  nodes?: string
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
  sessionId?: string
  title?: string
  status?: string
  assignedTo?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPTask')
    .values({
      id: data.id,
      sessionId: data.sessionId ?? null,
      title: data.title ?? null,
      status: data.status ?? null,
      assignedTo: data.assignedTo ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}

export async function updateTask(id: string, data: {
  title?: string
  status?: string
  assignedTo?: string
  completedAt?: Date | null
}): Promise<void> {
  const db = getTokidappDb()
  await db.updateTable('TokiDAPPTask')
    .set({ ...data, updatedAt: new Date() })
    .where('id', '=', id)
    .execute()
}

// ─── Approvals ───────────────────────────────────────────────

export async function findApprovalsByOrchestrator(orchestratorSessionId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPApprovalRequest')
    .where('orchestratorSessionId', '=', orchestratorSessionId)
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
  orchestratorSessionId?: string
  status?: string
  assignedTo?: string
  title?: string
  description?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPApprovalRequest')
    .values({
      id: data.id,
      orchestratorSessionId: data.orchestratorSessionId ?? null,
      status: data.status ?? null,
      assignedTo: data.assignedTo ?? null,
      title: data.title ?? null,
      description: data.description ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}

export async function updateApproval(id: string, data: {
  status?: string
  assignedTo?: string
  title?: string
  description?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.updateTable('TokiDAPPApprovalRequest')
    .set({ ...data, updatedAt: new Date() })
    .where('id', '=', id)
    .execute()
}

// ─── Events ──────────────────────────────────────────────────

export async function findEventsBySession(sessionId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPEventLog')
    .where('sessionId', '=', sessionId)
    .orderBy('createdAt', 'desc')
    .selectAll()
    .execute()
}

export async function createEvent(data: {
  id: string
  sessionId?: string
  eventType: string
  data?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPEventLog')
    .values({
      id: data.id,
      sessionId: data.sessionId ?? null,
      eventType: data.eventType,
      data: data.data ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .execute()
}

// ─── Deployments ─────────────────────────────────────────────

export async function findDeploymentsBySession(sessionId: string) {
  const db = getTokidappDb()
  return db.selectFrom('TokiDAPPDeployment')
    .where('sessionId', '=', sessionId)
    .orderBy('createdAt', 'desc')
    .selectAll()
    .execute()
}

export async function createDeployment(data: {
  id: string
  sessionId: string
  status?: string
  commitHash?: string
  commitMsg?: string
  buildLog?: string
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPDeployment')
    .values({
      id: data.id,
      sessionId: data.sessionId,
      status: data.status ?? null,
      commitHash: data.commitHash ?? null,
      commitMsg: data.commitMsg ?? null,
      buildLog: data.buildLog ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
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
  dagConfig?: string
  enabled?: boolean
}): Promise<void> {
  const db = getTokidappDb()
  await db.insertInto('TokiDAPPWorkflowDefinition')
    .values({
      id: data.id,
      slug: data.slug,
      name: data.name,
      dagConfig: data.dagConfig ?? null,
      enabled: data.enabled ?? true,
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
