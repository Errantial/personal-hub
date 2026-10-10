# Canvas calendar ingestion

The Connections screen imports read-only calendar entries from Canvas through a private school feed configured on the server or manual ICS file imports. This adapter covers calendar entries only. A separate [Canvas API adapter](canvas-api.md) imports course and assignment metadata; grades, submissions and alerts remain pending. No real school feed has been accessed during implementation.

## Setup

Set `CANVAS_CALENDAR_FEED_URL` in the repository-root `.env` for development or the server's private environment in production, then restart the API. Use the owner's calendar feed from `canvas.colorado.edu`. Do not paste the private URL into chat or commit it. The URL is never returned to the browser, placed in mutation receipts, exported, or logged.

Open Connections, choose a Source label, enable Auto refresh and save. Automatic refresh starts on the next worker tick and then runs at fifteen-minute intervals. Sync Canvas explicitly queues a refresh even while automatic refresh is paused. Auto refresh defaults off. Saving settings with Auto refresh off cancels queued/running refreshes and discards late results; already imported data and notes remain.

Without server configuration, Import ICS accepts a complete calendar file of at most 1 MiB. Each file replaces the latest observed snapshot; it does not merge multiple calendars. Entries absent from that snapshot become “Not in latest feed.” Uploads are blocked while a network refresh is active; wait or pause first.

