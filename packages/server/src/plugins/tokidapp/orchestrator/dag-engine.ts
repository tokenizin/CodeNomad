import type { DAGNode, DAGNodeStatus, DAGDefinition, ExecutionCallbacks, DAGResult, LifecyclePhase } from './types'
import { CausalGraphManager } from './causal-graph'
import { rollbackToPreviousCommit } from './rollback'
import { apiPost, apiGet, apiPut, STARGUARD_BASE } from './starguard-client'

// ── DAG Execution Engine ────────────────────────────────────────

interface DAGContext {
  orchestratorId: string
  nodes: DAGNode[]
  callbacks: ExecutionCallbacks
  abort: boolean
  causalManager: CausalGraphManager
}

/**
 * Execute a DAG of nodes with parallel processing, retry, and approval gates.
 *
 * Algorithm:
 * 1. Build adjacency index: nodeTitle -> { node, dependents: nodeTitle[] }
 * 2. Find root nodes (no unresolved deps) -> mark READY
 * 3. While nodes remain:
 *    a. Gather READY nodes -> group by parallelGroup
 *    b. For each group -> Promise.all(group.map(executeNode))
 *    c. On completion -> resolve dependents
 *    d. If deadlock -> error
 * 4. Return aggregated result
 */
export async function executeDAG(
  orchestratorId: string,
  dag: DAGDefinition,
  callbacks: ExecutionCallbacks,
): Promise<DAGResult> {
  const startTime = Date.now()
  const nodes = dag.nodes.map((n) => ({ ...n, status: 'PENDING' as DAGNodeStatus }))

  // ── Causal Graph ─────────────────────────────────────────────
  const causalManager = new CausalGraphManager()

  const ctx: DAGContext = { orchestratorId, nodes, callbacks, abort: false, causalManager }

  if (ctx.callbacks.onCausalGraphUpdate) {
    causalManager.onUpdate((cNodes, cEdges) => {
      ctx.callbacks.onCausalGraphUpdate(cNodes, cEdges)
    })
  }

  // Emit initial AttackGoal for the DAG intent
  const firstNode = nodes.find(n => n.dependencies.length === 0)
  if (firstNode) {
    causalManager.addAttackGoal(firstNode.metadata?.phase as string || 'workflow', {
      description: `Executing workflow: ${dag.id} with ${nodes.length} steps`,
      sourceStepId: firstNode.title,
    })
  }

  // Build adjacency
  const byTitle = new Map<string, DAGNode>()
  const dependents = new Map<string, string[]>() // node title -> dependents
  const depCount = new Map<string, number>() // node title -> remaining dep count

  for (const node of nodes) {
    byTitle.set(node.title, node)
    dependents.set(node.title, [])
    depCount.set(node.title, node.dependencies.length)
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      const list = dependents.get(dep) || []
      list.push(node.title)
      dependents.set(dep, list)
    }
  }

  // Track which nodes are ready
  const readyQueue: DAGNode[] = []

  function markReady(node: DAGNode) {
    if (ctx.abort) return
    node.status = 'READY'
    readyQueue.push(node)
  }

  // Initial roots
  for (const node of nodes) {
    if (depCount.get(node.title) === 0) {
      markReady(node)
    }
  }

  let completedCount = 0
  let failedCount = 0
  let skippedCount = 0
  const outputs: Record<string, string> = {}

  // Process ready queue
  while (readyQueue.length > 0 && !ctx.abort) {
    // Group by parallelGroup
    const groups = new Map<string, DAGNode[]>()
    for (const node of readyQueue.splice(0)) {
      const group = node.parallelGroup || `_seq_${node.order}`
      const list = groups.get(group) || []
      list.push(node)
      groups.set(group, list)
    }

    // Execute each group in parallel
    const groupPromises: Promise<void>[] = []
    for (const [, group] of groups) {
      groupPromises.push(
        (async () => {
          // Execute all nodes in this group in parallel
          const nodePromises = group.map((node) => executeNode(ctx, node, byTitle, outputs))
          const results = await Promise.allSettled(nodePromises)

          for (let i = 0; i < results.length; i++) {
            const result = results[i]
            const node = group[i]
            if (result.status === 'fulfilled') {
              completedCount++
              resolveDependents(node, dependents, depCount, byTitle, markReady)
            } else {
              failedCount++
              node.status = 'FAILED'
              node.errorMessage = (result as PromiseRejectedResult).reason?.message || String((result as PromiseRejectedResult).reason)
              callbacks.onNodeFail(node, node.errorMessage || 'Unknown error')
              callbacks.onLog('NODE_FAILED', 'ERROR', `Node failed: ${node.title}`, {
                error: node.errorMessage,
                toolName: node.toolName,
                nodeType: node.nodeType,
              })

              // ── Healing Actions ─────────────────────────────
              // Auto-rollback on deploy failure
              if (node.toolName === 'trigger_deploy') {
                callbacks.onLog('HEALING_ACTION', 'WARN', `Deploy failed — initiating rollback for ${node.title}`, {})
                const result = await rollbackToPreviousCommit(true)
                if (result.success) {
                  callbacks.onLog('HEALING_ACTION', 'INFO', `Rollback complete: ${result.branch} reverted to ${result.previousHash}`, {})
                  node.metadata = { ...node.metadata, rolledBack: true, rollbackHash: result.previousHash, rollbackMsg: result.previousMsg }
                  outputs[`rollback-${node.title}`] = `Rolled back ${result.branch} to ${result.previousHash}`
                } else {
                  callbacks.onLog('HEALING_ACTION', 'CRITICAL', `Rollback failed: ${result.error}`, {
                    requiresManualIntervention: true,
                  })
                }
              }

              // Auto-diagnose on test failure
              if (node.toolName === 'run_tests' && node.retryCount >= node.maxRetries) {
                callbacks.onLog('HEALING_ACTION', 'WARN', `Tests failed after ${node.retryCount} retries — creating diagnostic report`, {})
                try {
                  const { execSync } = await import('child_process')
                  const WORKSPACE_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()
                  const testOutput = execSync('bun run test 2>&1', { cwd: WORKSPACE_ROOT, encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: 120000 }).split('\n').slice(-10).join('\n')
                  callbacks.onLog('HEALING_ACTION', 'WARN', `Test failure details: ${testOutput.slice(0, 500)}`, {})
                  outputs[`diagnosis-${node.title}`] = testOutput
                } catch { /* non-critical */ }
              }

              // Escalate critical failures to human approval
              if (node.retryCount >= node.maxRetries && node.nodeType !== 'approval_gate') {
                callbacks.onLog('HEALING_ACTION', 'WARN', `All ${node.retryCount + 1} retries exhausted for ${node.title} — escalation recommended`, {
                  nodeTitle: node.title,
                  error: node.errorMessage,
                  requiresManualIntervention: true,
                })
              }

              // Skip dependents of failed nodes
              const deps = dependents.get(node.title) || []
              for (const depTitle of deps) {
                const depNode = byTitle.get(depTitle)
                if (depNode && depNode.status === 'PENDING') {
                  depNode.status = 'SKIPPED'
                  skippedCount++
                  callbacks.onLog('NODE_SKIPPED', 'WARN', `Skipped ${depNode.title} due to ${node.title} failure`)
                }
              }
            }
          }
        })(),
      )
    }

    await Promise.all(groupPromises)

    if (ctx.abort) break

    // Deadlock detection
    const remaining = nodes.filter((n) => n.status === 'PENDING' || n.status === 'READY')
    if (remaining.length > 0 && readyQueue.length === 0) {
      const msg = `Deadlock: ${remaining.length} nodes remain but none are ready`
      callbacks.onLog('ERROR', 'CRITICAL', msg, {
        pending: remaining.filter((n) => n.status === 'PENDING').map((n) => n.title),
      })
      return {
        success: false,
        completedNodes: completedCount,
        failedNodes: failedCount,
        skippedNodes: skippedCount,
        totalNodes: nodes.length,
        durationMs: Date.now() - startTime,
        error: msg,
        outputs,
      }
    }
  }

  const totalDuration = Date.now() - startTime

  // Broadcast completion
  callbacks.onBroadcast('orchestrator', 'dag_complete', {
    orchestratorId,
    completedNodes: completedCount,
    failedNodes: failedCount,
    durationMs: totalDuration,
  })

  callbacks.onLog('WORKFLOW_COMPLETED', 'INFO', `DAG execution complete`, {
    completedNodes: completedCount,
    failedNodes: failedCount,
    durationMs: totalDuration,
  })

  // Update orchestrator session on StarGuard
  await updateOrchestratorState(orchestratorId, 'completed', null)

  // Persist final DAG node states so they're recoverable via HTTP
  // on WS reconnect (fetchOrchestratorState in the client).
  try {
    await apiPost(`/api/tokidapp/orchestrator/${orchestratorId}/nodes`, {
      nodes: nodes.map((n) => ({
        order: n.order,
        title: n.title,
        nodeType: n.nodeType,
        toolName: n.toolName || null,
        toolInput: n.toolInput || null,
        toolOutput: n.toolOutput || null,
        status: n.status,
        errorMessage: n.errorMessage || null,
        parallelGroup: n.parallelGroup || null,
        dependencies: n.dependencies || [],
        maxRetries: n.maxRetries ?? 2,
        retryCount: n.retryCount ?? 0,
        timeoutMs: n.timeoutMs || null,
        assignedAgentId: n.assignedAgentId || null,
        agentType: n.agentType || null,
      })),
    })
  } catch {
    // Non-critical — nodes are available via WS during execution
  }

  return {
    success: failedCount === 0,
    completedNodes: completedCount,
    failedNodes: failedCount,
    skippedNodes: skippedCount,
    totalNodes: nodes.length,
    durationMs: totalDuration,
    outputs,
  }
}

