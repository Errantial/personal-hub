# Task agenda and Today attention summary

Backend implemented 2026-10-11; UI integration is pending. These are additive owner-authorized reads. Existing Today sections, cached views and task writes keep their behavior. No migration, new provider access or AI execution is added.

## Dates and scope

Both routes require local date-only `asOf` and exclusive `to`, a positive horizon of 1-31 days. The caller supplies dates in the intended timezone; the server does not infer them from its clock. No `timeZone` parameter is accepted because these reads do not expand schedules. Task/academic deadline counts use these dates; reminder due state uses the server instant returned as `generatedAt`.

Task buckets are overdue (`dueDate < asOf`), today (`dueDate = asOf`), upcoming (`asOf < dueDate < to`), later (`dueDate >= to`), and undated (null). Null is unknown, not overdue. Only active incomplete tasks count. Later tasks remain in the full task totals and can be browsed. Task deadlines stay separate from Calendar reservations and academic submission.

The current Today UI includes seven future dates through `today + 7`; to preserve that behavior, supply `asOf=today` and `to=today + 8`. Do not silently change an inclusive UI horizon when adopting this exclusive API boundary.

## Task agenda

GET `/api/v1/tasks/agenda` uses `taskAgendaQuerySchema`: dates, optional `bucket=all|overdue|today|upcoming|later|undated`, limit 1-200 (default 50), and paired `after`/`expectedCursorVersion`. Unknown fields and invalid cursor pairs return 400.

`taskAgendaResponseSchema` returns dates, selected bucket, full `summary`, `entries: [{ bucket, task }]`, and nullable `nextAfter: { id, version }`. Each task uses the existing full shared contract, including notes, sensitivity and nullable captured/current Canvas or academic source metadata. No source text is newly copied. Existing task detail/edit/delete/restore routes remain authoritative.

Summary fields are `openCount`, `overdueCount`, `todayCount`, `upcomingCount`, `laterCount` and `undatedCount`. They cover all owned active incomplete tasks, independent of page and selected bucket. The five bucket counts sum to `openCount`. Unlike the academic deadline agenda, `bucket=all` includes later tasks too. The legacy task list is unchanged.

Ordering is deadline ascending, then UUID ascending, with undated tasks last. Send both fields from `nextAfter`, preserve query filters and reset after refresh/filter/date changes. A current owned eligible cursor can page; a changed task version returns `VERSION_CONFLICT`. Completed/deleted/foreign/unknown cursors or cursors outside the selected bucket return 404. Source-label propagation can advance the task version even when its visible strongest label is unchanged. Preserve drafts and reload deliberately. Pages are consistent per request, not frozen across requests; creations or edits before the cursor can require a refresh.

Completing work or archiving its class does not complete a linked planner task. Direct academic provenance remains visible on such open tasks. Planner deletion/restoration and source relabeling retain existing source history and retry semantics.

## Today summary

GET `/api/v1/today/summary` uses `todaySummaryQuerySchema` and returns `todaySummarySchema`: dates, `generatedAt`, `tasks`, `academicWork`, `reminders` and scope warnings, in one consistent read-only database snapshot with session authorization rechecked inside it.

`tasks` is the full task summary above. `academicWork` reuses the academic agenda summary: open/overdue/today/upcoming counts, missing deadline/estimate counts, and known full estimated minutes for open undeleted work in active classes with a deadline before `to` or an unknown deadline. It excludes later academic work, submitted/cancelled/deleted work and archived classes. Zero effort is known; null is unknown. These manual estimates never subtract study time or imply school completeness, measured remaining effort, grades or mastery. More than 5000 eligible academic records returns `ACADEMIC_WORK_TOO_LARGE` for the whole summary, with no partial or invented-zero totals. Task agenda reads remain independently available.

`reminders` includes all owned queued/running/paused/failed counts; `dueCount` counts queued/running jobs scheduled at or before `generatedAt`. These are durable job states, not a guarantee that the target is still available or that a notification will be displayed. Delivery continues through the worker and rechecks target availability. Reminder counts are independent of the selected date horizon.

`unreadCount` covers the entire owner inbox, including records beyond the legacy 200-item view. `latestUnread` returns up to three full notification records in creation-time/UUID descending order; sorting retains database microseconds. Summary reads never mark them read. Use existing explicit read/batch-read/snooze contracts for actions. The worker projection exposes its shared heartbeat, safe error code and health, with absent/stale/error/future heartbeats unhealthy; it does not prove device/native delivery.

Warnings are `MANUAL_ACADEMIC_RECORDS_ONLY`, `SCHEDULE_NOT_INCLUDED` and `IMPORTED_DEADLINES_NOT_INCLUDED`. This summary does not include Calendar occurrences, Canvas/imported deadlines or provider completeness. Continue the existing independent schedule/imported-source reads and error states when integrating it. New counts must not silently deduplicate planner tasks and academic records that have distinct status and meaning.

## Offline, privacy and errors

Both new routes are online-only, outside the response-cache/task-outbox and AI-reference allowlists. They create no receipts or persisted summary state and do not deliver reminders, update versions or change source/planner records. Existing linked tasks keep ordinary offline edits. Do not display server counts as including queued local edits; preserve the offline/pending/conflict indicator and local drafts.

Private reads require owner authorization. Revoked sessions return 401; foreign cursors return 404. Keep pending/error/conflict states visible. Unavailable totals are not zero. No new UI controls, source reconciliation, provider calls, paid processing or native delivery is implemented.

## Validation

`npm run check` passed lint, strict types, formatting, production builds and 236 API/client tests, with one optional standard PostgreSQL test skipped because its isolated URL is unset. Nine new isolated tests cover empty/malformed/leap-day horizons, deadline buckets/bounds, tied-date and undated paging, guarded/unavailable cursors, owner/session isolation across tasks/work/reminders/inbox, full counts beyond 200, precise notification ordering/read transitions, inherited source metadata/lifecycle, read-only state/receipts, worker health, size rejection and persisted restart. Optional PostgreSQL coverage now exercises both new routes but remains unverified locally.

A compiled API smoke check used an isolated in-memory database with network calls forbidden. It verified task buckets/paging/stale-version conflicts, separate manual academic counts, reminder delivery followed by unread summary reads, and preserved notification state. No owner database access/reset, real provider calls, paid AI or device verification occurred. UI integration remains pending.
