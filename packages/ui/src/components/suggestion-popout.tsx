/**
 * SuggestionPopout — popover panel showing quick-action details.
 *
 * Anchored near the triggering icon, displays title, description, tags,
 * and a truncated prompt preview. "Use this" triggers the shared signal
 * and closes the popout.
 *
 * Uses Kobalte Popover for portal rendering, outside-click dismissal,
 * and Escape-key closing.
 */

import {
  For,
  Show,
  createSignal,
  type Component,
} from "solid-js"
import { Popover } from "@kobalte/core/popover"
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
  X,
} from "lucide-solid"
import type { QuickActionCard } from "../stores/quick-actions"
import { useI18n } from "../lib/i18n"

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

// ── Truncate prompt to first N lines ────────────────────────────────

function truncatePrompt(prompt: string, maxLines: number): string {
  const lines = prompt.split("\n")
  if (lines.length <= maxLines) return prompt
  return lines.slice(0, maxLines).join("\n") + "…"
}

// ── Component ───────────────────────────────────────────────────────

export interface SuggestionPopoutProps {
  action: QuickActionCard
  onClose: () => void
  onUseThis: () => void
}

const SuggestionPopout: Component<SuggestionPopoutProps> = (props) => {
  const { t } = useI18n()
  const [open, setOpen] = createSignal(true)
  const IconComponent = ICON_MAP[props.action.icon] ?? FALLBACK_ICON
  const promptPreview = truncatePrompt(props.action.promptTemplate, 2)

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen)
    if (!isOpen) props.onClose()
  }

  const handleUseThis = () => {
    props.onUseThis()
    setOpen(false)
  }

  return (
    <Popover open={open()} onOpenChange={handleOpenChange} placement="bottom-start" gutter={4}>
      <Popover.Anchor class="suggestion-popout-anchor" />
      <Show when={open()}>
        <Popover.Portal>
          <Popover.Content
            class="suggestion-popout-content"
            onEscapeKeyDown={() => setOpen(false)}
          >
            {/* Header */}
            <div class="suggestion-popout-header">
              <div class="suggestion-popout-icon-wrap">
                <Dynamic component={IconComponent} class="suggestion-popout-icon" />
              </div>
              <div class="suggestion-popout-titles">
                <Popover.Title class="suggestion-popout-title">
                  {props.action.title}
                </Popover.Title>
                <Popover.Description class="suggestion-popout-description">
                  {props.action.description}
                </Popover.Description>
              </div>
              <Popover.CloseButton class="suggestion-popout-close" aria-label={t("messageSection.suggestionPopout.close")}>
                <X class="suggestion-popout-close-icon" />
              </Popover.CloseButton>
            </div>

            {/* Tags */}
            <div class="suggestion-popout-tags">
              <For each={props.action.tags}>
                {(tag) => <span class="suggestion-popout-tag">{tag}</span>}
              </For>
            </div>

            {/* Prompt preview */}
            <div class="suggestion-popout-preview">
              <pre class="suggestion-popout-preview-code">{promptPreview}</pre>
            </div>

            {/* CTA */}
            <button
              type="button"
              class="suggestion-popout-cta"
              onClick={handleUseThis}
            >
              <span>{t("messageSection.suggestionPopout.useThis")}</span>
              <ArrowRight class="suggestion-popout-cta-arrow" />
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Show>
    </Popover>
  )
}

export default SuggestionPopout