async function executeNode(
  ctx: DAGContext,
  node: DAGNode,
  byTitle: Map<string, DAGNode>,
  outputs: Record<string, string>,
): Promise<void> {
  if (ctx.abort) return

  node.status = 'RUNNING'
  node.startedAt = new Date().toISOString()
  ctx.callbacks.onNodeStart(node)
  await updateNodeStatus(ctx.orchestratorId, node, 'RUNNING')

  try {
    switch (node.nodeType) {
      case 'tool_exec':
        await executeToolNode(ctx, node, outputs)
        break
      case 'approval_gate':
        await executeApprovalGate(ctx, node)
        break
      case 'broadcast':
        await executeBroadcastNode(ctx, node, outputs)
        break
      case 'merge':
        // Merge is a no-op — it just waits for deps (which we already do)
        break
      case 'parallel_branch':
        // Parallel branch is a marker — child nodes in the same parallelGroup run concurrently
        break
      case 'sub_workflow':
        await executeSubWorkflow(ctx, node)
        break
      default:
        throw new Error(`Unknown node type: ${node.nodeType}`)
    }

    node.status = 'COMPLETED'
    node.completedAt = new Date().toISOString()
    node.durationMs = Date.now() - new Date(node.startedAt!).getTime()
    ctx.callbacks.onNodeComplete(node)
    await updateNodeStatus(ctx.orchestratorId, node, 'COMPLETED')
    ctx.callbacks.onLog('NODE_COMPLETED', 'INFO', `Node completed: ${node.title}`, {
      durationMs: node.durationMs,
      nodeType: node.nodeType,
    })
  } catch (err) {
    const errorMsg = (err as Error).message

    if (node.retryCount < node.maxRetries) {
      node.retryCount++
      node.status = 'READY' // will retry
      ctx.callbacks.onLog('NODE_RETRY', 'WARN', `Retrying ${node.title} (${node.retryCount}/${node.maxRetries})`, {
        error: errorMsg,
      })
      throw err // re-throw to mark as retry
    }

    node.errorMessage = errorMsg
    ctx.callbacks.onLog('NODE_FAILED', 'ERROR', `Node failed: ${node.title}`, { error: errorMsg })
    throw err
  }
}

