/**
 * ChoiceBar
 *
 * Inline choice selection bar that appears above the prompt input textarea
 * when the system presents structured choices to the user.
 *
 * - Shows numbered buttons (1-9) for choices
 * - Keyboard: number keys select, Esc dismisses
 * - Supports single and multiple selection modes
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
import { Check, X, Timer } from "lucide-solid"
import type { ChatChoiceAskedPayload } from "../types/notify"

// ==================== Types ====================

interface ChoiceBarProps {
  /** Current active choice payload, or null to hide */
  choice: ChatChoiceAskedPayload | null
  /** Called when a choice is selected (single) or confirmed (multiple) */
  onSelect: (value: string | string[]) => void
  /** Called when the choice bar is dismissed */
  onDismiss: () => void
}

// ==================== Component ====================

const ChoiceBar: Component<ChoiceBarProps> = (props) => {
  // Track selected values for multiple mode
  const [selectedValues, setSelectedValues] = createSignal<Set<string>>(new Set())
  // Countdown seconds remaining (for timeout display)
  const [countdown, setCountdown] = createSignal<number | null>(null)
  // Track the dismiss timer ID for cleanup
  let dismissTimerId: ReturnType<typeof setTimeout> | undefined

  // Reset selections when choice changes
  createEffect(() => {
    // Access props.choice to trigger on change
    if (props.choice) {
      setSelectedValues(new Set())
    }
  })

  // Timeout auto-dismiss
  createEffect(() => {
    // Clear any previous timer
    if (dismissTimerId !== undefined) {
      clearTimeout(dismissTimerId)
      dismissTimerId = undefined
    }
    setCountdown(null)

    const currentChoice = props.choice
    if (!currentChoice || typeof currentChoice.timeout !== "number" || currentChoice.timeout <= 0) {
      return
    }

    // Start countdown
    const totalSeconds = currentChoice.timeout
    setCountdown(totalSeconds)

    // Decrement countdown every second
    const intervalId = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) return null
        return prev - 1
      })
    }, 1000)

    // Auto-dismiss after timeout
    dismissTimerId = setTimeout(() => {
      setCountdown(null)
      setSelectedValues(new Set())
      props.onDismiss()
    }, totalSeconds * 1000)

    onCleanup(() => {
      clearInterval(intervalId)
      if (dismissTimerId !== undefined) {
        clearTimeout(dismissTimerId)
        dismissTimerId = undefined
      }
    })
  })

  // Whether we are in multiple-selection mode
  const isMultiple = createMemo(() => props.choice?.multiple === true)

  // Handle option click
  const handleOptionClick = (value: string) => {
    if (isMultiple()) {
      setSelectedValues((prev) => {
        const next = new Set(prev)
        if (next.has(value)) {
          next.delete(value)
        } else {
          next.add(value)
        }
        return next
      })
    } else {
      props.onSelect(value)
    }
  }

  // Handle confirm for multiple mode
  const handleConfirm = () => {
    const values = Array.from(selectedValues())
    if (values.length === 0) return
    props.onSelect(values)
  }

  // Handle dismiss
  const handleDismiss = () => {
    setSelectedValues(new Set())
    props.onDismiss()
  }

  // Keyboard navigation (document-level)
  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!props.choice) return

      // Escape dismisses
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        handleDismiss()
        return
      }

      // Number keys 1-9 select the corresponding option
      const num = parseInt(event.key, 10)
      if (num >= 1 && num <= 9 && num <= props.choice.choices.length) {
        event.preventDefault()
        event.stopPropagation()
        handleOptionClick(props.choice.choices[num - 1].value)
        return
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown)
    })
  })

  // Render nothing when choice is null
  return (
    <Show when={props.choice}>
      {(choice) => (
        <div
          class="choice-bar flex flex-col gap-[var(--space-xs)] px-[var(--space-md)] pb-[var(--space-xs)]"
          role="group"
          aria-label={choice().title ?? "Available choices"}
          aria-live="polite"
        >
          {/* Title */}
          <Show when={choice().title}>
            <div class="choice-bar-title flex items-center gap-[var(--space-sm)]">
              <span class="text-[var(--font-size-xs)] font-semibold text-primary">
                {choice().title}
              </span>
              <Show when={isMultiple()}>
                <span class="text-[var(--font-size-xs)] text-muted">
                  (select one or more)
                </span>
              </Show>
              {/* Countdown timer for auto-dismiss */}
              <Show when={countdown() !== null}>
                <span class="choice-bar-countdown inline-flex items-center gap-1 ml-auto text-[var(--font-size-xs)] text-muted" aria-live="polite" role="timer">
                  <Timer class="w-3 h-3" aria-hidden="true" />
                  {countdown()}s
                </span>
              </Show>
            </div>
          </Show>
          <Show when={!choice().title && countdown() !== null}>
            <div class="choice-bar-countdown flex items-center gap-1 px-[var(--space-xs)] text-[var(--font-size-xs)] text-muted" aria-live="polite" role="timer">
              <Timer class="w-3 h-3" aria-hidden="true" />
              Auto-dismisses in {countdown()}s
            </div>
          </Show>

          {/* Choice buttons */}
          <div class="choice-bar-options flex flex-wrap gap-[var(--space-xs)]">
            <For each={choice().choices}>
              {(option, index) => {
                const isSelected = () => selectedValues().has(option.value)
                return (
                  <button
                    type="button"
                    class="choice-bar-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] border border-base bg-surface-secondary text-[var(--font-size-sm)] font-medium cursor-pointer whitespace-nowrap select-none transition-colors"
                    classList={{
                      "choice-bar-btn-active": isMultiple() && isSelected(),
                      "hover:bg-surface-tertiary hover:border-primary": !isMultiple() || !isSelected(),
                    }}
                    onClick={() => handleOptionClick(option.value)}
                    aria-pressed={isMultiple() ? isSelected() : undefined}
                    tabIndex={0}
                  >
                    {/* Check icon for multiple mode */}
                    <Show when={isMultiple() && isSelected()}>
                      <Check class="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                    </Show>
                    {/* Number indicator */}
                    <span class="choice-bar-num text-[var(--font-size-xs)] text-muted font-mono">
                      {index() + 1}.
                    </span>
                    <span>{option.label}</span>
                  </button>
                )
              }}
            </For>
          </div>

          {/* Confirm button for multiple mode */}
          <Show when={isMultiple() && selectedValues().size > 0}>
            <div class="choice-bar-confirm flex gap-[var(--space-xs)]">
              <button
                type="button"
                class="choice-bar-confirm-btn inline-flex items-center gap-1 px-3 py-1 rounded-[var(--radius-md)] bg-[var(--color-primary)] text-[var(--color-on-primary)] text-[var(--font-size-xs)] font-semibold cursor-pointer border-none transition-colors hover:opacity-90"
                onClick={handleConfirm}
              >
                <Check class="w-3.5 h-3.5" aria-hidden="true" />
                Confirm ({selectedValues().size})
              </button>
              <button
                type="button"
                class="choice-bar-dismiss-btn inline-flex items-center gap-1 px-3 py-1 rounded-[var(--radius-md)] border border-base bg-surface-secondary text-secondary text-[var(--font-size-xs)] cursor-pointer transition-colors hover:bg-surface-tertiary"
                onClick={handleDismiss}
              >
                <X class="w-3.5 h-3.5" aria-hidden="true" />
                Cancel
              </button>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}

export default ChoiceBar
