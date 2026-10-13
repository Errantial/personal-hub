# Offline Claude subscription response inspection

Implemented 2026-10-12. decodeClaudeSubscriptionResponse is a pure internal decoder for the prepared Claude print-mode JSON result. It launches no process, receives no credentials, performs no network or database I/O, and enables no provider. There is no public response-upload endpoint or durable settlement integration.

## Input and output boundaries

The decoder accepts a string or UTF-8 bytes, an exit code, a configured pinned Claude subscription profile and a context manifest. Native output is capped at 256 KiB before JSON parsing; bytes require valid UTF-8. Stream events, multiple JSON objects, arrays, truncated output and malformed envelopes are rejected. The expected envelope is a result with explicit subtype/error/turn/permission metadata, total estimated cost and a per-model usage map. Unknown native metadata is discarded, including session IDs and error text.

Only one exact configured model may appear. An absent or additional model is rejected; no alias/fallback selection occurs. Usage requires bounded nonnegative integer input/output/cache-read/cache-creation counts. Counts are not inferred from text length and cache tokens remain separate. Decimal cost lexemes are converted to rounded-up microdollar estimates without binary-float rounding. A single-model total must agree with its model estimate to that precision; this consistency check cannot establish an invoice or request-only scope.

Success additionally requires exit zero, subtype=success, is_error=false, one turn, no reported permission denials and output tokens within the declared maximum. These checks do not prove that tools, hooks, plugins, prior context or subagents were absent. Effective runtime isolation remains a separate gate.

The prepared request expects JSON guidance in result text. structured_output is not substituted. Shared strict guidance contracts reject extra action/tool fields, empty/oversized/NUL text and unsupported suggestion shapes. Every suggestion must match a supplied source kind, ID and version. A manifest still requires fresh owned provenance/context verification before eventual transmission or use; parsing it is not owner authorization. Guidance grants no action authority.

## Estimates are not settlement

Every inspection returns dispatchEnabled=false, billing=unverified and accounting=unsettled. outputState is validated, invalid, blocked, provider-error or unavailable; rejected output is null. Well-shaped exact-model usageEstimate may accompany invalid/blocked/error output, with scope=unverified and separately named totalEstimatedMicros/modelEstimatedMicros. There is no actualMicros field, budget transition, saved answer or readiness change. A zero estimate never becomes a zero-dollar subscription invoice; a missing estimate never defaults to zero. Invalid identity or malformed usage discards estimates rather than assigning them to the configured route.

Claude's [headless documentation](https://code.claude.com/docs/en/headless) distinguishes print-mode result text and structured output. Its [cost tracking reference](https://code.claude.com/docs/en/agent-sdk/cost-tracking) describes client estimates, resumed-session totals, per-model usage including nested work and incomplete/zeroed error reports. Those limitations are why this decoder cannot settle reservations or establish subscription entitlement, actual charges, complete token bounds or retry behavior. No automatic resend/refund is introduced.

## Validation and next work

Ten focused synthetic tests cover valid text/bytes, exact decimal estimates, zero/error estimates, multi-turn/permission/output-limit blocking, model mismatches, malformed usage, native byte/UTF-8 bounds, source identity/version checks, invalid provenance and configured pinned profiles. Existing OpenRouter protocol tests also pass after its unchanged exact decimal conversion was moved into a shared pure helper. Routine tests forbid fetch and invoke no native CLI. Final npm run check passed lint, strict types, formatting, production builds and 445 API/client tests; one optional standard PostgreSQL test was skipped. Browser tests were not rerun for this backend slice because it changes no UI/authentication code. No owner database, native inference, real provider, paid AI or device tests were used.

Dedicated account/runtime isolation, actual outbound disclosure, model entitlement, verified billing/retry bounds and durable native-result integration remain pending. No migration, dependency, UI/authentication change, account login, owner database access, inference or paid request is added.