async function executeToolNode(ctx: DAGContext, node: DAGNode, outputs: Record<string, unknown>): Promise<void> {
  const toolName = node.toolName
  if (!toolName) throw new Error('tool_exec node requires toolName')

  // Call the existing tool implementations
  const input = node.toolInput || {}
  let result: string

  ctx.callbacks.onLog('NODE_STARTED', 'INFO', `Running tool: ${toolName}`, { input, nodeTitle: node.title })

  const toolResult = await routeToTool(toolName, input, node.title, ctx)
  result = toolResult

  node.toolOutput = result
  outputs[node.title] = result

  // ── Causal Graph: emit evidence from tool output ─────────────
  const sourceNodeId = `evidence-${node.title}-${Date.now()}`
  ctx.causalManager.addEvidence(`Tool: ${toolName}`, {
    description: result.slice(0, 300),
    confidence: 1.0,
    sourceStepId: node.title,
  })

  // For analysis/diagnosis tools, also emit a Hypothesis
  if (['investigate_codebase', 'analyze', 'diagnose', 'plan', 'evaluate', 'reason'].includes(toolName)) {
    ctx.causalManager.addHypothesis(`Analysis from ${toolName}`, {
      description: `Inferred from ${node.title}: ${result.slice(0, 150)}`,
      confidence: 0.6,
      sourceStepId: node.title,
      supportedBy: sourceNodeId,
    })
  }

  // For security/vulnerability tools, emit a Vulnerability
  if (toolName === 'security_scan' || toolName === 'run_a11y_audit' || toolName === 'audit') {
    ctx.causalManager.addVulnerability(`Finding: ${toolName}`, {
      description: `Detected during ${node.title}: ${result.slice(0, 200)}`,
      confidence: 0.8,
      sourceStepId: node.title,
      revealedBy: sourceNodeId,
    })
  }

  // For test failures, emit an Exploit
  if (toolName === 'run_tests' && result.toLowerCase().includes('fail')) {
    ctx.causalManager.addExploit(`Test failure: ${node.title}`, {
      description: result.slice(0, 200),
      confidence: 0.9,
      sourceStepId: node.title,
    })
  }
}

