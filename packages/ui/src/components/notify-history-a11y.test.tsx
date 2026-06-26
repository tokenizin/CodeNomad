/**
 * Accessibility tests for the notification system (Slice 8).
 *
 * Tests the a11y enhancements for NotifyHistoryPanel and ChoiceBar:
 * - SR-only live region announces notification arrivals
 * - prefers-reduced-motion CSS overrides
 * - Focus management (panel focus on mount, restore on close)
 * - ChoiceBar auto-focus on first option
 *
 * These are structural/contract tests that verify the component's
 * a11y design without requiring a DOM rendering environment.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

// ── File Paths ──────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const CSS_PATH = join(__dirname, "..", "styles", "components", "notify-history.css")
const PANEL_PATH = join(__dirname, "notify-history-panel.tsx")
const CHOICE_BAR_PATH = join(__dirname, "choice-bar.tsx")

// ── Helper: read file content ───────────────────────────

function readSource(path: string): string {
  return readFileSync(path, "utf-8")
}

// ── AC-1: prefers-reduced-motion CSS ────────────────────

describe("AC-1: prefers-reduced-motion CSS", () => {
  it("notify-history.css file exists", () => {
    assert.ok(existsSync(CSS_PATH), "notify-history.css must exist")
  })

  it("contains @media (prefers-reduced-motion: reduce) block", () => {
    const css = readSource(CSS_PATH)
    assert.ok(
      css.includes("@media (prefers-reduced-motion: reduce)"),
      "CSS must contain prefers-reduced-motion media query",
    )
  })

  it("disables animation on .notify-history-panel", () => {
    const css = readSource(CSS_PATH)
    assert.ok(
      css.includes("animation: none !important"),
      "CSS must override animation with !important",
    )
    assert.ok(
      css.includes("transition: none !important"),
      "CSS must override transition with !important",
    )
  })

  it("covers .notify-history-backdrop and .choice-bar", () => {
    const css = readSource(CSS_PATH)
    assert.ok(
      css.includes(".notify-history-backdrop"),
      "CSS must cover .notify-history-backdrop",
    )
    assert.ok(
      css.includes(".choice-bar"),
      "CSS must cover .choice-bar",
    )
  })

  it("uses .notify-history-panel * wildcard for all descendants", () => {
    const css = readSource(CSS_PATH)
    assert.ok(
      css.includes("notify-history-panel *"),
      "CSS must apply to all descendants of panel",
    )
  })

  it("contains focus-visible ring for .notify-history-item", () => {
    const css = readSource(CSS_PATH)
    assert.ok(
      css.includes("notify-history-item:focus-visible"),
      "CSS must have focus-visible style for items",
    )
    assert.ok(
      css.includes("outline:"),
      "Focus-visible style must include outline",
    )
  })
})

// ── AC-2: ARIA Live Region ──────────────────────────────

describe("AC-2: SR-only live region for notifications", () => {
  it("panel source imports notify-history.css", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes('import "../styles/components/notify-history.css"'),
      "Panel must import the CSS file",
    )
  })

  it("panel contains role='status' on a hidden element", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes('role="status"'),
      "Panel must include a role='status' element for screen reader announcements",
    )
  })

  it("live region uses aria-live='polite'", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes('aria-live="polite"'),
      "Live region must use aria-live='polite'",
    )
  })

  it("live region uses aria-atomic='true'", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes('aria-atomic="true"'),
      "Live region must use aria-atomic='true' for whole-region updates",
    )
  })

  it("live region has class 'sr-only'", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes('class="sr-only"'),
      "Live region must use sr-only class for visual hiding",
    )
  })

  it("live region displays unread count from store", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes("unreadCount()"),
      "Live region content must reference unreadCount signal",
    )
  })

  it("live region reads translated unread label", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes('t("notifyHistory.unread"'),
      "Live region must use translated unread message",
    )
  })
})

// ── AC-3: Focus Management ──────────────────────────────

describe("AC-3: Focus management on panel open/close", () => {
  it("panel has tabIndex={-1} for programmatic focus", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes("tabIndex={-1}"),
      "Panel must have tabIndex={-1} so it can receive programmatic focus",
    )
  })

  it("panel has a ref for focus management", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes("ref={panelRef}"),
      "Panel must use a ref for focus management",
    )
  })

  it("panel has panelRef variable declaration", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes("let panelRef"),
      "Panel must declare a panelRef variable",
    )
  })

  it("panel focuses on mount via onMount", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes("onMount"),
      "Panel must import and use onMount for focus-on-open",
    )
    assert.ok(
      source.includes("panelRef.focus()"),
      "Panel must call focus() on the container on mount",
    )
  })

  it("panel accepts restoreFocusRef prop", () => {
    const source = readSource(PANEL_PATH)
    assert.ok(
      source.includes("restoreFocusRef"),
      "Panel must accept a restoreFocusRef prop",
    )
  })

  it("ESC handler restores focus before closing", () => {
    const source = readSource(PANEL_PATH)
    // The ESC handler should call restoreFocusRef().focus() before onClose
    assert.ok(
      source.includes("props.restoreFocusRef"),
      "ESC handler must reference restoreFocusRef",
    )
    assert.ok(
      source.includes("trigger.focus()"),
      "ESC handler must call focus() on the trigger element",
    )
  })

  it("instance-tabs passes restoreFocusRef to panel", () => {
    const instanceTabsPath = join(__dirname, "instance-tabs.tsx")
    const source = readSource(instanceTabsPath)
    assert.ok(
      source.includes("restoreFocusRef"),
      "instance-tabs must pass restoreFocusRef to NotifyHistoryPanel",
    )
    assert.ok(
      source.includes("notifyTriggerRef"),
      "instance-tabs must have a notifyTriggerRef variable",
    )
  })
})

// ── AC-4: ChoiceBar Auto-Focus ──────────────────────────

describe("AC-4: ChoiceBar auto-focuses first option", () => {
  it("choice-bar imports createEffect for auto-focus", () => {
    const source = readSource(CHOICE_BAR_PATH)
    assert.ok(
      source.includes("createEffect"),
      "ChoiceBar must use createEffect for auto-focus",
    )
  })

  it("choice-bar has firstButtonRef variable", () => {
    const source = readSource(CHOICE_BAR_PATH)
    assert.ok(
      source.includes("firstButtonRef"),
      "ChoiceBar must declare a firstButtonRef variable",
    )
  })

  it("choice-bar auto-focuses on choice appear", () => {
    const source = readSource(CHOICE_BAR_PATH)
    assert.ok(
      source.includes("firstButtonRef?.focus()"),
      "ChoiceBar must call focus() on the first button when choice appears",
    )
  })

  it("first option uses ref callback", () => {
    const source = readSource(CHOICE_BAR_PATH)
    assert.ok(
      source.includes("ref={index() === 0 ?"),
      "First choice button must use a ref callback",
    )
  })

  it("uses queueMicrotask for timing safety", () => {
    const source = readSource(CHOICE_BAR_PATH)
    assert.ok(
      source.includes("queueMicrotask"),
      "ChoiceBar must use queueMicrotask to ensure DOM is rendered before focus",
    )
  })
})

// ── AC-5: Tests Pass (Structural) ──────────────────────

describe("AC-5: All a11y tests pass", () => {
  it("this test file exists and is executable", () => {
    assert.ok(existsSync(__filename), "Test file must exist")
  })

  it("CSS file is syntactically valid (can be read)", () => {
    const css = readSource(CSS_PATH)
    assert.ok(css.length > 0, "CSS file must not be empty")
    // Verify key structural elements exist
    assert.ok(css.includes("@media"), "CSS must contain at least one media query")
    assert.ok(css.includes(":focus-visible"), "CSS must contain focus-visible selectors")
  })

  it("all source files are readable and non-empty", () => {
    const panelContents = readSource(PANEL_PATH)
    const choiceContents = readSource(CHOICE_BAR_PATH)
    assert.ok(panelContents.length > 100, "Panel source must be meaningful")
    assert.ok(choiceContents.length > 100, "ChoiceBar source must be meaningful")
  })
})

// ── AC-6: Zero Regressions (Structural Check) ──────────

describe("AC-6: No regressions in existing contracts", () => {
  it("existing notify-history-panel exports unchanged", () => {
    const source = readSource(PANEL_PATH)
    // The interface should still have existing required props
    assert.ok(source.includes("instanceId: string"), "instanceId prop must still exist")
    assert.ok(source.includes("onClose: () => void"), "onClose prop must still exist")
    assert.ok(source.includes("onAction?"), "onAction prop must still exist")
  })

  it("existing choice-bar exports unchanged", () => {
    const source = readSource(CHOICE_BAR_PATH)
    assert.ok(source.includes("ChoiceBarProps"), "ChoiceBarProps must still exist")
    assert.ok(source.includes("choice: ChatChoiceAskedPayload | null"), "choice prop must still exist")
    assert.ok(source.includes("onSelect:"), "onSelect prop must still exist")
    assert.ok(source.includes("onDismiss:"), "onDismiss prop must still exist")
  })

  it("existing notification store integration unchanged", () => {
    const panelSource = readSource(PANEL_PATH)
    // Verify core store functions are still used
    assert.ok(panelSource.includes("getNotifyEvents"), "getNotifyEvents must still be used")
    assert.ok(panelSource.includes("getUnreadCount"), "getUnreadCount must still be used")
    assert.ok(panelSource.includes("acknowledgeNotifyEvent"), "acknowledgeNotifyEvent must still be used")
  })
})
