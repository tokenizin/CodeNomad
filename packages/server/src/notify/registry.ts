/**
 * NotifyRegistry — In-memory notification registry with TTL expiry, LRU cap,
 * and optional WS broadcast callback.
 *
 * Each CodeNomad instance has its own event list. The registry provides
 * register/update/remove/list operations and calls a registered broadcast
 * callback when state changes so the caller can push WS envelopes.
 */

import { randomUUID } from 'node:crypto'
import type {
  NotifyEvent,
  NotifyWsEnvelope,
  NotifyPriority,
  NotifySeverity,
  NotifyCategory,
  NotifySource,
  NotifyFilter,
} from './types'

// ==================== Constants ====================

/** Default max events per instance before LRU eviction */
export const REGISTRY_INSTANCE_CAP = 500

/** Default TTL for events (7 days in ms) */
export const REGISTRY_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000

// ==================== Type-Level Severity/Priority Defaults ====================

export const NOTIFY_EVENT_SEVERITY: Record<string, NotifySeverity> = {
  SESSION_IDLE: 'info',
  SESSION_ERROR: 'error',
  SESSION_COMPACTED: 'warning',
  NODE_STARTED: 'info',
  NODE_COMPLETED: 'success',
  NODE_FAILED: 'error',
  NODE_RETRY: 'warning',
  TASK_COMPLETED: 'success',
  TASK_FAILED: 'error',
  MILESTONE_REACHED: 'success',
  HEALING_ACTION: 'warning',
  BROADCAST_SENT: 'info',
  WORKFLOW_COMPLETED: 'success',
  ESCALATION_RECOMMENDED: 'critical',
}

export const NOTIFY_EVENT_PRIORITY: Record<string, NotifyPriority> = {
  SESSION_IDLE: 'low',
  SESSION_ERROR: 'high',
  SESSION_COMPACTED: 'normal',
  NODE_STARTED: 'low',
  NODE_COMPLETED: 'normal',
  NODE_FAILED: 'high',
  NODE_RETRY: 'normal',
  TASK_COMPLETED: 'normal',
  TASK_FAILED: 'high',
  MILESTONE_REACHED: 'normal',
  HEALING_ACTION: 'normal',
  BROADCAST_SENT: 'low',
  WORKFLOW_COMPLETED: 'normal',
  ESCALATION_RECOMMENDED: 'urgent',
}

// ==================== Sort Helpers ====================

const PRIORITY_ORDER: Record<NotifyPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
}

const SEVERITY_ORDER: Record<NotifySeverity, number> = {
  info: 0,
  success: 1,
  warning: 2,
  error: 3,
  critical: 4,
}

function compareNotifyEvents(a: NotifyEvent, b: NotifyEvent): number {
  const pDiff = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]
  if (pDiff !== 0) return pDiff
  const sDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]
  if (sDiff !== 0) return sDiff
  return b.createdAt - a.createdAt
}

// ==================== Filter Helpers ====================

function applyFilter(events: NotifyEvent[], filter?: NotifyFilter): NotifyEvent[] {
  let result = events

  if (filter?.unreadOnly) {
    result = result.filter((e) => !e.read)
  }
  if (filter?.category) {
    const cats = Array.isArray(filter.category) ? filter.category : [filter.category]
    result = result.filter((e) => cats.includes(e.category))
  }
  if (filter?.priority) {
    const prios = Array.isArray(filter.priority) ? filter.priority : [filter.priority]
    result = result.filter((e) => prios.includes(e.priority))
  }
  if (filter?.severity) {
    const sevs = Array.isArray(filter.severity) ? filter.severity : [filter.severity]
    result = result.filter((e) => sevs.includes(e.severity))
  }
  if (filter?.source) {
    const sources = Array.isArray(filter.source) ? filter.source : [filter.source]
    result = result.filter((e) => sources.includes(e.source))
  }
  if (filter?.eventType) {
    result = result.filter((e) => e.eventType === filter.eventType)
  }
  if (filter?.eventTypePattern) {
    const re = new RegExp(filter.eventTypePattern, 'i')
    result = result.filter((e) => re.test(e.eventType))
  }
  if (filter?.helpRequired !== undefined) {
    result = result.filter((e) => e.helpRequired === filter.helpRequired)
  }
  if (filter?.escalationOnly) {
    result = result.filter((e) => e.escalation !== undefined)
  }
  if (filter?.since !== undefined) {
    result = result.filter((e) => e.createdAt >= filter.since!)
  }
  if (filter?.until !== undefined) {
    result = result.filter((e) => e.createdAt <= filter.until!)
  }

  result.sort(compareNotifyEvents)

  if (filter?.offset && filter.offset > 0) {
    result = result.slice(filter.offset)
  }
  if (filter?.limit && filter.limit > 0) {
    result = result.slice(0, filter.limit)
  }

  return result
}

// ==================== Registry ====================

export type NotifyBroadcastFn = (envelope: NotifyWsEnvelope) => void

export class NotifyRegistry {
  /** Instance-scoped event storage: Map<instanceId, NotifyEvent[]> */
  private readonly instances = new Map<string, NotifyEvent[]>()

  /** Max events per instance before LRU eviction */
  private readonly cap: number

  /** Default TTL for new events (ms) */
  private readonly defaultTtlMs: number

  /** Optional broadcast callback for WS push */
  private broadcastFn: NotifyBroadcastFn | null = null

  constructor(options?: { cap?: number; defaultTtlMs?: number }) {
    this.cap = options?.cap ?? REGISTRY_INSTANCE_CAP
    this.defaultTtlMs = options?.defaultTtlMs ?? REGISTRY_DEFAULT_TTL_MS
  }

  // ==================== Broadcast Wiring ====================

