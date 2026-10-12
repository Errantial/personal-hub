# Academic deadline agenda

Backend implemented 2026-10-11; UI integration remains pending. This owned read-only agenda combines open manual academic work across active classes. Imported Canvas deadlines, personal task deadlines and Calendar study intervals remain separate. Reading an agenda does not change estimates, submission status, grades, confidence or study plans.

## Request and response

`GET /api/v1/academic-work/agenda` uses `academicAgendaQuerySchema` and returns `academicAgendaResponseSchema`. All reads require current owner authorization and run in a consistent read-only database snapshot.

- Required `asOf` and exclusive `to` are local date-only values, with a positive span of at most 31 days. The caller chooses the intended local date; server UTC time does not determine whether work is overdue.
- Optional `courseId` selects an active owned class. Unknown, foreign or archived classes return 404.
- `bucket` is `all` (default), `overdue`, `today`, `upcoming` or `undated`. `limit` is 1-200, default 50.
- Pagination uses both `after` work ID and `expectedCursorVersion`, supplied together. Use the response's nullable `nextAfter: { id, version }` unchanged on the next page.

Eligible records have status `planned` or `in_progress`, an active class, no deletion timestamp, and a deadline strictly before `to` or an unknown deadline. All overdue work is included regardless of age; `asOf` is not a lower bound. Due exactly on `asOf` is today; later dates before `to` are upcoming; null is undated. Submitted/cancelled/deleted records and archived classes are excluded without altering their history.

Entries sort by deadline ascending, then work UUID ascending, with undated records last. Each entry exposes current work ID/version, class ID/name/version, title/kind, date, nullable full estimated minutes, importance/status, effective sensitivity, complete applied labels, owner-entered origin and bucket. Scores, notes and provider content are not selected. Read the owned single-work endpoint for editable details.

The `summary` covers all eligible records in the chosen class/horizon, independently of the selected bucket, cursor or page size. It includes `openCount`, `overdueCount`, `todayCount`, `upcomingCount`, `missingDeadlineCount`, `missingEstimateCount` and `estimatedOpenMinutes`. Overdue, today, upcoming and undated counts sum to the open count. Known zero estimates are not missing. Estimated minutes sum the owner's full known estimates; they are not measured remaining work and study time is not subtracted. Unknown estimates remain explicit. Future deadlines at/after `to` do not contribute to this summary.

Warnings include `MANUAL_RECORDS_ONLY`; an empty result does not establish complete school workload. More than 5000 relevant open records blocks the entire read with `413 ACADEMIC_WORK_TOO_LARGE`, including filtered bucket reads, rather than returning truncated totals. No migration or dependency is added.

## Paging and UI behavior

An unknown/foreign cursor or one no longer eligible for the chosen class/horizon/bucket returns 404. A still-eligible cursor with a changed work version returns `409 VERSION_CONFLICT`; reset paging and retain local edit drafts. Refresh and every class/date/bucket change reset the cursor. Guard delayed responses and preserve filters across pages.

Each response has consistent entries/counts, but separate pages do not form a frozen snapshot. Other records can move, appear or disappear between requests; a cursor version protects the anchor, not the whole agenda. Refresh after mutations or uncertain paging. Detail mutations still require the work's current version and an operation ID; this endpoint grants no write authority.

Keep overdue, today, upcoming and unknown dates distinct. Display pending, offline, error, conflict and oversized states explicitly; failed totals are unavailable, not zero. A filtered bucket can have no entries while the all-bucket summary has work. Do not combine manual and Canvas records as automatically reconciled duplicates.

This API is online-only, outside the response-cache/task-outbox allowlists and AI context references. Owner-entered record origin does not verify text provenance or approve AI transmission. Explicit [task/study creation from individual work](academic-planning.md) is implemented separately. UI wiring, offline agenda caching, automatic Canvas matching and automatic assignment allocation remain pending.

## Validation

Final `npm run check` passed lint, strict types, formatting, builds and 203 API/client tests; one optional PostgreSQL test was skipped because its isolated URL is unset. All 43 isolated browser regressions passed. Six new agenda tests cover local/leap-day/horizon boundaries, known zero versus unknown estimates, full counts beyond one page, tied-date/undated paging, cursor conflicts, filters, owner authorization/isolation, record/class lifecycle and oversized rejection. Standard PostgreSQL agenda paging/count coverage is added but unverified locally. Tests used synthetic isolated databases; no real providers, paid AI, owner database resets or device verification occurred.
