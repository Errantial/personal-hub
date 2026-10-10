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

See [planner behavior](planner.md) for exact recurrence/editing and reminder policies. Migration 002 adds these records without changing migration 001. These three backlog slices are distinct from roadmap phases 1–3: Canvas and email ingestion have not been implemented.

## Next: Android/offline and operational readiness

4. Kompakt compatibility prototype, Android local storage and durable offline operation queue. Preserve operation IDs across app/process restarts. Show stale data and conflicts; prove no Google Services dependency and test native reminders on the owner's firmware.
5. Export/deletion and backup/restore, session/password management and recovery, server deployment acceptance checks. Embedded local storage is not an Oracle production deployment.

Acceptance remaining for the broader planner milestone: an Android edit survives process death and synchronizes once; closed-app reminders and denied/revoked permissions are understood; monochrome navigation works on actual Kompakt hardware. Current web tests distinguish task deadlines from reserved study intervals and exercise recurrence/DST, conflict preservation, permission denial and 320px e-ink layout.

## Integration gates, before dependent features

- Verify Oracle CPU architecture, supported Bridge host/uptime, and persistent storage.
- Compare authorized Canvas API, calendar feed, and text-browser coverage; never store the private calendar URL in the repository.
- Verify the school mailbox backend/Graph consent and text-browser fallback coverage.
- Prove Proton Mail/Gmail completeness through Bridge and a text-only Proton Calendar write path.
- Confirm provider/model choices, numeric spending caps, and data retention before paid AI processing.

## AI and persistent-agent sequence

Implement the text/provenance/provider-routing gateway, typed action policies and email approval records before enabling hosted AI. Then add editable memory, durable responsibilities and scheduled reviews, result/activity history, pause/resume/cancel, bounded delegation, and bidirectional MCP. Every agent step and retrieved/tool context inherits routing and permission checks. See agent-scope.md and ai-permissions.md.

## Local verification receipt (2026-10-10)

Lint, strict type checks, formatting and production builds passed. API/client suite: 37 passed; one standard PostgreSQL test skipped locally because TEST_DATABASE_URL is unset. Browser suite: 14 passed, covering planner CRUD, occurrence edits, study blocks, server delivery, permission denial, 320px e-ink layout, lost-response retry and deliberate conflict recovery. Dependency audit reported zero production vulnerabilities. The build emits a bundle-size advisory (about 520 kB minified); Kompakt loading/performance still needs measurement. Synthetic tests use separate databases and did not enroll or reset the owner's database. Standard PostgreSQL coverage now includes recurring study blocks and the reminder worker; its remote result remains unverified.

## Verification still outstanding

The local suite covers the embedded PostgreSQL engine. The standard PostgreSQL check is opt-in via TEST_DATABASE_URL and configured in CI; a remote CI result must not be claimed before the repository is pushed and that job runs. CI has not run remotely. Android SDK command-line tools are unavailable on this Windows machine; no APK/device or actual Kompakt verification has occurred. No production deployment or real provider connection has occurred.
