# Slice 7 — QA Matrix & Integration Tests

## Summary

Build a comprehensive integration test suite covering the full notification system (Slices 1-6) as end-to-end integration tests. This is NOT about unit testing individual functions — those already exist. This is about coverage gaps between the layers.

## Existing Test Coverage (Do Not Duplicate)

| Layer | Test File | Tests | What It Covers |
|-------|-----------|-------|-----------------|
| UI types | `ui/src/types/notify.test.ts` | 38 | Schema creation, ID gen, expiry, comparator, filter function, lookup tables |
| UI storage | `ui/src/lib/notifications-storage.test.ts` | 31 | Persistence, LRU cap, TTL, schema versioning, add/update/remove/ack/escalate |
| UI store | `ui/src/stores/notifications.test.ts` | 11 | Store lifecycle, filter/sort delegation, unread count, REST API delegation |
| UI choice types | `ui/src/types/notify-choice.test.ts` | 7 | ChatChoicePayload interfaces constructable |
| UI ChoiceBar | `ui/src/components/choice-bar.test.ts` | 26 | Rendering, selection logic, keyboard nav (1-9, Esc), dismiss |
| UI history panel | `ui/src/components/notify-history-panel.test.ts` | 40 | Date grouping, filters, acknowledge, dismiss, action buttons, empty states |
| Server types | `server/src/notify/__tests__/types.test.ts` | 9 | Server type construction |
| Server choice types | `server/src/notify/__tests__/types-choice.test.ts` | 9 | Server ChatChoice types |
| Server registry | `server/src/notify/__tests__/registry.test.ts` | 43 | Registry CRUD, filter, sort, LRU trim, TTL expiry, broadcast callback, metrics |
| Server REST routes | `server/src/server/routes/notifications.test.ts` | 30 | REST list/filter/CRUD/error handling |
| Server producers | `server/src/notify/producers/__tests__/background-processes.test.ts` | 7 | Process status → NotifyCategory mapping |
| Server producers | `server/src/notify/producers/__tests__/orchestrator.test.ts` | 12 | Orchestrator onLog → NotifyEvent mapping |
| Server producers | `server/src/notify/producers/__tests__/choices.test.ts` | ? | Choice server types |

**Total existing tests:** ~260 notify tests

## Acceptance Criteria

| ID | Criterion | How to Verify |
|----|-----------|---------------|
| AC-1 | WS roundtrip: server `notify.create` broadcast → UI store receives event | Create NotifyEvent via REST POST, verify WS envelope `notify.create` fires, UI test store receives it |
| AC-2 | Cross-instance isolation: events for instance A don't appear in instance B's list | Register events for instance IDs "a" and "b" — list("a") only returns "a" events |
| AC-3 | LRU eviction: registry drops oldest events when cap reached | Register 501+ events for same instance, verify oldest is evicted |
| AC-4 | TTL expiry: expired events excluded from listings | Register event with 10ms TTL, wait 20ms, verify it's excluded from list |
| AC-5 | Combined filter at server REST layer: category + priority + severity | GET /api/notifications?category=error&priority=high&severity=critical returns only matching |
| AC-6 | Combined filter at UI store layer: same filter via store API | `getNotifyEvents({category:'error', priority:'high', severity:'critical'})` returns only matching |
| AC-7 | ChoiceBar lifecycle: `chat.choice.asked` → user selects → `chat.choice.replied` (via WS roundtrip) | Publish asked via REST/WS, simulate selection, verify replied event received |
| AC-8 | ChoiceBar lifecycle: `chat.choice.asked` → expires → `chat.choice.expired` | Publish asked, trigger expiry, verify expired event received via WS |
| AC-9 | Producer mapping: orchestrator `NODE_FAILED` → registry contains `error` category + `high` priority | Simulate orchestrator onLog(NODE_FAILED), verify events in registry |
| AC-10 | Producer mapping: background process `finished` → registry contains `success_progress` category | Simulate process completion, verify registry event |
| AC-11 | Error handling: POST create with missing required fields returns 400 | POST `/api/notifications` with empty body, expect 400 |
| AC-12 | Error handling: PATCH non-existent ID returns 404 | PATCH `/api/notifications/nonexistent` with ack, expect 404 |
| AC-13 | Error handling: DELETE non-existent instance returns 404 | DELETE `/api/notifications/nonexistent/instance`, expect 404 |
| AC-14 | Toast bridge fires for high/urgent priority and critical severity | Create event with priority='urgent', verify `showToastNotification` was invoked |
| AC-15 | All new QA tests pass (100%) | `node --test path/to/test/file.ts` returns 0 |
| AC-16 | 0 regressions in existing tests | Run all existing notify tests, all still pass |

## Test File Structure

Create a single integration test file:

- **Server-side:** `packages/server/src/notify/__tests__/qa-integration.test.ts`

This file tests the server-side integration points (registry + REST + events) end-to-end.

**Note:** No browser-level (Playwright) test is needed for this slice. The integration tests verify the server-side contracts and event flows that the UI reacts to. The UI-side ChoiceBar, store, and panel are already unit-tested in Slices 3, 5, and 6.

