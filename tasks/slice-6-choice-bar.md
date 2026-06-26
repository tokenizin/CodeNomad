# Slice 6 — ChoiceBar (UI)

## Summary

Implement the ChoiceBar — an inline choice button bar that appears above the prompt input textarea when the system presents structured choices to the user. This includes: SSE event types (`chat.choice.*`), ChoiceBar component, keyboard shortcuts (1-9, Esc), and integration into `prompt-input.tsx`.

## Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|-------------|
| AC-1 | `ChatChoiceAskedEvent`, `ChatChoiceRepliedEvent`, `ChatChoiceExpiredEvent` defined in SSEEvent union with typed `properties` | TypeScript compiles without `as` casts |
| AC-2 | SSEManager has `onChoiceAsked`, `onChoiceReplied`, `onChoiceExpired` callbacks + switch cases | Grep for those names in sse-manager.ts |
| AC-3 | `ChatChoiceAskedEvent` interface has `id`, `choices: {label, value}[], multiple?, title?, timeout?` | Type definition readable |
| AC-4 | ChoiceBar renders above textarea inside `prompt-input-main`, only when `activeChoice()` is non-null | Test: renders when data present, hidden when null |
| AC-5 | Each choice renders as a clickable button with the option number prefix (e.g., "1. View balance") | Test: buttons render with correct labels |
| AC-6 | Number keys 1-9 select the corresponding option | Test: keyboard events trigger selection |
| AC-7 | Escape dismisses the choice bar | Test: Esc fires dismiss callback |
| AC-8 | Choice bar auto-hides when `chat.choice.expired` SSE arrives | Test: expired event clears active choice |
| AC-9 | Server-side choice types mirrored in `packages/server/src/notify/types.ts` | Test: type file exports ChatChoice types |
| AC-10 | All new tests pass (100%) | `bun test` in packages/ui |
| AC-11 | 0 regressions in existing tests | Same `bun test` run |

## Step-by-step

### Step 1: Research existing patterns

Before writing code, read these files:

```bash
# SSE manager — existing event patterns (question.asked, notify.*)
less packages/ui/src/lib/sse-manager.ts

# Server-side notify types — where to mirror choice types
less packages/server/src/notify/types.ts

# prompt-input.tsx — integration point
less packages/ui/src/components/prompt-input.tsx

# toast-history-panel — pattern for ESC key handler
less packages/ui/src/components/toast-history-panel.tsx
```

### Step 2: Add server-side ChatChoice types

**File:** `packages/server/src/notify/types.ts`

Add after existing type definitions:

```typescript
/** Choice option presented to the user */
export interface ChatChoiceOption {
  label: string;
  value: string;
}

/** Payload for chat.choice.asked event */
export interface ChatChoiceAskedPayload {
  id: string;
  choices: ChatChoiceOption[];
  /** Allow multiple selections (default false) */
  multiple?: boolean;
  /** Optional title/context */
  title?: string;
  /** Auto-dismiss timeout in seconds */
  timeout?: number;
}

/** Payload for chat.choice.replied event */
export interface ChatChoiceRepliedPayload {
  id: string;
  value: string | string[];
}

/** Payload for chat.choice.expired event */
export interface ChatChoiceExpiredPayload {
  id: string;
}
```

Create test file `packages/server/src/notify/__tests__/types-choice.test.ts`:

```typescript
import { describe, it } from "node:test"
import assert from "node:assert/strict"

// Test type exports (compilation check)
describe("ChatChoice types", () => {
  it("ChatChoiceOption has label and value", () => {
    const o: ChatChoiceOption = { label: "Yes", value: "yes" }
    assert.equal(o.label, "Yes")
    assert.equal(o.value, "yes")
  })

  it("ChatChoiceAskedPayload has id and choices", () => {
    const p: ChatChoiceAskedPayload = {
      id: "c1",
      choices: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
    }
    assert.equal(p.id, "c1")
    assert.equal(p.choices.length, 2)
  })

  // ... add more tests
})
```

### Step 3: Add UI-side ChatChoice types

**File:** `packages/ui/src/types/notify.ts`

Add the same three interfaces + payloads (mirroring server types). Follow the existing pattern used by `NotifyEvent` types.

Copy the server types + export them. File already exists — append.

Create test file `packages/ui/src/types/notify-choice.test.ts` to verify types compile and are constructable.

### Step 4: Add SSE event types + callbacks

**File:** `packages/ui/src/lib/sse-manager.ts`

