/**
 * Notify History Panel
 *
 * Displays categorized notification history from the notification store,
 * with date grouping, filtering, acknowledge, dismiss, and inline action handling.
 */
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js"
import { Bell, X, Check, Trash2, ChevronDown, ChevronUp, AlertTriangle, HelpCircle, ArrowUpRight, ExternalLink } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import {
  getNotifyEvents,
  getUnreadCount,
  acknowledgeNotifyEvent,
  clearNotifyEvents,
} from "../stores/notifications"
import type { NotifyEvent, NotifyCategory, NotifyPriority, NotifySeverity, NotifyAction } from "../types/notify"
import {
  CATEGORY_COLORS,
  getCategoryLabel,
  getPriorityLabel,
  getSeverityLabel,
  formatNotifyTime,
  getDateGroup,
  groupNotifyEventsByDate,
} from "./notify-history-utils"
import type { NotifyPanelFilter } from "./notify-history-utils"

// ==================== Types ====================

interface NotifyHistoryPanelProps {
  /** Instance ID to load events for */
  instanceId: string;
  /** Close callback */
  onClose: () => void;
  /** Action callback for command/choiceValue actions */
  onAction?: (action: NotifyAction) => void;
}

// ==================== Constants ====================

/** Category filter pills to show in the filter bar */
const CATEGORY_FILTERS: NotifyCategory[] = [
  "error",
  "success_progress",
  "help_required",
  "escalation",
  "session_alert",
  "workaround_suggested",
  "mitigation_applied",
]

/** Priority quick-filters */
const PRIORITY_FILTERS: NotifyPriority[] = ["high", "urgent"]

/** Severity quick-filters */
const SEVERITY_FILTERS: NotifySeverity[] = ["error", "critical"]

/**
 * Check if a filter value matches a category
 */
function isCategoryFilter(value: NotifyPanelFilter): value is NotifyCategory {
  return CATEGORY_FILTERS.includes(value as NotifyCategory)
}

/**
 * Check if a filter value matches a priority
 */
function isPriorityFilter(value: NotifyPanelFilter): value is NotifyPriority {
  return PRIORITY_FILTERS.includes(value as NotifyPriority)
}

/**
 * Check if a filter value matches a severity
 */
function isSeverityFilter(value: NotifyPanelFilter): value is NotifySeverity {
  return SEVERITY_FILTERS.includes(value as NotifySeverity)
}

// ==================== Component ====================

