/**
 * NotifyEvent types — mirrored on the server for the categorized notification system.
 *
 * Mirrors `packages/ui/src/types/notify.ts` without UI-specific helpers (localStorage, signals).
 * Server producers use these types to emit events into NotifyRegistry.
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
  level: number
  fromAgent?: string
  toAgent?: string
  reason: string
  ttlMs?: number
}

/** Action that a user can take on a notification */
export interface NotifyAction {
  id: string
  label: string
  href?: string
  command?: string
  choiceValue?: string
  variant?: NotifyActionVariant
}

/** Optional success progress tracker */
export interface NotifySuccessProgress {
  current: number
  total: number
  unit?: string
}

// ==================== Main Event Interface ====================

/** A single categorized notification event */
export interface NotifyEvent {
  id: string
  instanceId: string
  sessionId?: string
  taskId?: string

  source: NotifySource
  category: NotifyCategory
  priority: NotifyPriority
  severity: NotifySeverity
  eventType: string

  title: string
  message: string

  escalation?: NotifyEscalation
  mitigate?: string
  workaround?: string
  helpRequired?: boolean
  successProgress?: NotifySuccessProgress

  actions?: NotifyAction[]
  metadata?: Record<string, unknown>

  createdAt: number
  read: boolean
  ackedAt?: number
  escalatedAt?: number
  ttlMs?: number

  schemaVersion: 1
}

// ==================== Filter Type ====================

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
