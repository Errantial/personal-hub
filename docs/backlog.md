# Implementation backlog

Updated 2026-10-10. This is the work queue; product.md remains the full scope, decisions.md records choices, and roadmap.md sets milestone order.

## Completed local foundation

- React/Vite web, Fastify API, strict shared TypeScript/Zod contracts, reproducible npm workspaces/lockfile.
- Single-owner enrollment and email/password login, scrypt password hashing, revocable hashed session tokens, protected private routes, origin checks, rate limits.
- Versioned tasks with title/notes/date-only deadline/priority/completion/explicit content label, and one-time calendar events with UTC instants/display timezone.
- Owner-scoped persistence, append-only SQL migration runner, atomic mutation receipts, optimistic conflict detection, soft-delete tombstones.
- Local embedded PostgreSQL through PGlite; standard PostgreSQL driver selected by DATABASE_URL and required in production.
- Browser CRUD forms, persistence across reload/restart, responsive layout, local e-ink preference, visible save/load errors.
- Local doctor command, contributor instructions, isolated API/browser tests, and CI definition for Windows/Linux plus PostgreSQL.
- CopilotKit/OpenDots confirmed as the later feature reference: specialist assistants, Spaces/pages, persistent conversations, scheduled work, memory/learning, tool controls, and later voice/Slack. No agent execution dependency installed.

## Completed planner slices 1–3

1. Calendar day/week agendas, IANA timezone viewing/input, date-only all-day events, daily/weekly/monthly rules and single-occurrence replacement/cancellation. Shared bounded expansion preserves local recurring starts through DST; gaps/folds, missing monthly dates, moved occurrences, stale versions and receipt retries have synthetic checks.
2. Owner-scoped class/topic portfolios with manual progress/confidence, notes and labels; linked study blocks with planned/completed/cancelled status. Source labels inherit through study blocks and occurrence replacements. Imported grades and automated study recommendations remain unknown/unimplemented.
3. Durable reminder schedules and inbox records, bounded server worker with leases/recovery/backoff, failure/heartbeat visibility, pause/resume/retry/cancel and read receipts. Restart recovery and duplicate suppression are tested. Optional browser alerts require permission and an open Reminders view; closed-app push/native delivery is not implemented.

See [planner behavior](planner.md) for exact recurrence/editing and reminder policies. Migration 002 adds these records without changing migration 001. These three backlog slices are distinct from roadmap phases 1–3: full academic and email ingestion remain pending.

## Current priority: core server/site

