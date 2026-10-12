# Responsibility review inbox and selected dismissal

Implemented 2026-10-11. These additive owner-authorized endpoints aggregate [responsibility records](responsibilities.md), current source metadata and blocked review history. They add no migration/dependency, dispatcher, background scheduling, paid AI, model/tool/provider call, prompt/result retention or planner/email write. executionEnabled=false always. UI integration remains pending.

## Owned attention

GET `/api/v1/responsibilities/attention` takes no query fields and returns server asOf, responsibility totals (active/paused/cancelled among nondeleted roots; deleted separately), dueCount and run totals (blocked/cancelled), plus executionEnabled=false. Due means an active nondeleted root with an active pending schedule due at the server's asOf; exhausted/cleared/paused/cancelled/deleted sources are excluded. Run totals retain cancelled/tombstone history. The totals are full owned counts, independent of inbox paging/filters. This reads one session-rechecked consistent snapshot without changing runs, schedules, receipts or notifications.

Counts measure stored scheduling/review state, not agent activity or completed work. Active does not establish a live executor; blocked is an unexecuted placeholder. This endpoint does not add notifications or replace the existing Today/planner attention APIs.

## Global review inbox

GET `/api/v1/responsibilities/runs/inbox` accepts status=blocked/cancelled/all (blocked default), trigger=manual/schedule/all (all default), optional owned responsibilityId, limit 1–100 (25 default), and paired after run UUID/expectedCursorVersion. An explicitly requested foreign/missing responsibility returns 404 even if its page would be empty.

Response: entries, counts `{ blocked, cancelled }`, nextAfter `{ id, version }` or null, executionEnabled=false. Counts apply trigger/responsibility filters but ignore status/page. Each entry contains the historical run metadata, current source `{ id, version, title, status, deletedAt, labels }`, and sourceChanged when the current parent version differs from admitted responsibilityVersion. Goal text, prompts, results, tool/provider responses and credentials are omitted. The current title may have changed; it is not a captured title. Current labels preserve owner history; captured labels/hashes alone are never present disclosure authority.

Ordering is createdAt descending, then run UUID descending. Cursor lookup uses the database's exact microsecond timestamp rather than the rounded response timestamp, preventing missed/duplicated rows within one millisecond. It must be owned/filter-eligible (404 otherwise), and changed eligible run versions return 409. A cancelled anchor under a blocked-only filter becomes ineligible; under all it remains eligible but changes version. Source metadata can change without changing an already cancelled run version. Pages are consistent snapshots, not frozen across requests; reset cursors on filters and guard delayed responses.

Current metadata is projected in the page query; clients need not fetch every parent, and the backend avoids a separate query per entry. Deleted/cancelled source history remains inspectable, with existing retained-content boundaries. Parent-detail access remains separately owned; this inbox never provides old goal text or evidence of execution.

## Atomic selected dismissal

POST `/api/v1/responsibilities/runs/dismiss-batch` takes operationId and 1–50 explicit unique items `{ id: runId, expectedVersion: runVersion }`. UUID case variants count as duplicates. It does not dismiss by filter or implicitly select later arriving runs.

All selected runs must be owned, version-matching and blocked. Missing/foreign selections return 404; stale versions or already cancelled runs return 409; invalid/oversized/duplicate selections return 400. The transaction locks every involved parent in canonical UUID order, then re-reads/locks selected runs in canonical run order. This matches lifecycle/due admission ordering, so concurrent pause/edit/delete cannot be overwritten. Any failed selection/activity write rolls back all run changes, activity and the receipt.

Success changes each selected run to cancelled/owner-dismissed, cancelledAt and version+1, appending one run-dismissed activity. It returns `{ runs, executionEnabled: false }` in canonical run UUID order; map by run ID rather than selection position. Parent versions and schedule due pointers are unchanged. Dismissal does not mean work succeeded and does not execute, resend, release a provider attempt or grant renewed authority.

Exact concurrent/lost-response retries return historical metadata without duplicate events or touching later arrivals. Changed successful operation IDs conflict. Refresh inbox/attention after retry; a historical receipt is not a current snapshot. Overlapping batches either commit the requested selection or fail atomically, preserving an earlier lifecycle cancellation reason. Existing individual dismissal remains available and uses the same run-version semantics. Existing export retains dismissal/activity; no new export field is required.

## UI handoff and validation

Show blocked review/changed or closed source/due totals without implying an agent is working. Keep selected IDs/versions stable across a lost response, preserve conflicts for explicit reload, and offer an atomic selected-dismiss action. Refresh counts after writes; do not infer them from loaded rows. Current source title/labels are distinct from historical run metadata; old goal text may be unavailable. Keep revoked/expired session, unavailable cursor, source change, retained deletion content and actionable conflicts visible. These APIs remain outside offline caches/task outbox and AI/MCP context.

Eight isolated synthetic tests passed for counts/read-only behavior, current-versus-admitted metadata, content-free pages/filter counts, microsecond ordering/version guards, cross-parent atomic/concurrent/historical dismissal, overlapping/pause races, activity failure rollback, boundaries, owner/session/origin isolation and persisted restart/export. Fetch is forbidden; fixtures use memory or isolated `.artifacts` databases. Optional standard PostgreSQL inbox/dismiss/attention coverage is added but unverified locally while TEST_DATABASE_URL is unset. Full npm run check passed lint, strict types, formatting, production builds and 310 API/client tests; one optional standard PostgreSQL test was skipped. Browser tests were not rerun because UI/authentication-layer code was unchanged. No owner database reads/resets, real providers, paid AI or device tests occur. UI controls, background scheduling, verified runtime gates and live execution remain pending.
