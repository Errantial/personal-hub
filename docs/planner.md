# Planner behavior and operating limits

Implemented locally: Calendar, Classes and Reminders. These are owner-authorized manual planner features; no provider, AI or OpenDots agent execution is enabled.

## Calendar

Day/week agendas show timed events in the selected viewing timezone. All-day events retain their calendar dates across viewing timezones. A task deadline remains a date-only deadline; a study block reserves an interval.

Calendar input interprets local times in the event's IANA timezone. Nonexistent DST times must be corrected; repeated times require an explicit earlier/later offset choice. Recurring timed starts keep their local clock time and constant elapsed duration. Future DST gaps shift forward; repeated future times use the earlier offset. The initial occurrence preserves the offset selected by the owner.

Rules support daily, weekly (same weekday), and monthly (same numbered day), intervals 1–52, optional count up to 1,000 and inclusive last occurrence date. Monthly rules skip months without the numbered day; skipped months do not consume the count. Arbitrary RRULE import, multiple weekdays, and “this and following” edits are not implemented.

All-day storage uses inclusive start/exclusive end dates; the editor shows an inclusive last day. Calendar queries are limited to 93 days; event duration is at most 31 days. Ongoing rules are expanded near the requested window rather than materialized indefinitely.

Each recurring occurrence is identified by the series ID and its original date. An occurrence edit stores a replacement; cancellation stores an exception. Moving an occurrence into another week retains its original identity. Edits use the series version, including occurrence edits. Changing the start anchor, timezone, all-day mode or rule clears exceptions and cancels pending occurrence reminders; other series edits preserve exceptions. Occurrence edits/cancellations cancel their pending reminders so a stale schedule cannot fire. Reminders do not automatically follow moved events: review or create the new schedule explicitly.

## Classes and study

Classes store term, instructor, notes and an explicit content label. Topics store manual progress (0–100%) and confidence (unknown/low/medium/high). An unassessed class does not claim a grade or a measured zero. Study blocks link to a class and optional topic, with planned/completed/cancelled status. Completing a block does not invent learning progress or change confidence.

Topic links must belong to the selected owned class. Class/topic labels are inherited by derived study blocks, including occurrence replacements. Source label upgrades propagate; inherited labels are conservatively retained until explicitly reviewed. Class deletion tombstones its topics while retaining existing calendar history. Grades, Canvas imports and AI study recommendations remain future work.

## Reminders

The API entry point starts the worker automatically. It polls every five seconds, claims at most 20 due jobs per batch using database locks and 30-second leases, and records a heartbeat. Queued work remains in the database through server restarts. Expired leases are reclaimed, with at most three attempts; delivery failures back off before retry. Safe error codes, attempt counts and worker health appear in Reminders.

Delivery means an inbox record and terminal job status committed together. A unique reminder receipt prevents duplicate inbox items after retry or restart. It does not mean an operating-system notification was displayed. Completed/deleted targets, cancelled/completed study sessions and cancelled occurrences suppress pending delivery. Pause, resume, retry and cancel use optimistic versions and mutation receipts. Delivered notifications remain in history; the inbox shows the latest 200 items.

Browser alerts are optional, require permission and run only while the Reminders view is open. A denied permission leaves the durable inbox available. Closing the page does not stop the server worker, but no browser push, Android alarm, email or attachment processing is implemented. The UI reports a missing/stale worker; it cannot guarantee a powered-off or unavailable server delivers on time. Overdue queued jobs are delivered when the server resumes.

Use isolated synthetic test databases. Standard PostgreSQL migration/worker coverage is configured in CI and opt-in locally through TEST_DATABASE_URL; physical Kompakt and production deployment acceptance remain separate gates.
