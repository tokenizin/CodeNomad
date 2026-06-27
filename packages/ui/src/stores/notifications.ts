import { createSignal } from "solid-js"
import type { NotifyEvent, NotifyFilter } from "../types/notify"
import { compareNotifyEvents, filterNotifyEvents } from "../types/notify"
import { serverApi } from "../lib/api-client"
import { sseManager } from "../lib/sse-manager"
import type { ToastVariant } from "../lib/notifications"

// ── Module-Level Signal ─────────────────────────────────

const [notifyEvents, setNotifyEvents] = createSignal<Map<string, NotifyEvent[]>>(new Map())
const [unreadCount, setUnreadCount] = createSignal(0)

const MAX_EVENTS_PER_INSTANCE = 500

// ── Priority/Severity → Toast Variant Mapping ──────────

const PRIORITY_TO_TOAST_VARIANT: Record<string, ToastVariant> = {
  urgent: "error",
  high: "warning",
  normal: "info",
  low: "success",
}

const SEVERITY_TO_TOAST_VARIANT: Record<string, ToastVariant> = {
  critical: "error",
  error: "error",
  warning: "warning",
  info: "info",
  success: "success",
}

/** Determine whether a notify event should trigger a toast notification */
export function shouldShowToast(event: NotifyEvent): boolean {
  return event.priority === "high" || event.priority === "urgent" || event.severity === "critical"
}

/** Map a notify event to a toast variant */
function eventToToastVariant(event: NotifyEvent): ToastVariant {
  return SEVERITY_TO_TOAST_VARIANT[event.severity] ?? PRIORITY_TO_TOAST_VARIANT[event.priority] ?? "info"
}

// ── Lazy Toast Bridge (avoids importing solid-toast on server) ──

let _showToast: ((payload: { title?: string; message: string; variant: ToastVariant; duration?: number }) => void) | null = null

async function ensureToastFn(): Promise<void> {
  if (_showToast) return
  try {
    const mod = await import("../lib/notifications")
    _showToast = (payload) => {
      mod.showToastNotification({
        title: payload.title,
        message: payload.message,
        variant: payload.variant,
        duration: payload.duration ?? 10000,
      })
    }
  } catch {
    // Not running in browser — toast not available
  }
}

function fireToast(event: NotifyEvent): void {
  if (!_showToast) return
  _showToast({
    title: event.title,
    message: event.message,
    variant: eventToToastVariant(event),
    duration: 10000,
  })
}

// ── Internal Helpers ────────────────────────────────────

function recalcUnreadCount(): void {
  let total = 0
  for (const events of notifyEvents().values()) {
    for (const event of events) {
      if (!event.read) total++
    }
  }
  setUnreadCount(total)
}

function setEvents(instanceId: string, events: NotifyEvent[]): void {
  setNotifyEvents((prev) => {
    const next = new Map(prev)
    next.set(instanceId, events)
    return next
  })
  recalcUnreadCount()
}

function addEvent(instanceId: string, event: NotifyEvent): void {
  setNotifyEvents((prev) => {
    const next = new Map(prev)
    const current = next.get(instanceId) ?? []
    // Prepend new event, trim to MAX_EVENTS_PER_INSTANCE
    const updated = [event, ...current].slice(0, MAX_EVENTS_PER_INSTANCE)
    next.set(instanceId, updated)
    return next
  })
  recalcUnreadCount()
}

function updateEvent(instanceId: string, id: string, patch: Partial<NotifyEvent>): void {
  setNotifyEvents((prev) => {
    const next = new Map(prev)
    const current = next.get(instanceId) ?? []
    const index = current.findIndex((entry) => entry.id === id)
    if (index < 0) return prev
    const updated = [...current.slice(0, index), { ...current[index], ...patch }, ...current.slice(index + 1)]
    next.set(instanceId, updated)
    return next
  })
  recalcUnreadCount()
}

function removeEvent(instanceId: string, id: string): void {
  setNotifyEvents((prev) => {
    const next = new Map(prev)
    const current = next.get(instanceId) ?? []
    next.set(
      instanceId,
      current.filter((entry) => entry.id !== id),
    )
    return next
  })
  recalcUnreadCount()
}

// ── Public API ──────────────────────────────────────────

function getNotifyEvents(instanceId: string, filter?: NotifyFilter): NotifyEvent[] {
  const events = notifyEvents().get(instanceId) ?? []
  if (filter) {
    return filterNotifyEvents(events, filter)
  }
  // Default sort: by priority desc → severity desc → createdAt desc
  return [...events].sort(compareNotifyEvents)
}

function getUnreadCount(): number {
  return unreadCount()
}

async function loadNotifyEvents(instanceId: string, filter?: NotifyFilter): Promise<void> {
  const events = await serverApi.listNotifications(instanceId)
  setEvents(instanceId, events)
}

async function acknowledgeNotifyEvent(instanceId: string, id: string): Promise<void> {
  try {
    await serverApi.acknowledgeNotification(instanceId, id)
    updateEvent(instanceId, id, { read: true, ackedAt: Date.now() })
  } catch (err) {
    const message = (err as Error).message || ''
    // If the server returns 404, the notification was already cleaned up
    // (e.g. server restart flushed the in-memory registry). Remove from local state.
    if (message.includes('404') || message.includes('not found')) {
      removeEvent(instanceId, id)
      return
    }
    throw err
  }
}

async function clearNotifyEvents(instanceId: string): Promise<void> {
  await serverApi.clearNotifications(instanceId)
  setEvents(instanceId, [])
}

function getNotifyEventById(instanceId: string, id: string): NotifyEvent | undefined {
  return notifyEvents().get(instanceId)?.find((entry) => entry.id === id)
}

// ── WS Event Listeners ─────────────────────────────────

sseManager.onNotifyCreated = (instanceId, event) => {
  const notifyEvent = event.properties?.event
  if (!notifyEvent) return
  addEvent(instanceId, notifyEvent)

  // Toast bridge: high-priority/critical events trigger toast notifications
  if (shouldShowToast(notifyEvent)) {
    void ensureToastFn().then(() => {
      fireToast(notifyEvent)
    })
  }
}

sseManager.onNotifyUpdated = (instanceId, event) => {
  const { id, patch } = event.properties
  if (!id || !patch) return
  updateEvent(instanceId, id, patch as Partial<NotifyEvent>)
}

sseManager.onNotifyRemoved = (instanceId, event) => {
  const { id } = event.properties
  if (!id) return
  removeEvent(instanceId, id)
}

// ── Test-Only Helpers ───────────────────────────────────

/** Reset the notification store to its initial state. Used in tests. */
function resetNotifyStoreForTests(): void {
  setNotifyEvents(new Map())
  setUnreadCount(0)
  _showToast = null
}

/** Directly set events for a given instance. Used in tests. */
function setNotifyEventsForTests(instanceId: string, events: NotifyEvent[]): void {
  setEvents(instanceId, events)
}

// ── Exports ─────────────────────────────────────────────

export {
  notifyEvents as __internal_notifyEvents,
  getNotifyEvents,
  getUnreadCount,
  loadNotifyEvents,
  acknowledgeNotifyEvent,
  clearNotifyEvents,
  getNotifyEventById,
  resetNotifyStoreForTests,
  setNotifyEventsForTests,
  addEvent,
}
