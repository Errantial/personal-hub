# Academic browsing and selected changes

Implemented 2026-10-12. Owned online backend routes add guarded browsing across manual work and atomic changes to explicit selections. UI/offline integration remains pending. These routes do not import provider grades/submissions, run AI or change linked planner tasks/study blocks.

## Browsing

`GET /api/v1/academic-work/browse` uses the shared `academicWorkBrowseQuerySchema`:

- Optional `courseId`; owned archived classes may still be requested.
- `courseState=active|archived|all`, default active.
- `status=all|open|planned|in_progress|submitted|cancelled`, default all. Open includes planned/in-progress.
- `kind=all|assignment|exam|project|other` and `deadline=any|dated|undated`, default all/any.
- Limit 1-200, default 50; optional `after`, `expectedCursorVersion` and `expectedCourseVersion`, supplied together.

`academicWorkBrowseResponseSchema` returns the filters, full summary, `work` and nullable `nextAfter={id,version,courseVersion}`. Each work record includes current `courseName`, `courseVersion` and `courseArchived` from the same read-only repeatable snapshot. Records/notes/scores remain private owned data. Tombstones are excluded; the existing history endpoint with `deleted=true` remains available.

Open records sort before submitted/cancelled records; each group sorts by deadline, undated last, then UUID. Summary counts apply to the class-state/class/kind/deadline filters, independently of the status filter and page: total/open/planned/in-progress/submitted/cancelled counts, open missing deadlines/estimates and known estimated open minutes. Zero is known effort; null remains missing. Estimates are full owner estimates, not remaining effort after subtracting study time.

The cursor must still belong to the selected filters and owner. Changed work or class versions return `VERSION_CONFLICT`; absent/deleted/foreign/filtered anchors return 404. Preserve all filters between pages and reset the cursor on refresh/filter changes. Cursor checks do not freeze the entire multi-page history. The original creation-time history endpoint and open deadline agenda retain their behavior.

## Selected changes

`POST /api/v1/academic-work/batch` uses `academicWorkBatchRequestSchema`: an operation UUID, 1-100 distinct explicit `{id,expectedVersion,expectedCourseVersion}` selections, and one action:

- `update` with nonempty `changes` containing status, priority, date-only deadline and/or estimated minutes.
- `delete`, which retains tombstones and all academic fields.

Omission preserves a field; null explicitly clears deadline/estimate. Explicit zero effort is valid. Title, notes, class, labels, source identity and scores cannot be batch-overwritten. An update requires active classes; historical deletion permits archived classes with their current versions. Class/topic restoration is not implemented; do not offer it as a recovery action for an archived-class error.

Reopening/cancelling graded work returns `ACADEMIC_SCORE_REVIEW_REQUIRED` for the entire selection. Review and explicitly clear that score through the individual edit flow first. Submission remains owner-reported; it does not prove school submission or mark linked tasks/study complete. Changing priority/deadline/effort never silently erases scores.

The owner schedule lock precedes canonical class/work locks. All ownership, availability, work/class versions and score/status checks pass before any update. Records, version advances, schedule revision and retry receipt commit together, or all roll back. Session authorization is rechecked for fresh changes and historical receipt replay. Successful responses preserve selection order; each selected record advances once even for a same-value update.

Retry the exact request/operation after a lost response. Changed payload reuse returns `OPERATION_CONFLICT`. Historical retries return historical results without overwriting later work or restoring deletion; reload current data for display. Deleted work uses the existing individual restore endpoint. Source captures/labels remain intact; changes to eligible open workload invalidate pending study drafts, and selected work-version changes invalidate AI references. Reminder delivery checks submission/deletion under the same schedule lock; already-delivered notifications remain history.

## Boundaries and verification

No migration, dependency, AI action authority, provider write or offline batch replay is added. Portable export already retains changed records/scores/tombstones; batch receipts are not a revision timeline. Filter-wide selection, score changes, automatic deadline shifts and batch restore remain pending.

Synthetic coverage includes strict filters/actions, 207-record guarded paging and complete totals, archived-class browsing, ownership, ancestor/work conflicts, field/score/label preservation, mixed-class changes, rollback, competing and duplicate writes, reminder suppression, receipt replay and persisted restart. Standard PostgreSQL browsing/duplicate/overlapping-batch coverage is added but remains opt-in through the disposable test URL.

Final validation: all 17 academic-management tests and three shared batch-authorization tests pass. `npm run check` passed 505 API/client tests with one optional PostgreSQL skip, lint, types, formatting and builds. All 84 browser regressions passed on an isolated rerun; compiled API smoke verified the endpoint wiring and migration guard. The final error-copy correction also passed focused checks and a refreshed API build. UI/offline controls and standard PostgreSQL verification remain pending.
