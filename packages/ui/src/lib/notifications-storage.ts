/**
 * Notifications persistence layer — localStorage-backed with LRU cap, TTL expiry,
 * schema versioning, and SSR-safe access.
 *
 * Keys: `codenomad:notifications:<instanceId>` (one key per instance).
 * Each value is a JSON-serialized NotifyStoragePayload.
 */

import { filterNotifyEvents, isNotifyEventExpired, compareNotifyEvents, generateNotifyId, type NotifyEvent, type NotifyFilter, type NotifyPriority, type NotifySeverity } from '../types/notify'

// ==================== Constants ====================

/** Current schema version — bump to invalidate stored data */
export const NOTIFY_STORAGE_SCHEMA_VERSION = 1

/** Storage key prefix */
export const NOTIFY_STORAGE_KEY_PREFIX = 'codenomad:notifications:'

/** Maximum events per instance (LRU cap) */
export const NOTIFY_STORAGE_CAP = 500

/** Default TTL for notifications (7 days in ms) */
export const NOTIFY_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Type-level severity defaults for category+event combinations */
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

/** Type-level priority defaults for category+event combinations */
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

// ==================== Storage Payload ====================

/** Shape of the serialized payload in localStorage */
export interface NotifyStoragePayload {
  schemaVersion: number
  instanceId: string
  events: NotifyEvent[]
  createdAt: number
  updatedAt: number
}

// ==================== SSR-Safe Helpers ====================

/** Check whether localStorage is available (SSR guard) */
function isLocalStorageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage !== null
  } catch {
    return false
  }
}

// ==================== Storage Key ====================

/** Build the localStorage key for a given instance */
export function storageKeyForInstance(instanceId: string): string {
  return `${NOTIFY_STORAGE_KEY_PREFIX}${instanceId}`
}

// ==================== Core Persistence ====================

