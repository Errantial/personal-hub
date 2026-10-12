# Local responsibility review schedules

Implemented 2026-10-11. Migration 037 adds local daily/weekly rules and a durable civil-slot index to the existing owned schedule. These schedules create blocked review placeholders through explicit owner admission; UI controls, background admission and agent execution remain pending.

## Contract

PUT `/api/v1/responsibilities/:id/local-schedule` takes `{ operationId, expectedVersion, rule }`. The version is the parent responsibility version. The strict rule has `startDate` (valid YYYY-MM-DD), `localTime` (HH:mm), `timeZone` (supported named or constant-offset zone), `frequency` (`daily` or `weekly`) and `interval` (integer 1–52, default 1). Weekly rules repeat on the start date's weekday; multiple weekdays, monthly rules and cron are unsupported. Attachments, context references and execution settings are rejected.

The response contains metadata-only parent receipt fields and the full schedule. Schedules now include nullable `localRule` and `nextLocalIndex`; legacy exported schedules default both to null. Check `localRule` before interpreting `intervalMinutes`: a local rule has null intervalMinutes but is repeating. Existing PUT `/:id/schedule` keeps its one-time/constant elapsed UTC contract and clears local fields when replacing a schedule.

Local and UTC modes share one schedule row and its version history. Replacing increments parent and schedule versions, resets the first pending slot, and cancels blocked runs with schedule-changed. Saving does not resume a paused responsibility. Clear uses the existing UTC endpoint with `schedule: null`: it retains rule metadata, sets a deletion timestamp and clears both pending pointers. Re-adding advances the same schedule version.

`startsAt` and `nextDueAt` are UTC instants. `nextLocalIndex` is the server-managed zero-based civil slot from the original start date, not an editable client counter. Each daily slot adds interval calendar days; each weekly slot adds seven times interval calendar days. The local clock is reconstructed for each date, preserving it across DST.

## Time and admission behavior

Timezone conversion uses Temporal compatible disambiguation: a missing spring clock time shifts forward by the gap; a repeated fall time selects the earlier occurrence. For Denver at 02:30, the spring gap resolves to 03:30 that day, then returns to 02:30 the next day. A fall fold creates one review slot, rather than repeating on the second offset. Show this policy in keyboard/tap-accessible Help when editing a local rule; Calendar's separate explicit-time input policy is unchanged.

Existing due preview, attention counts and selected admission operate on the stored UTC pending instant. Admission requires current parent and schedule versions and an active, nondeleted source. It creates one blocked run for the earliest pending slot and coalesces all additional missed civil slots into skippedIntervals. The pointer moves to the first slot strictly after server now, without generating a backlog. A timezone's skipped whole date may map two civil slots to the same instant; these are coalesced together.

Before advancing, the server verifies that the saved rule/index resolves to the saved UTC instant. Inconsistent state blocks with LOCAL_SCHEDULE_UNAVAILABLE instead of silently changing cadence. Date resolution and catch-up are bounded. Rules must resolve to supported UTC years 0001–9999; an unsupported initial slot returns LOCAL_SCHEDULE_RANGE. Exhaustion clears nextDueAt and nextLocalIndex without setting deletedAt. Operational advancement increments only schedule.version. Run slot uniqueness, atomic selected batches, historical receipts, lifecycle cancellation and no-resend behavior are preserved.

Refresh current detail and schedule after a historical retry: old receipts describe the original result, even after replacement, admission or cancellation. Distinguish parent version, operational schedule version, and run version. Paused/cancelled/deleted schedules are absent from due preview; resuming exposes overdue slots but never admits them automatically.

## Verification and limits

Eight new isolated synthetic tests cover spring gaps, fall folds, biweekly alignment, skipped civil dates, supported calendar bounds, strict inputs, UTC replacement, concurrent retries/admission, coalescing, lifecycle invalidation, SQL integrity, atomic rollback, populated migration compatibility, export and persisted restart. Together with the existing responsibility suite, all 23 focused tests passed. Fetch is forbidden; only synthetic memory/contained artifact databases are used. Owner/anonymous endpoint checks and optional standard PostgreSQL coverage are included. Standard PostgreSQL remains unverified locally while TEST_DATABASE_URL is unset.

Full npm run check passed lint, strict types, formatting, production builds and 318 API/client tests; one optional standard PostgreSQL test was skipped. Browser tests were not rerun because UI/authentication-layer code was unchanged. Verification is also recorded in the backlog and UI ledger. No UI/authentication-layer code, owner database, real provider, paid AI or device test is involved. Export preserves local rules and tombstones; import, offline schedule editing, background workers, actual agent results and provider execution remain pending.
