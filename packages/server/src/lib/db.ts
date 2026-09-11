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
  startedAt: Date | null
  metadata: unknown | null
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
  sessionId: string
  userId: string
  status: string
  commitHash: string | null
  commitMsg: string | null
  branch: string | null
  filesChanged: number | null
  vercelDeployId: string | null
  vercelUrl: string | null
  vercelHookId: string | null
  vercelTarget: string | null
  buildLogsBlobUrl: string | null
  buildLogsTruncated: string | null
  startedAt: Date
  completedAt: Date | null
  durationMs: number | null
  errorMessage: string | null
  errorDetails: unknown | null
  rolledBackToDeployId: string | null
  rolledBackAt: Date | null
  metadata: unknown | null
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
  sessionId: string
  userId: string
  title: string
  description: string | null
  agentType: string
  status: string
  priority: number | null
  assignedToUserId: string | null
  scheduledFor: Date | null
  completedAt: Date | null
  resultSummary: string | null
  errorMessage: string | null
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
  slug: string
  name: string
  defaultModeId: string
  stagePathnameHint: string | null
  toolExecutionMode: string
  entryAppPath: string | null
  summaryForPrompt: string | null
  voiceProfileId: string | null
  isActive: boolean
  version: number
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
  greetingPlayed: boolean
  voiceMode: boolean
  currentDagId: string | null
  status: string
  lifecyclePhase: string | null
  metadata: unknown | null
}

interface TokiDAPPOrchestratorNodeTable {
  id: string
  createdAt: Date
  updatedAt: Date
  orchestratorId: string
  order: number
  title: string
  nodeType: string
  toolName: string | null
  toolInput: unknown | null
  toolOutput: unknown | null
  status: string
  parallelGroup: string | null
  dependencies: string[] | null
  maxRetries: number
  retryCount: number
  timeoutMs: number | null
  assignedAgentId: string | null
  agentType: string | null
  errorMessage: string | null
  startedAt: Date | null
  completedAt: Date | null
  durationMs: number | null
  metadata: unknown | null
}

interface TokiDAPPApprovalRequestTable {
  id: string
  createdAt: Date
  updatedAt: Date
  orchestratorId: string
  nodeId: string | null
  title: string
  description: string | null
  contextSnapshot: unknown | null
  status: string
  priority: number | null
  assignedToUserId: string | null
  decidedByUserId: string | null
  decision: string | null
  comment: string | null
  expiresAt: Date | null
  autoApproveAfter: Date | null
  decidedAt: Date | null
}

interface TokiDAPPEventLogTable {
  id: string
  createdAt: Date
  orchestratorId: string | null
  nodeId: string | null
  eventType: string
  severity: string
  title: string
  description: string | null
  metadata: unknown | null
  correlationId: string | null
  source: string | null
}

interface TokiDAPPPublishmentTable {
  id: string
  orchestratorId: string
  channel: string
  eventType: string
  payload: unknown | null
  recipientCount: number
  publishedAt: Date
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
  sessionId: string | null
  orchestratorId: string | null
  nodeType: string
  label: string
  description: string | null
  confidence: number | null
  status: string | null
  evidence: string | null
  vulnerability: string | null
  sourceTool: string | null
  sourceStepId: string | null
}

interface CausalEdgeRecordTable {
  id: string
  createdAt: Date
  sessionId: string | null
  sourceNodeId: string
  targetNodeId: string
  label: string
  description: string | null
}

interface TokiDAPPWorkflowStepDefinitionTable {
  id: string
  createdAt: Date
  updatedAt: Date
  workflowId: string
  order: number
  title: string
  assistantScript: string | null
  mandatoryFieldKeys: string[] | null
  toolActionHint: string | null
  agentType: string | null
  nodeType: string | null
  parallelGroup: string | null
  dependencies: string[] | null
  isActive: boolean
}

interface AiProviderTable {
  id: string
  createdAt: Date
  updatedAt: Date
  kind: string
  label: string
  config: unknown | null
  enabled: boolean
}

interface AiModelTable {
  id: string
  createdAt: Date
  updatedAt: Date
  providerId: string
  name: string
  modelId: string
  contextWindow: number | null
  capabilities: string[] | null
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
  AiProvider: AiProviderTable
  AiModel: AiModelTable
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
