/**
 * QuickActions — card grid shown in CodeNomad's empty message state.
 *
 * SolidJS component. Each card is a prompt template; clicking one populates
 * the shared signal (stores/quick-actions.ts) which the PromptInput
 * subscribes to. The user sees the full prompt in the textarea before
 * sending, so they can customize bracketed placeholders.
 */

import {
  For,
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
  ArrowRight,
} from "lucide-solid"
import {
  QUICK_ACTIONS,
  QUICK_ACTION_CATEGORIES,
  getQuickActionsByCategory,
  setQuickActionPrompt,
  type QuickActionCard,
  type QuickActionCategory,
} from "../stores/quick-actions"

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

// ── Single card ─────────────────────────────────────────────────────

interface QuickActionCardProps {
  action: QuickActionCard
  onSelect: (action: QuickActionCard) => void
}

function QuickActionCard_(props: QuickActionCardProps) {
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.action)}
      class="quick-action-card group"
    >
      <div class="quick-action-card-header">
        <div class="quick-action-icon-wrap">
          <Dynamic component={ICON_MAP[props.action.icon] ?? MessageSquare} class="quick-action-icon" />
        </div>
        <div class="quick-action-text">
          <h3 class="quick-action-title">{props.action.title}</h3>
          <p class="quick-action-description">{props.action.description}</p>
        </div>
      </div>
      <div class="quick-action-tags">
        <For each={props.action.tags}>
          {(tag) => <span class="quick-action-tag">{tag}</span>}
        </For>
      </div>
      <div class="quick-action-cta">
        <span class="quick-action-cta-text">Use this</span>
        <ArrowRight class="quick-action-cta-arrow" />
      </div>
    </button>
  )
}

// ── Category filter chip ────────────────────────────────────────────

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
      class="quick-action-category-chip"
      classList={{ "is-active": props.active }}
    >
      {props.label}
    </button>
  )
}

// ── Main component ──────────────────────────────────────────────────

export interface QuickActionsProps {
  /** Called after a card is selected and signal is set. */
  onSelected?: () => void
}

export default function QuickActions(props: QuickActionsProps) {
  const [activeCategory, setActiveCategory] = createSignal<QuickActionCategory | null>(null)

  const filtered = createMemo(() => getQuickActionsByCategory(activeCategory()))

  const handleSelect = (action: QuickActionCard) => {
    setQuickActionPrompt(action.promptTemplate)
    props.onSelected?.()
  }

  return (
    <div class="quick-actions-container">
      {/* Heading */}
      <div class="quick-actions-heading">
        <h2 class="quick-actions-title">What can I help with?</h2>
        <p class="quick-actions-subtitle">
          Pick a starting point — you can customize the prompt before sending
        </p>
      </div>

      {/* Category filter */}
      <div class="quick-actions-categories">
        <CategoryChip
          label="All"
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

      {/* Card grid */}
      <div class="quick-actions-grid">
        <For each={filtered()}>
          {(action) => (
            <QuickActionCard_ action={action} onSelect={handleSelect} />
          )}
        </For>
      </div>
    </div>
  )
}
