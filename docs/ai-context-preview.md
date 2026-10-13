# Transient AI context review

Implemented 2026-10-12. `POST /api/v1/ai/context/preview` returns the owner's bounded assembled text for review, together with safe assessment metadata. It writes no receipt, preflight, request, attempt, answer or budget hold, and calls no provider. Live dispatch remains disabled.

`aiContextPreviewWriteSchema` uses the preflight fields and versions without `operationId`: request text/sensitivity, explicit owned/versioned source references, policy/budget versions and registry revision. Uploaded payloads/manifests, attachments, `saveAnswer`, simulated provider availability and dispatch flags are rejected. Memory and academic references retain their required settings/class versions.

The response is `{preview:true,dispatchEnabled:false,retained:false,payload,assessment}`. `payload` is the gateway's JSON request/source text envelope, or null when the route forbids assembly or exceeds its configured bound. The assessment has no durable ID/version/timestamp. A selected route can still have unresolved pricing/consent/provider/runtime/budget blockers; reviewing text never clears those blockers. Provider builders may add system instructions and native envelopes; this review is not a verified final transmission or token/invoice bound.

Ownership/session checks and assembly share a read-only repeatable snapshot. Stale policy/budget/registry/source/class/memory-settings versions fail without releasing text. Unavailable approved routes, attachment-derived inputs and unknown provenance never fall back or expose a partial payload. All responses use `Cache-Control:no-store`; text/digests remain absent from logs/history/export. Review creates no reusable authorization token: a later request must re-resolve current sources and settings.

UI review remains pending. Render projected text as untrusted plain text, retain visible errors/blockers, keep the review transient and disable it offline. Do not silently persist previews to caches, memory or conversations. Current planner/offline tasks remain available independently of AI. Source selection/review uses keyboard/tap-accessible controls; secondary explanations belong in Help.

Synthetic tests verify private bounded review, zero durable writes, denied/file-derived payload suppression, unchanged readiness blockers, strict request fields, all version gates, foreign-source/origin/session isolation and fresh submission after review. No real provider, paid request, owner database or device test is used.

All 41 context tests pass, including seven new review tests. The full API/client run passed 487 tests with one optional PostgreSQL skip; refreshed lint/types/formatting and production builds passed after excluding a generated browser snapshot from project formatting. Twelve additional Calendar-management tests passed separately. Browser verification retains three narrow Canvas overflow failures after a fresh isolated rerun; see the UI ledger.
