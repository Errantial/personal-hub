# Recurring reminders, tasks and events

Status: implementation plan, 2026-11-09. Separate PR/release from #75.

## Rule model

Add one shared `recurrenceSchema` in `packages/contracts` (not a second dialect):

- `rrule` canonical RFC 5545 string (`FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `BYSETPOS`, `COUNT`, `UNTIL`).
- `timeZone` explicit IANA zone, default `America/Denver`.
- Parsed convenience fields for the UI: frequency, interval, weekdays, monthly mode (`date`/pattern), end mode (`never`/`until`/`count`).
- `dtstart` date or local datetime; all-day vs timed due time.

Support daily, weekdays, chosen weekdays, every N days/weeks/months, monthly by date or nth weekday, yearly, and a raw custom RRULE. End never/on date/after N occurrences.

## Persistence

Migration 079 adds additive columns/tables:

- `recurrence` JSONB on tasks/reminders, nullable; existing rows unchanged.
- reminder/task occurrence identity (`series_id`, `occurrence_key`, `original_date`) and skipped/completed state.
- an occurrence uniqueness constraint on `(owner_id, series_id, occurrence_key)` so worker retries cannot duplicate.
- task `all_day`, due time already exists; add reminder offsets table `reminder_offsets(reminder_id, minutes_before)` with 1..N offsets.

## Expansion and worker

- Shared expansion service reuses existing Temporal/Calendar utilities where possible; DST uses `America/Denver` zone-aware plain dates and rejects/handles gaps consistently.
- Next occurrence computed from the rule and previous occurrence key, never from "now" alone; idempotent insert with `ON CONFLICT`.
- Completing/dismissing an occurrence creates exactly one next reminder/task and schedules its native notification through the existing reminder worker. The worker also catches up after reboot.
- This-occurrence edit/skip updates only the occurrence override; this-and-future truncates the series and creates a new rule; delete series is a soft delete in Recently deleted.

## UI and agent

- Web and Android picker: daily/weekdays/chosen days/every N/monthly by date or nth weekday/yearly/custom; until/count; timezone; human summary and repeat icon in lists.
- Agent tools: `reminder.create/update` and `task.create/update` accept recurrence; edits/deletes accept `scope: this|future|series`; recurring create/edit is Tier 1, series/future delete Tier 2. Auto-approve applies exactly as in #75.
- Before/after audit snapshots include the rule and scope. Undo restores the previous rule/occurrence.

## Tests and rollout

- Parsing and expansion: DST spring/fall, month-end, leap year, nth weekday, count/until, custom RRULE.
- Completion idempotency, duplicate worker runs, this-vs-future edits/skips/deletes, notification per occurrence, agent recurring create/edit/delete, auto-approve and Tier 2 approval.
- Additive migration check against a fresh production copy; default off/absent recurrence preserves existing behavior.
- Release follows the review gate: self-review, NEEDS REVIEW, explicit approval for exact SHA, then staged deploy and smoke test.

## Implementation receipt (2026-11-09)

Implemented on `feat/recurring-items` as a separate PR from #75:

- Shared RRULE-style rule in `packages/contracts` with `byDay`, `byMonthDay`, `monthlyMode`, `bySetPos`, `count`, `until` and an explicit `timeZone`; custom RRULE parsing/rendering and plain-language summaries.
- Migration 079: `recurrence_series`, nullable task/reminder series and occurrence columns, nullable recurrence JSON, task/event `reminder_offsets`, reminder `offset_minutes`, additive indexes and constraints.
- Idempotent next-occurrence generation for completed/skipped tasks and delivered/dismissed reminders, with this/future/series edits and soft-deleted series.
- Per-occurrence event reminders from offsets, task reminder offsets rebuilt on due-time changes, and a throttled worker sweep for recurring event reminders.
- Web/Android-bundled recurrence picker with summary, repeat icons in task/reminder/calendar lists, multiple offset controls, extra snooze preset, and this-vs-future event edit/delete.
- Agent RRULE text support for task, reminder and event create/update; Tier 1 edits, Tier 2 series/future deletion, audit snapshots and auto-approve gating.

Tests: `apps/api/tests/recurrence.test.ts` (DST, month-end, leap day, nth/last weekday, parsing, summaries) and `apps/api/tests/recurring-items.test.ts` (task completion idempotency, this/future edit and delete, reminder delivery/dismiss/cancel, event offsets, task offsets). Existing calendar, reminder, task and assistant suites pass.

## Review fixes (2026-11-09)

- Fixed monthly window indexing for intervals above one, with mid-series interval 2 and 3 tests.
- Offset reminders revive cancelled rows, resync after task/event restore and capability undo, and skip already-past automatic reminders.
- Task series/future deletes snapshot every affected occurrence plus the series state; capability Undo restores all rows, series bounds and automatic reminders. Restoring one series occurrence from Recently deleted restores the same deletion batch.
- Auto-generated next tasks are marked; reopening a completed occurrence removes an untouched generated occurrence, and undoing a recurring `task.create` deletes the whole series.
- Ending or shortening a recurrence through `task.update`, `event.update` or `reminder.update` is Tier 2: it prompts by default and only auto-applies when auto-approve is on.
- The recurring event reminder sweep skips cancelled/moved exceptions, does not bump unchanged versions, and isolates one failing event.
- Automatic offset reminders record `cancel_reason='sync'`/`target-unavailable`; only those system-cancelled rows are revived. User-cancelled reminders stay cancelled across sweeps and edits. Past automatic offsets are never created, but existing due/retrying rows are left alone.
- Restoring a this-and-future deletion batch restores the whole batch and clears only its own cut, preserving earlier series cuts. Reopening an occurrence removes only its direct untouched generated successor, not later occurrences produced by a completed successor. Failed offset reminders are requeued when their schedule changes.
