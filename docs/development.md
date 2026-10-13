# Development and operating guide

## Current implementation

[Academic management](academic-management.md) adds owner-only guarded browsing/full counts and atomic selected status/deadline/effort/priority/deletion. [Selected Calendar changes](calendar-management.md) add whole-record deletion and one-time timed study statuses, preserving recurrence/source history. Both use shared contracts, versions, schedule locks and guarded historical receipts. UI/offline integration remains pending.

[Transient context review](ai-context-preview.md) adds owner-authorized POST /api/v1/ai/context/preview in a read-only snapshot. It returns bounded text for local review with no-store/no-persistence semantics and visible execution blockers. Durable submission still rechecks and binds fresh sources; this enables no provider dispatch.

[Manual academic AI context](ai-academic-context.md) adds explicit work/class version references, bounded score-free text projections and verified direct task/study origins. Migration 045 guards immutable captures and retained labels. Workload-plan/legacy incomplete provenance and all live dispatch remain blocked.

[Offline Claude response inspection](ai-claude-response.md) adds a bounded pure native JSON decoder with exact-model/source validation and separately named unverified usage estimates. It enables no process, provider, accounting settlement or answer retention; CLI cost reports cannot establish an invoice.

[Local subscription runtime doctor](ai-runtime-doctor.md) adds npm run ai:runtime-doctor with explicit native executable paths. It inspects only version/help in a filtered environment and bounded temporary working directory, producing redacted reports. Advertised controls do not clear subscription blockers; account/isolation/billing remain unverified.

[Subscription isolation requirements](ai-subscription-isolation.md) add explicit readiness blockers and a pure bounded Claude CLI draft. No process or login is launched; preparation is not verified isolation. Codex request preparation and dedicated runtime/account/usage verification remain pending. Existing synthetic byte-token execution blocks subscription routes before admission.

[Offline charge-only recovery](ai-accounting-recovery.md) settles immutable reported synthetic usage without prompt resupply, external I/O or answer reconstruction. Migration 044 adds unavailable result metadata and SQL evidence checks. New recovery requires the attempt version; identical settled replay preserves saved/forgotten answers. Live invoice verification remains pending.

[Offline protocol recovery observations](ai-protocol-recovery.md) add bounded immutable pre-settlement metadata through migration 043. Uncertain IDs and coherent reported usage survive settlement/storage failure and restart without retaining answer text or resending. Protocol reports remain synthetic; live lookup and charge-only lost-answer recovery are pending.

[Offline OpenRouter durable accounting](ai-openrouter-accounting.md) integrates synthetic protocol reports with exact reported-cost settlement and per-request saved answers. Migration 042 adds safe nullable protocol metadata; older byte-token accounting is preserved. Restart/retry/storage failure never sends a second exchange. Live dispatch remains disabled.

[Offline OpenRouter protocol verification](openrouter-protocol.md) adds bounded injected-I/O exercises and exact-cost/native-usage decoding. Provider errors, invalid guidance, cache responses, redirects, cancellation and uncertainty are handled without retries. Synthetic test configuration is mandatory; live transport, durable settlement and provider account access remain pending.

[Provider setup and saved answers](ai-provider-setup.md) implement the owner-confirmed $50 monthly ceiling/$0.25 initial request cap and explicit per-request answer retention. Migrations 040/041 preserve spend/holds/history; owned answer reads/forget/export are available for validated synthetic results. Subscription/OpenRouter/Prem profiles are declarations; real transports/account verification remain pending.

[Verified AI context and synthetic text results](ai-verified-context.md) add private exact-context binding, explicit versioned memory references, final synthetic callback rechecks and bounded temporary source-linked guidance. Migrations 038/039 preserve older request/attempt metadata; legacy unbound requests require a new assessment before new admission. Public/live dispatch remains disabled.

[Local responsibility review schedules](responsibility-local-schedules.md) add daily/weekly civil rules, DST handling and durable slot indices through migration 037. Existing UTC schedules remain supported. Explicit admission coalesces missed slots into blocked placeholders; UI/background execution remains pending.

[Responsibility review inbox](responsibility-inbox.md) adds chronological guarded metadata browsing, current source state/label/version inspection, full owned attention totals and atomic explicit selected-run dismissal. It adds no migration/dependency, notifications, provider dispatch or background worker. UI integration remains pending; existing lifecycle, individual dismissal and offline task behavior are preserved.

