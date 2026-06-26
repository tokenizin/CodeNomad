# Slice 4: Logic — Producers

**Goal:** Wire real event sources to the NotifyEvent system — server-side (BackgroundProcessManager, Orchestrator DAG onLog) and UI-side (session events, permission/question hooks).

**Acceptance Criteria:**
- AC-1: Background process completed → Server publishes `notify.create` via EventBus
- AC-2: Background process failed → Server publishes `notify.create` with priority 'high' or severity 'critical'
- AC-3: Orchestrator DAG `onLog()` → Server publishes `notify.create` via EventBus
- AC-4: Session idle/error/compacted events → UI creates NotifyEvent via notification store
- AC-5: Permission asked/answered → UI creates NotifyEvent via notification store
- AC-6: All new tests pass (100%)
- AC-7: 0 regressions in existing tests

---

## Sub-Task A: Server — Background Process Producer

**Files:**
- Modify: `packages/server/src/notify/producers/background-processes.ts` (new)
- Modify: `packages/server/src/notify/producers/__tests__/background-processes.test.ts` (new)
- Reference: `packages/server/src/background-processes/manager.ts` — uses `eventBus.publish()`

**Pattern to follow:**
The `BackgroundProcessManager` already publishes:
```typescript
eventBus.publish({
  type: "instance.event",
  instanceId,
  event: { type: "background.process.updated", properties: { process, instanceId } }
})
```

New producer function `maybeNotifyOnProcessEvent(process, instanceId)`:
- `status === 'completed'` → NotifyEvent with category: `'success_progress'`, priority: `'normal'`, severity: `'info'`
- `status === 'failed'` → NotifyEvent with category: `'error'`, priority: `'high'`, severity: `'critical'`
- `status === 'cancelled'` → NotifyEvent with category: `'task_status'`, priority: `'low'`, severity: `'warning'`
- Publishes via `eventBus.publish({ type: "instance.event", instanceId, event: { type: "notify.create", properties: { event: notifyEvent } } })`
- Maps `process.name` → `title`, `process.summary` → `message`
- `id` = `crypto.randomUUID()`, `timestamp` = `new Date().toISOString()`

**Tests (`background-processes.test.ts`):**
1. Completed process → publishes `notify.create` with category `'success_progress'`
2. Failed process → publishes with priority `'high'`
3. Failed process → publishes with severity `'critical'`
4. Cancelled process → publishes with category `'task_status'`
5. Non-terminal status (pending/running) → does not publish
6. Verify published event payload structure (id present, timestamp valid ISO, schemaVersion: 2)

---

## Sub-Task B: Server — Orchestrator DAG Producer

**Files:**
- Modify: `packages/server/src/notify/producers/orchestrator.ts` (new)
- Modify: `packages/server/src/notify/producers/__tests__/orchestrator.test.ts` (new)
- Reference: `packages/server/plugins/tokidapp/orchestrator/dag-engine.ts` — `onLog(eventType, severity, title, metadata)`

**Pattern:**
The orchestrator calls `onLog` with eventTypes: `NODE_STARTED`, `NODE_COMPLETED`, `NODE_FAILED`, `NODE_RETRY`, `BROADCAST_SENT`, `HEALING_ACTION`, `WORKFLOW_COMPLETED`, `ERROR`.

New function `createNotifyFromOrchestratorLog(eventType, severity, title, metadata, instanceId)`:
- Maps eventType → NotifyCategory:
  - `NODE_FAILED`, `ERROR` → `'error'`
  - `NODE_COMPLETED`, `WORKFLOW_COMPLETED` → `'success_progress'`
  - `NODE_RETRY`, `HEALING_ACTION` → `'workaround_suggested'` or `'mitigation_applied'`
  - `NODE_STARTED` → `'task_status'`
  - `BROADCAST_SENT` → `'info'`
- Maps severity string → NotifySeverity: 'critical'/'high'/'medium'/'low'/'info'
- `title` maps directly to NotifyEvent.title
- Publishes to EventBus the same way as background-processes producer

**Tests:**
1. `NODE_FAILED` → category `'error'`
2. `ERROR` → category `'error'`
3. `NODE_COMPLETED` → category `'success_progress'`
4. `WORKFLOW_COMPLETED` → category `'success_progress'`
5. `NODE_RETRY` → appropriate category
6. `HEALING_ACTION` → appropriate category
7. Critical severity → NotifySeverity `'critical'`
8. Verify full event structure

---

## Sub-Task C: UI — Session Events Producer

**Files:**
- Modify: `packages/ui/src/stores/session-events.ts` — add notify events for session.idle/error/compacted
- Test: Run existing session-events tests to verify no regressions (no new test expected here unless adding testable behavior)

**Pattern:**
In the session-events handler, where `showToastNotification` is currently called for session events, also call:
```typescript
import { addEvent } from './notifications'

// session.idle → NotifyEvent
// session.error → NotifyEvent
// session.compacted → NotifyEvent
```

**Mapping:**
- `session.idle` → category: `'session_alert'`, severity: `'warning'`, priority: `'normal'`
- `session.error` → category: `'error'`, severity: `'critical'`, priority: `'high'`
- `session.compacted` → category: `'info'`, severity: `'info'`, priority: `'low'`

Also add `mitigation_applied` entries when available from session metadata.

---

## Sub-Task D: UI — Permission/Question Hooks

**Files:**
- Modify: `packages/ui/src/stores/permission-auto-accept.ts` (if it exists) OR `packages/ui/src/stores/session-events.ts` (if permission events already handled there)
- Investigate where `question.asked`, `question.replied` events are handled

**Pattern:**
Find where `permission.updated` or `question.asked` SSE events are handled. Add notify event creation:
- `question.asked` → category: `'help_required'`, severity: `'medium'`
- `question.replied` → category: `'success_progress'`, severity: `'info'`
- `permission.updated` (approved) → category: `'success_progress'`
- `permission.updated` (blocked) → category: `'escalation'`, severity: `'high'`

---

## Steps

### Step 1: Write server-side producer tests (failing)
Create `background-processes.test.ts` and `orchestrator.test.ts` with the test cases described above.

Run: `bun test -- packages/server/src/notify/producers/__tests__/`
Expected: FAIL — tests reference unimplemented functions

### Step 2: Implement server-side producers
Create `background-processes.ts` and `orchestrator.ts` with the producer functions.

Re-run tests.
Expected: PASS

### Step 3: UI-side (session-events + permission/question hooks)
Modify `session-events.ts` and any permission/question handler to import and call the notification store's `addEvent()`.

Run: `bun test -- packages/ui/src/stores/`
Expected: PASS (no regressions)

### Step 4: Full regression run

```bash
cd /Users/alexshapiro/contracts/CodeNomad
bun test -- packages/ui/src/
```

Expected: All tests pass except pre-existing `session-status.test.ts` solid-toast failure.

```bash
bun test -- packages/server/src/notify/
```

Expected: All server-side notify tests pass.

### Step 5: Report back
Provide a SUMMARY.md-style report with:
- Files modified/created
- Test results counts
- Any AC gaps or decisions