async function executeApprovalGate(ctx: DAGContext, node: DAGNode): Promise<void> {
  const decision = await ctx.callbacks.onApprovalRequired(node, {
    orchestratorId: ctx.orchestratorId,
    nodeTitle: node.title,
    toolOutput: node.toolOutput,
    metadata: node.metadata,
  })

  if (decision === 'rejected') {
    throw new Error(`Approval rejected: ${node.title}`)
  }
  if (decision === 'pending') {
    // DAG will pause here until the approval is resolved
    // The approval is being handled by the caller (e.g., via the approval queue)
    // We poll or wait for a callback
    throw new Error('Approval pending — DAG paused')
  }
  // approved — continue
}

async function executeBroadcastNode(ctx: DAGContext, node: DAGNode, outputs: Record<string, unknown>): Promise<void> {
  const channel = (node.metadata?.channel as string) || 'default'
  const event = (node.metadata?.event as string) || 'node_complete'
  const data = outputs

  ctx.callbacks.onBroadcast(channel, event, data)
  ctx.callbacks.onLog('BROADCAST_SENT', 'INFO', `Broadcast on ${channel}: ${event}`)

  // Persist publishment via StarGuard API
  try {
    await apiPost('/api/tokidapp/events', {
      orchestratorId: ctx.orchestratorId,
      eventType: 'BROADCAST_SENT',
      severity: 'INFO',
      title: `Broadcast: ${channel}/${event}`,
      metadata: { channel, event, nodeTitle: node.title },
    })
  } catch { /* non-critical */ }
}

async function executeSubWorkflow(ctx: DAGContext, node: DAGNode): Promise<void> {
  // Sub-workflow expansion — for now, treat as a tool exec with a special handler
  // Future: recursively execute another DAG as a sub-graph
  const subWorkflowId = node.metadata?.subWorkflowId as string
  if (!subWorkflowId) throw new Error('sub_workflow node requires subWorkflowId in metadata')
  // Would call executeDAG recursively with a nested DAG definition
}

function resolveDependents(
  node: DAGNode,
  dependents: Map<string, string[]>,
  depCount: Map<string, number>,
  byTitle: Map<string, DAGNode>,
  markReady: (node: DAGNode) => void,
) {
  const deps = dependents.get(node.title) || []
  for (const depTitle of deps) {
    const count = (depCount.get(depTitle) || 1) - 1
    depCount.set(depTitle, count)
    if (count === 0) {
      const depNode = byTitle.get(depTitle)
      if (depNode && depNode.status === 'PENDING') {
        markReady(depNode)
      }
    }
  }
}

// ── Tool Router ─────────────────────────────────────────────────

