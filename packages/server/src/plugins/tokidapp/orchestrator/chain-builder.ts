/**
 * Chain Builder — constructs linear execution chains from voice intent.
 *
 * Phase 4: Voice-driven linear chain construction (A → B → C).
 * Uses the DAG engine's native dependency model for sequential execution.
 *
 * Each step depends on the previous step's completion, creating a strict
 * linear execution order. Parallel/conditional chains are deferred to
 * a follow-up SCR.
 *
 * @module chain-builder
 */

import type { DAGNode, DAGDefinition, ExecutionCallbacks, DAGResult } from "./types"

// ── Types ─────────────────────────────────────────────────────

export interface ChainStep {
  /** Human-readable step name (e.g., "Investigate the issue") */
  title: string
  /** Tool to execute for this step */
  toolName: string
  /** Input parameters for the tool */
  toolInput?: Record<string, unknown>
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number
  /** Max retries on failure (default: 2) */
  maxRetries?: number
}

export interface LinearChain {
  /** Unique chain ID */
  id: string
  /** Ordered steps */
  steps: ChainStep[]
  /** User's original voice intent */
  originalIntent: string
  /** When the chain was created */
  createdAt: string
}

export interface ChainBuildResult {
  status: "built" | "error" | "invalid_steps"
  chain?: LinearChain
  dag?: DAGDefinition
  message: string
}

// ── Chain Builder ─────────────────────────────────────────────

/** Tool name mapping for common voice intents */
const INTENT_TOOL_MAP: Record<string, string> = {
  investigate: "investigate_codebase",
  research: "investigate_codebase",
  analyze: "investigate_codebase",
  search: "investigate_codebase",
  fix: "generate_feature",
  implement: "generate_feature",
  build: "generate_feature",
  create: "generate_feature",
  test: "run_tests",
  verify: "run_tests",
  check: "run_tests",
  lint: "run_lint",
  typecheck: "run_type_check",
  format: "run_lint",
  commit: "git_commit_push",
  deploy: "trigger_deploy",
  status: "git_status",
  diff: "capture_git_diff",
}

/**
 * Parse a voice intent string into ordered chain steps.
 * Extracts action verbs and maps them to tool names.
 */
export function parseVoiceIntentToSteps(intent: string): ChainStep[] {
  const lower = intent.toLowerCase()
  const steps: ChainStep[] = []

  // Split on common connectors: "then", "and", "after that", commas
  const segments = lower
    .split(/(?:,\s*|\s+then\s+|\s+and\s+(?:then\s+)?|\s+after\s+that\s+|\s+followed\s+by\s+)/)
    .map((s) => s.trim())
    .filter(Boolean)

  for (const segment of segments) {
    // Extract the first verb-like word
    const words = segment.split(/\s+/)
    const verb = words[0]

    // Find matching tool
    const toolName = INTENT_TOOL_MAP[verb]
    if (toolName) {
      // Extract the remaining text as context
      const context = words.slice(1).join(" ")
      steps.push({
        title: segment.charAt(0).toUpperCase() + segment.slice(1),
        toolName,
        toolInput: context ? { query: context } : undefined,
        timeoutMs: 30000,
        maxRetries: 2,
      })
    } else {
      // Unknown verb — use as a descriptive step with investigate as fallback
      steps.push({
        title: segment.charAt(0).toUpperCase() + segment.slice(1),
        toolName: "investigate_codebase",
        toolInput: { query: segment },
        timeoutMs: 30000,
        maxRetries: 2,
      })
    }
  }

  return steps
}

/**
 * Build a linear chain from parsed steps.
 * Each step depends on the previous step's completion.
 */
export function buildLinearChain(
  steps: ChainStep[],
  originalIntent: string,
): ChainBuildResult {
  if (steps.length === 0) {
    return {
      status: "invalid_steps",
      message: "No valid steps could be parsed from the voice intent. Please describe the steps more clearly.",
    }
  }

  if (steps.length > 10) {
    return {
      status: "invalid_steps",
      message: `Too many steps (${steps.length}). Maximum is 10. Please simplify the workflow.`,
    }
  }

  // Build DAG nodes with linear dependencies
  const nodes: DAGNode[] = steps.map((step, i) => ({
    order: i,
    title: step.title,
    nodeType: "tool_exec" as const,
    toolName: step.toolName,
    toolInput: step.toolInput || {},
    status: "PENDING" as const,
    dependencies: i === 0 ? [] : [steps[i - 1].title],
    maxRetries: step.maxRetries ?? 2,
    retryCount: 0,
    timeoutMs: step.timeoutMs ?? 30000,
  }))

  const chainId = `chain_${Date.now()}`
  const chain: LinearChain = {
    id: chainId,
    steps,
    originalIntent,
    createdAt: new Date().toISOString(),
  }

  const dag: DAGDefinition = {
    id: chainId,
    nodes,
    createdAt: chain.createdAt,
  }

  return {
    status: "built",
    chain,
    dag,
    message: `Linear chain built with ${steps.length} steps: ${steps.map((s) => s.title).join(" → ")}`,
  }
}

/**
 * Execute a linear chain using the DAG engine.
 * Wraps executeDAG with voice-friendly callbacks.
 */
export async function executeChain(
  dag: DAGDefinition,
  orchestratorId: string,
  executeDAGFn: (id: string, dag: DAGDefinition, callbacks: ExecutionCallbacks) => Promise<DAGResult>,
  options?: {
    onStepStart?: (stepIndex: number, title: string) => void
    onStepComplete?: (stepIndex: number, title: string, output: string) => void
    onStepFail?: (stepIndex: number, title: string, error: string) => void
    onComplete?: (result: DAGResult) => void
  },
): Promise<DAGResult> {
  const stepIndexMap = new Map(dag.nodes.map((n, i) => [n.title, i]))

  const callbacks: ExecutionCallbacks = {
    onNodeStart: (node) => {
      const idx = stepIndexMap.get(node.title) ?? 0
      options?.onStepStart?.(idx, node.title)
    },
    onNodeComplete: (node) => {
      const idx = stepIndexMap.get(node.title) ?? 0
      options?.onStepComplete?.(idx, node.title, node.toolOutput || "")
    },
    onNodeFail: (node, error) => {
      const idx = stepIndexMap.get(node.title) ?? 0
      options?.onStepFail?.(idx, node.title, error)
    },
    onApprovalRequired: async () => "approved", // Auto-approve for voice chains
    onBroadcast: () => {}, // No-op for voice
    onLog: () => {}, // No-op for voice
    onCausalGraphUpdate: () => {}, // No-op for voice
  }

  const result = await executeDAGFn(orchestratorId, dag, callbacks)
  options?.onComplete?.(result)
  return result
}

/**
 * Format a chain for display to the user (spoken or text).
 */
export function formatChainForDisplay(chain: LinearChain): string {
  const lines = [`Workflow: ${chain.steps.length} steps`]
  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i]
    const prefix = i === chain.steps.length - 1 ? "└" : "├"
    lines.push(`  ${prefix} Step ${i + 1}: ${step.title}`)
  }
  return lines.join("\n")
}
