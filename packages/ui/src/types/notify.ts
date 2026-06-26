/**
 * Categorized notification event types — shared between UI and server.
 *
 * Designed to replace the legacy 4-variant ToastVariant with a rich
 * 9-category, 4-priority, 5-severity schema that carries escalation,
 * mitigation, workaround, help-required, and success-progress metadata.
 */

// ==================== Enum-Like String Unions ====================

/** Event source — identifies the producer */
export type NotifySource =
  | 'orchestrator'
  | 'background_process'
  | 'session'
  | 'permission'
  | 'manual'
  | 'tui'
  | 'system'

/** Category — user-facing classification */
export type NotifyCategory =
  | 'session'
  | 'task'
  | 'milestone'
  | 'permission'
  | 'help_required'
  | 'escalation'
  | 'broadcast'
  | 'question'
  | 'system'
  | 'error'
  | 'success_progress'
  | 'task_status'
  | 'session_alert'
  | 'workaround_suggested'
  | 'mitigation_applied'

/** Priority — user-attention level */
export type NotifyPriority = 'low' | 'normal' | 'high' | 'urgent'

/** Severity — visual/impact level */
export type NotifySeverity = 'info' | 'success' | 'warning' | 'error' | 'critical'

/** Action variant for UI rendering */
export type NotifyActionVariant = 'primary' | 'secondary' | 'danger'

// ==================== Sub-Interfaces ====================

/** Escalation metadata — set when a notification is bumped to a higher tier */
export interface NotifyEscalation {
  /** Escalation level (1, 2, 3…) */
  level: number
  /** Name of the agent/entity that escalated */
  fromAgent?: string
  /** Name of the agent/entity being escalated to */
  toAgent?: string
  /** Human-readable reason for escalation */
  reason: string
  /** Auto-escalate if not acknowledged within this many ms */
  ttlMs?: number
}

/** Action that a user can take on a notification */
export interface NotifyAction {
  /** Unique action ID within the notification */
  id: string
  /** Display label for the action button */
  label: string
  /** Navigate to URL/route */
  href?: string
  /** Insert this command into the prompt input */
  command?: string
  /** Send as a chat.choice.replied value */
  choiceValue?: string
  /** Visual variant for the action button */
  variant?: NotifyActionVariant
}

/** Optional success progress tracker */
export interface NotifySuccessProgress {
  /** Current value (e.g. 3 of 5 steps) */
  current: number
  /** Total value */
  total: number
  /** Optional unit label (e.g. "steps", "files", "MB") */
  unit?: string
}

// ==================== Main Event Interface ====================

/** A single categorized notification event */
export interface NotifyEvent {
  /** Unique identifier (crypto.randomUUID()) */
  id: string
  /** CodeNomad instance this notification belongs to */
  instanceId: string
  /** Optional session this notification is related to */
  sessionId?: string
  /** Optional background task ID */
  taskId?: string

  /** Producer source */
  source: NotifySource
  /** User-facing category */
  category: NotifyCategory
  /** User-attention priority */
  priority: NotifyPriority
  /** Visual severity level */
  severity: NotifySeverity
  /** Machine-readable event type (e.g. "NODE_FAILED", "TASK_COMPLETED") */
  eventType: string

  /** Short notification title */
  title: string
  /** Longer notification body */
  message: string

  /** Escalation metadata (set when escalated) */
  escalation?: NotifyEscalation
  /** Suggested mitigation steps */
  mitigate?: string
  /** Suggested workaround */
  workaround?: string
  /** Whether user help is required to proceed */
  helpRequired?: boolean
  /** Optional success progress tracker */
  successProgress?: NotifySuccessProgress

  /** Action buttons the user can take */
  actions?: NotifyAction[]
  /** Arbitrary metadata from the producer */
  metadata?: Record<string, unknown>

  /** Epoch ms when this notification was created */
  createdAt: number
  /** Whether the user has read/dismissed this */
  read: boolean
  /** Epoch ms when the user acknowledged this */
  ackedAt?: number
  /** Epoch ms when this was escalated */
  escalatedAt?: number
  /** Auto-expire TTL in ms from createdAt */
  ttlMs?: number

  /** Schema version for persistence migration */
  schemaVersion: 1
}

// ==================== Filter Types ====================

/** Filter options for querying notifications */
export interface NotifyFilter {
  category?: NotifyCategory | NotifyCategory[]
  priority?: NotifyPriority | NotifyPriority[]
  severity?: NotifySeverity | NotifySeverity[]
  eventType?: string
  eventTypePattern?: string
  source?: NotifySource | NotifySource[]
  helpRequired?: boolean
  escalationOnly?: boolean
  since?: number
  until?: number
  unreadOnly?: boolean
  limit?: number
  offset?: number
}

