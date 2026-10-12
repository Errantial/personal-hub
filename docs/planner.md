# Planner behavior and operating limits

Implemented locally: Calendar, Classes and Reminders. These are owner-authorized manual planner features; no provider, AI or OpenDots agent execution is enabled.

## Calendar

Day/week agendas show timed events in the selected viewing timezone. All-day events retain their calendar dates across viewing timezones. A task deadline remains a date-only deadline; a study block reserves an interval.

Calendar input interprets local times in the event's IANA timezone. Nonexistent DST times must be corrected; repeated times require an explicit earlier/later offset choice. Recurring timed starts keep their local clock time and constant elapsed duration. Future DST gaps shift forward; repeated future times use the earlier offset. The initial occurrence preserves the offset selected by the owner.

Rules support daily, weekly (same weekday), and monthly (same numbered day), intervals 1–52, optional count up to 1,000 and inclusive last occurrence date. Monthly rules skip months without the numbered day; skipped months do not consume the count. Arbitrary RRULE import, multiple weekdays, and “this and following” edits are not implemented.

All-day storage uses inclusive start/exclusive end dates; the editor shows an inclusive last day. Calendar queries are limited to 93 days; event duration is at most 31 days. Ongoing rules are expanded near the requested window rather than materialized indefinitely.

Each recurring occurrence is identified by the series ID and its original date. An occurrence edit stores a replacement; cancellation stores an exception. Moving an occurrence into another week retains its original identity. Edits use the series version, including occurrence edits. Changing the start anchor, timezone, all-day mode or rule clears exceptions and cancels pending occurrence reminders; other series edits preserve exceptions. Occurrence edits/cancellations cancel their pending reminders so a stale schedule cannot fire. Reminders do not automatically follow moved events: review or create the new schedule explicitly.

## Restore deleted tasks and events

Online restore is implemented in the API; the UI undo control and offline restore are pending. `POST /api/v1/tasks/:id/restore`, `/api/v1/calendar/:id/restore`, and the legacy `/api/v1/events/:id/restore` accept only `operationId` and `expectedVersion`. Use the deleted record's current version, not its pre-delete version. Responses use the corresponding existing task/calendar/event response schemas. Restore clears `deletedAt`, advances the version and preserves the ID, content, completion/study status, source snapshots, label history, academic links, recurrence and occurrence exceptions.

`GET /api/v1/tasks/:id`, `/api/v1/calendar/:id` and `/api/v1/events/:id` return an owned active record or tombstone for explicit conflict recovery. Lists continue to exclude deleted records. Unknown/foreign IDs return 404; stale restore versions return `VERSION_CONFLICT`; an active record at the expected version returns `NOT_DELETED`. Extra input fields are rejected. Reuse the original path, payload and operation ID after a lost response; changing endpoint or payload with that ID conflicts. An old successful receipt returns its historical result even if the record was subsequently edited or deleted again. Reload current data before presenting that historical result as current.

Restore does not change reminder jobs or delivered notifications. Cancelled reminders remain cancelled; still-pending jobs use the restored target's availability when the worker next runs. Occurrence cancellations remain cancelled. Linked classes/topics can remain archived. Class/topic relabeling now captures new labels on deleted derived records too, advancing their versions; this can invalidate an outstanding Undo version. Unknown legacy label history remains unknown and blocked for AI.

Migration 019 retains each restored tombstone's timestamp/version and restoration timestamp/version in `planner_restorations`. Export includes safe `records.plannerRestorations` metadata (older format-v1 files default to an empty array). These records and mutation receipts remain retained; no purge, restore expiry, deleted-items browser, occurrence-only undo, or external provider write is implemented.

## Classes and study

Classes store term, instructor, notes and an explicit content label. Topics store manual progress (0–100%) and confidence (unknown/low/medium/high). An unassessed class does not claim a grade or a measured zero. Study blocks link to a class and optional topic, with planned/completed/cancelled status. Completing a block does not invent learning progress or change confidence.

Topic links must belong to the selected owned class. Class/topic labels are inherited by derived study blocks, including occurrence replacements. Source label upgrades propagate; inherited labels are conservatively retained until explicitly reviewed. Class deletion tombstones its topics while retaining existing calendar history. Canvas deadlines and assignment metadata are implemented; grades and AI study recommendations remain future work.

Topics and full calendar records now export `academicLabels`: all captured Personal/Restricted labels, or null when historical provenance is incomplete. Label changes can add a second permission boundary even when the strongest display label is unchanged; affected record versions increase. Study detachment and occurrence cancellation retain captured labels. Planner edits remain available for legacy records, but the AI routing preview blocks unknown history. Review/reset of captured history and actual AI execution remain pending. See [AI permissions](ai-permissions.md).

## Reminders

