# Task browsing and selected changes

Backend implemented 2026-10-11. UI integration remains pending. These additive routes use shared `taskBrowseQuerySchema`, `taskBrowseResponseSchema`, `taskBatchRequestSchema` and `taskBatchResponseSchema`. Existing list, detail, single-record writes, deadline agenda, restore, export and offline task edits retain their contracts. No migration or dependency is added.

## Browse

GET `/api/v1/tasks/browse` accepts:

| Parameter | Values |
| --- | --- |
| `status` | `all` (default), `open`, `completed` |
| `priority` | `all` (default), `low`, `normal`, `high` |
| `due` | `any` (default), `dated`, `undated` |
| `limit` | 1-200, default 50 |
| `after`, `expectedCursorVersion` | Paired UUID and positive version from `nextAfter` |

Only owned undeleted tasks are eligible. Results contain full shared task records, including current embedded academic/Canvas provenance. Order is incomplete first, then completed; each group sorts by deadline ascending, undated last, then UUID ascending. The older `/tasks` list keeps its existing order.

`summary: { totalCount, openCount, completedCount }` covers all active tasks matching priority and date-presence filters, independently of status selection and paging. This supports status counts even while browsing only completed tasks. Empty matches return explicit zeros. `totalCount = openCount + completedCount`.

`nextAfter` is `{ id, version }` or null. The anchor must remain owned, undeleted and eligible for every selected filter. Missing/foreign/deleted/no-longer-matching anchors return 404 `NOT_FOUND`; a changed eligible anchor returns 409 `VERSION_CONFLICT`. A page and its counts use one read-only repeatable snapshot with session revalidation, but successive pages are not a frozen dataset. Reset the cursor on refresh/filter changes and after writes. No read changes records, notifications or receipts.

Use `/tasks/agenda` for local overdue/today/upcoming classifications; this route has no inferred current date or deadline horizon. Imported source facts and manual assignment submission remain separate.

## Selected changes

POST `/api/v1/tasks/batch` applies one explicit action to 1-100 distinct active owned tasks. Every selection includes its current optimistic version:

```json
{
  "operationId": "00000000-0000-4000-8000-000000000001",
  "items": [
    { "id": "00000000-0000-4000-8000-000000000002", "expectedVersion": 3 }
  ],
  "action": {
    "kind": "update",
    "changes": { "completed": true, "priority": "high", "dueDate": null }
  }
}
```

For `kind: update`, provide at least one of `completed` (boolean), `priority` (low/normal/high), or `dueDate` (valid date-only string or null). Omitted fields remain unchanged; null deliberately removes a deadline. The same supplied values apply to every selected task. Successful assignments advance each task version once even when a value already matches, consistent with ordinary PUT behavior.

For deletion use `action: { "kind": "delete" }`, with no changes object. Deletion preserves normal tombstones and advances each version once. Existing per-task restore operations are available; batch restore/permanent deletion is not implemented. Reminder suppression happens when the existing worker rechecks the target, with the same owner lock as task writes. Reopening/restoring never automatically revives cancelled reminders. Rescheduling a deadline does not reschedule an explicitly scheduled reminder.

Title, notes, sensitivity, creation timestamps, captured/current source relationships and snapshots are preserved. The route accepts no arbitrary fields, source attachment/unlinking or label changes. Task completion does not submit an assignment, change estimated effort/mastery, or alter imported deadlines. Existing inherited labels and AI provenance restrictions remain in force.

All selected records and versions are checked under the shared owner schedule lock before one database update. A missing, foreign or deleted selection returns 404; any stale version returns 409 `VERSION_CONFLICT`. No task or receipt is saved on failure, including a database interruption. Records, source projections and the durable receipt commit together. The response is `{ tasks: [...] }` in input selection order, including deletion tombstones.

Exact retries with the same operation ID return the original historical response without repeating writes, even after later edits, deletion or restart. A successful operation ID reused with changed selections, versions, ordering or action returns 409 `OPERATION_CONFLICT`. Keep the complete request unchanged after a lost response. A rejected transaction has no receipt; an explicitly refreshed selection may then be submitted. Historical retry results are not proof of current versions: refresh before the next action.

## UI, offline and access boundaries

Keep explicit selected IDs and versions; a count or filter does not select every matching record. The server never changes unseen tasks automatically. Retain selection and drafts on errors, reload changed records before retrying, and guard delayed page responses. Batch changes are atomic, so do not display partial success. Update other task/Today/source report views after success, and reset browsing cursors.

Both routes require owner authorization; unknown/foreign records do not reveal private data. Origin/JSON protections and normal receipt ownership apply to batch writes. These new routes are online-only and outside response-cache, task-outbox and AI-reference allowlists. UI controls must show unavailable/offline/pending/conflict state; existing queued individual edits remain visible and server counts exclude those drafts. Do not invent an offline batch replay path or replace newer drafts with a historical retry response.

No UI controls, real provider calls, paid AI, live AI action execution, native delivery or device verification are added. No owner database access/reset is needed for tests.

## Validation

`npm run check` passed lint, strict types, formatting, production builds and 247 API/client tests; one optional standard PostgreSQL test was skipped because its isolated URL is unset. Eleven new synthetic tests cover strict bounds, full counts beyond 200, tied-date/undated/status paging, cursor eligibility/versions, ownership/revoked sessions, selected-field preservation, concurrent/historical retries, competing selections, forced database rollback, source labels/snapshots/file provenance, tombstones/restore/export, reminder suppression and persisted restart. All fixtures use isolated memory or `.artifacts` databases with network calls forbidden.

Optional PostgreSQL coverage adds duplicate and competing batch writes plus completed browsing, but remains unverified locally. Browser tests were not rerun for this batch because UI/authentication-layer code was unchanged. No owner database reads/resets, real providers, paid AI or device tests occurred. UI/offline batch integration remains pending.
