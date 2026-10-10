# Development and operating guide

## Current implementation

A local authenticated planner: React/Vite web, Fastify API, shared Zod contracts, single-owner enrollment/login, versioned tasks and one-time calendar events, durable storage/migrations, optimistic conflicts, duplicate-safe retries, and e-ink appearance.

Not implemented: recurrence/all-day calendar UI, reminders, class portfolios, Android APK/offline queue, provider connections, hosted AI/routing enforcement, memory, MCP or autonomous agent execution. Explicit content labels can be stored now; they do not imply AI is configured. No real account content is imported. See [implementation backlog](backlog.md).

## First run

Use Node.js 24 and npm 11. Defaults need no Docker, standalone database, provider keys, or `.env`.

```sh
npm ci
npm run doctor
npm run dev
```

Open `http://127.0.0.1:5173`, create the owner with an email and password of at least 12 characters, then add tasks/events. The email is a login identifier; no verification email is sent. Keep the password in a password manager: reset/recovery and password changes are not implemented yet. Enrollment closes after the first owner. No account/password was created for the owner by development tests.

API: `http://127.0.0.1:3001`. Root dev first builds shared contracts, then watches contracts/API/web together. Both listeners default to loopback; development API configuration rejects a non-loopback host. Stop with Ctrl+C. Embedded PostgreSQL data is saved under `.data/planner/`, excluded from Git. Do not run two API processes against the same embedded directory. This is server storage, not the future Android offline database.

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

Open the exact configured browser origin: `localhost` and `127.0.0.1` are different origins. The frontend uses relative `/api` URLs through the same-origin proxy; no permissive CORS policy is installed. Unsafe methods require an allowed `Origin` and JSON content type, including scripts/CLI clients. Future MCP callers will need their own authenticated transport rather than borrowing browser cookies.

## Database and migrations

The same numbered SQL migrations/query layer run on PGlite locally and the `pg` driver with DATABASE_URL. Migrations run before API readiness. Applied migration SHA-256 checksums are recorded and changes to applied files are refused. Add a new numbered SQL migration for every schema change; do not rewrite an applied migration.

```sh
npm run db:migrate
```

Tasks/events are scoped by owner, versioned, and soft-deleted. Mutations require an operationId UUID; the owner/operation pair atomically stores the result with its payload hash. An exact retry returns that original result, including after deletion. Reusing the ID for a different operation/payload returns 409. Updates/deletes also require expectedVersion; stale writes return 409 and do not overwrite newer data. Lists exclude tombstones. Omitted sensitivity on an update preserves the existing owner label; changing/removing a label requires an explicit value. Receipts/tombstones have no pruning policy yet and must be retained until future device synchronization rules define safe cleanup.

Task dueDate is a date-only deadline. Timed events use explicit UTC/offset timestamps and a display timezone; end must follow start. The browser enters datetime-local values in the device timezone and labels that behavior explicitly; changing display timezone does not move the UTC instant. All-day/recurrence and ambiguous/nonexistent local-time handling remain next work.

For local backups, stop the API before copying the entire embedded data directory and test restoring into a separate directory. Standard PostgreSQL uses database-aware backup/restore, not copying a live data directory. No automated backup/export/restore service or production restore test is claimed implemented.

## API contracts

| Method/path | Purpose |
| --- | --- |
| `GET /api/health` | Process liveness and contract version |
| `GET /api/ready` | Database query readiness, 503 when unavailable |
| `GET /api/v1/bootstrap` | Four planned, explicitly unconfigured connections |
| `GET /api/v1/auth/session` | Current user or null, and enrollment state |
| `POST /api/v1/auth/setup` | First owner enrollment; email, password, optional production setupToken |
| `POST /api/v1/auth/login` | Email/password login |
| `POST /api/v1/auth/logout` | Revoke current session |
| `GET /api/v1/tasks`, `GET /api/v1/events` | Owner's active records |
| `POST /api/v1/tasks`, `POST /api/v1/events` | Create with operationId |
| `PUT /api/v1/tasks/:id`, `PUT /api/v1/events/:id` | Replace editable fields with operationId and expectedVersion |
| `DELETE /api/v1/tasks/:id`, `DELETE /api/v1/events/:id` | Tombstone with operationId and expectedVersion |

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

Production requires NODE_ENV=production, a standard PostgreSQL DATABASE_URL, HTTPS WEB_ORIGINS, a trusted HTTPS reverse proxy/static host routing `/api` to Fastify, and a setup token for first enrollment. Keep API/DB ports private. Authentication is implemented, but deployment, password recovery, backup restoration, data export/deletion, and actual Oracle-host/PostgreSQL verification remain release work. Never imply this local scaffold is already deployed.