4. Completed core account slice: Preferences password changes with reauthentication/session rotation, safe active-session lists and versioned/idempotent revocation, and owner-scoped versioned planner JSON export with tombstones and consistent snapshots. See [account controls](account.md). Recovery, import/permanent deletion, automated backup/restore and deployment acceptance remain pending. Embedded local storage is not an Oracle production deployment.
5. Completed Canvas feed baseline: owner-scoped connection controls, private server feed configuration, explicit ICS import, durable automatic/manual refresh jobs, safe source links, stable UID deduplication, changed dates/cancellations/missing markers, personal notes/labels and exported provenance. See [Canvas ingestion](canvas.md). Synthetic tests validate the adapter; live school completeness and access remain unverified.
6. Completed Canvas calendar/class linkage: timezone-aware day/week read-only entries, point deadlines/all-day spans, explicit owned-class links, inherited class labels including archived classes, retained notes/linkage through refreshes, cached loaded agenda/portfolio viewing and export metadata. Source records remain separate from planner events/tasks and manual class assessments.
7. Completed source-linked planning: explicit task/study creation from available Canvas entries, version checks and retry receipts, immutable captured facts with current source status, retained owner edits/tombstones, inherited labels and file-derived provenance. Creation requires a connection; existing linked tasks retain offline editing.
8. Completed Canvas API metadata baseline: server-held personal-test token bound to the enrolled owner, bounded paginated read-only courses/assignments, durable refreshes, separate personal notes/labels, explicit class links, cached portfolio viewing and export. See [Canvas API](canvas-api.md). Each refresh checks upstream account identity; first successful import binds the ID, and changed-account tokens fail without replacing records. API records are separate from ICS entries; grades/submissions remain pending. Live access/completeness and multi-user OAuth remain gates.
9. Completed API-assignment planning: explicit task/study creation through shared planner operations, assignment/course version guards, immutable captured provenance and current facts/labels, retained owner edits/tombstones and existing linked-task offline edits. Creation is online-only; no source writes or inferred planner/feed merge.
10. Completed explicit feed/API reconciliation: owner confirmation based on exact assignment URLs, side-by-side facts, versioned links/removal/tombstones, shared effective labels and file provenance, and export. No automatic fact merge, planner deduplication or agenda suppression. See [reconciliation](canvas-reconciliation.md).
11. Completed linked planner-work visibility: expandable task/study lists on source planning and API class portfolios; confirmed associations group source identities, completed tasks remain visible, tombstones are excluded, and previously loaded lists support cached viewing. No inference of Canvas submission or mastery. Calendar reload now disables saving until the refreshed version arrives, retaining drafts/warnings while pending.
12. Completed routing permissions and read-only preview: owner settings, allowed/preferred aliases, full inherited-label intersection, version guards/retry receipts and deny-by-default behavior. Unavailable selected providers, file-derived context and incomplete historical provenance block; no classifier or provider calls occur. Preferences offers task-context simulation; backend supports typed planner/academic/Canvas source references. See [AI permissions](ai-permissions.md).
    Captured academic history preserves every applied label through relabeling, study detachment and occurrence cancellation. Masked labels still constrain routing; unknown legacy history blocks. Academic lock order matches label propagation. Synthetic upgrade checks preserve old notes, snapshots, versions, receipts and tombstones; the optional PostgreSQL test includes populated provenance and concurrent academic writes.
13. Next core server/site work: server provider registry, actual text/provenance dispatch gateway, budgets and metadata-only routing receipts before paid AI; submission/grade tracking and a proven email ingestion path. Keep provider secrets server-side, statuses explicit and routine tests synthetic.

## Deferred Android verification

Actual Kompakt verification is deferred by owner request (2026-10-10) and does not block core server/site development. Browser task outbox, stable IDs, cached viewing, session-expiry/revocation locking, conflict retention and cache cleanup are implemented. A provisional Capacitor APK bundles the UI and WebView outbox, uses native cookie transport and separates cache per server. AOSP emulator checks prove offline create/edit/completion survives force-stop and replays once. Actual Kompakt API/WebView/e-ink checks, native alarms, denied permissions and reboot/power-mode behavior remain deferred. Calendar/class/reminder offline edits and background delivery remain pending.

Acceptance remaining for the broader planner milestone: an Android edit survives process death and synchronizes once; closed-app reminders and denied/revoked permissions are understood; monochrome navigation works on actual Kompakt hardware. Current web tests distinguish task deadlines from reserved study intervals and exercise recurrence/DST, conflict preservation, permission denial and 320px e-ink layout.

## Integration gates, before dependent features

- Verify Oracle CPU architecture, supported Bridge host/uptime, and persistent storage.
- Compare authorized Canvas API, calendar feed, and text-browser coverage; never store the private calendar URL in the repository.
- Verify the school mailbox backend/Graph consent and text-browser fallback coverage.
- Prove Proton Mail/Gmail completeness through Bridge and a text-only Proton Calendar write path.
- Confirm provider/model choices, numeric spending caps, and data retention before paid AI processing.

## AI and persistent-agent sequence

Implement the text/provenance/provider-routing gateway, typed action policies and email approval records before enabling hosted AI. Then add editable memory, durable responsibilities and scheduled reviews, result/activity history, pause/resume/cancel, bounded delegation, and bidirectional MCP. Every agent step and retrieved/tool context inherits routing and permission checks. See agent-scope.md and ai-permissions.md.

The next backend slice is planned, not implemented. Acceptance:

