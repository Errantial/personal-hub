# Development and operating guide

The [OpenRouter mail broker](openrouter-mail-broker.md) is implemented in development with a separate approved profile and existing grants/lineage/accounting. Its setup and validation boundaries are documented separately; no later production deployment or actual model-quality acceptance is claimed.

PR #46 merged as `b52745c` with Linux/Windows/PostgreSQL checks green on `0530fc9`. J1-J4 and their controls are integrated; the TypeSafe setup/status paragraphs below are historical. Offline evaluation preparation/decoding uses the production protocol without network access. Actual model-quality execution, server configuration, live approvals and release acceptance remain separate gates. P8 part 2 deterministic study proposals are the next feature slice after broker acceptance.

J3 development changes Use mail to explicit-grant [broker workflow](jev-mail-workflow.md) for owner asks and scheduled agents, with shared admission, history revocation and bounded continuations. Existing switches do not approve TypeSafe; migration 066 is append-only. J4 controls and live readiness remain pending.

Jev mail broker J1/J2 foundations are implemented in development: [contracts, grants, paged receipts, provider evidence and accounting](jev-mail-broker.md). They add append-only migrations 064/065 and owner grant/readiness endpoints. Internal TypeSafe transport has no connected owner-ask/agent execution route; existing Use mail behavior is unchanged until J3/J4. No real account evidence, live disclosure or deployment is established by synthetic checks.

## Current implementation

