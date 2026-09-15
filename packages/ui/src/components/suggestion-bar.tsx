/**
 * SuggestionBar — full-width compact icon-only quick action bar for
 * CodeNomad's empty message state.
 *
 * Renders all QUICK_ACTIONS as icon-only buttons in a horizontal wrapping
 * row. Each button shows a Kobalte Tooltip on hover/focus and opens a
 * SuggestionPopout on click with details + "Use this" CTA.
 *
 * i18n: uses messageSection.suggestionBar.* and messageSection.suggestionPopout.*
 */

import {
  For,
  Show,
  createMemo,
  createSignal,
  type Component,
  type JSX,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import {
  MessageSquare,
  Search,
  BookOpen,
  Shield,
  FileText,
  Code,
  Lightbulb,
  TrendingUp,
  Coins,
  GitBranch,
} from "lucide-solid"
import { Tooltip } from "@kobalte/core/tooltip"
import {
  QUICK_ACTIONS,
  QUICK_ACTION_CATEGORIES,
  getQuickActionsByCategory,
  setQuickActionPrompt,
  type QuickActionCard,
  type QuickActionCategory,
} from "../stores/quick-actions"
import { useI18n } from "../lib/i18n"
import SuggestionPopout from "./suggestion-popout"

// ── Icon registry ───────────────────────────────────────────────────

const ICON_MAP: Record<string, Component<{ class?: string }>> = {
  MessageSquare,
  Search,
  BookOpen,
  Shield,
  FileText,
  Code,
  Lightbulb,
  TrendingUp,
  Coins,
  GitBranch,
}

const FALLBACK_ICON = MessageSquare

// ── Category chip ───────────────────────────────────────────────────

interface CategoryChipProps {
  label: string
  active: boolean
  onClick: () => void
}

function CategoryChip(props: CategoryChipProps) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class="suggestion-category-chip"
      classList={{ "is-active": props.active }}
    >
      {props.label}
    </button>
  )
}

// ── Single icon button ──────────────────────────────────────────────

interface SuggestionIconBtnProps {
  action: QuickActionCard
  onSelect: (action: QuickActionCard) => void
}

function SuggestionIconBtn(props: SuggestionIconBtnProps) {
  const IconComponent = ICON_MAP[props.action.icon] ?? FALLBACK_ICON

  return (
    <Tooltip openDelay={200} closeDelay={100} gutter={6} placement="top">
      <Tooltip.Trigger
        type="button"
        class="suggestion-icon-btn"
        aria-label={`${props.action.title} — ${props.action.description}`}
        onClick={() => props.onSelect(props.action)}
      >
        <Dynamic component={IconComponent} class="suggestion-icon" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="suggestion-tooltip">
          <div class="suggestion-tooltip-title">{props.action.title}</div>
          <div class="suggestion-tooltip-description">{props.action.description}</div>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  )
}

// ── Main component ──────────────────────────────────────────────────

export interface SuggestionBarProps {
  /** Called after a popout "Use this" selection. */
  onSelected?: () => void
}

export default function SuggestionBar(props: SuggestionBarProps) {
  const { t } = useI18n()
  const [activeCategory, setActiveCategory] = createSignal<QuickActionCategory | null>(null)
  const [selectedAction, setSelectedAction] = createSignal<QuickActionCard | null>(null)

  const filtered = createMemo(() => getQuickActionsByCategory(activeCategory()))

  const handleSelect = (action: QuickActionCard) => {
    setSelectedAction(action)
  }

  const handleUseThis = () => {
    const action = selectedAction()
    if (!action) return
    setQuickActionPrompt(action.promptTemplate)
    setSelectedAction(null)
    props.onSelected?.()
  }

  const handlePopoutClose = () => {
    setSelectedAction(null)
  }

  return (
    <div class="suggestion-bar">
      {/* Category filter row */}
      <div class="suggestion-bar-categories">
        <CategoryChip
          label={t("messageSection.suggestionBar.all")}
          active={activeCategory() === null}
          onClick={() => setActiveCategory(null)}
        />
        <For each={QUICK_ACTION_CATEGORIES}>
          {(cat) => (
            <CategoryChip
              label={cat.label}
              active={activeCategory() === cat.id}
              onClick={() => setActiveCategory(cat.id)}
            />
          )}
        </For>
      </div>

      {/* Icon button row */}
      <div class="suggestion-bar-icons">
        <For each={filtered()}>
          {(action) => (
            <SuggestionIconBtn action={action} onSelect={handleSelect} />
          )}
        </For>
      </div>

      {/* Popout */}
      <Show when={selectedAction()}>
        {(action) => (
          <SuggestionPopout
            action={action()}
            onClose={handlePopoutClose}
            onUseThis={handleUseThis}
          />
        )}
      </Show>
    </div>
  )
}
