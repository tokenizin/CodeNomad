/**
 * Background Process Producer — maps background process terminal events to NotifyEvents.
 *
 * Called by the BackgroundProcessManager when a process completes, fails, or is cancelled.
 * Publishes a `notify.create` event via EventBus for the notifications system to pick up.
 */

import { randomUUID } from 'node:crypto'
import type { EventBus } from '../../events/bus'
import type { BackgroundProcess } from '../../api-types'
import type { NotifyEvent, NotifyCategory, NotifyPriority, NotifySeverity } from '../types'

// ==================== Status → NotifyEvent Mapping ====================

interface NotifyMapping {
  category: NotifyCategory
  priority: NotifyPriority
  severity: NotifySeverity
}

function getMappingForProcess(process: BackgroundProcess): NotifyMapping | null {
  const { status, terminalReason } = process

  // Only terminal statuses produce notifications
  if (status === 'running') return null

  // Map terminal statuses
  if (status === 'error' || terminalReason === 'failed') {
    return { category: 'error', priority: 'high', severity: 'critical' }
  }

  if (status === 'stopped') {
    if (terminalReason === 'finished') {
      return { category: 'success_progress', priority: 'normal', severity: 'info' }
    }
    // user_stopped, user_terminated → cancelled
    return { category: 'task_status', priority: 'low', severity: 'warning' }
  }

  return null
}

/**
 * Build a NotifyEvent from a BackgroundProcess and its terminal status.
 * Publishes `notify.create` via EventBus if the status is terminal.
 *
 * @param process - The completed/errored background process
 * @param instanceId - The workspace/instance ID
 * @param eventBus - The EventBus to publish on
 * @returns The published NotifyEvent, or undefined if no event was published
 */
export function maybeNotifyOnProcessEvent(
  process: BackgroundProcess,
  instanceId: string,
  eventBus: EventBus,
): NotifyEvent | undefined {
  const mapping = getMappingForProcess(process)
  if (!mapping) return undefined

  const notifyEvent: NotifyEvent = {
    id: randomUUID(),
    instanceId,
    source: 'background_process',
    category: mapping.category,
    priority: mapping.priority,
    severity: mapping.severity,
    eventType: `background.process.${process.status}`,
    title: process.title,
    message: `Background process "${process.title}" ${process.status}${process.terminalReason ? ` (${process.terminalReason})` : ''}`,
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
