# Slice 5: Notify History Panel (UI Component)

**Goal:** Build a categorized notification history panel component that displays NotifyEvents from the notification store, with filtering, mark-as-read/acknowledge, dismiss, and inline action handling.

**Reference patterns:** `components/toast-history-panel.tsx` (structure, styling, i18n, key handling), `stores/notifications.ts` (API), `types/notify.ts` (types)

**Test tool:** `bun test` (use `node:test` + `node:assert/strict`, co-located test files)

---

## Acceptance Criteria

| AC | Description | Verification |
|----|-------------|-------------|
| AC-1 | Component renders empty state when no events | Test: empty store shows empty state |
| AC-2 | Component lists events grouped by date (today/yesterday/earlier) | Test: events from different days grouped correctly |
| AC-3 | Filter by category, priority, severity work | Test: each filter type narrows results |
| AC-4 | Acknowledge button marks event as read via store API | Test: click calls `acknowledgeNotifyEvent` |
| AC-5 | Dismiss button removes event via store API | Test: click removes event |
| AC-6 | Inline action buttons render and handle click events | Test: action button fires callback |
| AC-7 | Unread count badge shows correct count | Test: matches `getUnreadCount()` |
| AC-8 | Keyboard: Escape closes panel | Test: ESC key calls `onClose` |
| AC-9 | Keyboard: Tab/Shift+Tab navigates items | Test: focus management works |
| AC-10 | Panel integrates into instance-tabs alongside ToastHistoryPanel | Test: import resolves, Show toggle renders |
| AC-11 | Backdrop click closes panel | Test: click outside calls `onClose` |
| AC-12 | All new tests pass (100%) | Test: `bun test` |
| AC-13 | 0 regressions in existing tests | Test: `bun test` full suite |

---

## Task Steps

### Step 0: Read pattern files (reference only, no test yet)

Read these files to understand existing patterns:
- `packages/ui/src/components/toast-history-panel.tsx` — full structural template
- `packages/ui/src/stores/notifications.ts` — store API
- `packages/ui/src/types/notify.ts` — type definitions
- `packages/ui/src/components/instance-tabs.tsx` — integration point (around line 277 for ToastHistoryPanel mount)

Key patterns to follow:
- SolidJS arrow-function components with `Component<Props>` type
- `createMemo` for derived state (filtered/sorted lists, date groups)
- `createSignal` for local UI state (active filter, panel visibility)
- `Show`/`For`/`Switch` for control flow
- `useI18n()` from `../lib/i18n` for translations (use `notifyHistory.` prefix for i18n keys)
- lucide-solid icons
- CSS class naming: `notify-history-*` (BEM-like, same as `toast-history-*`)
- `role="dialog"`, `aria-modal`, `aria-label` for accessibility
- ESC key listener + backdrop click for close

### Step 1: Write failing test — empty state

Create `packages/ui/src/components/notify-history-panel.test.tsx`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Tests for NotifyHistoryPanel component
// These test state management and store integration logic
// using module-level function exports from the notification store