Status reconciled 2026-10-14 against release `519054d` (migration 057), the [deployment receipt](../deploy/oracle-linux/README.md#release-519054d-2026-10-14) and dated [implementation log](implementation-log.md). This summary does not substitute for a fresh production audit. Use the [agent acceptance checklist](agents-acceptance.md) for outstanding authenticated/live checks and the [post-agents development plan](post-agents-development-plan.md) for the next gated slices.

The authenticated React/Fastify planner uses shared Zod contracts, optimistic versions, durable operation receipts and tombstones. Tasks, recurring/all-day Calendar, class/topic portfolios, manual academic Work, reminders, Undo/Recently deleted and task-only offline replay are implemented. Selected task/Calendar/Work changes, study settings/goals/plan approval, reminder snooze/history, memory editing and email draft review have UI controls integrated into main. Detailed backend inspection/report endpoints do not all have dedicated controls; online batch/settings operations are not task-outbox operations. See [planner behavior](planner.md), [academic work](academic-work.md), [study contracts](study.md), [memory](memory.md) and the [UI ledger](ui-agent-ledger.md).

The [Today/Assistant flow](ai-assistant.md) uses a server-held owner-configured OpenRouter key/model and saved spending limits. Owner asks propose changes for review/Apply through ordinary planner operations. [D57 scheduled agents](superpowers/specs/2026-10-14-persistent-agents-design.md) are deployed: pinned conversations, daily/weekly schedules, action modes, per-agent spending threshold and Inbox results. Settings > AI > Actions is implemented. Pause permits a currently running run to finish; uncertainty is not a retry invitation. First owner-created agent/run and daily-use acceptance remain pending. Release deployment is not proof of usefulness, strict per-agent reservation semantics or complete source/history lineage.

The **general verified-context gateway is separate and has disabled dispatch**. Its [versioned context/memory bindings](ai-verified-context.md), [manual academic projections](ai-academic-context.md), [mail context](ai-mail-context.md), [transient preview](ai-context-preview.md), [durable synthetic requests/accounting](ai-gateway.md) and offline protocol/recovery checks do not imply that the narrow live paths already enforce the complete shared context/history/output model. Workload-plan and uncertain legacy provenance remain blocked. Do not add academic/memory context by bypassing that boundary. Subscription runtime doctor/preparation and offline response inspection enable no subscription inference.

[Legacy responsibility records/reviews](responsibilities.md), their [local schedules](responsibility-local-schedules.md) and [review inbox](responsibility-inbox.md) remain nonexecuting backend placeholders. Their limits do not describe the separate D57 runtime. Automatic memory access/edits, delegation, event triggers, MCP, web browsing, external calendar writes and email sends are outside the deployed D57 slice.

[Read-only mail ingestion](email-ingestion.md) runs through Proton Bridge on the owner's Windows computer; live sync was recorded as operating every ten minutes on 2026-10-14. Tokens/settings stay outside the repository; Bridge stays on loopback and upload uses HTTPS. Mail browsing, [categories/rules](mail-organization.md), selected-message [category suggestions](mail-classification.md), [task suggestions](mail-task-suggestions.md) and [exact-quote task capture](mail-tasks.md) are implemented. Required Gmail coverage and move/deletion reconciliation remain unresolved. Mail-derived task context remains AI-blocked until verified binding exists. Categories do not determine sensitivity.

[Email draft approval](email-drafts.md) has owner review controls, exact-message version/hash-bound approval/revocation and retained history. The [attempt lifecycle](email-attempts.md) is an internal synthetic-only harness; there is no live send adapter, worker or delivery proof. Sending, including invitation/cancellation emails, always requires explicit approval. Calendar permission never establishes an external provider's write capability.

Connections supports read-only [Canvas feeds](canvas.md), [API metadata](canvas-api.md), explicit [feed/API reconciliation](canvas-reconciliation.md), source-linked task/study creation, immutable captures/current inspection, notes and inherited labels. Source refreshes preserve owner planning fields. Previously loaded source ranges/lists have owner-scoped cached viewing. The school blocks personal-token creation. A [browser collector](canvas-browser.md) is implemented in development with a dedicated local profile, distinct browser provenance, explicit selected-course coverage and partial-no-prune ingestion; the historical one-course proof still does not establish live two-course/all-selected-course completeness or an installed unattended schedule. No grades, submissions or attachment text are imported. Outlook mailbox backend/tenant consent remains unverified. Routine tests use synthetic data and never access real feeds.

At the recorded deployment, startup applies append-only migrations through 057 before readiness. Never alter an applied migration. Existing notes, versions, captures, operation receipts and tombstones must survive upgrades. Legacy source identities and missing label history cannot be reconstructed by assumption; unknown provenance remains blocked for AI while ordinary planner edits remain available. Study blocks and recorded time do not prove assignment completion/mastery, and external calendars are not checked by study previews.

The provisional Capacitor APK bundles the UI and task outbox, uses native cookie transport and disables native request logging. AOSP emulator checks cover offline task edits/process restart/replay. Actual Kompakt, closed-app native reminders, offline Calendar/class/reminder edits and release signing retain separate pending gates. Browser checks are Chromium evidence, not hardware evidence. Tests must use isolated servers/databases and never seed/reset the owner's database.

Interface copy: prefer concise titles/labels. Put useful secondary explanations in keyboard/tap-accessible contextual Help. Keep actionable errors and pending/offline/conflict states visible. Visual refinement remains deferred; preserve the [UI ledger](ui-agent-ledger.md) contracts.

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

Reminder/inbox snooze and history backend is online-only. Shared contracts define delivered-reminder snooze, owned detail reads, bounded filtered pages, full unread counts and atomic selected-read batches. Migration 025 preserves prior deliveries and adds same-owner snooze links. Snooze/history/read controls are implemented in Inbox; offline mutations remain unsupported. See [reminder contracts](planner.md#snooze-and-inbox-history-backend-implemented-2026-10-11).

Android builds and the isolated synthetic server are described in [android.md](android.md). Run `npm run android:build -- --test` separately from `npm run check`. Native requests use the shared contracts and existing API authorization. Never point device tests at the owner's database.

The browser caches its static shell using a service worker and stores owner-scoped private snapshots and a task outbox in IndexedDB. After an online login and initial load, tasks can be created/edited/completed/deleted offline and survive reload. Reconnect or select Sync now to replay the original operation IDs in order. Web Locks prevent competing tabs from draining the same outbox. Cached views and task edits require the last verified session to remain unexpired; server revocation is checked before replay.

Task conflicts keep their local draft and stop ordered replay. Review the draft and explicitly discard that task's queued changes to use the server record. Automatic overwrite/rebase is not implemented. Sign-out requires pending tasks to be synchronized or discarded, then clears private local storage. Reauthentication as the same owner retains locked drafts. A different owner clears the previous owner's cache. No cookies/passwords are stored in IndexedDB.

Other screens can show previously loaded data, including only previously visited calendar ranges; their edits require a connection. Browser cache eviction, clearing site data and private browsing can remove the outbox. Service workers require a secure origin (HTTPS or loopback); first-time offline visits cannot work. Browser verification is Chromium-only. Separate AOSP emulator checks cover task replay after process death; actual Kompakt firmware remains unverified.

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

Migration 026 adds [manual academic work](academic-work.md): owned/versioned class work, recorded submission/scores, bounded history, deletion/restore, class-label propagation, missing-data summaries and portable export. Class Work UI is implemented; offline Work edits and dedicated controls for every history/report endpoint remain pending. Scores do not change topic confidence, and this slice does not expand AI context or consume real provider data.

Open manual academic deadlines/priority/effort now inform [study priorities](study.md#academic-workload-signals-implemented-2026-10-11), with missing-data warnings and stale-draft protection. Work, class and topic mutations use the owner schedule lock before academic ancestors, matching approval lock order even when an affected class has no allocated slots. Owner goal budgets remain unchanged; grades are excluded from ranking. This integration needs no schema migration, provider calls or AI access.

The same numbered SQL migrations/query layer run on PGlite locally and the `pg` driver with DATABASE_URL. Migrations run before API readiness. Applied migration SHA-256 checksums are recorded and changes to applied files are refused. Add a new numbered SQL migration for every schema change; do not rewrite an applied migration.

AI preflight uses repeatable snapshots and retries only rolled-back database-only mutations. Never put provider calls inside a retryable mutation transaction. Internal budget accounting locks the owner policy before reservation rows; uncertain holds require confirmed usage to settle. Accounting/transition receipts never authorize a paid retry. Durable metadata-only requests and an internal synthetic-only attempt state machine are implemented. This general gateway has no live dispatch endpoint/worker; its synthetic lifecycle is distinct from the deployed narrow Assistant/agent runtime and retained conversations. See ai-gateway.md and ai-assistant.md.

```sh
npm run db:migrate
```

Tasks/events are scoped by owner, versioned, and soft-deleted. Mutations require an operationId UUID; the owner/operation pair atomically stores the result with its payload hash. An exact retry returns that original result, including after deletion. Reusing the ID for a different operation/payload returns 409. Updates/deletes also require expectedVersion; stale writes return 409 and do not overwrite newer data. Lists exclude tombstones. Omitted sensitivity on an update preserves the existing owner label; changing/removing a label requires an explicit value. Receipts/tombstones have no pruning policy yet and must be retained until future device synchronization rules define safe cleanup.

Task dueDate is a date-only deadline. Calendar timed events use explicit UTC/offset timestamps and an IANA timezone; end must follow start. Calendar input uses the selected event timezone and requires an earlier/later offset choice for repeated local times; nonexistent local times are rejected. Today shows the current day in the device timezone, with independent cached planner/Canvas/reminder reads and offline task capture. Create/edit events through Calendar; the former Today one-time event editor is removed. All-day dates have an exclusive end date in storage. Recurring timed events preserve local start time through DST; see [planner behavior](planner.md).

For local backups, stop the API before copying the entire embedded data directory and test restoring into a separate directory. Standard PostgreSQL uses database-aware backup/restore, not copying a live data directory. The planner JSON download is a portable export, not a backup or supported import format. Production same-device backup and isolated restore verification are recorded in the Oracle operating guide. Restores must target a separate database for verification; no automatic rollback over live owner writes is authorized. Encrypted off-host backup remains owner-deferred.

## API contracts

Study/recovery backend: owner-authorized `/api/v1/study` routes provide versioned preferences/goals, ranked manual subject priorities, write-free previews, durable draft history/editing, atomic approval, safe cancellation/hiding and progress reports. `/api/v1/planner/deleted` pages task/calendar tombstones for existing restore operations. Migrations 023/024 add the study records and owner schedule revision locks; export adds settings/goals/plans without changing format v1. No AI or external provider is called, and external calendars are explicitly unchecked. Owner study availability/goals/plan approval UI is implemented; offline study edits remain pending. See [study contracts](study.md) and the UI ledger.

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

Run `check` and browser verification sequentially. Both build shared contracts, and concurrent builds can restart or reload the browser suite's watched development server while a test is navigating.

Browser tests start separate listeners on web 5180/API 3010, wait for database readiness, and use a unique synthetic database under `.artifacts/e2e/`. They never reuse/reset the owner's database. They exercise account state, appearance persistence, API failure/retry, narrow layout, planner CRUD, and a save whose response is lost. Screenshots/video/traces are disabled. A passing browser test is not proof of Kompakt hardware compatibility.

Optional: set `TEST_DATABASE_URL` to a disposable PostgreSQL database and run `npm test`. That test creates a uniquely named test schema, exercises the standard driver, and drops only that schema afterward. Default tests use embedded PostgreSQL and never connect to an inherited DATABASE_URL. CI defines Windows/Linux checks, Linux browser checks and a disposable PostgreSQL 17 service. Remote CI remains unverified until the repository is pushed and jobs run.

## Build inspection and production boundary

```sh
npm run build
npm run start:api
npm run preview --workspace @hub/web
```

Vite preview is `http://127.0.0.1:4173` and proxies `/api`; it is for local build inspection. Views have their own paths (`/today`, `/calendar`, …): a static host must serve `index.html` for unknown non-asset paths and serve `/sw.js` with `Cache-Control: no-cache`. The build writes a precache list and version into `sw.js`, so every built asset, including lazily loaded views, is available offline after the first online load. Built API loads root `.env` and resolves migrations alongside `apps/api/migrations`. A deployment must include that directory, compiled apps, shared contracts and runtime dependencies.

Production requires NODE_ENV=production, a standard PostgreSQL DATABASE_URL, HTTPS WEB_ORIGINS, a trusted HTTPS reverse proxy/static host routing `/api` to Fastify, and a setup token for first enrollment. Keep API/DB ports private. The Oracle Linux ARM64/PostgreSQL deployment is operating at https://hub.ecg.name; release `519054d` and same-device backup/isolated restore checks have dated receipts in the [operating guide](../deploy/oracle-linux/README.md#release-519054d-2026-10-14). Password recovery, permanent deletion, owner daily-use acceptance and off-host backups retain their separate unresolved/deferred status. A successful local build does not prove a later release is deployed.
