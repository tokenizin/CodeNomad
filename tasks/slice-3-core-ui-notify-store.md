# Slice 3: core-ui — Solid Signal Store for Notifications

**Goal:** Create `packages/ui/src/stores/notifications.ts` — a SolidJS signal-based reactive store that mirrors the server-side `NotifyRegistry` on the client, listens for WS push events via `sseManager`, and exposes a clean CRUD/filter/subscribe API.

## Design Context

The foundation types (`packages/ui/src/types/notify.ts`) and server registry/REST/WS (`packages/server/src/`) are already committed. This store is the client-side reactive bridge.

## Requirements

### R1: Signal Store (`stores/notifications.ts`)

Follow the **exact pattern** from:
- `stores/alerts.ts` — module-level `createSignal`, simple getters/setters
- `stores/background-processes.ts` — `Map<string, T[]>` keyed by instanceId, SSE event listeners

**Store structure:**

```typescript
import { createSignal } from "solid-js"
import type {
  NotifyEvent, NotifyFilter, NotifySort, NotifySortField, NotifySortDirection,
} from "../types/notify"
import { sseManager } from "../lib/sse-manager"
import { serverApi } from "../lib/api-client"

// Module-level signal: instanceId → NotifyEvent[]
const [notifyEvents, setNotifyEvents] = createSignal<Map<string, NotifyEvent[]>>(new Map())

// Unread count signal (total across all instances)
const [unreadCount, setUnreadCount] = createSignal(0)

// === Internal helpers ===
function recalcUnreadCount(): void { /* sum of !read across all instances */ }

function setEvents(instanceId: string, events: NotifyEvent[]): void {
  setNotifyEvents(prev => { /* ... Map copy + set */ })
  recalcUnreadCount()
}

function addEvent(instanceId: string, event: NotifyEvent): void {
  /* prepend to array, trim to 500 */
}

function updateEvent(instanceId: string, id: string, patch: Partial<NotifyEvent>): void {
  /* find + merge */
}

function removeEvent(instanceId: string, id: string): void {
  /* filter out */
}

// === Public API ===
function getNotifyEvents(instanceId: string, filter?: NotifyFilter, sort?: NotifySort): NotifyEvent[]
function getUnreadCount(): number
async function loadNotifyEvents(instanceId: string, filter?: NotifyFilter): Promise<void>
async function acknowledgeNotifyEvent(instanceId: string, id: string): Promise<void>
async function clearNotifyEvents(instanceId: string): Promise<void>
function getNotifyEventById(instanceId: string, id: string): NotifyEvent | undefined

// === WS event listeners ===
sseManager.onNotifyCreated = (instanceId, event) => { /* add + toast bridge */ }
sseManager.onNotifyUpdated = (instanceId, event) => { /* update */ }
sseManager.onNotifyRemoved = (instanceId, event) => { /* remove */ }
```

### R2: Toast Bridge

When a `notify.create` WS event arrives with `priority === 'high'` or `severity === 'critical'`, call `showToastNotification()` from `../lib/notifications` with appropriate variant mapping:
- `critical`/`error` → `error`
- `high`/`warning` → `warning`
- `medium`/`info` → `info`
- `low`/`success` → `success`

### R3: Filter + Sort

Reuse the `filterNotifyEvents()` and `sortNotifyEvents()` utilities from `../types/notify.ts`.

### R4: Tests (`stores/notifications.test.ts`)

**Testing pattern:** Follow `node:test` with `node:assert/strict`. See existing tests at `stores/delta-buffer.test.ts`, `stores/permission-auto-accept.test.ts`, `stores/message-prompt-display.test.ts` for the exact test style.

**Minimum test coverage:**
1. `setEvents/getNotifyEvents` — basic lifecycle (add, list)
2. `addEvent` — prepend to array, trim at 500
3. `updateEvent` — partial patch by id
4. `removeEvent` — removes from array
5. `unreadCount` — recalculates correctly through add/update/remove
6. `filter` — delegates to `filterNotifyEvents`
7. `sort` — delegates to `sortNotifyEvents`
8. `loadNotifyEvents` — sets loading state, fetches from API
9. `acknowledgeNotifyEvent` — PATCH REST + local state update
10. `clearNotifyEvents` — DELETE REST + local state clear

For tests that make HTTP calls, mock `serverApi` or provide a test double.

### R5: Export Index

Ensure all public symbols are re-exported from the UI package's main barrel export if one exists (check `packages/ui/src/index.ts` or similar).

## Test Execution

```bash
# Run only the new store tests
cd /Users/alexshapiro/contracts/CodeNomad
bun run test -- packages/ui/src/stores/notifications.test.ts

# Full regression
bun run test -- packages/ui/src/

# Server tests too
bun run test -- packages/server/src/
```

## Acceptance Criteria

- AC-1: Store compiles without type errors
- AC-2: All store tests pass (`node:test` + `node:assert/strict`)
- AC-3: WS event handlers wired correctly (onNotifyCreated/Updated/Removed)
- AC-4: Toast bridge fires for high-priority/critical events
- AC-5: Filter + sort delegate to shared utilities
- AC-6: API methods (load/acknowledge/clear) call correct REST endpoints
- AC-7: 0 regressions in existing UI + server tests
- AC-8: Commit with message: `feat(notify): Solid signal store + tests`

## Implementation Steps (TDD)

### Step 0: SSEManager callbacks (prerequisite)

Before the store, add `onNotifyCreated`, `onNotifyUpdated`, `onNotifyRemoved` callback properties to `SSEManager` class in `packages/ui/src/lib/sse-manager.ts`, plus the corresponding `case` branches in `handleEvent()`:

```typescript
// Add to the SSEEvent union type (already covered by catch-all, but add explicit types):
type NotifyCreatedEvent = { type: "notify.create"; properties: { event: NotifyEvent } }
type NotifyUpdatedEvent = { type: "notify.update"; properties: { id: string; instanceId: string; patch: Record<string, unknown> } }
type NotifyRemovedEvent = { type: "notify.remove"; properties: { id: string; instanceId: string } }

// Add to handleEvent switch after the "server.instance.disposed" case:
case "notify.create":
  this.onNotifyCreated?.(instanceId, event as NotifyCreatedEvent)
  break
case "notify.update":
  this.onNotifyUpdated?.(instanceId, event as NotifyUpdatedEvent)
  break
case "notify.remove":
  this.onNotifyRemoved?.(instanceId, event as NotifyRemovedEvent)
  break

// Add callback properties alongside existing ones:
onNotifyCreated?: (instanceId: string, event: NotifyCreatedEvent) => void
onNotifyUpdated?: (instanceId: string, event: NotifyUpdatedEvent) => void
onNotifyRemoved?: (instanceId: string, event: NotifyRemovedEvent) => void
```

### Step 1: Write tests → confirm failure

### Step 2: Implement store → pass tests

### Step 3: Run full regression → green

### Step 4: Commit
