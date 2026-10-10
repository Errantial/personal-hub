# Canvas API courses and assignments

Connections has a separate Canvas API panel for read-only course and assignment metadata. It is independent of the existing calendar feed/file importer. No live school API access or completeness has been verified. Neither adapter writes to Canvas.

## Setup and access

Set `CANVAS_API_TOKEN` privately in the server environment or repository-root `.env`, then restart the API. Never put it in `VITE_*` settings, source control, chat, screenshots or logs. The frontend accepts no token and displays only configured/not configured. The fixed upstream origin is `https://canvas.colorado.edu`; the server-held token is bound to the enrolled owner in `owner_setup`, so another owner cannot activate or use it.

This manual-token path is for the owner's personal testing. School policy/permissions may prevent token generation or access; live access remains a gate. Canvas documents manual tokens for testing and requires OAuth for multi-user applications. Expansion needs institution-approved OAuth and per-owner credential storage rather than this singleton configuration. [Canvas OAuth and manual token guidance](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth).

Select API auto refresh and Save API settings to enable fifteen-minute refreshes, or Sync Canvas API for a manual job. Auto refresh defaults off. Saving it off cancels queued/running jobs and prevents a late fetch from committing. Imported records and personal fields remain. Removing the token stops network work; retained records are still viewable. Credential changes do not prove the new token represents the same school account: compare the account/records before relying on synchronization.

## Imported fields and boundaries

The adapter requests the current user's active student course enrollments, including term metadata, through `GET /api/v1/courses`, then `GET /api/v1/courses/:id/assignments` for each returned course. It explicitly applies assignment date overrides for the requesting Canvas user. Canvas documents these paginated resources and the user-specific `due_at` behavior. [Courses](https://developerdocs.instructure.com/services/canvas/resources/courses), [assignments](https://developerdocs.instructure.com/services/canvas/resources/assignments).

Persisted provider fields are restricted to course ID/name/code/term/timezone and assignment ID/title/due instant/possible points/published flag/locked flag. Missing deadlines and flags remain unknown; no deadline is inferred from text. Due instants display in the device timezone. Possible points describe the assignment, not the owner's earned score. Descriptions, HTML, syllabi, enrollments, grades, submissions, feedback, attachment references and calendar-feed URLs are not persisted; linked resources are never fetched. Assignment links are constructed from validated numeric IDs on the fixed school origin.

API records remain separate from ICS entries because their identity/coverage differs. There is no inferred merge, automatic agenda deadline or class creation. Existing feed-derived tasks and study blocks are unaffected. Grades/submission status, announcements, browser enrichment and cross-adapter reconciliation are upcoming work.

## Assignment planning

Connections offers Create task and Plan study for available API assignments. Review the title, personal notes and date-only task deadline or timed study interval before saving. A missing source deadline stays empty. Timed deadlines propose a date in the device timezone; study time is chosen separately. Study blocks require an active owned class and may use a different class from the source's explicit link. No provider writes or automatic conversion occur.

Creation uses the existing task/calendar APIs with `canvasSourceRef: {kind: 'assignment-api', itemId, expectedVersion, expectedCourseVersion}`. The source and course must still be available at those versions. Changes retain the planner draft; explicitly reload Canvas API, then Reload source version, before retrying. An unchanged request retries with its original operation ID. Deliberately creating another planner item remains allowed; feed/API records are not automatically deduplicated against planner work.

Migration 009 adds owned assignment foreign keys and separate immutable snapshots to tasks/events without changing earlier migrations. Planner `canvasSource` includes captured title/deadline/labels/course version and current facts/status/course version. Source labels inherit from API source, course, assignment and linked local class, including archived classes. Refreshes never overwrite the owner's task deadline, study time, notes, completion or tombstone. Changing/detaching the source link is unsupported. Export includes provenance on active and deleted planner records.

Creation requires a connection; existing assignment-linked tasks retain ordinary offline edits/replay. Study editing remains online-only. API metadata is not file-derived; future AI still requires the provider-routing gateway and evaluates captured/current labels. No AI processing is enabled.

## Personal records and class portfolios