[Responsibility records/reviews](responsibilities.md) implement three backend milestones: owned lifecycle/labels (034), UTC review schedules and atomic explicit due admission (035), and blocked run/activity history/export (036). Active permits scheduling/manual placeholders, not agent execution. No worker, provider/model/MCP call, lease or planner action is enabled. UI and live runtime gates remain pending.

[Editable owner memory](memory.md) adds owned preferences/goals/facts, global/per-record disable, versioned edits, guarded literal search, metadata-only receipts, content-clearing forget tombstones and export. Migration 033 preserves existing records. Explicit versioned memory references are implemented separately in the verified context gateway; automatic extraction, MCP context, embeddings, automatic retrieval and provider calls remain disabled. UI controls/provenance integration remain pending; forgetting clears logical memory text but not old backups or independently saved copies.

[Email attempt lifecycle](email-attempts.md) adds one-attempt consumption, uncertainty-preserving synthetic callbacks, idempotent confirmed test outcomes, owned metadata history and export. Migration 032 preserves drafts/approvals. The harness requires NODE_ENV=test and reserved test addresses; no send endpoint, worker, credentials or production enable switch exists. Previews remain blocked; synthetic sent is not real delivery evidence.

[Email draft approval foundation](email-drafts.md) adds owner plain-text drafts, immutable revisions, version/hash-bound approval/revocation, delete/restore history, guarded pages and blocked send previews. Migration 031 and export arrays preserve owned data. It enables no mailbox access, attachment handling, provider sends or AI processing. UI review/send adapters remain pending; delete retains private history.

[Typed action permissions](ai-actions.md) add versioned owner task/calendar modes, immutable email approval requirements and a typed read-only authority/capability preview. Migration 030 and portable export support are added. Ordinary owner planner writes are unchanged; no AI executor or provider call is enabled by this preview. UI controls remain pending.

[Task browsing and selected changes](task-management.md) add bounded active/completed task pages and atomic selected completion, priority, deadline and tombstone writes. Every selected version must match; full records and durable receipts commit together under the existing owner schedule lock. No migration/dependency is added. New UI controls and offline batch replay remain pending.

The additive [task agenda and Today attention summary](today-summary.md) provide guarded task deadline paging and full task/manual-work/reminder totals in consistent owner-authorized reads. They are online-only, add no migration or provider calls, and do not change versions, delivery/read state or retry receipts. UI integration remains pending; Calendar/imported-source views remain independent.

Interface copy: prefer titles and labels over flavor text. Put secondary explanations in contextual Help, hover/focus tips or expandable details, accessible by keyboard and tap. Keep actionable errors, offline/pending/conflict state and essential warnings visible. See AGENTS.md.

A local authenticated planner: React/Vite web, Fastify API, shared Zod contracts, single-owner enrollment/login, versioned tasks, day/week calendar with all-day/recurring events and occurrence edits, class/topic portfolios, manual study blocks, durable reminders/inbox, optimistic conflicts, duplicate-safe retries, and e-ink appearance. See [planner behavior](planner.md) for recurrence rules, label inheritance and delivery limits.

Connections supports read-only Canvas calendar feeds, explicit ICS import, automatic/manual durable refresh jobs and personal notes/labels/class links. Imported entries appear read-only in Calendar and linked class portfolios; previously loaded ranges/lists have owner-scoped cached viewing. Configure the private URL only on the server; see [Canvas setup and boundaries](canvas.md). School completeness and richer API access remain unverified. No real feed is accessed by routine tests.

Connections can create owned tasks and one-time study blocks with `canvasSourceRef` on the existing create operations. Feed entries require their current version; API assignments require `kind: 'assignment-api'` and both assignment and course versions. Creation requires available owned sources and a connection; source facts and labels are retained with live source metadata in `canvasSource`. Planner edits/tombstones preserve provenance, and refreshes never overwrite personal planning fields. Future AI routing must evaluate captured/current source labels and file-derived provenance; see canvas.md and canvas-api.md. No AI processing is enabled.

Canvas API separately syncs read-only course/assignment metadata with durable jobs and a server-held personal-test token, explicit class links, owner notes/labels, cached portfolio viewing and export. It neither merges feed entries nor imports grades/submissions/descriptions. See [Canvas API setup and boundaries](canvas-api.md). Live school access/completeness and expansion through OAuth remain unverified.