async function routeToTool(toolName: string, input: Record<string, unknown>, nodeTitle: string, ctx: DAGContext): Promise<string> {
  // These mirror the tools from the existing tokidapp.ts routeMessage
  const { execSync } = await import('child_process')
  const WORKSPACE_ROOT = process.env.CLI_WORKSPACE_ROOT || process.cwd()

  switch (toolName) {
    case 'investigate_codebase': {
      const query = (input.query as string) || ''
      const keywords = query.replace(/investigate|find|search/gi, '').trim().split(/\s+/).filter(Boolean)
      if (keywords.length === 0) return 'Please provide search keywords.'
      try {
        const pattern = keywords.join('|')
        const results = execSync(
          `rg -l -i "${pattern}" --type ts --type tsx --type css --glob '!node_modules' --glob '!.next' --glob '!public/codenomad' 2>/dev/null | head -20`,
          { cwd: WORKSPACE_ROOT, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
        )
        const files = results.trim().split('\n').filter(Boolean)
        if (files.length === 0) return `No files found for: ${keywords.join(', ')}`
        return `Found ${files.length} file(s):\n${files.map((f) => `- ${f}`).join('\n')}`
      } catch { return 'Search failed.' }
    }

    case 'run_tests': {
      try {
        const output = execSync('bun run test 2>&1', { cwd: WORKSPACE_ROOT, encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: 120000 })
        const passMatch = output.match(/(\d+)\s+passed/i)
        const failMatch = output.match(/(\d+)\s+failed/i)
        return `Tests: ${passMatch?.[1] || '?'} passed, ${failMatch?.[1] || '0'} failed`
      } catch (e: any) { return `Test error: ${e.message || 'unknown'}` }
    }

    case 'git_status': {
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: WORKSPACE_ROOT, encoding: 'utf-8' }).trim()
        const status = execSync('git status --short', { cwd: WORKSPACE_ROOT, encoding: 'utf-8' }).trim()
        const changes = status ? status.split('\n').length : 0
        return `Branch: ${branch}\nUncommitted: ${changes} file(s)`
      } catch (e: any) { return `Git error: ${e.message}` }
    }

    case 'generate_feature': {
      const prompt = (input.prompt as string) || ''
      const { execSync: exec } = await import('child_process')
      const path = await import('path')
      const fs = await import('fs')
      const filesCreated: string[] = []
      const match = prompt.match(/(\w+)\s*(page|component|route)/i)
      if (!match) return 'Specify what to create: page, component, or API route.'
      const name = match[1].toLowerCase()
      const type = match[2].toLowerCase()
      if (type === 'page') {
        const dir = path.join(WORKSPACE_ROOT, 'src', 'app', name)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'page.tsx'), `'use client'\n\nexport default function ${name.charAt(0).toUpperCase() + name.slice(1)}Page() {\n  return <div className="p-8"><h1 className="text-2xl font-bold text-white">${name}</h1></div>\n}\n`)
        filesCreated.push(`src/app/${name}/page.tsx`)
      }
      if (type === 'component') {
        const compPascal = name.charAt(0).toUpperCase() + name.slice(1)
        const compDir = path.join(WORKSPACE_ROOT, 'src', 'components')
        fs.mkdirSync(compDir, { recursive: true })
        fs.writeFileSync(path.join(compDir, `${compPascal}.tsx`), `'use client'\n\nexport function ${compPascal}({ className = "" }: { className?: string }) {\n  return <div className={className}>${compPascal}</div>\n}\n`)
        filesCreated.push(`src/components/${compPascal}.tsx`)
      }
      return filesCreated.length > 0 ? `Created:\n${filesCreated.map((f) => `- ${f}`).join('\n')}` : 'Could not determine what to create.'
    }

    case 'commit_push': {
      const msg = (input.commitMsg as string) || 'Auto-commit from orchestrator'
      execSync('git add -A', { cwd: WORKSPACE_ROOT, encoding: 'utf-8' })
      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd: WORKSPACE_ROOT, encoding: 'utf-8' })
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: WORKSPACE_ROOT, encoding: 'utf-8' }).trim()
      execSync(`git push origin ${branch}`, { cwd: WORKSPACE_ROOT, encoding: 'utf-8', timeout: 30000 })
      const hash = execSync('git rev-parse HEAD', { cwd: WORKSPACE_ROOT, encoding: 'utf-8' }).trim()
      return `Committed and pushed: ${hash.slice(0, 7)} on ${branch}`
    }

    case 'trigger_deploy': {
      const hookUrl = process.env.VERCEL_DEPLOY_HOOK_URL
      if (!hookUrl) return 'VERCEL_DEPLOY_HOOK_URL not configured.'
      const res = await fetch(hookUrl, { method: 'POST' })
      if (!res.ok) return `Deploy hook failed: ${res.status}`
      return 'Deploy triggered on Vercel.'
    }

    case 'diagnose':
    case 'analyze':
    case 'plan':
    case 'evaluate':
    case 'validate':
      return await callLightweightConcierge(nodeTitle, input)

    default:
      return `Unknown tool: ${toolName}`
  }
}

async function callLightweightConcierge(title: string, input: Record<string, unknown>): Promise<string> {
  try {
    const prompt = (input.prompt as string) || (input.query as string) || title
    const res = await apiPost('/api/tokidapp/chat', { content: prompt, sessionId: 'orchestrator' })
    if (!res.ok) return `Analysis unavailable (${res.status})`
    const data = await res.json()
    return data.message || 'Analysis complete.'
  } catch {
    return 'Analysis unavailable.'
  }
}

// ── DAG Builder ─────────────────────────────────────────────────

interface PhaseConfig {
  phase: LifecyclePhase
  nodeType: DAGNode['nodeType']
  toolName: string
  timeoutMs: number
  maxRetries: number
  parallelWithNext?: boolean
  isHealing?: boolean
  healingFallback?: LifecyclePhase
  metadata?: Record<string, unknown>
}

