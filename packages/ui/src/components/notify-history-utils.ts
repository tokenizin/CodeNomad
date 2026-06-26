/**
 * Pure utility functions for the NotifyHistoryPanel component.
 *
 * Separated from the component to allow testing without SolidJS/lucide runtime.
 */
import type { NotifyEvent, NotifyCategory, NotifyPriority, NotifySeverity } from "../types/notify"

// ==================== Types ====================

/** Filter type union for the active filter signal */
export type NotifyPanelFilter = "all" | NotifyCategory | NotifyPriority | NotifySeverity

export interface DateGroup {
  key: string
  labelKey: string
  events: NotifyEvent[]
}

// ==================== Constants ====================

/** Category color mapping */
export const CATEGORY_COLORS: Record<NotifyCategory, string> = {
  session: "#4a90d9",
  task: "#7c4dff",
  milestone: "#00c853",
  permission: "#ff6d00",
  help_required: "#ff1744",
  escalation: "#d50000",
  broadcast: "#00bcd4",
  question: "#aa00ff",
  system: "#78909c",
  error: "#d32f2f",
  success_progress: "#2e7d32",
  task_status: "#1565c0",
  session_alert: "#e65100",
  workaround_suggested: "#f9a825",
  mitigation_applied: "#00897b",
}

/** Category display labels — fills missing entries from NOTIFY_CATEGORY_LABELS */
export const PANEL_CATEGORY_LABELS: Record<NotifyCategory, string> = {
  session: "Session",
  task: "Task",
  milestone: "Milestone",
  permission: "Permission",
  help_required: "Help Required",
  escalation: "Escalation",
  broadcast: "Broadcast",
  question: "Question",
  system: "System",
  error: "Error",
  success_progress: "Success Progress",
  task_status: "Task Status",
  session_alert: "Session Alert",
  workaround_suggested: "Workaround",
  mitigation_applied: "Mitigation",
}

// ==================== Utilities ====================

/**
 * Format time display
 *
 * @param timestamp - Timestamp
 * @returns Formatted time string
 */
export function formatNotifyTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/**
 * Get date group key
 *
 * @param timestamp - Timestamp
 * @returns Group key (today|yesterday|earlier)
 */
export function getDateGroup(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  const isSameDay = (d1: Date, d2: Date) =>
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()

  if (isSameDay(date, today)) {
    return "today"
  } else if (isSameDay(date, yesterday)) {
    return "yesterday"
  } else {
    return "earlier"
  }
}

/**
 * Check if event starts a new day group
 *
 * @param current - Current event
 * @param previous - Previous event (undefined for first)
 * @returns Whether it is a new day
 */
export function isNewDayGroup(current: NotifyEvent, previous: NotifyEvent | undefined): boolean {
  if (!previous) return true
  return getDateGroup(current.createdAt) !== getDateGroup(previous.createdAt)
}

/**
 * Group notify events by date (today / yesterday / earlier)
 *
 * @param events - Sorted notify events
 * @returns Groups with date group keys
 */
export function groupNotifyEventsByDate(events: NotifyEvent[]): DateGroup[] {
  const groups: DateGroup[] = []
  let currentGroup: DateGroup | null = null

  for (const event of events) {
    const dateGroup = getDateGroup(event.createdAt)

    if (!currentGroup || currentGroup.key !== dateGroup) {
      currentGroup = {
        key: dateGroup,
        labelKey: `notifyHistory.${dateGroup}`,
        events: [],
      }
      groups.push(currentGroup)
    }

    currentGroup.events.push(event)
  }

  return groups
}

/**
 * Map a NotifyCategory to its display label
 */
export function getCategoryLabel(category: NotifyCategory): string {
  return PANEL_CATEGORY_LABELS[category] ?? category
}

/**
 * Map a NotifyPriority to its display label
 */
export function getPriorityLabel(priority: NotifyPriority): string {
  const labels: Record<NotifyPriority, string> = {
    low: "Low",
    normal: "Normal",
    high: "High",
    urgent: "Urgent",
  }
  return labels[priority] ?? priority
}

/**
 * Map a NotifySeverity to its display label
 */
export function getSeverityLabel(severity: NotifySeverity): string {
  const labels: Record<NotifySeverity, string> = {
    info: "Info",
    success: "Success",
    warning: "Warning",
    error: "Error",
    critical: "Critical",
  }
  return labels[severity] ?? severity
}
