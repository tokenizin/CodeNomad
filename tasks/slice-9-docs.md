# Slice 9: Documentation

**Complexity:** tiny
**Slice:** docs
**Track:** implementation

## Summary

Close out the notification & choice feature by updating product documentation to reflect the final implementation.

## What was built

A new categorized notification system in CodeNomad with:
- **`notify.*` event family**: 9 categories (broadcast, error, escalation, help_required, info, mitigation_applied, session_alert, success_progress, system, task_status, workaround_suggested), 4 priorities (low/normal/high/urgent), 5 severities (info/low/medium/high/critical)
- **NotifyEvent schema**: typed events with escalation, mitigate, workaround, helpRequired, successProgress, actions (href/command/choiceValue)
- **NotifyRegistry** (server): LRU 500 cap, TTL 7 days, 6 REST endpoints (GET/POST/PATCH/DELETE), WS broadcast
- **NotifyStore** (UI): SolidJS signal store, localStorage persistence, toast bridge for high-priority/critical events
- **Producers**: background process, orchestrator DAG, session events, permission/question hooks
- **NotifyHistoryPanel**: UI panel with date grouping, category/priority/severity filters, acknowledge/dismiss, inline actions, unread badge
- **ChoiceBar**: Inline choice buttons (1-9 keyboard), single/multiple selection, countdown timer
- **QA integration tests**: 70 tests covering WS roundtrip, LRU, TTL, filters, error handling
- **A11y**: prefers-reduced-motion, aria-live region, focus management, auto-focus

## Files to update

1. **Design doc** (`docs/plans/2026-06-27-codenomad-notifications-and-choices-design.md`) — Verify it accurately reflects what was built. Update sections if final implementation deviated.

2. **CodeMap** (`codemap.yml`) — Add entries for the new files:
   - `packages/ui/src/types/notify.ts` (NotifyEvent schema)
   - `packages/ui/src/lib/notifications-storage.ts` (localStorage persistence)
   - `packages/ui/src/stores/notifications.ts` (SolidJS signal store)
   - `packages/ui/src/components/notify-history-panel.tsx` (UI panel)
   - `packages/ui/src/components/choice-bar.tsx` (ChoiceBar)
   - `packages/ui/src/styles/components/notify-history.css` (a11y CSS)
   - `packages/server/src/notify/` (server-side: types, registry, producers, routes)
   - `packages/server/src/server/routes/notifications.ts` (REST endpoints)
   - `packages/server/src/server/routes/choices.ts` (choice reply endpoint)

3. **Product/Feature docs** — Create or update a feature overview in the CodeNomad docs area (check if `docs/notifications/` or similar exists).

## Acceptance Criteria

| AC | Description |
|----|-------------|
| AC-1 | Design doc reflects final implementation (deviations noted if any) |
| AC-2 | CodeMap has entries for all new modules |
| AC-3 | Feature documentation added/updated |
| AC-4 | All changes committed in CodeNomad |