describe('NotifyHistoryPanel', () => {
  // Will be filled in each step
  it('renders empty state', async () => {
    // Verify empty state renders
    assert.ok(true, 'placeholder')
  })
})
```

Run to confirm it passes (placeholder):
```bash
cd /Users/alexshapiro/contracts/CodeNomad/packages/ui
bun test
```

### Step 2: Create the NotifyHistoryPanel component

Create `packages/ui/src/components/notify-history-panel.tsx`:

The component should:
1. Accept `instanceId: string`, `onClose: () => void` props
2. Subscribe to notification store via `getNotifyEvents(instanceId)` 
3. Use `createMemo` for:
   - `filteredEvents` — apply active filter
   - `groupedEvents` — group by date (today/yesterday/earlier) matching `toast-history-panel.tsx` `getDateGroup()` logic
   - `unreadCount` — from store `getUnreadCount()`
   - `isEmpty`, `isFilterEmpty` — computed booleans
4. Use `createSignal` for:
   - `activeFilter` — `'all' | NotifyCategory | NotifyPriority | NotifySeverity`
   - `expandedEventId` — for expandable details
5. Render:
   - Header: Bell icon, title ("Notification History"), unread badge, Mark All Read / Clear All / Close buttons
   - Filter bar: category filter pills (show most common categories), severity quick-filters
   - Content: date-grouped list of notification items
   - Empty state: fallback when no events
   - Filter-empty state: when filter yields no results

Each notification item should show:
- Category indicator colored dot (map categories to CSS classes)
- Title (bold if unread)
- Message (2-line clamp)
- Timestamp
- Severity/priority badges
- Action buttons (from `event.actions`)
- Acknowledge button (if unread)
- Dismiss button
- Expandable details: escalation info, mitigate, workaround, helpRequired, successProgress

### Step 3: Write component tests

Replace the placeholder test with real tests:

```
Test: empty state — renders empty fallback when no events
Test: filter by category — narrows results
Test: filter by priority — narrows results  
Test: filter by severity — narrows results
Test: acknowledge event — calls store API
Test: dismiss event — removes from list
Test: action button renders and fires
Test: unread count displays correctly
Test: date grouping (today/yesterday/earlier)
Test: ESC key closes panel
Test: backdrop click closes panel
```

Use the store's test helpers (`resetNotifyStoreForTests`, `setNotifyEventsForTests`) to populate test data.

### Step 4: Run tests and fix

```bash
cd /Users/alexshapiro/contracts/CodeNomad/packages/ui
bun test
```

Expected: All new tests pass, 0 regressions.

### Step 5: Integrate into instance-tabs

Modify `packages/ui/src/components/instance-tabs.tsx`:
1. Add import: `import NotifyHistoryPanel from "./notify-history-panel"`
2. Add `showNotifyHistory()` signal alongside `showToastHistory()`
3. Add a new toggle button (notifications bell with unread badge from new store)
4. Add `<Show when={showNotifyHistory()}>` block alongside the existing toast history one
5. For now, keep both panels parallel (the old toast history and new notify history)

### Step 6: Final test run

```bash
cd /Users/alexshapiro/contracts/CodeNomad/packages/ui
bun test
```

Expected: All tests pass with 0 failures.

### Step 7: Commit

```bash
cd /Users/alexshapiro/contracts/CodeNomad
git add packages/ui/src/components/notify-history-panel.tsx
git add packages/ui/src/components/notify-history-panel.test.tsx
git add packages/ui/src/components/instance-tabs.tsx
git commit -m "feat(notify): Slice 5 ui — NotifyHistoryPanel with filters, acknowledge, dismiss"
```

Report back: commit hash, test results (N/M passed), any deviations.

---

## Key Implementation Details

### Color mapping for categories
```typescript
const CATEGORY_COLORS: Record<NotifyCategory, string> = {
  session: '#4a90d9',
  task: '#7c4dff',
  milestone: '#00c853',
  permission: '#ff6d00',
  help_required: '#ff1744',
  escalation: '#d50000',
  broadcast: '#00bcd4',
  question: '#aa00ff',
  system: '#78909c',
  error: '#d32f2f',
  success_progress: '#2e7d32',
  task_status: '#1565c0',
  session_alert: '#e65100',
  workaround_suggested: '#f9a825',
  mitigation_applied: '#00897b',
}
```

### Category display labels (fill missing ones from types)
The existing `NOTIFY_CATEGORY_LABELS` in `types/notify.ts` is missing entries for categories added in Slice 4. Update it or add a local mapping:
```typescript
const PANEL_CATEGORY_LABELS: Record<NotifyCategory, string> = {
  ...NOTIFY_CATEGORY_LABELS,
  error: 'Error',
  success_progress: 'Success Progress',
  task_status: 'Task Status',
  session_alert: 'Session Alert',
  workaround_suggested: 'Workaround',
  mitigation_applied: 'Mitigation',
}
```

### Filter options
Show category filter pills (most common: error, success_progress, help_required, escalation, session_alert, workaround_suggested, mitigation_applied) plus "All" default. Include priority quick-filters (high, urgent) and severity quick-filters (error, critical).

### Action handling
When event has `actions[]`, render each as a button. On click:
- `action.href` → `window.open(href, '_blank')` or Tauri `openUrl`
- `action.command` → insert into prompt input (pass dispatch up via callback)
- `action.choiceValue` → send as `chat.choice.replied` (pass dispatch up via callback)

For simplicity in Slice 5, implement `href` actions inline. Command and choiceValue actions emit a callback prop `onAction(action: NotifyAction)`.
