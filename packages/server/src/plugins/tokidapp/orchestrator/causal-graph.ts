/**
 * Causal Graph Manager for TokiDAPP Orchestrator.
 *
 * Maintains in-memory causal inference state during DAG execution.
 * Emits causal graph updates that are forwarded to the client via WebSocket.
 *
 * Inspired by LuaN1aoAgent's GraphManager.causal_graph (networkx DiGraph)
 * with node types: Evidence -> Hypothesis -> Vulnerability -> Exploit -> AttackGoal
 */

export type CausalNodeType = 'Evidence' | 'Hypothesis' | 'Vulnerability' | 'Exploit' | 'AttackGoal'

export type CausalEdgeType = 'SUPPORTS' | 'CONTRADICTS' | 'REVEALS' | 'EXPLOITS' | 'ENABLES' | 'REQUIRES'

export interface CausalNode {
  id: string
  nodeType: CausalNodeType
  label: string
  description?: string
  confidence?: number
  status?: string
  evidence?: string
  vulnerability?: string
  sourceStepId?: string
}

export interface CausalEdge {
  sourceId: string
  targetId: string
  label: CausalEdgeType
  description?: string
}

export interface CausalGraphState {
  nodes: CausalNode[]
  edges: CausalEdge[]
}

type CausalUpdateListener = (nodes: CausalNode[], edges: CausalEdge[]) => void

export class CausalGraphManager {
  private nodes: Map<string, CausalNode> = new Map()
  private edges: CausalEdge[] = []
  private listeners: Set<CausalUpdateListener> = new Set()

  addNode(node: CausalNode): void {
    this.nodes.set(node.id, node)
    this.emitUpdate()
  }

  addEdge(edge: CausalEdge): void {
    // Avoid duplicate edges
    const exists = this.edges.some(
      (e) => e.sourceId === edge.sourceId && e.targetId === edge.targetId && e.label === edge.label,
    )
    if (!exists) {
      this.edges.push(edge)
      this.emitUpdate()
    }
  }

  addEvidence(
    label: string,
    opts?: {
      description?: string
      confidence?: number
      sourceStepId?: string
    },
  ): CausalNode {
    const node: CausalNode = {
      id: `evidence-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      nodeType: 'Evidence',
      label,
      description: opts?.description,
      confidence: opts?.confidence ?? 1.0,
      sourceStepId: opts?.sourceStepId,
    }
    this.addNode(node)
    return node
  }

  addHypothesis(
    label: string,
    opts?: {
      description?: string
      confidence?: number
      sourceStepId?: string
      supportedBy?: string
    },
  ): CausalNode {
    const node: CausalNode = {
      id: `hypothesis-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      nodeType: 'Hypothesis',
      label,
      description: opts?.description,
      confidence: opts?.confidence ?? 0.5,
      sourceStepId: opts?.sourceStepId,
    }
    this.addNode(node)
    if (opts?.supportedBy) {
      this.addEdge({
        sourceId: opts.supportedBy,
        targetId: node.id,
        label: 'REVEALS',
      })
    }
    return node
  }

  addVulnerability(
    label: string,
    opts?: {
      description?: string
      confidence?: number
      sourceStepId?: string
      revealedBy?: string
    },
  ): CausalNode {
    const node: CausalNode = {
      id: `vuln-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      nodeType: 'Vulnerability',
      label,
      description: opts?.description,
      confidence: opts?.confidence ?? 0.8,
      sourceStepId: opts?.sourceStepId,
    }
    this.addNode(node)
    if (opts?.revealedBy) {
      this.addEdge({
        sourceId: opts.revealedBy,
        targetId: node.id,
        label: 'REVEALS',
      })
    }
    return node
  }

  addExploit(
    label: string,
    opts?: {
      description?: string
      confidence?: number
      sourceStepId?: string
      exploits?: string
    },
  ): CausalNode {
    const node: CausalNode = {
      id: `exploit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      nodeType: 'Exploit',
      label,
      description: opts?.description,
      confidence: opts?.confidence ?? 0.9,
      sourceStepId: opts?.sourceStepId,
    }
    this.addNode(node)
    if (opts?.exploits) {
      this.addEdge({
        sourceId: node.id,
        targetId: opts.exploits,
        label: 'EXPLOITS',
      })
    }
    return node
  }

  addAttackGoal(
    label: string,
    opts?: {
      description?: string
      sourceStepId?: string
      enabledBy?: string
    },
  ): CausalNode {
    const node: CausalNode = {
      id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      nodeType: 'AttackGoal',
      label,
      description: opts?.description,
      confidence: 1.0,
      sourceStepId: opts?.sourceStepId,
    }
    this.addNode(node)
    if (opts?.enabledBy) {
      this.addEdge({
        sourceId: opts.enabledBy,
        targetId: node.id,
        label: 'ENABLES',
      })
    }
    return node
  }

  /** Register a listener for update events. Returns an unsubscribe function. */
  onUpdate(listener: CausalUpdateListener): () => void {
    this.listeners.add(listener)
    // Immediately emit current state to new listener
    listener(this.getNodes(), this.getEdges())
    return () => {
      this.listeners.delete(listener)
    }
  }

  getNodes(): CausalNode[] {
    return Array.from(this.nodes.values())
  }

  getEdges(): CausalEdge[] {
    return [...this.edges]
  }

  getState(): CausalGraphState {
    return { nodes: this.getNodes(), edges: this.getEdges() }
  }

  clear(): void {
    this.nodes.clear()
    this.edges = []
  }

  private emitUpdate(): void {
    const nodes = this.getNodes()
    const edges = this.getEdges()
    for (const listener of this.listeners) {
      try {
        listener(nodes, edges)
      } catch {
        // Swallow listener errors to avoid breaking the graph manager
      }
    }
  }
}
