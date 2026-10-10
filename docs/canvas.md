# Canvas calendar ingestion

The Connections screen now imports read-only calendar entries from Canvas. It supports a private school feed configured on the server and manual ICS file imports. This is a calendar baseline, not full Canvas assignment, grade, submission or alert access. No real school feed has been accessed during implementation.

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

Entries are viewed in Connections and are included in the planner JSON export with source labels and versions. They are not yet projected into the planner agenda, linked to class portfolios, or converted into tasks/study blocks. Import history is shown for the last twenty jobs; older jobs and missing entries are retained. The current connection view has an explicit 2,000-retained-entry limit; pagination/pruning remains pending. Exceeding it shows an error rather than a truncated list; JSON export retains its separate limits.

## Parser and transport boundaries

Uses pinned `ical.js` for parsing and Temporal for date/time validation. Supports single, complete VERSION 2.0 VCALENDAR documents with unique VEVENT UIDs, UTC timestamps, supported IANA TZID local times, and date-only entries. Timed zero-duration entries can represent deadlines; all-day end dates remain exclusive. Date-only entries without DTEND use the next day. Floating times, DST gaps/folds, invalid dates, mixed date/timestamp endpoints, recurrence rules/exceptions and DURATION are rejected. Rejected documents leave the previous snapshot unchanged. Rich Canvas access and broader calendar support remain separate work. [ical.js parsing documentation](https://github.com/kewisch/ical.js/wiki/Parsing-iCalendar).

Descriptions render as escaped text; HTML is never executed. Only HTTPS links to specific assignment/calendar-event/quiz paths on the school host are exposed; credential-bearing links, query strings and other schemes/hosts are omitted. ATTACH, alarm instructions and other unneeded properties are not fetched or executed.

Network requests use only the configured exact school origin and calendar-feed path, forbid redirects, time out after ten seconds, and stream at most 1 MiB. Each snapshot accepts at most 2,000 entries. Errors expose fixed codes, never raw provider responses or request URLs. Login pages and partial documents cannot silently erase the prior import.

## Durable refreshes

Migration 004 adds owner-scoped source settings, imported records and durable jobs. Migration 005 records input provenance. Applied migrations remain unchanged. Mutations use shared contracts, exact-Origin/JSON guards, optimistic versions and idempotency receipts.

Only one queued/running job per owner is permitted. Workers claim jobs with a random thirty-second lease, fetch outside the transaction, and atomically commit only while holding the current lease. Snapshot writes, notes and settings serialize on the source row. Expired leases are recovered across restarts; three interrupted attempts produce `LEASE_EXPIRED`. Fetch/parse failures terminate that job with a fixed error code; automatic refresh tries again at the next scheduled interval, or the owner can queue a new manual job. Pause invalidates leases before any late snapshot can commit.

The current server feed is bound to the enrolled owner in owner_setup and the agreed school host; another user's source cannot fetch it. Multi-owner onboarding/OAuth, account-specific credentials, provider API pagination, ETags, progress/grades and browser enrichment remain pending. Standard PostgreSQL checks exist in CI but have not run locally without TEST_DATABASE_URL. All routine tests use synthetic feeds or mock fetches; browser tests explicitly clear inherited feed configuration.
