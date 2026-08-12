import { Kysely, PostgresDialect, type Selectable, type Insertable } from 'kysely'
import { Pool, types as pgTypes } from 'pg'

// Parse BIGINT as number (not string)
pgTypes.setTypeParser(20, (val: string) => parseInt(val, 10))

// ─── Database Schema Types (TokiDAPP subset only) ────────────

interface TokiDAPPSessionTable {
  id: string
  createdAt: Date
  updatedAt: Date
  userId: string
  title: string | null
  status: string | null
}

interface TokiDAPPMessageTable {
  id: string
  createdAt: Date
  updatedAt: Date
  sessionId: string
  role: string
  content: string
  sources: string | null
}

interface TokiDAPPAudioRecordingTable {
  id: string
  sessionId: string
  userId: string
  durationMs: number | null
  mimeType: string
  sampleRate: number | null
  channels: number | null
  blobUrl: string
  blobSize: number | null
  blobHash: string | null
  transcript: string | null
  transcriptStatus: string | null
  transcriptModel: string | null
  summary: string | null
  createdAt: Date
  expiresAt: Date | null
}

interface TokiDAPPDeploymentTable {
  id: string
  createdAt: Date
  updatedAt: Date
  sessionId: string
  status: string | null
  commitHash: string | null
  commitMsg: string | null
  buildLog: string | null
}

interface TokiDAPPAgentSessionTable {
  id: string
  tokidappSessionId: string
  agentType: string
  status: string
  model: string | null
  provider: string | null
  inputTokens: number | null
  outputTokens: number | null
  audioInputMs: number | null
  audioOutputMs: number | null
  connectedAt: Date
  disconnectedAt: Date | null
  reconnectCount: number | null
  metadata: unknown | null
}

interface AiUsageEventTable {
  id: string
  userId: string
  tokidappSessionId: string | null
  agentSessionId: string | null
  modelId: string
  provider: string | null
  eventType: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** PROVIDER_REPORTED or ESTIMATED — measured counts vs guessed ones. */
  usageSource: string
  /**
   * Text/audio split, null when the provider reported no breakdown. Null and 0
   * mean different things to a pricer: null is "unknown, use the flat rate",
   * 0 is "measured, and there was no audio".
   */
  promptTextTokens: number | null
  promptAudioTokens: number | null
  completionTextTokens: number | null
  completionAudioTokens: number | null
  /** Cached prompt tokens — a discounted *subset* of promptTokens, not an addition. */
  promptCachedTokens: number | null
  starXpCost: string | null
  /** Idempotency key: a retried generation must not double-count. */
  requestId: string
  createdAt: Date
}

interface TokiDAPPTaskTable {
  id: string
  createdAt: Date
  updatedAt: Date
  sessionId: string | null
  title: string | null
  status: string | null
  assignedTo: string | null
  completedAt: Date | null
}

interface TokiDAPPWorkspaceTable {
  id: string
  createdAt: Date
  updatedAt: Date
  sessionId: string | null
  name: string | null
  status: string | null
}

interface TokiDAPPWorkflowDefinitionTable {
  id: string
  createdAt: Date
  updatedAt: Date
  slug: string | null
  name: string | null
  dagConfig: string | null
  enabled: boolean
}

interface TokiDAPPWorkflowSessionTable {
  id: string
  createdAt: Date
  updatedAt: Date
  workflowDefinitionId: string | null
  sessionId: string
  status: string | null
}

interface TokiDAPPOrchestratorSessionTable {
  id: string
  createdAt: Date
  updatedAt: Date
  sessionId: string
  status: string | null
  lifecyclePhase: string | null
  metadata: string | null
  nodes: string | null
}

interface TokiDAPPOrchestratorNodeTable {
  id: string
  createdAt: Date
  updatedAt: Date
  orchestratorSessionId: string
  nodeType: string | null
  status: string | null
  data: string | null
}

interface TokiDAPPApprovalRequestTable {
  id: string
  createdAt: Date
  updatedAt: Date
  orchestratorSessionId: string | null
  status: string | null
  assignedTo: string | null
  title: string | null
  description: string | null
}

interface TokiDAPPEventLogTable {
  id: string
  createdAt: Date
  updatedAt: Date
  sessionId: string | null
  eventType: string | null
  data: string | null
}

interface TokiDAPPPublishmentTable {
  id: string
  createdAt: Date
  updatedAt: Date
  orchestratorSessionId: string | null
  status: string | null
  publicationUri: string | null
}

interface TokiDAPPFileArtifactTable {
  id: string
  createdAt: Date
  updatedAt: Date
  sessionId: string
  fileName: string | null
  fileType: string | null
  fileSize: number | null
  blobUrl: string | null
  extractedText: string | null
}

// ─── Database Interface ──────────────────────────────────────

export interface TokiDAPPDB {
  TokiDAPPSession: TokiDAPPSessionTable
  TokiDAPPMessage: TokiDAPPMessageTable
  TokiDAPPAudioRecording: TokiDAPPAudioRecordingTable
  TokiDAPPDeployment: TokiDAPPDeploymentTable
  TokiDAPPAgentSession: TokiDAPPAgentSessionTable
  TokiDAPPTask: TokiDAPPTaskTable
  TokiDAPPWorkspace: TokiDAPPWorkspaceTable
  TokiDAPPWorkflowDefinition: TokiDAPPWorkflowDefinitionTable
  TokiDAPPWorkflowSession: TokiDAPPWorkflowSessionTable
  TokiDAPPOrchestratorSession: TokiDAPPOrchestratorSessionTable
  TokiDAPPOrchestratorNode: TokiDAPPOrchestratorNodeTable
  TokiDAPPApprovalRequest: TokiDAPPApprovalRequestTable
  TokiDAPPEventLog: TokiDAPPEventLogTable
  TokiDAPPPublishment: TokiDAPPPublishmentTable
  TokiDAPPFileArtifact: TokiDAPPFileArtifactTable
  AiUsageEvent: AiUsageEventTable
}

export type DB = Kysely<TokiDAPPDB>

// ─── Connection Pool ─────────────────────────────────────────

let _db: DB | null = null

export function getTokidappDb(): DB {
  if (_db) return _db

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })

  _db = new Kysely<TokiDAPPDB>({
    dialect: new PostgresDialect({ pool }),
  })

  return _db
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.destroy()
    _db = null
  }
}