Canvas documents calendar feeds as a way to subscribe to course events and assignments. Their content and date window must be compared with the actual school account before relying on completeness. [Canvas calendar overview](https://community.instructure.com/en/kb/articles/662743-unknown).

## Record behavior

- Stable owner/UID records deduplicate repeated snapshots. Provider title, description, dates, safe source links and availability update only when changed.
- Personal notes and entry labels remain separate from provider fields and survive refreshes. Stale note edits retain their form draft; Reload entry version explicitly adopts the current version before retrying.
- A source label inherits into each entry's effective sensitivity. Only owner-selected labels affect sensitivity; no classifier runs.
- Missing entries are retained with a missing marker, because feed omission does not establish deletion. Explicit cancellations remain visible and preserve prior details when the cancellation has only a UID/status. Nothing automatically deletes or overwrites planner tasks/events.
- Uploaded-file content has `inputKind: calendar-file`; fresh network content has `calendar-feed`. Minimal cancellation or omission preserves the existing content's provenance. Future AI must reject file/attachment-derived context even if its sensitivity label would otherwise permit routing. No imported text currently goes to any AI provider.

Entries appear in Connections, day/week Calendar agendas, and linked class portfolios. They are included in the planner JSON export with source labels, versions, class IDs and file/network provenance. Connections can explicitly create linked tasks or study blocks. Import history is shown for the last twenty jobs; older jobs and missing entries are retained. Views have an explicit 2,000-entry limit per requested collection; calendar queries currently read the bounded owner's collection before filtering. Pagination/pruning remains pending. Exceeding a limit shows an error rather than a truncated list; JSON export retains its separate limits.

## Class linkage and agenda

In Connections, use Edit notes and Linked class to assign an entry to an existing class. No class is guessed from provider text or URLs. Notes, entry labels and class links share the entry's optimistic version and idempotent receipt. Refreshes update provider fields while preserving those owner fields. Older clients that omit courseId preserve the existing link; explicitly selecting No class removes it.

Only owned, active classes can receive a new link. Deleting a class keeps the existing link marked Archived class and retains its sensitivity inheritance; notes can still be edited, or the owner can explicitly unlink it. Effective sensitivity is the strongest owner-applied source, entry and linked-class label, including archived classes. Linking does not change class/topic progress, grades or the class's own notes.

Calendar uses the selected viewing timezone for timed entries. A timed entry without an end, or with equal start/end, is displayed as a point deadline. It belongs to the day containing that instant, including exactly the start of the day, and excludes exactly the next day's start. Timed intervals overlap days normally; date-only spans retain their dates and exclusive end regardless of timezone. Missing/cancelled records show their last-known date/state and remain read-only. Imported entries have no planner edit/delete controls and do not create reserved planner events.

The new owner-authorized `GET /api/v1/connections/canvas/calendar?from=...&to=...&timeZone=...` uses the planner's maximum 93-day range. `GET /api/v1/connections/canvas/items?courseId=...` lists an owned class's linked entries. Both return import freshness and read-only records from a consistent snapshot. Previously loaded ranges and class lists can be viewed from the existing owner/expiry-scoped browser cache; new ranges and edits require a connection. A failed Canvas read does not stop the personal calendar from loading. Reload calendar or Reload class Canvas entries refreshes imported snapshots. Migration 006 adds an owned-class foreign key; existing migrations are unchanged.

## Source-linked planning

In Connections, select Create task or Plan study on an available entry. Review the title and task deadline, or choose an active owned class and study interval/timezone. The task deadline defaults to the source's date, with timed sources converted to the device timezone; it remains an editable date-only deadline. Study times are explicit and separate from that deadline. Neither action changes the Canvas record, class progress or grades. Study creation accepts a one-time timed block; ordinary Calendar editing can subsequently change the planner schedule. No automatic task creation, recommendations, deadline propagation or provider writes occur.

Creation uses the normal `POST /api/v1/tasks` or `POST /api/v1/calendar` operation with an optional `canvasSourceRef: { itemId, expectedVersion }`. The server validates owner, version and available status, captures source facts under the import locks, and stores the planner item and receipt atomically. Stale sources return 409 and preserve the browser draft; Reload Canvas followed by Reload source version adopts the latest source without replacing entered planner fields. Retrying an unchanged save returns the same item; a deliberate new creation with a new operation ID creates another item. There is no one-task-per-source constraint.

Migration 007 adds owner-scoped foreign keys and immutable source snapshots to tasks/events. Each response/export has additive nullable `canvasSource` metadata: captured version, title, timing, safe link, input kind and effective source label, alongside current source version/title/timing/status/provenance/label. Existing exports default this field to null. Planner edits and tombstones retain the link; replacement/detachment is not supported. Refreshes and missing/cancelled source markers never overwrite planner titles, notes, deadlines, completion, times or versions and never resurrect deleted planner items. Canvas source details in Today and Calendar expose changes for owner review.

Effective planner sensitivity is the strongest planner label, captured source label and current source/entry/class label. Lowering the planner label or unlinking a source's class does not erase captured provenance. Shared `plannerSensitivity` resolves this inheritance; future routing must use it rather than only the planner's stored `sensitivity`. `plannerTextIsAttachmentDerived` remains true when either captured or current provenance is calendar-file, including file-to-network refreshes. Source descriptions are not automatically copied to planner notes. A future AI gateway must reject file-derived records and context, including titles, notes, exports and linked reminder context; these helpers do not implement or enable AI processing.

Creation is online-only; pending task edits must sync before creating a Canvas task. Existing linked tasks use the normal offline outbox, which retains provenance through edits/replay. Cached provenance is a last-loaded snapshot; a reconnect/read is needed to observe new source labels or statuses. Study edits remain online-only. No routine tests access real providers.

## Parser and transport boundaries

Uses pinned `ical.js` for parsing and Temporal for date/time validation. Supports single, complete VERSION 2.0 VCALENDAR documents with unique VEVENT UIDs, UTC timestamps, supported IANA TZID local times, and date-only entries. Timed zero-duration entries can represent deadlines; all-day end dates remain exclusive. Date-only entries without DTEND use the next day. Floating times, DST gaps/folds, invalid dates, mixed date/timestamp endpoints, recurrence rules/exceptions and DURATION are rejected. Rejected documents leave the previous snapshot unchanged. Rich Canvas access and broader calendar support remain separate work. [ical.js parsing documentation](https://github.com/kewisch/ical.js/wiki/Parsing-iCalendar).

Descriptions render as escaped text; HTML is never executed. Only HTTPS links to specific assignment/calendar-event/quiz paths on the school host are exposed; credential-bearing links, query strings and other schemes/hosts are omitted. ATTACH, alarm instructions and other unneeded properties are not fetched or executed.

Network requests use only the configured exact school origin and calendar-feed path, forbid redirects, time out after ten seconds, and stream at most 1 MiB. Each snapshot accepts at most 2,000 entries. Errors expose fixed codes, never raw provider responses or request URLs. Login pages and partial documents cannot silently erase the prior import.

## Durable refreshes

Migration 004 adds owner-scoped source settings, imported records and durable jobs. Migration 005 records input provenance. Applied migrations remain unchanged. Mutations use shared contracts, exact-Origin/JSON guards, optimistic versions and idempotency receipts.

Only one queued/running job per owner is permitted. Workers claim jobs with a random thirty-second lease, fetch outside the transaction, and atomically commit only while holding the current lease. Snapshot writes, notes and settings serialize on the source row. Expired leases are recovered across restarts; three interrupted attempts produce `LEASE_EXPIRED`. Fetch/parse failures terminate that job with a fixed error code; automatic refresh tries again at the next scheduled interval, or the owner can queue a new manual job. Pause invalidates leases before any late snapshot can commit.

The current server feed is bound to the enrolled owner in owner_setup and the agreed school host; another user's source cannot fetch it. Multi-owner onboarding/OAuth, account-specific credentials, ETags, progress/grades and browser enrichment remain pending. Provider API pagination is implemented separately in the [metadata adapter](canvas-api.md). Standard PostgreSQL checks exist in CI but have not run locally without TEST_DATABASE_URL. All routine tests use synthetic feeds or mock fetches; browser tests explicitly clear inherited feed and API-token configuration.