// ==================== WS Envelope Types ====================

/** Server → client WS event envelopes for notification changes */
export type NotifyWsEnvelope =
  | { type: 'notify.create'; properties: { event: NotifyEvent } }
  | { type: 'notify.update'; properties: { id: string; instanceId: string; patch: Partial<NotifyEvent> } }
  | { type: 'notify.remove'; properties: { id: string; instanceId: string } }

// ==================== Helper Functions ====================

/** Category display labels */
export const NOTIFY_CATEGORY_LABELS: Record<NotifyCategory, string> = {
  session: 'Session',
  task: 'Task',
  milestone: 'Milestone',
  permission: 'Permission',
  help_required: 'Help Required',
  escalation: 'Escalation',
  broadcast: 'Broadcast',
  question: 'Question',
  system: 'System',
  error: 'Error',
  success_progress: 'Success Progress',
  task_status: 'Task Status',
  session_alert: 'Session Alert',
  workaround_suggested: 'Workaround',
  mitigation_applied: 'Mitigation',
}

/** Priority display labels */
export const NOTIFY_PRIORITY_LABELS: Record<NotifyPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

/** Severity display labels */
export const NOTIFY_SEVERITY_LABELS: Record<NotifySeverity, string> = {
  info: 'Info',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
  critical: 'Critical',
}

/** Priority sort order (higher = more important) */
export const NOTIFY_PRIORITY_ORDER: Record<NotifyPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
}

/** Severity sort order (higher = more severe) */
export const NOTIFY_SEVERITY_ORDER: Record<NotifySeverity, number> = {
  info: 0,
  success: 1,
  warning: 2,
  error: 3,
  critical: 4,
}

/** Priority → legacy ToastVariant for migration bridging */
export const NOTIFY_PRIORITY_TO_VARIANT: Record<NotifyPriority, string> = {
  low: 'info',
  normal: 'info',
  high: 'warning',
  urgent: 'error',
}

/** Severity → legacy ToastVariant for migration bridging */
export const NOTIFY_SEVERITY_TO_VARIANT: Record<NotifySeverity, string> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
  critical: 'error',
}

/**
 * Sort comparator: priority descending, then severity descending, then createdAt descending.
 * Returns -1 if a should sort before b, 1 if after, 0 if equal.
 */
export function compareNotifyEvents(a: NotifyEvent, b: NotifyEvent): number {
  const pDiff = NOTIFY_PRIORITY_ORDER[b.priority] - NOTIFY_PRIORITY_ORDER[a.priority]
  if (pDiff !== 0) return pDiff
  const sDiff = NOTIFY_SEVERITY_ORDER[b.severity] - NOTIFY_SEVERITY_ORDER[a.severity]
  if (sDiff !== 0) return sDiff
  return b.createdAt - a.createdAt
}

/**
 * Apply a filter to a list of notify events, returning matching results
 * sorted by priority desc → severity desc → createdAt desc.
 */
export function filterNotifyEvents(events: NotifyEvent[], filter?: NotifyFilter): NotifyEvent[] {
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

  // Sort
  result.sort(compareNotifyEvents)

  // Paginate
  if (filter?.offset && filter.offset > 0) {
    result = result.slice(filter.offset)
  }

  if (filter?.limit && filter.limit > 0) {
    result = result.slice(0, filter.limit)
  }

  return result
}

/**
 * Check whether a NotifyEvent has expired based on its ttlMs.
 */
export function isNotifyEventExpired(event: NotifyEvent, now: number = Date.now()): boolean {
  if (!event.ttlMs) return false
  return now - event.createdAt > event.ttlMs
}

/**
 * Generate a unique ID for a notification.
 */
export function generateNotifyId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback for environments without crypto.randomUUID
  return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
}

// ==================== Chat Choice Types ====================

/** A single choice option presented to the user */
export interface ChatChoiceOption {
  label: string
  value: string
}

/** Payload for chat.choice.asked event */
export interface ChatChoiceAskedPayload {
  id: string
  choices: ChatChoiceOption[]
  /** Allow multiple selections (default false) */
  multiple?: boolean
  /** Optional title/context heading */
  title?: string
  /** Auto-dismiss timeout in seconds */
  timeout?: number
}

/** Payload for chat.choice.replied event */
export interface ChatChoiceRepliedPayload {
  id: string
  value: string | string[]
}

/** Payload for chat.choice.expired event */
export interface ChatChoiceExpiredPayload {
  id: string
}
