# AI gateway foundation

Implemented: server profile configuration, declared token-allowance quotes, versioned owner consent to provider disclosures, owned numeric limits, an internal reservation/accounting engine, bounded text preflight, durable metadata-only requests/history, and synthetic-only attempts/recovery. Provider execution, actual price/token-bound/retention verification, health/model verification, conversations, tools, and queued AI work are pending. This foundation cannot send paid requests. Quote, consent and lifecycle controls are backend capabilities; their UI controls remain pending.

## Provider profiles

`AI_PROVIDER_PROFILES` is a server-only JSON array, empty by default. Each entry has a unique lowercase `alias`, an `adapter` identifier (`anthropic`, `openai`, or `openai-compatible`), a declared `model`, a `credentialEnv` reference, `enabled` (defaults false), `maxInputCharacters` (1–48000), and `maxOutputTokens` (1–32000). At most 24 profiles are supported; the entire encoded JSON is bounded at 24,000 characters. Optional pricing/disclosure fields are described below. Unknown fields, duplicate aliases, invalid bounds, inline credentials, and arbitrary endpoints are rejected.

Credential references must use the `AI_SECRET_` prefix, such as `AI_SECRET_ROUTINE`. Values come only from the server environment and stay in server memory. Never use `VITE_*`, browser forms, logs, or the repository for credentials. Startup errors expose only the setting name. Model/adapter names are declarations, not verified support or a working transport. Compatible/self-hosted endpoints need a later server-controlled adapter.

Owner-authenticated `GET /api/v1/ai/providers` returns safe profiles, a revision, `dispatchEnabled: false`, and `health: 'not_checked'`. States are `disabled`, `credential_missing`, and `configured`. Configured means enabled with a credential present; it does not mean reachable or authorized upstream. The revision fingerprints public configuration and credential-presence state, excluding secrets and secret names. It is not a credential-rotation or health proof. Restart after environment changes.

There is no browser profile editor or provider network request. Routing aliases can be saved before profiles exist; preflight blocks unconfigured destinations. Configuration is currently for the single-owner server, not multi-user credential delegation.

## Declared prices and provider consent

Profiles optionally include `pricing` and `retentionDisclosure`, both default null. Pricing requires `revision` (1–80 identifier characters), `validUntil` (UTC timestamp), `inputTokenLimit` (1–2,000,000), and integer USD-millionth rates per million tokens: `inputMicrosPerMillionTokens` and `outputMicrosPerMillionTokens` (0–1,000,000,000). Retention requires a `revision` and a concise server-declared `summary` (1–2,000 characters). These are operator declarations, not verified upstream rates, retention guarantees or owner choices. No real rates or retention defaults are bundled.

Public profiles add these declarations and `policyRevision`, a SHA-256 fingerprint of the safe alias/adapter/model/configuration state/limits/prices/disclosure. Registry revisions also change. Secrets and credential reference names remain excluded. Rotating a secret without changing its presence does not change the fingerprint; verified upstream identity/retention must still be checked before any future dispatch.

`GET /api/v1/ai/provider-readiness` returns the registry revision and each profile's quote, saved consent, `consentCurrent`, and all preliminary blockers in one owned repeatable snapshot. It always reports `dispatchEnabled: false`, `DISPATCH_DISABLED`, `PROVIDER_VERIFICATION_REQUIRED` and `TOKEN_BOUND_UNVERIFIED`. Missing/expired pricing, missing disclosure, missing/stale consent, unavailable configuration and budget gates add explicit blockers. There are no provider calls or reservations.

Quotes use the entire configured input-token allowance and `maxOutputTokens`, rounding each cost leg upward separately to a whole USD millionth using BigInt. Price expiry is inclusive: at `validUntil`, the quote is unavailable. The quote basis is `configured_token_allowance`; it is neither a character-to-token estimate nor a verified worst-case provider invoice. Adapters must later prove the serialized envelope/system overhead fits the token bound and verify all billable token categories/fees before admission. Budget comparisons include current-month recorded spend/holds plus the quote, using exact arithmetic. Equality fits; larger values block. Even a zero quote does not enable execution or override zero-limit blocking.