function makePayload(instanceId: string, events: NotifyEvent[]): NotifyStoragePayload {
  return {
    schemaVersion: NOTIFY_STORAGE_SCHEMA_VERSION,
    instanceId,
    events,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * Load notifications from localStorage for a given instance.
 * Handles: SSR guard, missing key, schema version mismatch (drop+reseed with warning),
 * TTL expiry of individual events.
 *
 * Returns an empty array in any error condition.
 */
export function loadNotifications(instanceId: string): NotifyEvent[] {
  if (!isLocalStorageAvailable()) return []

  try {
    const key = storageKeyForInstance(instanceId)
    const raw = window.localStorage.getItem(key)
    if (!raw) return []

    const payload: NotifyStoragePayload = JSON.parse(raw)

    // Schema version mismatch → drop + reseed
    if (payload.schemaVersion !== NOTIFY_STORAGE_SCHEMA_VERSION) {
      console.warn(
        `[notifications-storage] schema version mismatch (stored: ${payload.schemaVersion}, current: ${NOTIFY_STORAGE_SCHEMA_VERSION}). Dropping stored data for instance "${instanceId}".`,
      )
      window.localStorage.removeItem(key)
      return []
    }

    let events = payload.events

    // Prune expired events
    const beforeCount = events.length
    events = events.filter((e) => !isNotifyEventExpired(e))
    if (events.length !== beforeCount) {
      // Persist the pruned list
      saveNotifications(instanceId, events)
    }

    return events
  } catch (error) {
    console.warn('[notifications-storage] failed to load notifications:', error)
    return []
  }
}

/**
 * Save notifications to localStorage for a given instance.
 * Trims to LRU cap before writing.
 * Silently ignores localStorage errors (quota exceeded, etc.).
 */
export function saveNotifications(instanceId: string, events: NotifyEvent[]): void {
  if (!isLocalStorageAvailable()) return

  try {
    const trimmed = trimToCapacity(events)
    const payload = makePayload(instanceId, trimmed)
    const key = storageKeyForInstance(instanceId)
    window.localStorage.setItem(key, JSON.stringify(payload))
  } catch (error) {
    console.warn('[notifications-storage] failed to save notifications:', error)
  }
}

/**
 * Remove stored notifications for a given instance.
 */
export function clearStoredNotifications(instanceId: string): void {
  if (!isLocalStorageAvailable()) return
  try {
    const key = storageKeyForInstance(instanceId)
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

// ==================== Event Mutations ====================

/**
 * Add a single event and persist.
 * Pre-pends to the front (newest first), trims to cap.
 *
 * @returns The full updated event list, or empty array on failure.
 */
export function addStoredNotification(instanceId: string, event: NotifyEvent): NotifyEvent[] {
  const events = loadNotifications(instanceId)
  events.unshift(event)
  saveNotifications(instanceId, events)
  return events
}

/**
 * Update an event in place (partial patch) and persist.
 *
 * @returns The updated event or undefined if not found.
 */
export function updateStoredNotification(
  instanceId: string,
  id: string,
  patch: Partial<NotifyEvent>,
): NotifyEvent | undefined {
  const events = loadNotifications(instanceId)
  const index = events.findIndex((e) => e.id === id)
  if (index === -1) return undefined

  events[index] = { ...events[index], ...patch, id: events[index].id }
  saveNotifications(instanceId, events)
  return events[index]
}

/**
 * Remove an event by id and persist.
 *
 * @returns true if the event was found and removed.
 */
export function removeStoredNotification(instanceId: string, id: string): boolean {
  const events = loadNotifications(instanceId)
  const index = events.findIndex((e) => e.id === id)
  if (index === -1) return false

  events.splice(index, 1)
  saveNotifications(instanceId, events)
  return true
}

/**
 * Ack an event: set read=true, ackedAt=now, and persist.
 *
 * @returns The updated event or undefined if not found.
 */
export function ackStoredNotification(instanceId: string, id: string): NotifyEvent | undefined {
  return updateStoredNotification(instanceId, id, { read: true, ackedAt: Date.now() })
}

/**
 * Escalate an event: bump escalation level (or create it), set escalatedAt, and persist.
 *
 * @returns The updated event or undefined if not found.
 */
export function escalateStoredNotification(
  instanceId: string,
  id: string,
  reason: string,
): NotifyEvent | undefined {
  const events = loadNotifications(instanceId)
  const index = events.findIndex((e) => e.id === id)
  if (index === -1) return undefined

  const event = events[index]
  const currentLevel = event.escalation?.level ?? 0
  events[index] = {
    ...event,
    escalation: {
      level: currentLevel + 1,
      reason,
      fromAgent: event.escalation?.toAgent,
    },
    escalatedAt: Date.now(),
  }
  saveNotifications(instanceId, events)
  return events[index]
}

/**
 * Get filtered, sorted notifications for an instance.
 * Returns events sorted by priority desc → severity desc → createdAt desc.
 */
export function queryStoredNotifications(instanceId: string, filter?: NotifyFilter): NotifyEvent[] {
  const events = loadNotifications(instanceId)
  return filterNotifyEvents(events, filter)
}

// ==================== Utility Functions ====================

/**
 * Trim events to the LRU capacity (keeps newest first, drops oldest when over cap).
 * Uses the existing sort order (newest first) and slices to cap.
 */
export function trimToCapacity(events: NotifyEvent[], cap: number = NOTIFY_STORAGE_CAP): NotifyEvent[] {
  if (events.length <= cap) return events
  // Ensure sorted newest-first
  const sorted = [...events].sort(compareNotifyEvents)
  return sorted.slice(0, cap)
}

/**
 * Filter out expired events based on ttlMs.
 */
export function removeExpired(events: NotifyEvent[], now: number = Date.now()): NotifyEvent[] {
  return events.filter((e) => !isNotifyEventExpired(e, now))
}

/**
 * Default severity for a given event type string.
 */
export function defaultSeverityForEventType(eventType: string): NotifySeverity {
  return NOTIFY_EVENT_SEVERITY[eventType] ?? 'info'
}

/**
 * Default priority for a given event type string.
 */
export function defaultPriorityForEventType(eventType: string): NotifyPriority {
  return NOTIFY_EVENT_PRIORITY[eventType] ?? 'normal'
}
