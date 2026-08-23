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
  endedAt: Date | null
  metadata: string | null
}

// Minimal User subset — only the columns session creation needs to verify.
// The full User model lives in ZenStack; this is just enough to ensure a
// stub row exists so TokiDAPPSession.userId FK never fails on a fresh DB.
interface UserTable {
  id: string
  walletAddress: string | null
  role: string | null
  email: string | null
  isActive: boolean | null
  createdAt: Date | null
  updatedAt: Date | null
  lastLoginAt: Date | null
}

interface TokiDAPPMessageTable {
  id: string
  createdAt: Date
  updatedAt: Date
  sessionId: string
  role: string
  content: string
  sources: string | null
  contentType: string | null
  toolCallId: string | null
  toolName: string | null
  toolStatus: string | null
  metadata: string | null
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

interface StarXpUsageLedgerTable {
  id: string
  userId: string
  onChainAddress: string
  chainId: number
  /** High-precision StarXP units, decimal string. */
  credit: string
  /** High-precision StarXP units, decimal string. */
  debt: string
  autoTopUp: boolean
  updatedAt: Date
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

/** Narrow, read-only projection used by the machine-to-machine API. */
export interface AgentApiKeyRecord {
  id: string
  label: string
  hashedKey: string
  scopes: string[]
  allowedAgents: string[]
  revokedAt: Date | null
}

interface AgentApiKeyTable extends AgentApiKeyRecord {
  createdBy: string
}

interface TokiDAPPTaskTable {
  id: string
  createdAt: Date
  updatedAt: Date
  sessionId: string | null
  title: string | null
  status: string | null
  assignedTo: string | null
  description: string | null
  agentType: string | null
  priority: number | null
  scheduledFor: Date | null
  assignedToUserId: string | null
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
  voiceProfileId: string | null
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
  assignedToUserId: string | null
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

interface CausalNodeRecordTable {
  id: string
  createdAt: Date
  updatedAt: Date
  sessionId: string | null
  orchestratorId: string | null
  nodeType: string | null
  content: string | null
  status: string | null
  metadata: string | null
}

interface CausalEdgeRecordTable {
  id: string
  createdAt: Date
  updatedAt: Date
  sourceNodeId: string
  targetNodeId: string
  edgeType: string | null
  label: string | null
}

interface TokiDAPPWorkflowStepDefinitionTable {
  id: string
  createdAt: Date
  updatedAt: Date
  workflowId: string
  order: number
  title: string | null
  assistantScript: string | null
  mandatoryFieldKeys: string | null
  toolActionHint: string | null
  agentType: string | null
  nodeType: string | null
  parallelGroup: string | null
  dependencies: string | null
  isActive: boolean
}

interface AIProviderTable {
  id: string
  createdAt: Date
  updatedAt: Date
  kind: string
  label: string
  enabled: boolean
  config: string | null
}

interface AIModelTable {
  id: string
  createdAt: Date
  updatedAt: Date
  modelId: string
  name: string
  providerId: string
  capabilities: string[] | null
  contextWindow: number | null
  enabled: boolean
}

// ─── Database Interface ──────────────────────────────────────

export interface TokiDAPPDB {
  AgentApiKey: AgentApiKeyTable
  User: UserTable
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
  StarXpUsageLedger: StarXpUsageLedgerTable
  CausalNodeRecord: CausalNodeRecordTable
  CausalEdgeRecord: CausalEdgeRecordTable
  TokiDAPPWorkflowStepDefinition: TokiDAPPWorkflowStepDefinitionTable
  AIProvider: AIProviderTable
  AIModel: AIModelTable
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

/**
 * Look up an API key on every request.  This deliberately does not cache the
 * result: revocation must take effect on the next request.
 */
export async function findActiveAgentApiKeys(): Promise<AgentApiKeyRecord[]> {
  return getTokidappDb()
    .selectFrom("AgentApiKey")
    .select(["id", "label", "hashedKey", "scopes", "allowedAgents", "revokedAt"])
    .where("revokedAt", "is", null)
    .execute()
}