`PUT /api/v1/ai/provider-consents/:alias` accepts only `approved`, `expectedVersion`, `expectedRegistryRevision`, and `operationId`. Unsaved consent defaults to false/version 1. Approval requires a configured disclosure and binds the current profile revision; changing the model, adapter, prices, limits, configuration state or disclosure invalidates it. Unrelated profile changes invalidate pending writes through the registry guard, without invalidating an unchanged profile's saved consent. Revocation clears approval and its active snapshot. Saving consent never selects a provider, creates a budget, or authorizes an action/email send.

Migration 020 stores versioned consent and the safe profile/disclosure snapshot actually approved; mutation receipts preserve historical approval/revocation responses. Matching retries return the historical response even after revocation/configuration changes; always reload readiness before presenting current consent. Changed payloads/aliases with an existing ID conflict. Reads/writes are online-only and owner-scoped. Export adds `records.aiProviderConsents` (older files default empty). No local prompt retention, permanent purge, automatic reapproval, consent expiry or verified external retention enforcement is implemented. Disclosure summaries must contain no credentials or private account samples.

Preflight receipts add nullable `executionReadiness`, using the selected server profile and the same policy/budget/context snapshot. The existing primary `reason` remains compatible, including `DISPATCH_DISABLED`; additional readiness blockers describe gates still open. Legacy receipts default this field to null, which cannot authorize future execution. Denied/unavailable routing has no selected readiness. Quotes/consents/old preflights must all be revalidated immediately before any future transmission.

## Spending limits

`GET/PUT /api/v1/ai/budget` reads or versionedly saves `monthlyLimitMicros` and `perRequestLimitMicros`: integer USD millionths, bounded at 1,000,000 USD. Set both; the request limit cannot exceed the monthly limit. Both null means unconfigured; zero blocks paid execution. The monthly boundary is UTC. Defaults are null, not an inferred budget from the owner's cost preference.

The browser converts decimal USD exactly with up to six fractional digits. Writes require owner authorization, expected version, and an operation ID. Lost-response retries reuse their original payload/ID. Reload retains draft amounts and adopts the latest version. Limits do not establish pricing, token estimates, affordability, retention approval, or execution consent. Preflight incurs no provider charge and creates no accounting reservation.

### Internal accounting engine

Migration 018 adds `ai_budget_reservations`. Internal server functions serialize admission and settlement on the owner's budget row. A future caller must supply an owned durable inference-step ID, a policy version, an approved provider/model, and a server-derived worst-case charge. There is no HTTP reserve/settle/release API and no production worker calls these functions. Neither a reservation nor a transition receipt authorizes model transmission.

Admission requires configured limits, a matching version, a maximum charge within the request limit, and `spent + held + new maximum <= monthly limit`. The per-request cap applies to an inference step; a whole conversation/responsibility budget is later scope. Same owner/request ID and payload returns the existing reservation; changing provider, model, estimate or policy payload conflicts. Retrying a released or settled ID never creates a new reservation.

`reserved` holds the maximum before execution. Any dispatcher must durably mark it `uncertain` before transmission. `uncertain` continues to hold the full maximum and cannot be released on timeout, restart, or expiry. Only confirmed usage, including confirmed zero charge, can settle it. `released` is permitted only from an unclaimed reservation. Standalone accounting transitions use versions/idempotency receipts. Receipts are historical results, not dispatch tickets; the synthetic request/attempt harness below independently prevents repeated callbacks. Production adapters must preserve that boundary.

Settled actual charges replace the hold. A confirmed amount above the reservation is recorded as an overrun rather than understated; it can block subsequent admission. Each amount is bounded at 1,000,000 USD. Aggregate totals use decimal strings/BigInt to preserve exact arithmetic. Limit reductions do not erase existing holds. Accounting attributes costs to the reservation's admission month, not the provider's invoice month; an old inference ID is not re-reserved at a month boundary. All-month unresolved/uncertain totals remain visible so rollover does not hide outstanding work.

Preferences shows recorded current-month spend/holds and additional earlier-month outstanding holds. Uncertain amounts are already included in held amounts. This is internal app accounting, not provider billing synchronization. Runtime workers do not create reservations while execution is disabled. Export includes safe reservation records without operational hashes or secrets. Verified prices and token bounds, provider usage reconciliation, actual paid requests and a reviewed uncertainty-resolution workflow remain pending.

## Preflight

`POST /api/v1/ai/preflights` accepts an operation ID, expected policy/budget versions, expected registry revision, text (1–12000 characters), an owner-applied request label, and at most 20 unique owned typed references. Provider/model/endpoint overrides, simulated availability, screenshot and attachment fields are rejected. Policy/context/budget reads use one repeatable snapshot. Serialization races retry only rolled-back transactions without external side effects.