Explicit [academic-work targets](academic-reminders.md) are implemented. Only open undeleted work in an active class accepts creation/rescheduling/resume/retry or snooze. Delivery rechecks availability under the owner schedule lock. Closing/deleting/archiving suppresses pending delivery; reopening/restoring does not revive cancelled reminders. Date-only academic deadlines never imply a reminder instant, and changing a deadline does not reschedule it. New academic creation controls remain pending; existing rescheduling preserves API-created targets.

The API entry point starts the worker automatically. It polls every five seconds, claims at most 20 due jobs per batch using database locks and 30-second leases, and records a heartbeat. Queued work remains in the database through server restarts. Expired leases are reclaimed, with at most three attempts; delivery failures back off before retry. Safe error codes, attempt counts and worker health appear in Reminders.

Delivery means an inbox record and terminal job status committed together. A unique reminder receipt prevents duplicate inbox items after retry or restart. It does not mean an operating-system notification was displayed. Completed/deleted targets, cancelled/completed study sessions and cancelled occurrences suppress pending delivery. Pause, resume, retry and cancel use optimistic versions and mutation receipts. Delivered notifications remain in history; the inbox shows the latest 200 items.

Browser alerts are optional, require permission and run only while the Reminders view is open. A denied permission leaves the durable inbox available. Closing the page does not stop the server worker, but no browser push, Android alarm, email or attachment processing is implemented. The UI reports a missing/stale worker; it cannot guarantee a powered-off or unavailable server delivers on time. Overdue queued jobs are delivered when the server resumes.

Use isolated synthetic test databases. Standard PostgreSQL migration/worker coverage is configured in CI and opt-in locally through TEST_DATABASE_URL; physical Kompakt and production deployment acceptance remain separate gates.

### Snooze and inbox history (backend implemented 2026-10-11)

`POST /api/v1/reminders/:id/snooze` accepts `reminderSnoozeSchema`: `{ operationId, expectedVersion, scheduledAt }`. Use the current delivered reminder version. The explicit instant must be future and within 365 days at admission. Queued/paused/failed jobs still use existing reschedule/control operations. Snooze creates a new queued child with the same title, target and original occurrence date, marks the source notification read, and advances the source reminder version atomically. The source remains delivered. `reminderSnoozeResponseSchema` returns `{ sourceReminder, reminder, notification }`.

Each delivery has at most one snooze child, enforced by a same-owner foreign key and unique parent constraint in migration 025. Child records carry `snoozedFromId`; old exports default it to null. A child can itself be snoozed after delivery. Cancelling a child does not authorize another snooze of the original delivery: create a deliberate new reminder if needed. Snooze does not change the target schedule or deadline. Completed/deleted targets, cancelled/completed study blocks and unavailable/cancelled occurrences reject snooze; targets are checked again at delivery. A target changed after acceptance may suppress the child. The owner's snooze time can precede or follow the target time.

An exact lost-response retry returns its original receipt even after the child delivers or changes. Reusing the operation ID for a different payload returns `OPERATION_CONFLICT`; stale versions return `VERSION_CONFLICT`; a second child at a current source version returns `REMINDER_ALREADY_SNOOZED`. State/target failures return `REMINDER_STATE`/`REMINDER_TARGET_UNAVAILABLE`; invalid times return `SNOOZE_TIME`. Reload `GET /api/v1/reminders/:id` (`reminderResponseSchema`) for current owned state rather than treating a historical receipt as current.

`GET /api/v1/reminders/history` accepts optional `limit` (1-200, default 50), `before` (owned reminder UUID), and `status`. `GET /api/v1/notifications/history` accepts the same limit/cursor fields and `unreadOnly=true|false` (default false). Results use `reminderHistorySchema`/`notificationHistorySchema`: records and `nextBefore`, null on the last page. Notification history includes the full owner `unreadCount`, independent of page size/filter. `GET /api/v1/notifications/summary` returns `notificationSummarySchema` (`unreadCount`), including records beyond the legacy 200-item inbox.

Pages order by creation timestamp descending, then ID descending; cursor comparisons retain database microsecond precision. Owned cursors remain usable after their notification is read or reminder changes status. New arrivals appear on a fresh first page; paging is not a frozen cross-request snapshot. Read/status changes can remove records from a filtered subsequent page. Unknown/foreign cursors return 404. Existing list endpoints retain prior behavior.

`POST /api/v1/notifications/read` accepts `notificationsReadSchema`: `{ operationId, notificationIds }`, with 1-200 unique owned IDs. Every ID must exist before any is changed; unavailable/foreign IDs return 404 without partial writes. `notificationsReadResponseSchema` returns records in input order. Already-read timestamps are preserved. Same-operation retries return the original result and never mark later arrivals read. No implicit global mark-all exists: explicitly submit selected/loaded IDs and label that scope accurately.

These controls are backend-only, online-only and excluded from the task outbox. UI integration, offline snooze, native/closed-app alerts, permanent purge and retention remain pending. Export includes snooze links and delivery/read history without lease tokens. No email, provider calls or paid AI are introduced.