const NotifyHistoryPanel: Component<NotifyHistoryPanelProps> = (props) => {
  const { t } = useI18n()

  // State
  const [activeFilter, setActiveFilter] = createSignal<NotifyPanelFilter>("all")
  const [expandedEventId, setExpandedEventId] = createSignal<string | null>(null)

  // All events from store for this instance
  const allEvents = createMemo(() => getNotifyEvents(props.instanceId))

  // Filtered events
  const filteredEvents = createMemo(() => {
    const filter = activeFilter()
    if (filter === "all") return allEvents()

    // Try matching as category first, then priority, then severity
    if (isCategoryFilter(filter)) {
      return allEvents().filter((e) => e.category === filter)
    }
    if (isPriorityFilter(filter)) {
      return allEvents().filter((e) => e.priority === filter)
    }
    if (isSeverityFilter(filter)) {
      return allEvents().filter((e) => e.severity === filter)
    }
    return allEvents()
  })

  // Grouped events
  const groupedItems = createMemo(() => groupNotifyEventsByDate(filteredEvents()))

  // Is empty (no events at all)
  const isEmpty = createMemo(() => allEvents().length === 0)

  // Filter empty (has events but no matches)
  const isFilterEmpty = createMemo(() => !isEmpty() && filteredEvents().length === 0)

  // Has any unread events
  const hasUnread = createMemo(() => allEvents().some((e) => !e.read))

  // Unread count from store
  const unreadCount = createMemo(() => getUnreadCount())

  // Close on ESC
  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown)
    })
  })

  // Handle acknowledge
  const handleAcknowledge = async (eventId: string) => {
    try {
      await acknowledgeNotifyEvent(props.instanceId, eventId)
    } catch (error) {
      console.warn("[notify-history] acknowledge failed", error)
    }
  }

  // Handle dismiss — marks event as acknowledged (dismissed from unread view).
  // In a future slice, this will also remove the event from the store.
  const handleDismiss = async (eventId: string) => {
    try {
      await acknowledgeNotifyEvent(props.instanceId, eventId)
    } catch (error) {
      console.warn("[notify-history] dismiss failed", error)
    }
  }

  // Handle clear all
  const handleClearAll = async () => {
    try {
      await clearNotifyEvents(props.instanceId)
    } catch (error) {
      console.warn("[notify-history] clear all failed", error)
    }
  }

  // Handle mark all as read
  const handleMarkAllAsRead = async () => {
    const events = allEvents()
    for (const event of events) {
      if (!event.read) {
        try {
          await acknowledgeNotifyEvent(props.instanceId, event.id)
        } catch (error) {
          console.warn("[notify-history] mark read failed for", event.id, error)
        }
      }
    }
  }

  // Handle action click
  const handleActionClick = (event: MouseEvent, action: NotifyAction) => {
    event.stopPropagation()

    if (action.href) {
      void handleOpenAction(action.href)
    } else if (action.command || action.choiceValue) {
      props.onAction?.(action)
    }
  }

  // Open external link
  async function handleOpenAction(href: string): Promise<void> {
    try {
      const { isTauriHost } = await import("../lib/runtime-env")
      if (isTauriHost()) {
        try {
          const { openUrl } = await import("@tauri-apps/plugin-opener")
          await openUrl(href)
          return
        } catch (error) {
          console.warn("[notify-history] unable to open via system opener", error)
        }
      }
    } catch {
      // runtime-env import failed, fall through
    }

    window.open(href, "_blank", "noopener,noreferrer")
  }

  // Toggle expanded details
  const toggleExpanded = (eventId: string) => {
    setExpandedEventId((prev) => (prev === eventId ? null : eventId))
  }

  // Backdrop click
  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) {
      props.onClose()
    }
  }

  // Action variant class mapping
  const actionVariantClass = (variant?: string): string => {
    switch (variant) {
      case "danger": return "notify-history-action-danger"
      case "primary": return "notify-history-action-primary"
      default: return "notify-history-action-secondary"
    }
  }

  return (
    <div class="notify-history-backdrop" onClick={handleBackdropClick}>
      <div
        class="notify-history-panel flex flex-col overflow-hidden rounded-[var(--radius-xl)] border border-base bg-surface-base"
        style={{
          "width": "min(420px, calc(100vw - var(--space-lg) * 2))",
          "max-height": "calc(100vh - var(--space-lg) * 2)",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t("notifyHistory.title")}
      >
        {/* Header */}
        <header class="flex items-center justify-between gap-[var(--space-md)] p-[var(--space-md)] border-b border-base bg-surface-secondary">
          <div class="flex items-center gap-[var(--space-sm)] min-w-0">
            <Bell class="w-5 h-5 text-primary flex-shrink-0" aria-hidden="true" />
            <h2 class="text-[var(--font-size-base)] font-semibold text-primary m-0 truncate">{t("notifyHistory.title")}</h2>
            <Show when={hasUnread()}>
              <span
                class="inline-flex items-center justify-center min-w-[1.25rem] h-[1.25rem] px-[0.35rem] rounded-full bg-[var(--color-primary)] text-[var(--color-on-primary)] text-[var(--font-size-xs)] font-semibold flex-shrink-0"
                aria-label={t("notifyHistory.unread", { count: unreadCount() })}
              >
                {unreadCount()}
              </span>
            </Show>
          </div>
          <div class="flex items-center gap-[var(--space-xs)] flex-shrink-0">
            <Show when={!isEmpty()}>
              <button
                type="button"
                class="notify-history-action-btn inline-flex items-center gap-1 px-1 py-0.5 rounded-[var(--radius-sm)] border border-base bg-surface-secondary text-[var(--font-size-xs)] font-medium cursor-pointer"
                onClick={handleMarkAllAsRead}
                title={t("notifyHistory.markAllRead")}
              >
                {t("notifyHistory.markAllRead")}
              </button>
              <button
                type="button"
                class="notify-history-action-btn notify-history-action-btn-danger inline-flex items-center gap-1 px-1 py-0.5 rounded-[var(--radius-sm)] border border-base bg-surface-secondary text-[var(--font-size-xs)] font-medium cursor-pointer"
                onClick={handleClearAll}
                title={t("notifyHistory.clearAll")}
              >
                <Trash2 class="w-3.5 h-3.5" aria-hidden="true" />
                {t("notifyHistory.clearAll")}
              </button>
            </Show>
            <button
              type="button"
              class="notify-history-close-btn inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] border border-base bg-surface-secondary text-primary cursor-pointer"
              onClick={props.onClose}
              aria-label={t("notifyHistory.close")}
            >
              <X class="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Filter bar */}
        <Show when={!isEmpty()}>
          <div class="flex flex-col gap-[var(--space-xs)] px-[var(--space-md)] py-[var(--space-sm)] border-b border-base bg-surface-secondary">
            {/* Category filter pills */}
            <div class="flex items-center gap-[var(--space-xs)] overflow-x-auto" aria-label={t("notifyHistory.filter.category")}>
              <button
                type="button"
                class="notify-history-filter-btn px-3 py-1 rounded-full border border-base bg-transparent text-[var(--text-secondary)] text-[var(--font-size-xs)] font-medium cursor-pointer whitespace-nowrap"
                classList={{
                  "notify-history-filter-btn-active": activeFilter() === "all",
                }}
                aria-pressed={activeFilter() === "all"}
                onClick={() => setActiveFilter("all")}
              >
                {t("notifyHistory.filter.all")}
              </button>
              <For each={CATEGORY_FILTERS}>
                {(category) => (
                  <button
                    type="button"
                    class="notify-history-filter-btn px-3 py-1 rounded-full border border-base bg-transparent text-[var(--text-secondary)] text-[var(--font-size-xs)] font-medium cursor-pointer whitespace-nowrap"
                    classList={{
                      "notify-history-filter-btn-active": activeFilter() === category,
                    }}
                    aria-pressed={activeFilter() === category}
                    onClick={() => setActiveFilter(activeFilter() === category ? "all" : category)}
                  >
                    {getCategoryLabel(category)}
                  </button>
                )}
              </For>
            </div>
            {/* Priority and severity quick-filters */}
            <div class="flex items-center gap-[var(--space-xs)] overflow-x-auto">
              <span class="text-[var(--font-size-xs)] text-muted flex-shrink-0">Priority:</span>
              <For each={PRIORITY_FILTERS}>
                {(priority) => (
                  <button
                    type="button"
                    class="notify-history-filter-btn notify-history-filter-priority px-2 py-0.5 rounded-[var(--radius-sm)] border border-base bg-transparent text-[var(--text-secondary)] text-[var(--font-size-xs)] font-medium cursor-pointer whitespace-nowrap"
                    classList={{
                      "notify-history-filter-btn-active": activeFilter() === priority,
                    }}
                    aria-pressed={activeFilter() === priority}
                    onClick={() => setActiveFilter(activeFilter() === priority ? "all" : priority)}
                  >
                    {getPriorityLabel(priority)}
                  </button>
                )}
              </For>
              <span class="text-[var(--font-size-xs)] text-muted flex-shrink-0 ml-[var(--space-sm)]">Severity:</span>
              <For each={SEVERITY_FILTERS}>
                {(severity) => (
                  <button
                    type="button"
                    class="notify-history-filter-btn notify-history-filter-severity px-2 py-0.5 rounded-[var(--radius-sm)] border border-base bg-transparent text-[var(--text-secondary)] text-[var(--font-size-xs)] font-medium cursor-pointer whitespace-nowrap"
                    classList={{
                      "notify-history-filter-btn-active": activeFilter() === severity,
                    }}
                    aria-pressed={activeFilter() === severity}
                    onClick={() => setActiveFilter(activeFilter() === severity ? "all" : severity)}
                  >
                    {getSeverityLabel(severity)}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Content */}
        <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <Show
            when={!isEmpty()}
            fallback={
              <div class="flex flex-col items-center justify-center p-[var(--space-xl)] text-secondary text-center">
                <Bell class="w-12 h-12 opacity-50 mb-[var(--space-md)]" aria-hidden="true" />
                <p class="m-0 text-[var(--font-size-sm)]">{t("notifyHistory.empty")}</p>
              </div>
            }
          >
            <Show
              when={!isFilterEmpty()}
              fallback={
                <div class="flex flex-col items-center justify-center p-[var(--space-xl)] text-secondary text-center">
                  <Bell class="w-12 h-12 opacity-50 mb-[var(--space-md)]" aria-hidden="true" />
                  <p class="m-0 text-[var(--font-size-sm)]">{t("notifyHistory.empty.filter")}</p>
                </div>
              }
            >
              <For each={groupedItems()}>
                {(group) => (
                  <div class="p-[var(--space-sm)]">
                    <div class="px-[var(--space-sm)] py-[var(--space-xs)] text-[var(--font-size-xs)] font-semibold text-muted uppercase tracking-wide">
                      {t(group.labelKey)}
                    </div>
                    <ul role="list" class="flex flex-col gap-[var(--space-xs)] list-none p-0 m-0">
                      <For each={group.events}>
                        {(event) => {
                          const isExpanded = () => expandedEventId() === event.id
                          const hasDetails = !!(event.escalation || event.mitigate || event.workaround || event.helpRequired || event.successProgress)

                          return (
                            <li
                              tabIndex={0}
                              class="notify-history-item flex flex-col gap-[var(--space-xs)] px-[var(--space-md)] py-[var(--space-sm)] rounded-[var(--radius-lg)] border-none bg-surface-secondary relative w-full text-start font-inherit text-inherit cursor-pointer"
                              classList={{
                                "notify-history-item-unread": !event.read,
                              }}
                              onClick={() => {
                                if (!event.read) {
                                  void handleAcknowledge(event.id)
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault()
                                  if (!event.read) {
                                    void handleAcknowledge(event.id)
                                  }
                                }
                              }}
                            >
                              <div class="flex items-start gap-[var(--space-sm)] w-full">
                                {/* Category indicator dot */}
                                <span
                                  class="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-[0.3rem] notify-history-indicator"
                                  style={{ "background-color": CATEGORY_COLORS[event.category] ?? "#78909c" }}
                                  aria-hidden="true"
                                />
                                <div class="flex-1 min-w-0">
                                  {/* Title and timestamp row */}
                                  <div class="flex items-center gap-2">
                                    <span class="text-sm font-medium text-primary truncate">{event.title}</span>
                                    <span class="text-xs text-muted flex-shrink-0 whitespace-nowrap">{formatNotifyTime(event.createdAt)}</span>
                                  </div>
                                  {/* Message */}
                                  <p class="text-xs text-secondary m-0 line-clamp-2">{event.message}</p>
                                  {/* Badges row */}
                                  <div class="flex items-center gap-[var(--space-xs)] mt-1 flex-wrap">
                                    <span
                                      class="inline-flex items-center px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[var(--font-size-xs)] font-medium"
                                      style={{
                                        "background-color": `${CATEGORY_COLORS[event.category] ?? "#78909c"}20`,
                                        color: CATEGORY_COLORS[event.category] ?? "#78909c",
                                      }}
                                    >
                                      {getCategoryLabel(event.category)}
                                    </span>
                                    <span class="inline-flex items-center px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-surface-tertiary text-[var(--font-size-xs)] text-muted font-medium">
                                      {getPriorityLabel(event.priority)}
                                    </span>
                                    <span class="inline-flex items-center px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-surface-tertiary text-[var(--font-size-xs)] text-muted font-medium">
                                      {getSeverityLabel(event.severity)}
                                    </span>
                                  </div>
                                </div>
                                {/* Action buttons */}
                                <div class="flex items-center gap-[var(--space-xs)] flex-shrink-0">
                                  {/* Acknowledge button */}
                                  <Show when={!event.read}>
                                    <button
                                      type="button"
                                      class="notify-history-item-ack inline-flex items-center justify-center w-6 h-6 rounded-[var(--radius-sm)] border-none bg-transparent text-primary cursor-pointer"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        void handleAcknowledge(event.id)
                                      }}
                                      aria-label={t("notifyHistory.acknowledge")}
                                      title={t("notifyHistory.acknowledge")}
                                    >
                                      <Check class="w-3.5 h-3.5" aria-hidden="true" />
                                    </button>
                                  </Show>
                                  {/* Dismiss button */}
                                  <button
                                    type="button"
                                    class="notify-history-item-dismiss inline-flex items-center justify-center w-6 h-6 rounded-[var(--radius-sm)] border-none bg-transparent text-muted cursor-pointer"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      void handleDismiss(event.id)
                                    }}
                                    aria-label={t("notifyHistory.dismiss")}
                                    title={t("notifyHistory.dismiss")}
                                  >
                                    <X class="w-3.5 h-3.5" aria-hidden="true" />
                                  </button>
                                  {/* Expand details button */}
                                  <Show when={hasDetails}>
                                    <button
                                      type="button"
                                      class="notify-history-item-expand inline-flex items-center justify-center w-6 h-6 rounded-[var(--radius-sm)] border-none bg-transparent text-muted cursor-pointer"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        toggleExpanded(event.id)
                                      }}
                                      aria-label={t("notifyHistory.details")}
                                      title={t("notifyHistory.details")}
                                    >
                                      <Show when={isExpanded()} fallback={<ChevronDown class="w-3.5 h-3.5" aria-hidden="true" />}>
                                        <ChevronUp class="w-3.5 h-3.5" aria-hidden="true" />
                                      </Show>
                                    </button>
                                  </Show>
                                </div>
                              </div>

                              {/* Unread indicator dot (unread only, on right edge) */}
                              <Show when={!event.read}>
                                <span class="notify-history-item-unread-dot absolute top-[var(--space-sm)] right-[var(--space-sm)] w-2 h-2 rounded-full bg-[var(--color-primary)]" aria-hidden="true" />
                              </Show>

                              {/* Action buttons from event.actions[] */}
                              <Show when={event.actions && event.actions.length > 0}>
                                <div class="flex items-center gap-[var(--space-xs)] flex-wrap mt-1">
                                  <For each={event.actions}>
                                    {(action) => (
                                      <button
                                        type="button"
                                        class={`notify-history-item-action inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-sm)] border border-base text-[var(--font-size-xs)] font-medium cursor-pointer ${actionVariantClass(action.variant)}`}
                                        onClick={(e) => handleActionClick(e, action)}
                                      >
                                        <Show when={action.href}>
                                          <ExternalLink class="w-3 h-3" aria-hidden="true" />
                                        </Show>
                                        {action.label}
                                      </button>
                                    )}
                                  </For>
                                </div>
                              </Show>

                              {/* Expandable details section */}
                              <Show when={isExpanded() && hasDetails}>
                                <div class="mt-1 pt-[var(--space-xs)] border-t border-base">
                                  <Show when={event.escalation}>
                                    <div class="flex items-start gap-1 mb-1">
                                      <AlertTriangle class="w-3.5 h-3.5 text-[#d50000] flex-shrink-0 mt-0.5" aria-hidden="true" />
                                      <div class="text-xs">
                                        <span class="font-semibold text-primary">{t("notifyHistory.escalation")}: </span>
                                        <span class="text-secondary">{event.escalation!.reason}</span>
                                        <Show when={event.escalation!.fromAgent && event.escalation!.toAgent}>
                                          <span class="text-muted">
                                            {" "}({event.escalation!.fromAgent} → {event.escalation!.toAgent})
                                          </span>
                                        </Show>
                                      </div>
                                    </div>
                                  </Show>
                                  <Show when={event.mitigate}>
                                    <div class="flex items-start gap-1 mb-1">
                                      <ArrowUpRight class="w-3.5 h-3.5 text-[#00897b] flex-shrink-0 mt-0.5" aria-hidden="true" />
                                      <div class="text-xs">
                                        <span class="font-semibold text-primary">{t("notifyHistory.mitigate")}: </span>
                                        <span class="text-secondary">{event.mitigate}</span>
                                      </div>
                                    </div>
                                  </Show>
                                  <Show when={event.workaround}>
                                    <div class="flex items-start gap-1 mb-1">
                                      <ArrowUpRight class="w-3.5 h-3.5 text-[#f9a825] flex-shrink-0 mt-0.5" aria-hidden="true" />
                                      <div class="text-xs">
                                        <span class="font-semibold text-primary">{t("notifyHistory.workaround")}: </span>
                                        <span class="text-secondary">{event.workaround}</span>
                                      </div>
                                    </div>
                                  </Show>
                                  <Show when={event.helpRequired}>
                                    <div class="flex items-start gap-1 mb-1">
                                      <HelpCircle class="w-3.5 h-3.5 text-[#ff1744] flex-shrink-0 mt-0.5" aria-hidden="true" />
                                      <div class="text-xs">
                                        <span class="font-semibold text-primary">{t("notifyHistory.helpRequired")}</span>
                                      </div>
                                    </div>
                                  </Show>
                                  <Show when={event.successProgress}>
                                    <div class="flex items-start gap-1">
                                      <Check class="w-3.5 h-3.5 text-[#2e7d32] flex-shrink-0 mt-0.5" aria-hidden="true" />
                                      <div class="text-xs">
                                        <span class="font-semibold text-primary">{t("notifyHistory.successProgress")}: </span>
                                        <span class="text-secondary">
                                          {event.successProgress!.current}/{event.successProgress!.total}
                                          <Show when={event.successProgress!.unit}>
                                            {" "}{event.successProgress!.unit}
                                          </Show>
                                        </span>
                                      </div>
                                    </div>
                                  </Show>
                                </div>
                              </Show>
                            </li>
                          )
                        }}
                      </For>
                    </ul>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )
}

export default NotifyHistoryPanel