Connections also supports explicit [feed/API reconciliation](canvas-reconciliation.md) based on matching assignment URLs, retaining separate facts and notes. Confirmed associations share effective labels and file-derived provenance, with version checks, stable rows and tombstones. No provider/planner facts are merged automatically.

Preferences includes [AI routing permissions and preview](ai-permissions.md), server profile visibility, numeric spending limits, and durable [AI preflights](ai-gateway.md). Preflight uses server configuration status and bounded owned text projections, retaining metadata rather than prompt/source text. Provider dispatch, health/model verification, priced execution, conversations and AI actions remain pending; declared quotes and versioned disclosure consent now have backend endpoints, with UI controls pending. Canvas API refreshes bind the upstream account ID after a successful import and reject tokens for another account. Maintain the [UI agent ledger](ui-agent-ledger.md) for the later rewrite.

Manual academic work supports explicit [task/study creation and source reports](academic-planning.md), with atomic snapshots, owned links, retained labels and retry receipts. [Academic reminders](academic-reminders.md) use explicit scheduled instants and recheck target availability before delivery and snooze. New creation/inspection/report controls remain pending for the UI agent; existing reminder rescheduling preserves academic targets. Planning snapshots do not approve source text for AI processing.

On restart, the API applies migrations 010-044 before readiness. They preserve existing planner fields, notes, versions, source snapshots, receipts and tombstones. Migrations 028/029 add direct academic planning links and owned academic reminder targets without reconstructing old links. Legacy Canvas account identity remains unverified until a complete successful refresh. Legacy calendar/topic history and old source snapshots without complete label arrays cannot be retroactively reconstructed; ordinary planner editing remains available, while routing checks block that uncertain context. No automatic backfill or owner-history review/reset is implemented.

A provisional Capacitor APK bundles this UI and its IndexedDB task outbox. Native login, offline task edits and process-restart/replay are tested on an AOSP emulator. Actual Kompakt hardware, native alarms/background delivery, offline calendar/class/reminder edits, email/Proton connections, richer Canvas access, imported grades, AI study suggestions, hosted AI/routing enforcement, AI memory retrieval, MCP and autonomous agent execution remain pending. Stored labels do not imply AI is configured. Development checks have not accessed real account content. See [implementation backlog](backlog.md).

## First run

Use Node.js 24 and npm 11. Defaults need no Docker, standalone database, provider keys, or `.env`.

```sh
npm ci
npm run doctor
npm run dev
```

Open `http://127.0.0.1:5173`, create the owner with an email and password of at least 12 characters, then add tasks/events. The email is a login identifier; no verification email is sent. Preferences supports password changes, active-session revocation and planner JSON export; see [account controls](account.md). Keep the password in a password manager: reset/recovery is not implemented. Enrollment closes after the first owner. No account/password was created for the owner by development tests.

API: `http://127.0.0.1:3001`. Root dev first builds shared contracts, then watches contracts/API/web together. Both listeners default to loopback; development API configuration rejects a non-loopback host. Stop with Ctrl+C. Embedded PostgreSQL data is saved under `.data/planner/`, excluded from Git. Do not run two API processes against the same embedded directory. This is server storage. The browser offline prototype uses IndexedDB separately; Android native storage is not implemented.

## Offline prototype