const PHASE_CONFIGS: Record<LifecyclePhase, PhaseConfig> = {
  analyze:      { phase: 'analyze',      nodeType: 'tool_exec',      toolName: 'analyze',        timeoutMs: 30000,  maxRetries: 2 },
  diagnose:     { phase: 'diagnose',     nodeType: 'tool_exec',      toolName: 'diagnose',       timeoutMs: 30000,  maxRetries: 2 },
  investigate:  { phase: 'investigate',  nodeType: 'tool_exec',      toolName: 'investigate_codebase', timeoutMs: 30000, maxRetries: 2 },
  identify:     { phase: 'identify',     nodeType: 'tool_exec',      toolName: 'diagnose',       timeoutMs: 30000,  maxRetries: 2 },
  plan:         { phase: 'plan',         nodeType: 'tool_exec',      toolName: 'plan',           timeoutMs: 60000,  maxRetries: 2 },
  test:         { phase: 'test',         nodeType: 'tool_exec',      toolName: 'run_tests',      timeoutMs: 120000, maxRetries: 1, parallelWithNext: true },
  evaluate:     { phase: 'evaluate',     nodeType: 'tool_exec',      toolName: 'evaluate',       timeoutMs: 60000,  maxRetries: 2, parallelWithNext: true },
  validate:     { phase: 'validate',     nodeType: 'tool_exec',      toolName: 'evaluate',       timeoutMs: 60000,  maxRetries: 2 },
  audit:        { phase: 'audit',        nodeType: 'broadcast',      toolName: 'audit',          timeoutMs: 15000,  maxRetries: 1 },
  split:        { phase: 'split',        nodeType: 'tool_exec',      toolName: 'plan',           timeoutMs: 30000,  maxRetries: 2, parallelWithNext: true },
  assign:       { phase: 'assign',       nodeType: 'tool_exec',      toolName: 'assign_task',    timeoutMs: 30000,  maxRetries: 2, parallelWithNext: true },
  broadcast:    { phase: 'broadcast',    nodeType: 'broadcast',      toolName: 'broadcast',      timeoutMs: 15000,  maxRetries: 1 },
  execute:      { phase: 'execute',      nodeType: 'tool_exec',      toolName: 'generate_feature', timeoutMs: 120000, maxRetries: 2 },
  monitor:      { phase: 'monitor',      nodeType: 'broadcast',      toolName: 'monitor',        timeoutMs: 15000,  maxRetries: 1 },
  track:        { phase: 'track',        nodeType: 'tool_exec',      toolName: 'git_status',     timeoutMs: 15000,  maxRetries: 1 },
  alert:        { phase: 'alert',        nodeType: 'broadcast',      toolName: 'alert',          timeoutMs: 15000,  maxRetries: 1 },
  react:        { phase: 'react',        nodeType: 'tool_exec',      toolName: 'diagnose',       timeoutMs: 30000,  maxRetries: 2 },
  learn:        { phase: 'learn',        nodeType: 'tool_exec',      toolName: 'analyze',        timeoutMs: 30000,  maxRetries: 2 },
  reason:       { phase: 'reason',       nodeType: 'tool_exec',      toolName: 'plan',           timeoutMs: 60000,  maxRetries: 2 },
  heal:         { phase: 'heal',         nodeType: 'tool_exec',      toolName: 'diagnose',       timeoutMs: 60000,  maxRetries: 3, isHealing: true },
  update:       { phase: 'update',       nodeType: 'tool_exec',      toolName: 'generate_feature', timeoutMs: 60000, maxRetries: 2 },
  package:      { phase: 'package',      nodeType: 'tool_exec',      toolName: 'git_status',     timeoutMs: 30000,  maxRetries: 2, parallelWithNext: true },
  release:      { phase: 'release',      nodeType: 'tool_exec',      toolName: 'commit_push',    timeoutMs: 60000,  maxRetries: 2, parallelWithNext: true },
  deploy:       { phase: 'deploy',       nodeType: 'tool_exec',      toolName: 'trigger_deploy', timeoutMs: 120000, maxRetries: 1 },
  approve:      { phase: 'approve',      nodeType: 'approval_gate',  toolName: 'approve',        timeoutMs: 300000, maxRetries: 0 },
  notify:       { phase: 'notify',       nodeType: 'broadcast',      toolName: 'broadcast',      timeoutMs: 15000,  maxRetries: 1 },
  report:       { phase: 'report',       nodeType: 'broadcast',      toolName: 'broadcast',      timeoutMs: 15000,  maxRetries: 1 },
  voice_conversation_start:      { phase: 'voice_conversation_start',      nodeType: 'tool_exec',    toolName: 'transcribe_audio',  timeoutMs: 60000,  maxRetries: 1 },
  voice_conversation_transcribe: { phase: 'voice_conversation_transcribe', nodeType: 'tool_exec',    toolName: 'transcribe_audio',  timeoutMs: 30000,  maxRetries: 2 },
  voice_conversation_translate:  { phase: 'voice_conversation_translate',  nodeType: 'tool_exec',    toolName: 'translate_text',    timeoutMs: 15000,  maxRetries: 2 },
  voice_conversation_respond:    { phase: 'voice_conversation_respond',    nodeType: 'tool_exec',    toolName: 'synthesize_speech', timeoutMs: 60000,  maxRetries: 1 },
  voice_conversation_end:        { phase: 'voice_conversation_end',        nodeType: 'broadcast',    toolName: 'broadcast',         timeoutMs: 15000,  maxRetries: 1 },
}

