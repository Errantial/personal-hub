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
- Dots/OpenDots-style persistent agent capabilities recorded as later scope; no agent execution dependency installed.

## Next: finish reliable planner behavior

1. Calendar day/week view, all-day events and recurrence. Define occurrence/exception storage before edits; test daylight-saving transitions, skipped/ambiguous local times, and date-only deadlines separately from timed commitments.
2. Basic class/topic portfolios, progress, and manual study-time blocks. Imported grades remain unknown until a connector proves their availability.
3. Durable jobs/reminder delivery records. Add bounded worker execution, leases, retry/reconciliation, notification status, and stop controls before scheduled AI responsibilities.
4. Kompakt compatibility prototype, Android local storage and durable offline operation queue. Preserve operation IDs across app/process restarts. Show stale data and conflicts; prove no Google Services dependency and test native reminders on the owner's firmware.
5. Export/deletion and backup/restore, session/password management and recovery, server deployment acceptance checks. Embedded local storage is not an Oracle production deployment.

Acceptance for the next planner slice: a task deadline and a reserved study interval have different meanings; recurring/all-day items remain correct through DST; an Android edit survives process death and synchronizes once; conflicts are visible; denied notification permission is understandable; monochrome navigation works on actual Kompakt hardware.

## Integration gates, before dependent features

- Verify Oracle CPU architecture, supported Bridge host/uptime, and persistent storage.
- Compare authorized Canvas API, calendar feed, and text-browser coverage; never store the private calendar URL in the repository.
- Verify the school mailbox backend/Graph consent and text-browser fallback coverage.
- Prove Proton Mail/Gmail completeness through Bridge and a text-only Proton Calendar write path.
- Confirm provider/model choices, numeric spending caps, and data retention before paid AI processing.

## AI and persistent-agent sequence

Implement the text/provenance/provider-routing gateway, typed action policies and email approval records before enabling hosted AI. Then add editable memory, durable responsibilities and scheduled reviews, result/activity history, pause/resume/cancel, bounded delegation, and bidirectional MCP. Every agent step and retrieved/tool context inherits routing and permission checks. See agent-scope.md and ai-permissions.md.

## Local verification receipt (2026-10-10)

Lint, strict type checks, formatting and production builds passed. API/client suite: 20 passed; one standard PostgreSQL test skipped locally because TEST_DATABASE_URL is unset. Browser suite: 9 passed, including lost-response retry and conflict/draft preservation. Dependency audit: zero reported vulnerabilities. The default development server starts with database readiness and enrollment open; synthetic tests did not create the owner account.

## Verification still outstanding

The local suite covers the embedded PostgreSQL engine. The standard PostgreSQL check is opt-in via TEST_DATABASE_URL and configured in CI; a remote CI result must not be claimed before the repository is pushed and that job runs. CI has not run remotely. Android SDK command-line tools are unavailable on this Windows machine; no APK/device or actual Kompakt verification has occurred. No production deployment or real provider connection has occurred.
