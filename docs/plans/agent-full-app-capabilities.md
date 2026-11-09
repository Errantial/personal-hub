# Full-app agent capabilities

Status: inventory, phase-1 implementation and recurring items, 2026-11-09. Phase 1 (registry, task/event delete/restore, study preferences, audit snapshots and undo) is implemented; the matrix marks the remaining phases. This follows the deployed context/reminder slice (PR #73, release `f99fdf7`).

## Inventory

The app exposes planner records (tasks, reminders, calendar series/occurrences, classes/topics, academic work, tracked deadlines, responsibilities/agents), mailbox records (connectors, messages, drafts, rules, broker grants), memory, study plans/goals, AI settings/routing/budget/actions, account/session state, and Recently deleted. The Android shell exposes the same bundled UI with native notifications and cookies; no separate server entity.

## Capability matrix

| Entity | Read | Create | Update | Delete | Restore / bulk |
| --- | --- | --- | --- | --- | --- |
| Tasks | context (`planner-task-v1`) | existing `task.create`, including recurrence | existing `task.update` (this/future) | **new** `task.delete` (Tier 2; this/future/series) | **new** `task.restore`; batch missing |
| Task reminders | context (`planner-reminder-v1`) | existing `reminder.create`, including recurrence | existing `reminder.update` | existing `reminder.cancel` (Tier 2; this/future/series) | n/a |
| Calendar events | context (`planner-event-v1`) | existing `event.create`, including recurrence and offsets | existing `event.update` | **new** `event.delete` (Tier 2; series) | **new** `event.restore`; batch missing |
| Occurrences | context | n/a | occurrence edit (this/future) | occurrence delete (this/future/series) | missing undo |
| Classes/topics | context (`planner-course-v1`) | missing | missing | missing | missing |
| Academic work | selected context only | missing | missing | missing | batch/restore missing |
| Tracked deadlines | context (`tracked-deadline-v1`) | n/a | missing | n/a | complete/reopen missing |
| Responsibilities/agents | agent UI | missing | missing | missing | pause/resume missing |
| Notifications | API/UI | n/a | missing (not implemented) | n/a | bulk read missing |
| Preferences | API/UI | n/a | `study.preferences.update` (Tier 1) | n/a | revert is a normal update |
| Memory | API/UI | missing | missing | missing | forget/history missing |
| Study settings/goals | API/UI | missing | missing | missing | plan approval missing |
| Mail messages | within existing broker grant | n/a | **new** label/read/archive (Tier 2/3 by action) | archive only | rules/drafts missing |
| Mail drafts | within existing grant | missing | missing | missing | send is Tier 3, never auto |
| Recently deleted | API/UI | n/a | n/a | n/a | **new** generic restore |
| Account/auth/sessions | API/UI | prohibited | prohibited | prohibited | prohibited |
| AI routing/budget/actions/consent | API/UI | prohibited | prohibited | prohibited | prohibited |

Risk tiers:

- **Tier 1** reads and owner-data creates/updates: allowed by default in a direct chat; background agents follow the normal action policy. Includes tasks, reminders, events, planner items, classes, notes and study preferences. Notification read is not implemented.
- **Tier 2** deletes, restores, bulk changes over ~10 records and mail archiving: soft delete through Recently deleted where available. They prompt by default and auto-apply only when the owner enables auto-approve.
- **Tier 3** sending/replying to mail, outward-facing actions, Canvas submissions, account/password/auth/sessions/tokens and AI permission policies: approval every time; the agent can never widen its own permissions.

## Framework

One server capability registry (`apps/api/src/ai/capabilities.ts`) with a zod schema per capability, owner-scoped target lookup, optimistic version, risk tier, apply/undo, before/after snapshot and audit row. Existing task/event/reminder proposal tools remain the first registry entries; new tools use the same execution and audit path rather than separate handlers. The model receives a compact capability list and returns generic `{capability, arguments}` calls; invalid or unavailable capabilities are dropped and counted. The audit log stores operation ID, capability, target, tier, decision and before/after snapshots (no prompt/mail text); `undo last agent action` and the Settings audit view use that snapshot.

Settings > AI > Actions gains grouped grants and the owner auto-approve switch. Tier 2 prompts by default and follows that switch; Tier 3 remains approval-required. Account/auth and AI policy capabilities are never exposed.

Migration 078 additively adds snapshot/undo columns to `ai_capability_audit`; no applied migration changes. Rollback remains code-only for the additive schema.

## Rollout

1. Registry, audit snapshots/undo, Tier 1 study preferences, task/event delete and restore.
2. Classes/topics, academic work and tracked deadlines.
3. Responsibilities, memory and study settings.
4. Mail labels/read/archive within the existing broker grant; drafts/send remain Tier 3 and out of scope for auto-apply.
5. Full tests, production DB-copy migration check and staged release.


## Phase 1 receipt

Implemented `apps/api/src/ai/capabilities.ts` with owner-scoped definitions for `task.delete`, `task.restore`, `event.delete`, `event.restore` and `study.preferences.update`. The model receives generic `tools: [{capability, arguments}]` calls; arguments may reference context refs for deletes and are resolved server-side. Tier 1 uses the new `capabilities` grant; Tier 2 deletes/restores prompt unless the owner enables auto-approve, and Tier 3 capabilities are never exposed. Migration 078 adds before/after snapshots, operation/tool identity and undo state to the 077 audit table.

`GET /api/v1/ai/capabilities/audit` returns recent decisions; `POST /api/v1/ai/capabilities/undo` reverses a stored snapshot. Settings > AI > Actions shows the new grant group, a Tier-1 automatic button and the audit list with Undo. Marked task/event updates continue through the existing audited proposal path; their existing proposal Undo is unchanged.

Still missing from the full matrix: classes/topics, academic-work CRUD/batch/restore, tracked-deadline overrides/completion, responsibilities, memory, study goals/plans, notification reads, and mail labels/read/archive/drafts. These are the next phases; the registry and audit/undo schema are ready for them.


## Auto-approve toggle (added 2026-11-07)

Settings > AI > Actions has an owner-only **Auto-approve agent changes** switch, default OFF. When ON, Tier 1 and Tier 2 proposals that would normally wait for approval are applied automatically for both direct owner asks and scheduled agents. Tier 3 actions still prompt; the agent has no capability that can read or change this switch, and a setting change is itself audited with before/after policy state. Auto-applied actions carry `auto_approved=true` in `ai_capability_audit`, remain undoable through the proposal UI or the audit Undo button, and deletes remain soft deletes in Recently deleted. Deletes and restores follow the same Tier 1/2 setting instead of always asking. A separate Tier 3 opt-in is not built.

## Recurring items (implemented 2026-11-09, separate release)

Repeating reminders, tasks and events use one shared RRULE-style rule in `packages/contracts` (`frequency`, `interval`, `byDay`, `byMonthDay`, `monthlyMode`, `bySetPos`, `count`, `until`, explicit `timeZone`). It supports daily, weekdays, chosen weekdays, every N days/weeks/months/years, monthly by date or nth/last weekday, yearly, and a custom RRULE parser (`FREQ`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`, `BYMONTHDAY`, `BYSETPOS`). Plain-language summaries and a repeat icon appear in task, reminder and calendar lists.

Migration 079 is additive: a `recurrence_series` table, nullable series/occurrence columns on tasks and reminders, nullable recurrence columns, `reminder_offsets` JSON on tasks/events, and `offset_minutes` on reminders. Existing rows remain non-repeating. Completion or skip of a recurring task creates exactly one next occurrence, protected by a unique `(owner_id, series_id, occurrence_key)` index. Repeating reminder delivery creates the next reminder idempotently, and each occurrence notifies through the existing worker. This-vs-future edits/skips/deletes are supported for tasks, reminders and event occurrences; whole-series deletion stays a soft delete in Recently deleted.

Agent tools accept RRULE text: creating or editing a repeating task/reminder/event is Tier 1, and series or future deletion is Tier 2. They honor auto-approve exactly like other actions and record the rule in before/after audit snapshots. Multiple reminder offsets are available per task/event; snooze presets and task due-time/all-day fields remain owner-controlled. Tests cover DST wall-time changes, month-end and leap-day skips, nth/last weekday, count/until, idempotent completion, this-vs-future, per-occurrence reminders, offsets, agent recurrence parsing and Tier 2 series delete.

Review follow-ups folded into this release: capability undo now writes its own audit row with the undo operation ID; audit action names are mapped explicitly instead of derived by splitting the capability string; a Tier 3 proposal test proves auto-approve ON still leaves it waiting; the Settings text no longer claims deletes/restores always ask; and this matrix no longer marks notification read as implemented.