For UI-side tests that need the store alive:
- **UI-side:** `packages/ui/src/stores/notifications.qa.test.ts` — additional integration scenarios for the store (combined filters, cross-instance isolation via store API, toast bridge invocation tracking)

## Test Design

### Test 1: WS Roundtrip (Server)
1. Create a NotifyRegistry with a mock broadcast callback
2. Subscribe the mock to track WS envelope emissions
3. Create an event via `registry.register()`
4. Verify broadcast callback was called with `{ type: 'notify.create', payload: { event: {...} } }`
5. Verify the event ID in the broadcast matches the registered event

### Test 2: Cross-Instance Isolation
1. Register 3 events for instance "a"
2. Register 2 events for instance "b"
3. GET `/api/notifications?instanceId=a` — returns exactly 3 events
4. GET `/api/notifications?instanceId=b` — returns exactly 2 events
5. Registry `list('a')` returns only 3 events, no "b" events

### Test 3: LRU Eviction
1. Create registry with `maxEvents: 5`
2. Register 6 events for same instance
3. Verify oldest event is evicted (length === 5, oldest id not present)
4. Verify eviction event type in metrics

### Test 4: TTL Expiry
1. Register event with `ttlMs: 50`
2. Immediately verify event appears in list (not yet expired)
3. After 100ms, verify event excluded from list
4. Verify can still GET by ID directly (expiry is for listings, not hard delete)

### Test 5: Combined REST Filter
1. POST /api/notifications with various category/priority/severity combos
2. GET /api/notifications?category=error&priority=high&severity=critical
3. Verify only matching events returned
4. Test at least 4 different filter combos with expected results

### Test 6: Combined UI Store Filter
1. Load events into store via `setEvents()`
2. Call `getNotifyEvents({category:'error', priority:'high', severity:'critical'})`
3. Verify only matching events returned
4. Test same 4 combos as Test 5 for cross-layer consistency

### Test 7: ChoiceBar lifecycle — asked → replied
1. Publish `chat.choice.asked` via EventBus/WS mechanism
2. Simulate user selecting choice value "yes"
3. POST `/api/choices/reply` with the choice ID and value
4. Verify replied event is broadcast with matching ID and value
5. Verify reply payload has correct `{id, value}` shape

### Test 8: ChoiceBar lifecycle — asked → expired
1. Publish `chat.choice.asked` with timeout=1s
2. Wait for expiry
3. Verify expired event is broadcast with matching ID
4. Verify expired payload has correct `{id}` shape

### Test 9: Orchestrator Producer Mapping
1. Call `createNotifyFromOrchestratorLog` (from producers/orchestrator.ts) with `eventType: 'NODE_FAILED'`
2. Verify the created event has `category: 'error'`
3. Test all mapping paths: NODE_COMPLETED→success_progress, NODE_RETRY→workaround_suggested, HEALING_ACTION→mitigation_applied, ERROR→error, BROADCAST_SENT→broadcast, WORKFLOW_COMPLETED→success_progress, NODE_STARTED→task_status

### Test 10: Background Process Producer Mapping
1. Call `maybeNotifyOnProcessEvent` with `{status:'finished'}`
2. Verify event has `category:'success_progress'`, `priority:'normal'`, `severity:'info'`
3. Test all mapping paths: error→error/high/critical, user_stopped→task_status/low/warning, user_terminated→task_status/low/warning

### Test 11: REST Error Handling — POST Validation
1. POST `/api/notifications` with empty body — expect 400
2. POST with missing `title` — expect 400
3. POST with missing `instanceId` — expect 400
4. POST with invalid `priority` value — expect 400

### Test 12: REST Error Handling — PATCH/DELETE Not Found
1. PATCH `/api/notifications/nonexistent-id` — expect 404
2. DELETE `/api/notifications/nonexistent-instance/nonexistent-id` — expect 404

### Test 13: Toast Bridge (UI Store Integration)
1. Set up store with a spy on toast invocation
2. Call store's WS listener directly with a `notify.create` event
3. Test with priority='urgent' — toast bridge should fire
4. Test with priority='low' — toast bridge should NOT fire
5. Test with severity='critical' — toast bridge should fire
6. Test with severity='info' — toast bridge should NOT fire
7. Test with priority='high' — toast bridge should fire

## How to Run

Server tests:
```bash
node --test /Users/alexshapiro/contracts/CodeNomad/packages/server/src/notify/__tests__/qa-integration.test.ts
```

UI store tests:
```bash
cd /Users/alexshapiro/contracts/CodeNomad/packages/ui && node --test src/stores/notifications.qa.test.ts
```

Full regression:
```bash
# Run ALL existing notify tests to confirm 0 regressions
node --test /Users/alexshapiro/contracts/CodeNomad/packages/server/src/notify/__tests__/
cd /Users/alexshapiro/contracts/CodeNomad/packages/ui && node --test src/stores/notifications.test.ts src/stores/notifications.qa.test.ts
```

## Commit

```bash
cd /Users/alexshapiro/contracts/CodeNomad
git add -A
git commit -m "test(notify): Slice 7 qa — integration matrix tests for full notify system"
```

## Pre-existing Failures

These test failures existed BEFORE Slice 1 and are NOT your concern:
- `session-status.test.ts` (solid-toast server-side import error) — ignore
