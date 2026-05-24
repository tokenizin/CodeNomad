export type DAGNodeType =
  | 'tool_exec'
  | 'approval_gate'
  | 'parallel_branch'
  | 'merge'
  | 'broadcast'
  | 'sub_workflow'

export type DAGNodeStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'BLOCKED'

export interface DAGNode {
  order: number
  title: string
  nodeType: DAGNodeType
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  status: DAGNodeStatus
  parallelGroup?: string
  dependencies: string[]  // node IDs (by title or unique key)
  nodeId?: string         // assigned after creation
  maxRetries: number
  retryCount: number
  timeoutMs?: number
  assignedAgentId?: string
  agentType?: string
  errorMessage?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  metadata?: Record<string, unknown>
}

export interface DAGDefinition {
  id: string
  nodes: DAGNode[]
  createdAt: string
}

export interface ExecutionCallbacks {
  onNodeStart: (node: DAGNode) => void
  onNodeComplete: (node: DAGNode) => void
  onNodeFail: (node: DAGNode, error: string) => void
  onApprovalRequired: (node: DAGNode, context: Record<string, unknown>) => Promise<'approved' | 'rejected' | 'pending'>
  onBroadcast: (channel: string, event: string, data: unknown) => void
  onLog: (eventType: string, severity: string, title: string, metadata?: Record<string, unknown>) => void
}

export interface DAGResult {
  success: boolean
  completedNodes: number
  failedNodes: number
  skippedNodes: number
  totalNodes: number
  durationMs: number
  error?: string
  outputs: Record<string, string>
}

export type LifecyclePhase =
  | 'analyze'
  | 'diagnose'
  | 'investigate'
  | 'identify'
  | 'plan'
  | 'test'
  | 'evaluate'
  | 'validate'
  | 'audit'
  | 'split'
  | 'assign'
  | 'broadcast'
  | 'execute'
  | 'monitor'
  | 'track'
  | 'alert'
  | 'react'
  | 'learn'
  | 'reason'
  | 'heal'
  | 'update'
  | 'package'
  | 'release'
  | 'deploy'
  | 'approve'
  | 'notify'
  | 'report'
