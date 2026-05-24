import type { DAGNode } from './types'
import { apiPost, apiGet, apiPut } from './starguard-client'

export interface ApprovalRequest {
  id: string
  orchestratorId: string
  nodeId?: string
  title: string
  description?: string
  contextSnapshot?: Record<string, unknown>
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED'
  priority: number
  assignedToUserId?: string
  decidedByUserId?: string
  decision?: string
  comment?: string
  expiresAt?: string
  autoApproveAfter?: string
  decidedAt?: string
  createdAt: string
}

export interface ApprovalDecision {
  approvalId: string
  decision: 'approve' | 'reject'
  comment?: string
}

// In-memory pending approval queue (synced with StarGuard DB)
const pendingApprovals = new Map<string, ApprovalRequest>()
const approvalResolvers = new Map<string, (decision: 'approved' | 'rejected') => void>()

/**
 * Create an approval request and persist to StarGuard.
 * Returns the approval ID.
 */
export async function createApprovalRequest(
  orchestratorId: string,
  node: DAGNode,
  context: Record<string, unknown>,
  assignedToUserId?: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    orchestratorId,
    nodeId: node.nodeId || node.title,
    title: `Approve: ${node.title}`,
    description: node.metadata?.description as string || `Approval required for DAG node: ${node.title}`,
    contextSnapshot: {
      nodeTitle: node.title,
      nodeType: node.nodeType,
      toolOutput: node.toolOutput,
      ...context,
    },
    priority: (node.metadata?.priority as number) || 0,
  }
  if (assignedToUserId) body.assignedToUserId = assignedToUserId

  const res = await apiPost('/api/tokidapp/approvals', body)

  if (!res.ok) {
    throw new Error(`Failed to create approval: ${res.status}`)
  }

  const approval: ApprovalRequest = await res.json()
  pendingApprovals.set(approval.id, approval)
  return approval.id
}

/**
 * Wait for an approval decision. Polls the StarGuard API
 * every 2 seconds until the approval is resolved.
 */
export async function waitForApprovalDecision(
  approvalId: string,
  timeoutMs = 300000, // 5 min default
): Promise<'approved' | 'rejected'> {
  // Check if there's already a resolver (from WS)
  const existingResolver = approvalResolvers.get(approvalId)
  if (existingResolver) {
    return new Promise((resolve) => {
      approvalResolvers.set(approvalId, resolve)
    })
  }

  // Poll StarGuard API
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await apiGet(`/api/tokidapp/approvals/${approvalId}`)

      if (res.ok) {
        const approval: ApprovalRequest = await res.json()
        if (approval.status === 'APPROVED') return 'approved'
        if (approval.status === 'REJECTED') return 'rejected'
        if (approval.status === 'EXPIRED' || approval.status === 'CANCELLED') return 'rejected'
      }
    } catch { /* retry */ }

    // Wait 2 seconds between polls
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  // Timeout — reject
  return 'rejected'
}

/**
 * Resolve an approval decision from a WS message or API call.
 * This allows real-time resolution without polling.
 */
export function resolveApproval(approvalId: string, decision: 'approved' | 'rejected'): boolean {
  const resolver = approvalResolvers.get(approvalId)
  if (resolver) {
    resolver(decision)
    approvalResolvers.delete(approvalId)
    pendingApprovals.delete(approvalId)
    return true
  }
  return false
}

/**
 * Get all pending approvals for a user or orchestrator.
 */
export function getPendingApprovals(orchestratorId?: string): ApprovalRequest[] {
  const results: ApprovalRequest[] = []
  for (const approval of pendingApprovals.values()) {
    if (!orchestratorId || approval.orchestratorId === orchestratorId) {
      results.push(approval)
    }
  }
  return results
}

/**
 * Fetch pending approvals from StarGuard.
 */
export async function fetchPendingApprovals(assignedToUserId?: string): Promise<ApprovalRequest[]> {
  try {
    const params = new URLSearchParams({ status: 'PENDING' })
    if (assignedToUserId) params.set('assignedTo', 'me')

    const res = await apiGet('/api/tokidapp/approvals', Object.fromEntries(params))

    if (!res.ok) return []
    return await res.json()
  } catch {
    return []
  }
}

/**
 * Submit an approval decision to StarGuard.
 */
export async function submitApprovalDecision(
  approvalId: string,
  decision: 'approve' | 'reject',
  comment?: string,
  userId?: string,
): Promise<boolean> {
  try {
    const res = await apiPut(`/api/tokidapp/approvals/${approvalId}`, {
      status: decision === 'approve' ? 'APPROVED' : 'REJECTED',
      comment,
    })

    if (res.ok) {
      // Resolve any in-memory waiters
      resolveApproval(approvalId, decision === 'approve' ? 'approved' : 'rejected')
      return true
    }
    return false
  } catch {
    return false
  }
}