/**
 * Lifecycle template definitions with parallel groups and healing branches.
 * Each template defines phases, parallel groups, and fallback strategies.
 */
const LIFECYCLE_TEMPLATES: Record<string, {
  phases: LifecyclePhase[]
  parallelGroups?: string[][]      // groups of phases that run in parallel
  healingBranches?: Record<string, LifecyclePhase[]>  // phase -> healing fallback chain
  description: string
}> = {
  full_deploy: {
    phases: ['analyze', 'plan', 'approve', 'split', 'assign', 'broadcast', 'execute', 'test', 'evaluate', 'validate', 'audit', 'package', 'release', 'deploy', 'monitor', 'track', 'alert', 'learn'],
    parallelGroups: [
      ['test', 'evaluate'],
      ['split', 'assign', 'broadcast'],
      ['package', 'release'],
      ['monitor', 'track', 'alert'],
    ],
    healingBranches: {
      'test': ['diagnose', 'heal', 'validate'],
      'deploy': ['diagnose', 'heal', 'validate', 'deploy'],
    },
    description: 'Full software lifecycle: analyze → plan → approve → parallel execute → test/evaluate → audit → release → deploy → monitor',
  },

  investigate_issue: {
    phases: ['diagnose', 'investigate', 'identify', 'plan', 'approve', 'heal', 'test', 'validate', 'audit', 'broadcast'],
    parallelGroups: [
      ['test', 'heal'],
    ],
    healingBranches: {
      'identify': ['investigate', 'diagnose', 'reason'],
      'heal': ['diagnose', 'investigate', 'heal'],
    },
    description: 'Issue investigation: diagnose → investigate → identify → plan → approve → heal → test → validate',
  },

  quick_query: {
    phases: ['analyze', 'investigate', 'identify', 'report'],
    parallelGroups: [],
    healingBranches: {},
    description: 'Quick Q&A: analyze → investigate → identify → report',
  },

  deploy_only: {
    phases: ['analyze', 'plan', 'approve', 'package', 'release', 'deploy', 'monitor', 'alert'],
    parallelGroups: [
      ['package', 'release'],
      ['monitor', 'alert'],
    ],
    healingBranches: {
      'deploy': ['diagnose', 'heal', 'validate', 'deploy'],
    },
    description: 'Deploy pipeline: analyze → plan → approve → package → release → deploy → monitor',
  },

  feature_generation: {
    phases: ['analyze', 'plan', 'approve', 'split', 'assign', 'execute', 'test', 'evaluate', 'validate', 'audit', 'broadcast'],
    parallelGroups: [
      ['test', 'evaluate'],
      ['split', 'assign'],
    ],
    healingBranches: {
      'execute': ['diagnose', 'plan', 'approve', 'execute'],
      'test': ['diagnose', 'heal', 'test'],
    },
    description: 'Feature generation: analyze → plan → approve → assign → execute → test → evaluate → deploy',
  },

  financial_assessment: {
    phases: ['analyze', 'investigate', 'evaluate', 'reason', 'plan', 'approve', 'report', 'broadcast'],
    parallelGroups: [
      ['investigate', 'evaluate'],
      ['report', 'broadcast'],
    ],
    healingBranches: {},
    description: 'Financial: analyze → investigate → evaluate → reason → plan → approve → report',
  },

  voice_conversation: {
    phases: [
      'voice_conversation_start',
      'investigate',
      'reason',
      'voice_conversation_translate',
      'voice_conversation_respond',
      'voice_conversation_end',
    ],
    parallelGroups: [
      ['investigate', 'reason'],
      ['voice_conversation_translate', 'voice_conversation_respond'],
    ],
    healingBranches: {
      'investigate': ['diagnose', 'investigate'],
    },
    description: 'Voice conversation: listen → investigate/reason → translate (EN↔ID) → respond (TTS) → loop',
  },
}