1. Add three interfaces to the SSEEvent union:
   - `ChatChoiceAskedEvent { type: "chat.choice.asked", properties?: { payload: ChatChoiceAskedPayload } }`
   - `ChatChoiceRepliedEvent { type: "chat.choice.replied", properties?: { payload: ChatChoiceRepliedPayload } }`
   - `ChatChoiceExpiredEvent { type: "chat.choice.expired", properties?: { payload: ChatChoiceExpiredPayload } }`

2. In the SSEManager class (the `handleEvent` switch), add three cases:
   - `case "chat.choice.asked":` → call `this.onChoiceAsked?.(event)`
   - `case "chat.choice.replied":` → call `this.onChoiceReplied?.(event)`
   - `case "chat.choice.expired":` → call `this.onChoiceExpired?.(event)`

3. Add callback properties:
   - `onChoiceAsked?: (event: ChatChoiceAskedEvent) => void`
   - `onChoiceReplied?: (event: ChatChoiceRepliedEvent) => void`
   - `onChoiceExpired?: (event: ChatChoiceExpiredEvent) => void`

### Step 5: Create ChoiceBar component

**File:** `packages/ui/src/components/choice-bar.tsx`

Follow the pattern from `toast-history-panel.tsx` (SolidJS arrow-function component, `createSignal`, `createMemo`, `createEffect`, `Show`/`For` control flow, `lucide-solid` icons, CSS classes).

Props:
```typescript
interface ChoiceBarProps {
  choice: ChatChoiceAskedPayload | null;
  onSelect: (value: string | string[]) => void;
  onDismiss: () => void;
}
```

Features:
- Render only when `choice` is non-null
- Show title in bold (when present)
- Each option as a button: `{index + 1}. {label}` 
- `multiple` mode: allow selecting multiple -> show "Confirm" button
- Single mode: clicking an option immediately selects it
- ESC dismisses (document-level keydown listener)
- Options visible at a glance, compact layout
- `role="group"` / `aria-label` on the container
- `aria-live="polite"` for dynamic content

### Step 6: Create ChoiceBar tests

**File:** `packages/ui/src/components/choice-bar.test.ts`

Use `node:test` with `node:assert/strict`. Test the pure component logic and keyboard handling via exported test helpers.

Write tests for:
- Empty/null choice → nothing rendered
- Single choice renders buttons
- Multiple choice renders buttons + confirm
- Number key selects option
- Esc dismisses
- Expired event clears choice
- aria-live region present

### Step 7: Integrate into prompt-input.tsx

**File:** `packages/ui/src/components/prompt-input.tsx`

1. Import ChoiceBar and the ChatChoice types
2. Add `activeChoice` signal state
3. Add SSE listeners for `chat.choice.asked`, `chat.choice.replied`, `chat.choice.expired`
4. Insert `<ChoiceBar>` between `prompt-input-field-container` closing div and `prompt-input-actions`
5. `onSelect` → send the chosen value via `chat.choice.replied` through the API or callback
6. `onDismiss` → clear active choice

```typescript
import ChoiceBar from "./choice-bar"
import type { ChatChoiceAskedPayload } from "../types/notify"
import { getActiveInstance } from "../stores/instances"
```

Look at the JSX at line ~910 (inside `prompt-input-main`). Insert after the field-container div:

```tsx
<Show when={activeChoice()}>
  <ChoiceBar
    choice={activeChoice()}
    onSelect={(value) => {
      // Handle selection
      setActiveChoice(null)
    }}
    onDismiss={() => setActiveChoice(null)}
  />
</Show>
```

### Step 8: Register choice API endpoint

**File:** `packages/server/src/server/http-server.ts`

Follow the `registerNotificationRoutes` pattern. Add:

```typescript
import { registerChoiceRoutes } from "./routes/choices"
// ...
registerChoiceRoutes(app, { notifyRegistry })
```

**File:** `packages/server/src/server/routes/choices.ts`

POST /api/choices/reply — accept `{ instanceId, id, value }` → publish `chat.choice.replied` via EventBus/WS

### Step 9: Run tests

```bash
cd /Users/alexshapiro/contracts/CodeNomad
npm run test --workspace=@codenomad/ui
```

Verify:
- All new choice tests pass
- All existing tests still pass (0 regressions)

### Step 10: Commit

```bash
cd /Users/alexshapiro/contracts/CodeNomad
git add -A
git commit -m "feat(notify): Slice 6 ui — ChoiceBar with SSE events, keyboard nav, prompt-input integration"
```