The shared routing resolver checks complete labels, versions, ownership, and file provenance. All applicable rules must permit the destination. An unavailable selected alias never silently switches destinations. File-derived context blocks; unknown history or stale/missing/unowned sources rejects without creating a receipt.

Only a selected configured destination permits ephemeral text assembly. The allowlist includes task planning fields, base calendar fields, class name/term/instructor/notes, topic manual assessments, feed text/facts/owner notes, and assignment metadata/owner notes. It excludes source URLs, private feed identifiers, captured provider blobs, credentials, arbitrary database columns, and attachments. Occurrence replacements and captured Canvas snapshot text are not included; current base-record fields are used. Request text is owner supplied; wording never determines labels.

The entire serialized JSON envelope must fit the profile character limit, including escaping and manifest overhead. No truncation occurs. Counts are JavaScript string units, not tokens or bytes. Null source/context counts mean not assembled, not empty.

Every accepted preflight is `blocked`, with `dispatchEnabled: false`:

| Reason | Meaning |
| --- | --- |
| `ATTACHMENT_DERIVED` | Forbidden file provenance. |
| `NO_APPROVED_PROVIDER` | No destination permitted for every label. |
| `PROVIDER_UNAVAILABLE` | Selected alias is missing, disabled, or lacks a credential. |
| `INPUT_LIMIT` | Serialized envelope exceeds the profile limit. |
| `BUDGET_UNSET` | Route/context fits; limits are unconfigured. |
| `BUDGET_ZERO_LIMIT` | Route/context fits; a limit is zero. |
| `MONTHLY_BUDGET_EXCEEDED` | Recorded current-month spend/holds already exhaust the limit. |
| `DISPATCH_DISABLED` | Routing/context/basic limit checks passed; inspect `executionReadiness` for additional pricing/consent/budget gates. Execution remains disabled. |

Reasons follow this order. A nested routing decision can be `selected` while preflight remains blocked. It proves neither health, affordability nor completed work. A future dispatcher must revalidate policy, sources/ancestor provenance, profile, budget, retention and action permissions immediately before transmission. An old preflight cannot authorize it.

## History and retention

Accepted preflights persist atomically with idempotency receipts. The same owner/operation/payload returns the original result, even after settings change or history hiding. Changed payloads with the same operation ID return `OPERATION_CONFLICT`. Snapshot race exhaustion returns `RETRY_REQUIRED`; retry the same operation. No provider call or paid retry occurs.

`GET /api/v1/ai/preflights` pages active records with `limit` (default 20, maximum 50) and an optional owned `before` ID. Ordering preserves SQL timestamp microseconds and uses ID tie-breaking. `GET /:id` reads an active owned receipt. `DELETE /:id` requires its version/operation ID and retains a tombstone. A hidden cursor still works.

Metadata contains IDs, versions, labels, alias/model, configuration revision, limit/usage snapshots, reason, and counts. Raw prompt/source text is discarded and never returned or logged. Mutation receipts retain a payload hash and metadata result, not input text. Preflights are not executable queued jobs and have no retained prompt to replay after restart.

Planner export includes owned limits and all preflight metadata/tombstones; older format-v1 files default these fields to null/empty. Hide is not permanent deletion. Metadata/tombstones and mutation receipts remain retained; permanent purge/retention controls are pending.

## Durable requests and synthetic attempts

The owner-authorized request API stores a lifecycle record separately from preflight history. `POST /api/v1/ai/requests` uses `aiRequestWriteSchema` (the preflight write shape), creates a blocked request and its assessment atomically, and returns `aiRequestSchema`. An exact operation retry returns its original result; changed input with the same operation ID conflicts. Creation reserves nothing and calls no provider. Requests retain typed source/version references and a private request-bound text digest; raw prompt/source text and model results are discarded. The digest and input manifest are excluded from responses and export. `textRetained: false` and `dispatchEnabled: false` remain explicit.

`GET /api/v1/ai/requests` accepts `limit` (default 20, maximum 50) and an owned `before` ID; microsecond timestamp/ID ordering supports retained hidden cursors. `GET /:id` reads an active owned request. `POST /:id/cancel` requires an operation ID/current version and cancels only blocked requests. `DELETE /:id` hides metadata with a versioned tombstone. Neither action is permitted for an uncertain attempt. Hidden records remain in export; independent preflight hiding does not erase request assessments. Mutation receipts are historical snapshots, so reload current records after a retry.