Course IDs and assignment IDs within a course deduplicate imports. Updates change only provider metadata and observed availability, preserving IDs, owner notes, labels and links. A successful full snapshot marks absent courses/assignments Not in latest API snapshot; omission is not deletion. Available means present in the snapshot, not proof of enrollment, publication, submission or mastery. Failed/partial/over-limit responses leave the entire previous snapshot and import timestamp unchanged.

Edit API course notes allows an explicit link to an existing owned class. API assignments then appear read-only in that class's Canvas assignments section. Multiple API courses can be linked to one class. No mapping is guessed and imported names never overwrite manual class fields. Archived local classes retain links and label inheritance; unchanged links may keep their notes edited, while new links require active owned classes. No imported data changes topic progress/confidence or grades.

Course and assignment edits use optimistic versions and idempotent receipts. A conflict retains the form draft; Reload Canvas API and Reload API record version adopt the latest version without overwriting edited fields. Settings drafts also retain their version until an explicit reload/save. Effective sensitivity is the strongest source label, API course label, assignment label and linked local class label, including archived classes. No automatic classification or AI processing occurs.

Previously loaded class assignment lists use the owner/expiry-scoped browser cache. Cache content reflects the last loaded snapshot; new data/labels and edits require a connection. The connection panel itself is online-only. Views reject more than 2,000 retained records per collection rather than truncating them. Portable planner export includes API records, notes, links, labels and safe source settings as additive format-v1 fields, defaulting to empty/null for older exports. Its existing 10,000-record/16-MiB limits apply. Tokens, sync jobs and lease tokens are excluded. Pagination/pruning of retained application records remains pending.

## Transport and durable refreshes

Bearer authentication is sent only as an Authorization header. Fetches are GET-only, redirects are forbidden, and every pagination URL must use the exact school origin and the same collection path (with optional `.json` suffix), without credentials, fragments or access-token query parameters. Canvas's Link header drives pagination; arbitrary page numbers are not guessed. Malformed Link headers, duplicate next links, repeated URLs, unsafe destinations and invalid/duplicate IDs fail the whole snapshot. A page without a next link ends that collection. [Canvas pagination](https://developerdocs.instructure.com/services/canvas/basics/file.pagination).

Bounds: 100 courses, 2,000 assignments total, 100 pages total, 1 MiB per response, 8 MiB aggregate, ten seconds per request/stream and ninety seconds per whole fetch. Pages must be JSON arrays with supported metadata; invalid timestamps/timezones and incomplete restricted course objects fail rather than silently erase data. 401/403/429 and transport failures expose fixed error codes, without response bodies, URLs or credentials. Failed jobs are terminal; an enabled source retries on its next fifteen-minute schedule, or the owner can request a manual refresh. There is no fallback to another adapter or automatic bypass of access restrictions.

Migration 008 adds separate source, course, assignment and job tables with ownership foreign keys. Source locks serialize settings, owner edits and commits. Jobs have a 120-second lease, one active job per owner, token-checked commits and restart recovery. Three expired attempts become LEASE_EXPIRED. A successful fetch commits the entire snapshot and counts atomically. Full network fetches happen outside the transaction. Pause invalidates the lease; interrupted or paused work cannot overwrite newer data.

## API and validation

- `GET/PUT /api/v1/connections/canvas/lms`: owner-only records, configuration status, settings and recent job history; PUT uses operation ID and expected version.
- `POST /api/v1/connections/canvas/lms/sync`: duplicate-safe manual refresh, configured enrolled owner only.
- `PUT /api/v1/connections/canvas/lms/courses/:id`: notes, label and nullable owned courseId with expected version/operation ID.
- `PUT /api/v1/connections/canvas/lms/assignments/:id`: notes and label with expected version/operation ID.
- `GET /api/v1/connections/canvas/lms/records?courseId=...`: owned class's linked courses/assignments and import timestamp in a consistent snapshot.

API tests use synthetic transport and databases for credential boundaries, pagination, limits, ownership, labels, notes/link preservation, missing records, conflicts, exports, lease recovery and pause. Browser fixtures test rendering, conflicts, explicit class linkage and cached offline lists; they do not contact Canvas or prove live adapter access. Existing browser tests explicitly clear inherited API/feed credentials. Standard PostgreSQL, remote CI, live identity/coverage and actual Kompakt behavior remain separate gates.
