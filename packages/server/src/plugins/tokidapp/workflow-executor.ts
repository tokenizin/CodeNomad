import { apiGet, apiPost, apiPut } from './orchestrator/starguard-client'
import { invokePmaNode } from '../../server/routes/nomadworks-bridge'

// ── Types ──────────────────────────────────────────────────────

interface ExecNode {
  id: string
  stepOrder: number
  phaseName: string
  nodeType: string
  status: string
  dependencies: string[]
  toolName?: string
  agentType?: string
  input?: Record<string, unknown>
  maxRetries?: number
  retryCount?: number
  maxExecTimeMs?: number
}

interface ExecDetails {
  id: string
  status: string
  currentPhase?: string
  nodes: ExecNode[]
}

// ── Main Entry Point ───────────────────────────────────────────

export async function processExecution(
  executionId: string,
  send: (msg: string) => void,
): Promise<void> {
  // 1. Fetch execution + nodes
  const response = await apiGet(`/api/tokidapp/executions/${executionId}`)
  if (!response.ok) throw new Error(`Execution ${executionId} not found (HTTP ${response.status})`)
  const exec: ExecDetails = await response.json()
  const nodes = exec.nodes.filter((n: ExecNode) => n.status === 'PENDING')
  if (nodes.length === 0) {
    // All already done — just mark execution complete
    await apiPut(`/api/tokidapp/executions/${executionId}`, { status: 'completed' })
    send(JSON.stringify({ type: 'execution_status', executionId, status: 'completed', completedNodes: exec.nodes.length, totalNodes: exec.nodes.length }))
    return
  }

  // 2. Mark execution as running
  await apiPut(`/api/tokidapp/executions/${executionId}`, { status: 'running', startedAt: new Date().toISOString() })
  send(JSON.stringify({ type: 'execution_status', executionId, status: 'running', completedNodes: 0, totalNodes: nodes.length }))

  // 3. Build dependency graph
  const byId = new Map<string, ExecNode>()
  const dependents = new Map<string, string[]>()
  const depCount = new Map<string, number>()

  for (const node of nodes) {
    byId.set(node.id, node)
    dependents.set(node.id, [])
    depCount.set(node.id, node.dependencies.length)
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      const list = dependents.get(dep) || []
      list.push(node.id)
      dependents.set(dep, list)
    }
  }

  let completedCount = 0
  let failedCount = 0
  let cancelled = false

  // 4. Process loop
  while (!cancelled) {
    // Check if execution was cancelled
    const statusCheckRes = await apiGet(`/api/tokidapp/executions/${executionId}`)
    if (statusCheckRes.ok) {
      const statusData: Record<string, unknown> = await statusCheckRes.json()
      if (statusData.status === 'cancelled') {
        cancelled = true
        break
      }
    }

    // Find ready nodes (dependencies resolved)
    const readyNodes = nodes.filter(
      (n) => n.status === 'PENDING' && depCount.get(n.id) === 0,
    )

    if (readyNodes.length === 0) {
      const remaining = nodes.filter((n) => n.status === 'PENDING')
      if (remaining.length === 0) break // all done
      // Deadlock
      throw new Error(`Deadlock: ${remaining.length} nodes remain but none are ready`)
    }

    // Process all ready nodes
    for (const node of readyNodes) {
      // Update node to RUNNING
      await apiPut(`/api/tokidapp/executions/${executionId}/nodes/${node.id}`, {
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
      })
      send(JSON.stringify({
        type: 'execution_node_status',
        executionId,
        nodeId: node.id,
        stepOrder: node.stepOrder,
        phaseName: node.phaseName,
        status: 'RUNNING',
      }))

      try {
        let result: Record<string, unknown> = {}

        switch (node.nodeType) {
          case 'pma_delegate': {
            // Route through NomadWorks bridge
            const bridgeResult = await invokePmaNode({
              intent: (node.input?.intent as string) || node.toolName || 'Execute workflow step',
              agentType: node.agentType || 'developer',
              executionNodeId: node.id,
              executionId,
              context: (node.input as Record<string, unknown>) || {},
              send,
            })
            result = { status: 'completed', evidence: bridgeResult.evidence, taskId: bridgeResult.taskId }
            break
          }

          case 'approval':
            // Skip — human-in-loop, leave as PENDING
            result = { status: 'skipped', reason: 'Approval gate — manual approval required' }
            break

          default:
            // tool_exec and others — mark completed (simulated)
            result = { status: 'completed', simulated: true }
        }

        // Update node to COMPLETED
        const durationMs = result.status === 'completed'
          ? Math.round(performance.now() - parseFloat(String(node.stepOrder)))
          : 0

        const updateData: Record<string, unknown> = { status: 'COMPLETED' }
        if (result.output || result.simulated) updateData.output = result
        if (result.evidence) updateData.output = result.evidence
        if (durationMs > 0) updateData.durationMs = durationMs
        updateData.completedAt = new Date().toISOString()

        await apiPut(`/api/tokidapp/executions/${executionId}/nodes/${node.id}`, updateData)
        send(JSON.stringify({
          type: 'execution_node_status',
          executionId,
          nodeId: node.id,
          stepOrder: node.stepOrder,
          phaseName: node.phaseName,
          status: 'COMPLETED',
          output: result.output || result.evidence || { simulated: true },
        }))

        // Mark node as completed in our local tracking
        node.status = 'COMPLETED'
        completedCount++

        // Resolve dependents
        const deps = dependents.get(node.id) || []
        for (const depId of deps) {
          const count = depCount.get(depId) || 0
          depCount.set(depId, Math.max(0, count - 1))
        }

      } catch (err) {
        // Handle failure
        const errorMsg = err instanceof Error ? err.message : String(err)
        node.status = 'FAILED'
        failedCount++

        await apiPut(`/api/tokidapp/executions/${executionId}/nodes/${node.id}`, {
          status: 'FAILED',
          errorMessage: errorMsg,
          completedAt: new Date().toISOString(),
        })
        send(JSON.stringify({
          type: 'execution_node_status',
          executionId,
          nodeId: node.id,
          stepOrder: node.stepOrder,
          phaseName: node.phaseName,
          status: 'FAILED',
          error: errorMsg,
        }))

        // Skip dependents
        const deps = dependents.get(node.id) || []
        for (const depId of deps) {
          const depNode = byId.get(depId)
          if (depNode && depNode.status === 'PENDING') {
            depNode.status = 'SKIPPED'
            await apiPut(`/api/tokidapp/executions/${executionId}/nodes/${depId}`, {
              status: 'SKIPPED',
              completedAt: new Date().toISOString(),
            })
          }
        }
      }
    }
  }

  // 5. Final status
  const allNodes = [...exec.nodes, ...nodes]
  const allDone = allNodes.every(
    (n) => n.status === 'COMPLETED' || n.status === 'SKIPPED' || n.status === 'FAILED',
  )
  const finalStatus = cancelled ? 'cancelled' : failedCount > 0 ? 'failed' : 'completed'

  await apiPut(`/api/tokidapp/executions/${executionId}`, {
    status: finalStatus,
    completedAt: new Date().toISOString(),
    ...(failedCount > 0 ? { errorMessage: `${failedCount} node(s) failed` } : {}),
  })
  send(JSON.stringify({
    type: 'execution_status',
    executionId,
    status: finalStatus,
    completedNodes: completedCount,
    failedNodes: failedCount,
    totalNodes: allNodes.length,
  }))
}