- Server provider registry maps saved aliases to protected credentials, supported models and actual availability; arbitrary client endpoints and simulated availability cannot authorize dispatch.
- Bounded text context has an owned/versioned provenance manifest for every fragment. Policy/source versions and complete labels are revalidated before transmission; forbidden file/image content and unknown provenance block.
- Durable requests and metadata-only routing receipts expose pending/blocked/failed/completed state. Lost responses, restarts and retries cannot silently switch destinations or duplicate a paid request.
- Owner-selected provider/model, retention and numeric spending limits are configured before paid execution; tests use fake adapters and exercise budget exhaustion without network charges.
- Model actions use existing authorized/versioned planner operations. Email sends, invitations and cancellation emails require explicit approval; external calendar writes need a proven writable adapter. Memory, agent execution and MCP remain later slices.

## Local verification receipt (2026-10-10)

Lint, strict type checks, formatting and production builds passed. API/client suite: 81 passed; one standard PostgreSQL test skipped because TEST_DATABASE_URL is unset. Browser suite: 29 passed, including account controls, planner export, Canvas import/note conflicts, class linkage, cached agenda/portfolio viewing, source-linked task/study creation, stale-source draft recovery, offline creation rejection, linked-task offline completion/replay and 320px e-ink layout. Calendar ingestion/planning checks cover owner isolation, archived classes, inherited labels, point/all-day boundaries through DST, immutable snapshots, retry receipts, refresh preservation, tombstones and file/network provenance. New Canvas REST metadata checks cover pagination, rejected unsafe destinations, bounded responses, stripped extra fields, owner-bound credentials, note/link preservation, missing markers, exports, lease recovery and late-result cancellation. Browser API responses are synthetic; the API UI check covers stale note/planner drafts, explicit assignment/course version reload, task/study request contracts, blocked offline creation and cached class assignments offline. Assignment-planning API checks exercise owner isolation, version guards, inherited labels, receipt retries, immutable/current facts, missing sources and exported tombstones. Prior Android verification: debug APK and app instrumentation APK build; four phased AOSP API 34/WebView 113 tests pass for enrollment, offline create/edit/completion, force-stop recovery, and reconnect with persisted native session/e-ink preference. Independent API receipts verify zero server tasks while offline, then one completed task at version 3 after replay. No Google Services package is required. The device test found and fixed older WebViews' lack of AbortSignal.any. See [Android instructions](android.md) for reproducible phases and remaining limits.

Current backend checks additionally cover exact-URL reconciliation, stable association receipts/tombstones, shared file provenance, complete captured/current labels, grouped planner work, changed-account token rejection, populated legacy upgrades and preserved private records. Routing checks cover incompatible label intersections, no unavailable-provider fallback, masked academic labels, relabeling/detachment/occurrence cancellation, unknown history and text-only previews with zero provider calls. New browser checks exercise permission/reconciliation lost-response retries, retained conflict drafts, file-derived blocking and linked planner work. A compiled API smoke check applies all 15 migrations to an isolated in-memory database and validates academic labels, routing decisions, reconciliation, account binding and export without provider calls.

The prior dependency audit reported zero production vulnerabilities; dependencies are unchanged in this slice. The web bundle emits a size advisory (about 588 kB minified); actual Kompakt performance still needs measurement. Tests used separate synthetic databases and never enrolled or reset the owner's workspace. Standard PostgreSQL and remote CI results remain unverified.

## Verification still outstanding

The standard PostgreSQL check is opt-in via TEST_DATABASE_URL and configured in CI; CI has not run remotely. Android SDK command-line tools are installed, but actual Kompakt, closed-app native reminders, production TLS and release signing are unverified. T3's Device panel could not attach to the booted emulator; verification used Android instrumentation and adb instead. No production deployment or real provider connection has occurred.

## Interface guideline

Prefer concise titles and labels. Use keyboard/tap-accessible contextual Help for useful secondary explanations. Keep errors, pending/offline/conflict state and essential warnings visible. Marketing/welcome copy has been removed from the current screens.
