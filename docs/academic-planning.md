# Planning from manual academic work

Backend implemented 2026-10-11; new UI controls remain pending. Manual academic records, imported Canvas assignments and personal planner items keep separate facts and status.

## Explicit creation

POST `/api/v1/academic-work/:id/planner-work` uses `academicPlanningWriteSchema`: operation ID, current `expectedWorkVersion`/`expectedCourseVersion`, and one of:

- `kind: task`, with ordinary editable `task` fields: required title, optional notes, date-only deadline, priority, completion and sensitivity. Metadata, client IDs and other source references are rejected.
- `kind: study`, with validated Calendar `event` input. Initial creation requires the source class, a one-time timed planned block of at most 180 elapsed minutes and an optional owned topic in that class. All-day/repeating/completed/cancelled initial blocks are rejected.

The owner chooses titles, notes, dates and times explicitly; defaults do not copy source text or dates. This operation uses ordinary Calendar validation, not automatic availability/provider conflict checks. Only undeleted open work (`planned`/`in_progress`) in an active owned class creates records. Changed work/class versions return `VERSION_CONFLICT`. Deleted/closed/archived sources block with `ACADEMIC_WORK_DELETED`, `ACADEMIC_WORK_CLOSED` or `ACADEMIC_CLASS_ARCHIVED`; unknown/foreign work returns 404. A mismatched study class returns `ACADEMIC_CLASS_MISMATCH`.

Creation reuses existing task/Calendar writers under the owner schedule lock. Item, source snapshot/link and receipt commit atomically; failure rolls back all. Reuse the exact endpoint/payload/operation ID after an uncertain response. Receipt replay returns its original result even after source changes/deletion, so reload before treating it as current. Changed payloads conflict; different operation IDs deliberately create separate records.

`academicPlanningResponseSchema` returns kind, task/event and source. Migration 028 adds same-owner `academic_planner_sources` with exactly one planner target and at most one direct academic source per target. Immutable snapshot fields reuse `studyWorkloadSnapshotSchema`: IDs/versions, class label, nullable date/estimate, priority/status, applied work labels and `owner-entered-planning-fields` origin. Titles, notes and scores are not selected/copied. Direct assignment links remain separate from automatic plan workload-ranking dependencies.

## Inspection and retained history

Tasks, Calendar records/occurrences and legacy events add nullable `academicSource` summary metadata: link/work/original-class IDs, captured/current work/class versions, current work status, deletion/archival flags and known inherited labels. Old records/exports default to null. Source class can differ from a block's current class after editing.

GET `/api/v1/tasks/:id/academic-source` and `/api/v1/calendar/:id/academic-source` return `academicPlannerSourceResponseSchema`, including owned tombstones and optional `expectedVersion`. Changed item versions conflict; unknown/foreign items return 404. The response includes current item version/deletion, nullable source link/snapshot and current source planning fields. `source: null` means no direct academic link, not proof of no other influence. `changed` compares work/original-class versions, including edits to uncopied fields; it does not assert a particular field changed. Known link labels do not verify text origin or reconstruct unknown earlier topic history.

GET `/api/v1/academic-work/:id/planner-work` uses `academicPlannerWorkQuerySchema`: limit 1-200/default 50, optional owned `after` link ID, and `deleted=false|true|all` (default false). Entries contain source and current task/Calendar record; completed/cancelled records remain visible. Source work may be closed/deleted or in an archived class.

Pages sort by link UUID, not creation time; `nextAfter` is null at the end. Cursors must belong to the owned source and remain usable after target deletion-state changes. Unknown/foreign/wrong-source cursors return 404. Reset on refresh/filter changes, preserve filters and guard delayed responses. Pages are not frozen; refresh after mutations because newly created UUIDs may sort before the cursor.

Source edits never overwrite planner fields. Task/block completion never marks work submitted, decrements full estimates, records a school grade or changes confidence/mastery. Deletion/restore and class archival retain links/snapshots; planner restoration remains independent. No unlink, existing-item attachment, source replacement or purge is implemented.

Work/class/topic labels persist through deleted records, detachment, changed class/topic links and occurrence replacements. Stronger labels remain; new masked labels advance item versions once and already captured labels do not. Ordinary edits cannot lower inherited source labels. Unknown event `academicLabels: null` stays unknown. Source relabeling may conflict with offline task replay/restores; retain drafts and require review.

## Planning report

GET `/api/v1/academic-work/:id/planner-work-summary` accepts required local date-only `from`, exclusive `to` and `timeZone` for 1-31 days, returning `academicPlannerSummarySchema` in a consistent owned read-only snapshot.

Task open/completed/deleted counts cover all direct linked history, independent of dates/pages. Calendar root/deleted-root counts cover all linked history; timed occurrence counts/minutes cover the requested range. Shared recurrence/exception expansion includes moved/completed replacements. Cancelled occurrences are omitted; cancelled status on retained timed blocks is counted separately. Elapsed minutes clip to local range boundaries through DST. All-day occurrences have a separate count and no invented study minutes. Overlaps sum as recorded, not verified attendance.

Keep `MANUAL_RECORDS_ONLY`, `PLANNER_COMPLETION_IS_NOT_SUBMISSION` and `STUDY_TIME_IS_NOT_MASTERY` available with report Help. Current source estimates/status remain independent. Deleted/closed work and archived classes retain reports. More than 5000 linked tasks or Calendar roots each, or 20000 expanded occurrences, blocks the entire report with `ACADEMIC_WORK_TOO_LARGE`; unavailable is not zero.

## Export, offline and AI

Format-v1 export adds default-empty `academicPlannerSources`, retaining snapshots, known labels and deleted targets/sources. Existing per-array 10000-record and 16 MiB file limits apply. Migrations preserve old records/receipts without retroactive linking.

Creation, full inspection, browsing and reports are online-only, outside cache/outbox allowlists. Summary metadata in existing cached task/Calendar snapshots is historical offline. Linked-task edits use the ordinary outbox, versions and conflict review.

The [manual academic context gateway](ai-academic-context.md) now verifies explicitly selected academic work and direct planner origins, projects allowlisted manual text and binds captured/current source metadata. Newly created direct study blocks retain complete class/topic history. Existing incomplete history and workload-plan blocks still return PROVENANCE_UNAVAILABLE; no legacy history is invented. Migration 045 protects capture identity/snapshots/time from rewriting or deletion and permits only growing labels. UI selection, automatic matching/deadline propagation, assignment optimizer allocation and provider execution remain pending.

## Validation

A compiled API smoke check applied all 29 migrations to an isolated in-memory database and verified linked task/study creation, retained label conflicts, captured/current inspection, source reports/export, historical retries and academic reminder delivery/suppression. Network calls were forbidden and workers were invoked explicitly.

`npm run check` passed lint, strict types, formatting, production builds and 227 API/client tests; one optional standard PostgreSQL test was skipped because its isolated URL is unset. All 45 isolated browser tests passed. Nineteen new planning/report tests cover ownership, versions, retries/concurrent writes, atomic rollback, strict inputs, normalized constraints, populated migration upgrade, restart/export, retained labels through detachment/tombstones/new ancestors, full paged counts, recurrence exceptions, DST clipping and size blocking. Browser coverage verifies source relabeling stops stale offline task replay while retaining the local draft. Lint/types/formatting were rerun after the browser-test changes. Standard PostgreSQL coverage is added but unverified locally; no real provider calls, paid AI, owner database resets or device tests occurred.
