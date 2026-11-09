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