The internal `synthetic-execution.ts` harness runs only with `NODE_ENV=test`, has no dispatch route or production worker, and accepts synthetic adapters without credentials. Admission requires original text resupply, current routing/budget/registry/source versions, complete permitted provenance, current consent, an unexpired declared quote, and sufficient funds. It pins the original provider and never falls back. A synthetic byte-token bound is checked; it is not a real provider tokenizer. Zero-price admission is currently unsupported.

Admission locks budget before request rows and atomically creates one unique attempt, an uncertain full budget hold, and immutable pricing/admission snapshots. A newly claimed attempt invokes one callback outside the transaction and any retry loop. An existing claim returns metadata without repeating that callback, including after restart. A crash before the callback conservatively retains uncertainty. Confirmed synthetic usage atomically settles the hold and marks the attempt/request completed or failed; accounting uses the admitted price even if settings later change, including recorded overruns. Matching confirmation is idempotent; conflicting usage is rejected. Transport failures, malformed results and failed accounting retain the full hold. No owner HTTP endpoint can assert usage or release an uncertain attempt.

These are three completed backend slices: durable request controls; atomic synthetic admission/settlement; recovery/history/export. Production provider verification, real tokenizer/billing bounds, actual retention enforcement, live adapters, result/conversation storage and dispatch remain pending. No synthetic completion represents a paid model request or an AI planner action. New migrations 021/022 add request/attempt records without changing earlier migrations.

## Owner-confirmed provider and retention settings (2026-10-11)

[Provider setup](ai-provider-setup.md) records subscription-first evaluation preferences, OpenRouter as a general API candidate and Prem-confidential as the labeled-data candidate. The backend now enforces a $50/month ceiling and initializes existing owners at $0.25/request; existing spend/holds persist. Requests can explicitly opt into saving validated synthetic answers with owned read/forget/export. A pinned no-fallback OpenRouter request builder performs no network calls. Actual subscription logins, model/price/retention verification and live transports remain pending.

## Verified context and synthetic text results (2026-10-11)

[Verified context contracts](ai-verified-context.md) extend the foundation with a safe source/version/label manifest, private exact-envelope binding, explicit memory references, final post-admission checks and an internal bounded fake-adapter result flow. Result text is temporary; durable result metadata contains status/counts only. Old unbound requests cannot gain new admission without a new assessment; already claimed attempts never resend. No live adapter/public dispatch/worker/action execution is enabled. Provider/model, numeric caps and production answer retention remain owner decisions.

## Lifecycle verification

Latest validation: `npm run check` passed with 132 API/client tests (one optional standard PostgreSQL test skipped), and `npm run test:e2e` passed all 43 browser tests. The nine request lifecycle tests include an isolated persisted database restart. No real provider or owner database was used.

Synthetic tests cover duplicate and competing admission, owner isolation, stale sources and changed text, non-test rejection, confirmed success/failure/overruns, conflicting confirmations, callback errors, invalid usage, atomic accounting rollback, immutable admitted pricing, hidden-cursor paging, safe export and persistence across restart without resending. Routine tests forbid network access and use isolated databases. Standard PostgreSQL lifecycle concurrency remains unverified locally.

## Verification

Quote/consent slice: full check passed with 123 API/client tests; all 43 browser tests passed. The six synthetic provider-policy tests include configured maximum charges, per-leg rounding, expiry, defaults and strict validation, owner isolation, duplicate approvals, stale/revoked historical receipts, profile invalidation, approved snapshots and exact budget boundaries/holds. Preflight/export checks retain safe metadata and discard request text; forbidden-network spies confirm zero provider calls. Migration 020 runs in the isolated embedded tests. Optional standard PostgreSQL coverage includes duplicate and competing consent writes, but remains skipped locally because TEST_DATABASE_URL is unset.

Checks use synthetic profiles/credentials, isolated databases, and forbidden-network spies. Browser tests override profiles to an empty registry. Optional PostgreSQL checks cover concurrent duplicate preflights, microsecond paging and budget row-lock admission in a dedicated synthetic schema; these checks were skipped locally. Routine validation never calls real providers, processes real account content, resets the owner's database, or incurs AI charges.