Reminder/inbox snooze and history backend is online-only. Shared contracts define delivered-reminder snooze, owned detail reads, bounded filtered pages, full unread counts and atomic selected-read batches. Migration 025 preserves prior deliveries and adds same-owner snooze links. UI integration is pending; see [reminder contracts](planner.md#snooze-and-inbox-history-backend-implemented-2026-10-11).

Android builds and the isolated synthetic server are described in [android.md](android.md). Run `npm run android:build -- --test` separately from `npm run check`. Native requests use the shared contracts and existing API authorization. Never point device tests at the owner's database.

The browser caches its static shell using a service worker and stores owner-scoped private snapshots and a task outbox in IndexedDB. After an online login and initial load, tasks can be created/edited/completed/deleted offline and survive reload. Reconnect or select Sync now to replay the original operation IDs in order. Web Locks prevent competing tabs from draining the same outbox. Cached views and task edits require the last verified session to remain unexpired; server revocation is checked before replay.

Task conflicts keep their local draft and stop ordered replay. Review the draft and explicitly discard that task's queued changes to use the server record. Automatic overwrite/rebase is not implemented. Sign-out requires pending tasks to be synchronized or discarded, then clears private local storage. Reauthentication as the same owner retains locked drafts. A different owner clears the previous owner's cache. No cookies/passwords are stored in IndexedDB.

Other screens can show previously loaded data, including only previously visited calendar ranges; their edits require a connection. Browser cache eviction, clearing site data and private browsing can remove the outbox. Service workers require a secure origin (HTTPS or loopback); first-time offline visits cannot work. The prototype is verified on Chromium, not Android process death or actual Kompakt firmware.

## Configuration

Copy `.env.example` to repository-root `.env` only when changing defaults. Existing process environment takes precedence. Never expose provider secrets in frontend `VITE_*` variables.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `development` by default; `test` for isolated tests; `production` enables deployment guards |
| `API_HOST`, `API_PORT` | API listener, default `127.0.0.1:3001` |
| `API_PROXY_TARGET` | Vite server-side `/api` proxy target; change alongside API_PORT |
| `WEB_PORT` | Vite development port, default 5173 |
| `WEB_ORIGINS` | Exact allowed browser origins, comma-separated, without trailing slash/path. Defaults permit `http://127.0.0.1:5173` and `http://127.0.0.1:4173` |
| `PGLITE_DATA_DIR` | Embedded development database directory; default `.data/planner` resolved relative to repository |
| `DATABASE_URL` | `postgresql://...` connection for a standard PostgreSQL server. Required in production; an empty value selects embedded development storage |
| `SETUP_TOKEN` | At least 32 random characters; required for first enrollment in production. Remove from server settings after owner creation |
| `LOG_LEVEL` | API logging level, default info |
| `CANVAS_CALENDAR_FEED_URL` | Optional private calendar URL on the exact school host; never returned to clients or exported. Enable automatic refresh in Connections after setup |
| `CANVAS_API_TOKEN` | Optional server-only token for personal Canvas API testing; fixed school origin/enrolled owner, read-only metadata adapter. Expansion requires OAuth |

Open the exact configured browser origin: `localhost` and `127.0.0.1` are different origins. The frontend uses relative `/api` URLs through the same-origin proxy; no permissive CORS policy is installed. Unsafe methods require an allowed `Origin` and JSON content type, including scripts/CLI clients. Future MCP callers will need their own authenticated transport rather than borrowing browser cookies.

## Database and migrations

Migration 028 adds [direct academic planner sources](academic-planning.md) with composite owned foreign keys, immutable planning snapshots and one direct source per planner item. Migration 029 adds [academic reminder targets](academic-reminders.md), preserving old rows/receipts and rejecting foreign-owned work links. Delivery and snooze share the owner schedule lock with source mutations. Synthetic populated-upgrade and persisted-restart tests cover both migrations; standard PostgreSQL coverage remains opt-in.

The [academic deadline agenda](academic-agenda.md) adds an owner-authorized read-only cross-class workload view with date/UUID paging, cursor versions, full horizon counts and missing-data totals. It uses existing records with no migration or dependency. Notes/grades, offline caching, AI context and imported-source reconciliation remain outside this endpoint.

Migration 027 adds [study workload source history](study-workload.md): draft planning snapshots, owner-scoped block links, current/captured inspection and portable export. Labels propagate through retained links, including other-class and deleted/detached blocks. Snapshots exclude source text/grades. Old history stays unavailable; this does not unblock AI context or add offline operations. Approved source sets are not duplicated for each block.

Migration 026 adds [manual academic work](academic-work.md): owned/versioned class work, recorded submission/scores, bounded history, deletion/restore, class-label propagation, missing-data summaries and portable export. UI/offline integration is pending. Scores do not change topic confidence, and this slice does not expand AI context or consume real provider data.

Open manual academic deadlines/priority/effort now inform [study priorities](study.md#academic-workload-signals-implemented-2026-10-11), with missing-data warnings and stale-draft protection. Work, class and topic mutations use the owner schedule lock before academic ancestors, matching approval lock order even when an affected class has no allocated slots. Owner goal budgets remain unchanged; grades are excluded from ranking. This integration needs no schema migration, provider calls or AI access.

The same numbered SQL migrations/query layer run on PGlite locally and the `pg` driver with DATABASE_URL. Migrations run before API readiness. Applied migration SHA-256 checksums are recorded and changes to applied files are refused. Add a new numbered SQL migration for every schema change; do not rewrite an applied migration.

AI preflight uses repeatable snapshots and retries only rolled-back database-only mutations. Never put provider calls inside a retryable mutation transaction. Internal budget accounting locks the owner policy before reservation rows; uncertain holds require confirmed usage to settle. Accounting/transition receipts never authorize a paid retry. Durable metadata-only requests and an internal synthetic-only attempt state machine are implemented. No HTTP dispatch endpoint or production worker exists; actual provider dispatch and prompt/result retention remain pending. See ai-gateway.md.

```sh
npm run db:migrate
```

Tasks/events are scoped by owner, versioned, and soft-deleted. Mutations require an operationId UUID; the owner/operation pair atomically stores the result with its payload hash. An exact retry returns that original result, including after deletion. Reusing the ID for a different operation/payload returns 409. Updates/deletes also require expectedVersion; stale writes return 409 and do not overwrite newer data. Lists exclude tombstones. Omitted sensitivity on an update preserves the existing owner label; changing/removing a label requires an explicit value. Receipts/tombstones have no pruning policy yet and must be retained until future device synchronization rules define safe cleanup.

Task dueDate is a date-only deadline. Calendar timed events use explicit UTC/offset timestamps and an IANA timezone; end must follow start. Calendar input uses the selected event timezone and requires an earlier/later offset choice for repeated local times; nonexistent local times are rejected. Today shows the current day in the device timezone, with independent cached planner/Canvas/reminder reads and offline task capture. Create/edit events through Calendar; the former Today one-time event editor is removed. All-day dates have an exclusive end date in storage. Recurring timed events preserve local start time through DST; see [planner behavior](planner.md).

For local backups, stop the API before copying the entire embedded data directory and test restoring into a separate directory. Standard PostgreSQL uses database-aware backup/restore, not copying a live data directory. The planner JSON download is a portable export, not a backup or supported import format. No automated backup/restore service or production restore test is claimed implemented.

## API contracts

Study/recovery backend: owner-authorized `/api/v1/study` routes provide versioned preferences/goals, ranked manual subject priorities, write-free previews, durable draft history/editing, atomic approval, safe cancellation/hiding and progress reports. `/api/v1/planner/deleted` pages task/calendar tombstones for existing restore operations. Migrations 023/024 add the study records and owner schedule revision locks; export adds settings/goals/plans without changing format v1. No AI or external provider is called, and external calendars are explicitly unchecked. UI integration/offline study edits remain pending. See [study contracts](study.md) and the UI ledger.

AI request lifecycle backend: `POST /api/v1/ai/requests` takes the shared preflight write contract and atomically stores a blocked request plus its assessment. `GET /api/v1/ai/requests` pages active records by owned `before` IDs; `GET /:id` reads one active record. `POST /:id/cancel` and `DELETE /:id` require `operationId` and `expectedVersion`. Cancel applies only to blocked requests; hiding preserves metadata/tombstones and refuses uncertain attempts. These routes never dispatch or reserve money. Prompt text is discarded; an internal test harness requires the original text again before synthetic admission. Migrations 021/022 retain requests/attempts, and planner export includes safe request and attempt metadata. UI controls remain pending. See [request lifecycle](ai-gateway.md#durable-requests-and-synthetic-attempts).

AI quote/consent backend: `GET /api/v1/ai/provider-readiness` returns per-profile declared quotes, current consent and all preliminary execution blockers. `PUT /api/v1/ai/provider-consents/:alias` versionedly approves/revokes the current safe server profile/disclosure using an operation ID and expected registry revision. New profile fields and preflight `executionReadiness` are shared contracts. Migration 020 stores safe approved snapshots; no prompt text, provider transport or reservation is created. UI controls remain pending. See [provider policy](ai-gateway.md#declared-prices-and-provider-consent).

Planner undo backend: owner-authorized `POST /api/v1/tasks/:id/restore`, `POST /api/v1/calendar/:id/restore` and legacy `POST /api/v1/events/:id/restore` take the shared `restoreItemSchema` (`operationId`, current tombstone `expectedVersion`) and return existing response shapes. Matching `GET /:id` routes read active records or tombstones for explicit conflict recovery. Migration 019 retains restoration metadata, also included in planner export. See [restore behavior](planner.md#restore-deleted-tasks-and-events). Tasks and Calendar have Undo and Recently deleted (online only); offline restore remains pending.

| Method/path | Purpose |
| --- | --- |
| `GET /api/health` | Process liveness and contract version |
| `GET /api/ready` | Database query readiness, 503 when unavailable |
| `GET /api/v1/bootstrap` | Four planned, explicitly unconfigured connections |
| `GET /api/v1/auth/session` | Current user or null, enrollment state and actual session expiry |
| `POST /api/v1/auth/setup` | First owner enrollment; email, password, optional production setupToken |
| `POST /api/v1/auth/login` | Email/password login |
| `POST /api/v1/auth/logout` | Revoke current session |
| `GET /api/v1/tasks`, `GET /api/v1/events` | Owner's active records |
| `GET /api/v1/tasks/agenda?asOf=...&to=...` | Full deadline buckets, guarded cursor paging and unchanged task/source contracts |
| `GET /api/v1/today/summary?asOf=...&to=...` | Consistent task/manual-work/reminder attention and full unread totals; excludes schedule/imported deadlines |
| `POST /api/v1/tasks`, `POST /api/v1/events` | Create with operationId; tasks accept an optional stable clientId UUID for offline creation |
| `PUT /api/v1/tasks/:id`, `PUT /api/v1/events/:id` | Replace editable fields with operationId and expectedVersion |
| `DELETE /api/v1/tasks/:id`, `DELETE /api/v1/events/:id` | Tombstone with operationId and expectedVersion |
| `GET/POST /api/v1/calendar`, `PUT/DELETE /api/v1/calendar/:id` | Full series CRUD; legacy event edits reject advanced records |
| `POST /api/v1/calendar/batch` | Atomic selected whole-record deletion or one-time timed study-status changes |
| `GET /api/v1/calendar/occurrences?from=YYYY-MM-DD&to=YYYY-MM-DD&timeZone=...` | Expand a date window, exclusive to, maximum 93 days |
| `PUT/DELETE /api/v1/calendar/:id/occurrences/:date` | Replace/cancel one occurrence using the series expectedVersion |
| `GET/POST /api/v1/courses`, `PUT/DELETE /api/v1/courses/:id` | Owner class portfolios and tombstones |
| `GET /api/v1/academic-work/browse` | Guarded all-status manual work with full filter counts and current class versions |
| `POST /api/v1/academic-work/batch` | Explicit versioned/class-guarded status, priority, deadline, effort or tombstone changes |
| `POST /api/v1/academic-work/:id/planner-work` | Explicit linked task/study creation with current work/class versions and atomic receipts |
| `GET /api/v1/academic-work/:id/planner-work` | Bounded linked-work pages, optional deleted history and owned UUID cursor |
| `GET /api/v1/tasks/:id/academic-source`, `GET /api/v1/calendar/:id/academic-source` | Captured/current direct academic provenance, including owned tombstones |
| `GET /api/v1/academic-work/:id/planner-work-summary?from=...&to=...&timeZone=...` | Full linked status counts and range-clipped study minutes for 1-31 local days |
| `GET/POST /api/v1/topics`, `PUT/DELETE /api/v1/topics/:id` | Manual progress/confidence linked to an owned class |
| `GET/POST /api/v1/reminders`, `PUT /api/v1/reminders/:id` | Durable schedules and worker health; task/event/academic-work/standalone targets and queued/paused/failed rescheduling |
| `POST /api/v1/reminders/:id/control` | Versioned pause/resume/retry/cancel action |
| `GET /api/v1/notifications`, `POST /api/v1/notifications/:id/read` | Owner inbox and idempotent read receipts |
| `GET/PUT /api/v1/connections/canvas` | Canvas source settings, safe status/history, imported entries and inherited labels |
| `POST /api/v1/connections/canvas/sync` | Queue a duplicate-safe network refresh; server feed required |
| `POST /api/v1/connections/canvas/import` | Import a complete ICS snapshot with an operation ID; up to 1 MiB |
| `PUT /api/v1/connections/canvas/items/:id` | Versioned personal notes, entry label and optional owned courseId; provider fields remain read-only |
| `GET /api/v1/connections/canvas/calendar?from=...&to=...&timeZone=...` | Read-only imported entries for a maximum 93-day viewing range |
| `GET /api/v1/connections/canvas/items?courseId=...` | Owned class's linked read-only records and last import time |
| `GET/PUT /api/v1/connections/canvas/lms` | Canvas API records, settings and safe job history |
| `POST /api/v1/connections/canvas/lms/sync` | Queue an enrolled-owner API refresh; server token required |
| `PUT /api/v1/connections/canvas/lms/courses/:id`, `.../assignments/:id` | Versioned notes/labels; courses also accept an explicit owned class link |
| `GET /api/v1/connections/canvas/lms/records?courseId=...` | Owned class's linked API courses/assignments and freshness |
| `GET /api/v1/connections/canvas/reconciliation` | Consistent owned comparisons and association tombstones |
| `PUT /api/v1/connections/canvas/reconciliation/:itemId` | Confirm/remove matching assignment association with source/link versions and operation ID |
| `GET /api/v1/connections/canvas/planner-work?kind=calendar\|assignment-api&itemId=...` | Active owned tasks/study blocks grouped through confirmed source links |
| `GET/PUT /api/v1/ai/routing` | Owner routing policy, deny-by-default, versioned/idempotent writes |
| `POST /api/v1/ai/routing/preview` | Read-only text policy simulation; no provider dispatch or preview-text persistence |
| `GET /api/v1/ai/providers` | Safe server profile/configuration status; health unchecked, dispatch disabled |
| `GET/PUT /api/v1/ai/budget` | Owner USD spending limits; versioned/idempotent settings |
| `POST /api/v1/ai/preflights` | Versioned bounded text check; persists metadata only, never dispatches |
| `POST /api/v1/ai/context/preview` | Transient owner text review; no records, receipts, holds or dispatch |
| `GET /api/v1/ai/preflights` | Owner history with bounded ID-cursor pagination |
| `GET/DELETE /api/v1/ai/preflights/:id` | Read an active receipt or versionedly retain a hide tombstone |

Request/response types and runtime schemas live in `packages/contracts/src/index.ts`. Session tokens are random, hashed in storage, sent in HttpOnly/SameSite=Strict cookies, Secure in production, and expire after seven days. Passwords use salted scrypt. All responses disable caching. Routes validate ownership before planner access; unknown endpoints and internal errors return sanitized structured errors. Logs omit query strings, cookies, authorization, and private error content. Unexpected database startup errors also omit raw exception details.

## Checks and browser verification

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

`check`: lint, strict type checks, API/client tests, formatting checks and production builds. Tests cover credentials/session handling, owner isolation, origin policy, date/timezone/range validation, mutation retries/conflicts/deletes, migrations and persistence across a restart.

Browser tests start separate listeners on web 5180/API 3010, wait for database readiness, and use a unique synthetic database under `.artifacts/e2e/`. They never reuse/reset the owner's database. They exercise account state, appearance persistence, API failure/retry, narrow layout, planner CRUD, and a save whose response is lost. Screenshots/video/traces are disabled. A passing browser test is not proof of Kompakt hardware compatibility.

Optional: set `TEST_DATABASE_URL` to a disposable PostgreSQL database and run `npm test`. That test creates a uniquely named test schema, exercises the standard driver, and drops only that schema afterward. Default tests use embedded PostgreSQL and never connect to an inherited DATABASE_URL. CI defines Windows/Linux checks, Linux browser checks and a disposable PostgreSQL 17 service. Remote CI remains unverified until the repository is pushed and jobs run.

## Build inspection and production boundary

```sh
npm run build
npm run start:api
npm run preview --workspace @hub/web
```

Vite preview is `http://127.0.0.1:4173` and proxies `/api`; it is for local build inspection. Views have their own paths (`/today`, `/calendar`, …): a static host must serve `index.html` for unknown non-asset paths and serve `/sw.js` with `Cache-Control: no-cache`. The build writes a precache list and version into `sw.js`, so every built asset, including lazily loaded views, is available offline after the first online load. Built API loads root `.env` and resolves migrations alongside `apps/api/migrations`. A deployment must include that directory, compiled apps, shared contracts and runtime dependencies.

Production requires NODE_ENV=production, a standard PostgreSQL DATABASE_URL, HTTPS WEB_ORIGINS, a trusted HTTPS reverse proxy/static host routing `/api` to Fastify, and a setup token for first enrollment. Keep API/DB ports private. Authentication and planner export are implemented; deployment, password recovery, backup restoration, permanent deletion, and actual Oracle-host/PostgreSQL verification remain release work. Never imply this local scaffold is already deployed.
