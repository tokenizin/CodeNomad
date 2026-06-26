/**
 * Orchestrator DAG Producer — maps orchestrator onLog() events to NotifyEvents.
 *
 * Called by the orchestrator DAG engine's onLog callback whenever a DAG execution event occurs.
 * Publishes a `notify.create` event via EventBus for the notifications system to pick up.
 */

import { randomUUID } from 'node:crypto'
import type { EventBus } from '../../events/bus'
import type { NotifyEvent, NotifyCategory, NotifyPriority, NotifySeverity } from '../types'

// ==================== Event Type → Notify Mapping ====================

interface NotifyMapping {
  category: NotifyCategory
  /** Default priority (can be overridden by severity) */
  priority: NotifyPriority
}

/**
 * Maps orchestrator event type to a base NotifyCategory and NotifyPriority.
 * Severity is derived from the severity string passed to onLog().
 */
function getMappingForEventType(eventType: string): NotifyMapping {
  switch (eventType) {
    case 'NODE_FAILED':
    case 'ERROR':
      return { category: 'error', priority: 'high' }
    case 'NODE_COMPLETED':
    case 'WORKFLOW_COMPLETED':
      return { category: 'success_progress', priority: 'normal' }
    case 'NODE_RETRY':
      return { category: 'workaround_suggested', priority: 'normal' }
    case 'HEALING_ACTION':
      return { category: 'mitigation_applied', priority: 'normal' }
    case 'NODE_STARTED':
      return { category: 'task_status', priority: 'low' }
    case 'BROADCAST_SENT':
      return { category: 'broadcast', priority: 'low' }
    default:
      return { category: 'system', priority: 'normal' }
  }
}

/**
 * Maps orchestrator severity string to NotifySeverity.
 */
function mapSeverity(severity: string): NotifySeverity {
  switch (severity.toUpperCase()) {
    case 'CRITICAL':
      return 'critical'
    case 'ERROR':
      return 'error'
    case 'WARN':
    case 'WARNING':
      return 'warning'
    case 'SUCCESS':
      return 'success'
    case 'INFO':
    default:
      return 'info'
  }
}

/**
 * Build a NotifyEvent from an orchestrator DAG onLog() call.
 * Publishes `notify.create` via EventBus.
 *
 * @param eventType - DAG event type (NODE_FAILED, NODE_COMPLETED, WORKFLOW_COMPLETED, etc.)
 * @param severity - Severity string from DAG (ERROR, WARN, INFO, CRITICAL)
 * @param title - Event title from DAG
 * @param metadata - Optional metadata from DAG
 * @param instanceId - The workspace/instance ID
 * @param eventBus - The EventBus to publish on
 * @returns The published NotifyEvent
 */
export function createNotifyFromOrchestratorLog(
  eventType: string,
  severity: string,
  title: string,
  metadata: Record<string, unknown> | undefined,
  instanceId: string,
  eventBus: EventBus,
): NotifyEvent {
  const mapping = getMappingForEventType(eventType)
  const resolvedSeverity = mapSeverity(severity)
  const message = metadata?.error
    ? `${title}: ${String(metadata.error)}`
    : title

  const notifyEvent: NotifyEvent = {
    id: randomUUID(),
    instanceId,
    source: 'orchestrator',
    category: mapping.category,
    priority: mapping.priority,
    severity: resolvedSeverity,
    eventType,
    title,
    message,
    metadata: metadata as Record<string, unknown> | undefined,
    createdAt: Date.now(),
    read: false,
    schemaVersion: 1,
  }

  eventBus.publish({
    type: 'instance.event',
    instanceId,
    event: {
      type: 'notify.create',
      properties: { event: notifyEvent },
    },
  })

  return notifyEvent
}
