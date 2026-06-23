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
  createdAt: Date
  updatedAt: Date
  sessionId: string
  blobUrl: string
  duration: number | null
  format: string | null
  status: string | null
  userId: string | null
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
  createdAt: Date
  updatedAt: Date
  sessionId: string
  agentType: string | null
  workspaceId: string | null
  status: string | null
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