/**
 * Build a lifecycle DAG from an intent.
 * Uses rich templates with parallel groups and healing branches.
 * Falls back to simple phase list if no template matches.
 */
export function buildLifecycleDAG(
  intentType: string,
  userInput: string,
  entities: Record<string, string>,
  lifecyclePhases?: LifecyclePhase[],
): { nodes: DAGNode[]; phases: LifecyclePhase[] } {
  const template = LIFECYCLE_TEMPLATES[intentType] || getTemplateForIntentType(intentType)
  const phases = lifecyclePhases || template.phases
  const nodes: DAGNode[] = []

  // Build parallel group index: phase -> group name
  const parallelGroupMap = new Map<string, string>()
  if (template.parallelGroups) {
    for (const group of template.parallelGroups) {
      const groupName = `parallel-${group.join('-')}`
      for (const phase of group) {
        parallelGroupMap.set(phase, groupName)
      }
    }
  }

  // Build healing branch map
  const healingMap = template.healingBranches || {}

  let prevTitle: string | null = null

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]
    const nodeTitle = `${phase}-${i}`
    const config = PHASE_CONFIGS[phase]
    const deps: string[] = prevTitle ? [prevTitle] : []

    const parallelGroup = parallelGroupMap.get(phase)
    const nodeType = config.nodeType
    const toolName = config.toolName

    // Check for healing fallback
    const healingFallback = healingMap[phase]
    const healingFallbackDeps = healingFallback
      ? [`${healingFallback[0]}-${i + 1}`]
      : undefined

    nodes.push({
      order: i,
      title: nodeTitle,
      nodeType,
      toolName,
      toolInput: { query: userInput, ...entities, phase },
      status: 'PENDING',
      dependencies: deps,
      parallelGroup,
      maxRetries: config.maxRetries,
      retryCount: 0,
      timeoutMs: config.timeoutMs,
      metadata: {
        phase,
        intentType,
        isHealing: config.isHealing || undefined,
        healingFallback: healingFallback || undefined,
        description: config.nodeType === 'approval_gate'
          ? `Human approval required for: ${phase}`
          : `Executing: ${phase}`,
      },
    })

    prevTitle = nodeTitle
  }

  return { nodes, phases }
}

function getTemplateForIntentType(intentType: string): typeof LIFECYCLE_TEMPLATES[string] {
  switch (intentType) {
    case 'CREATE_ACTION':
      return LIFECYCLE_TEMPLATES.feature_generation
    case 'UPDATE_STATE':
      return LIFECYCLE_TEMPLATES.investigate_issue
    case 'REPORT_ISSUE':
      return LIFECYCLE_TEMPLATES.investigate_issue
    case 'REQUEST_APPROVAL':
      return {
        phases: ['analyze', 'evaluate', 'approve', 'audit', 'broadcast'],
        parallelGroups: [['audit', 'broadcast']],
        healingBranches: {},
        description: 'Approval: analyze → evaluate → approve → audit',
      }
    case 'ASSESS_FINANCIAL':
      return LIFECYCLE_TEMPLATES.financial_assessment
    case 'PREDICT_NEXT_STEP':
      return {
        phases: ['analyze', 'reason', 'plan', 'approve', 'broadcast'],
        parallelGroups: [],
        healingBranches: {},
        description: 'Recommendation: analyze → reason → plan → approve',
      }
    default:
      return LIFECYCLE_TEMPLATES.quick_query
  }
}

/**
 * Get all available lifecycle templates with descriptions.
 */
export function getLifecycleTemplates() {
  return Object.entries(LIFECYCLE_TEMPLATES).map(([slug, template]) => ({
    slug,
    phases: template.phases,
    parallelGroups: template.parallelGroups || [],
    hasHealing: Object.keys(template.healingBranches || {}).length > 0,
    description: template.description,
  }))
}

// ── StarGuard API Helpers ───────────────────────────────────────

async function updateNodeStatus(orchestratorId: string, node: DAGNode, status: string): Promise<void> {
  try {
    await apiPut(`/api/tokidapp/orchestrator/${orchestratorId}`, { nodeStatus: status })
  } catch { /* non-critical */ }
}

async function updateOrchestratorState(orchestratorId: string, status: string, lifecyclePhase: string | null): Promise<void> {
  try {
    await apiPut(`/api/tokidapp/orchestrator/${orchestratorId}`, {
      status,
      lifecyclePhase: lifecyclePhase || undefined,
    })
  } catch { /* non-critical */ }
}

export { updateOrchestratorState, updateNodeStatus }