  /** Set the broadcast callback. Only one callback at a time. */
  setBroadcast(fn: NotifyBroadcastFn | null): void {
    this.broadcastFn = fn
  }

  /** Get the current broadcast callback (for testing). */
  getBroadcastFn(): NotifyBroadcastFn | null {
    return this.broadcastFn
  }

  private broadcast(envelope: NotifyWsEnvelope): void {
    this.broadcastFn?.(envelope)
  }

  // ==================== Event Lifecycle ====================

  /**
   * Register a new notification event.
   * Automatically sets default severity/priority from eventType, applies TTL,
   * trims to LRU cap, and broadcasts notify.create.
   *
   * @param event - Partial event; `id`, `createdAt`, and `schemaVersion` are auto-filled if missing.
   * @returns The fully resolved event that was stored.
   */
  register(event: Partial<NotifyEvent> & { instanceId: string; title: string; message: string }): NotifyEvent {
    const now = Date.now()
    const resolved: NotifyEvent = {
      id: event.id ?? randomUUID(),
      instanceId: event.instanceId,
      sessionId: event.sessionId,
      taskId: event.taskId,
      source: event.source ?? 'manual',
      category: event.category ?? 'session',
      priority: event.priority ?? NOTIFY_EVENT_PRIORITY[event.eventType ?? ''] ?? 'normal',
      severity: event.severity ?? NOTIFY_EVENT_SEVERITY[event.eventType ?? ''] ?? 'info',
      eventType: event.eventType ?? 'MANUAL',
      title: event.title,
      message: event.message,
      escalation: event.escalation,
      mitigate: event.mitigate,
      workaround: event.workaround,
      helpRequired: event.helpRequired,
      successProgress: event.successProgress,
      actions: event.actions,
      metadata: event.metadata,
      createdAt: event.createdAt ?? now,
      read: false,
      ackedAt: event.ackedAt,
      escalatedAt: event.escalatedAt,
      ttlMs: event.ttlMs ?? this.defaultTtlMs,
      schemaVersion: 1,
    }

    const list = this.getInstanceEvents(resolved.instanceId)
    list.unshift(resolved)
    this.trimInstance(resolved.instanceId)
    this.broadcast({ type: 'notify.create', properties: { event: resolved } })
    return resolved
  }

  /**
   * Update an existing event by id.
   * Broadcasts notify.update. Returns undefined if not found.
   */
  update(instanceId: string, id: string, patch: Partial<NotifyEvent>): NotifyEvent | undefined {
    const list = this.instances.get(instanceId)
    if (!list) return undefined
    const index = list.findIndex((e) => e.id === id)
    if (index === -1) return undefined
    list[index] = { ...list[index], ...patch, id: list[index].id }
    this.broadcast({ type: 'notify.update', properties: { id, instanceId, patch } })
    return list[index]
  }

  /**
   * Remove an event by id.
   * Broadcasts notify.remove. Returns true if found and removed.
   */
  remove(instanceId: string, id: string): boolean {
    const list = this.instances.get(instanceId)
    if (!list) return false
    const index = list.findIndex((e) => e.id === id)
    if (index === -1) return false
    list.splice(index, 1)
    if (list.length === 0) {
      this.instances.delete(instanceId)
    }
    this.broadcast({ type: 'notify.remove', properties: { id, instanceId } })
    return true
  }

  /**
   * Purge all events for an instance.
   */
  clear(instanceId: string): void {
    const list = this.instances.get(instanceId)
    if (!list) return
    this.instances.delete(instanceId)
    for (const event of list) {
      this.broadcast({ type: 'notify.remove', properties: { id: event.id, instanceId } })
    }
  }

  // ==================== Query ====================

  /**
   * List events for an instance, with optional filtering and sorting.
   * Does NOT broadcast — this is a read operation.
   */
  list(instanceId: string, filter?: NotifyFilter): NotifyEvent[] {
    const events = this.instances.get(instanceId)
    if (!events) return []
    // Prune expired before listing
    const pruned = this.pruneExpired(instanceId, events)
    return applyFilter(pruned, filter)
  }

  /**
   * Get a single event by id.
   */
  get(instanceId: string, id: string): NotifyEvent | undefined {
    return this.instances.get(instanceId)?.find((e) => e.id === id)
  }

  /**
   * Get all known instance IDs.
   */
  getKnownInstances(): string[] {
    return Array.from(this.instances.keys())
  }

  // ==================== Internal Helpers ====================

  private getInstanceEvents(instanceId: string): NotifyEvent[] {
    let list = this.instances.get(instanceId)
    if (!list) {
      list = []
      this.instances.set(instanceId, list)
    }
    return list
  }

  /** Trim events for an instance to the LRU cap (newest first). */
  private trimInstance(instanceId: string): void {
    const list = this.instances.get(instanceId)
    if (!list || list.length <= this.cap) return
    list.sort(compareNotifyEvents)
    list.splice(this.cap)
  }

  /** Remove expired events from an instance's list. Returns pruned list. */
  private pruneExpired(instanceId: string, events: NotifyEvent[]): NotifyEvent[] {
    const now = Date.now()
    const alive = events.filter((e) => {
      if (!e.ttlMs) return true
      return now - e.createdAt <= e.ttlMs
    })
    if (alive.length !== events.length) {
      if (alive.length === 0) {
        this.instances.delete(instanceId)
      } else {
        this.instances.set(instanceId, alive)
      }
    }
    return alive
  }

  /**
   * Get total count of stored events across all instances (for metrics).
   */
  getTotalEventCount(): number {
    let count = 0
    for (const list of this.instances.values()) {
      count += list.length
    }
    return count
  }

  /**
   * Get instance count (for metrics).
   */
  getInstanceCount(): number {
    return this.instances.size
  }
}
