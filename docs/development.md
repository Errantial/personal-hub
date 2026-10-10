# Development and operating guide

## Current implementation

Interface copy: prefer titles and labels over flavor text. Put secondary explanations in contextual Help, hover/focus tips or expandable details, accessible by keyboard and tap. Keep actionable errors, offline/pending/conflict state and essential warnings visible. See AGENTS.md.

A local authenticated planner: React/Vite web, Fastify API, shared Zod contracts, single-owner enrollment/login, versioned tasks, day/week calendar with all-day/recurring events and occurrence edits, class/topic portfolios, manual study blocks, durable reminders/inbox, optimistic conflicts, duplicate-safe retries, and e-ink appearance. See [planner behavior](planner.md) for recurrence rules, label inheritance and delivery limits.

Connections supports read-only Canvas calendar feeds, explicit ICS import, automatic/manual durable refresh jobs and personal notes/labels. Configure the private URL only on the server; see [Canvas setup and boundaries](canvas.md). School completeness and richer API access remain unverified. No real feed is accessed by routine tests.

A provisional Capacitor APK bundles this UI and its IndexedDB task outbox. Native login, offline task edits and process-restart/replay are tested on an AOSP emulator. Actual Kompakt hardware, native alarms/background delivery, offline calendar/class/reminder edits, email/Proton connections, richer Canvas access, imported grades, automatic study suggestions, hosted AI/routing enforcement, memory, MCP and autonomous agent execution remain pending. Stored labels do not imply AI is configured. Development checks have not accessed real account content. See [implementation backlog](backlog.md).

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

Open the exact configured browser origin: `localhost` and `127.0.0.1` are different origins. The frontend uses relative `/api` URLs through the same-origin proxy; no permissive CORS policy is installed. Unsafe methods require an allowed `Origin` and JSON content type, including scripts/CLI clients. Future MCP callers will need their own authenticated transport rather than borrowing browser cookies.

## Database and migrations

The same numbered SQL migrations/query layer run on PGlite locally and the `pg` driver with DATABASE_URL. Migrations run before API readiness. Applied migration SHA-256 checksums are recorded and changes to applied files are refused. Add a new numbered SQL migration for every schema change; do not rewrite an applied migration.

```sh
npm run db:migrate
```

Tasks/events are scoped by owner, versioned, and soft-deleted. Mutations require an operationId UUID; the owner/operation pair atomically stores the result with its payload hash. An exact retry returns that original result, including after deletion. Reusing the ID for a different operation/payload returns 409. Updates/deletes also require expectedVersion; stale writes return 409 and do not overwrite newer data. Lists exclude tombstones. Omitted sensitivity on an update preserves the existing owner label; changing/removing a label requires an explicit value. Receipts/tombstones have no pruning policy yet and must be retained until future device synchronization rules define safe cleanup.

Task dueDate is a date-only deadline. Calendar timed events use explicit UTC/offset timestamps and an IANA timezone; end must follow start. Calendar input uses the selected event timezone and requires an earlier/later offset choice for repeated local times; nonexistent local times are rejected. The Today quick editor uses device local time for simple one-time events. All-day dates have an exclusive end date in storage. Recurring timed events preserve local start time through DST; see [planner behavior](planner.md).

For local backups, stop the API before copying the entire embedded data directory and test restoring into a separate directory. Standard PostgreSQL uses database-aware backup/restore, not copying a live data directory. The planner JSON download is a portable export, not a backup or supported import format. No automated backup/restore service or production restore test is claimed implemented.

## API contracts

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
| `POST /api/v1/tasks`, `POST /api/v1/events` | Create with operationId; tasks accept an optional stable clientId UUID for offline creation |
| `PUT /api/v1/tasks/:id`, `PUT /api/v1/events/:id` | Replace editable fields with operationId and expectedVersion |
| `DELETE /api/v1/tasks/:id`, `DELETE /api/v1/events/:id` | Tombstone with operationId and expectedVersion |
| `GET/POST /api/v1/calendar`, `PUT/DELETE /api/v1/calendar/:id` | Full series CRUD; legacy event edits reject advanced records |
| `GET /api/v1/calendar/occurrences?from=YYYY-MM-DD&to=YYYY-MM-DD&timeZone=...` | Expand a date window, exclusive to, maximum 93 days |
| `PUT/DELETE /api/v1/calendar/:id/occurrences/:date` | Replace/cancel one occurrence using the series expectedVersion |
| `GET/POST /api/v1/courses`, `PUT/DELETE /api/v1/courses/:id` | Owner class portfolios and tombstones |
| `GET/POST /api/v1/topics`, `PUT/DELETE /api/v1/topics/:id` | Manual progress/confidence linked to an owned class |
| `GET/POST /api/v1/reminders`, `PUT /api/v1/reminders/:id` | Durable schedules and worker health; reschedule queued/paused/failed jobs |
| `POST /api/v1/reminders/:id/control` | Versioned pause/resume/retry/cancel action |
| `GET /api/v1/notifications`, `POST /api/v1/notifications/:id/read` | Owner inbox and idempotent read receipts |
| `GET/PUT /api/v1/connections/canvas` | Canvas source settings, safe status/history, imported entries and inherited labels |
| `POST /api/v1/connections/canvas/sync` | Queue a duplicate-safe network refresh; server feed required |
| `POST /api/v1/connections/canvas/import` | Import a complete ICS snapshot with an operation ID; up to 1 MiB |
| `PUT /api/v1/connections/canvas/items/:id` | Versioned personal notes and entry label; provider fields remain read-only |

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

Vite preview is `http://127.0.0.1:4173` and proxies `/api`; it is for local build inspection. Built API loads root `.env` and resolves migrations alongside `apps/api/migrations`. A deployment must include that directory, compiled apps, shared contracts and runtime dependencies.

Production requires NODE_ENV=production, a standard PostgreSQL DATABASE_URL, HTTPS WEB_ORIGINS, a trusted HTTPS reverse proxy/static host routing `/api` to Fastify, and a setup token for first enrollment. Keep API/DB ports private. Authentication and planner export are implemented; deployment, password recovery, backup restoration, permanent deletion, and actual Oracle-host/PostgreSQL verification remain release work. Never imply this local scaffold is already deployed.
