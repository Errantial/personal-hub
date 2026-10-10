# AI gateway foundation

Implemented: server profile configuration, owned numeric limits, an internal reservation/accounting engine, bounded text preflight, and durable metadata-only history. Provider execution, health/model verification, pricing/cost estimates, retention consent, conversations, tools, and queued AI work are pending. This foundation cannot send paid requests.

## Provider profiles

`AI_PROVIDER_PROFILES` is a server-only JSON array, empty by default. Each entry has a unique lowercase `alias`, an `adapter` identifier (`anthropic`, `openai`, or `openai-compatible`), a declared `model`, a `credentialEnv` reference, `enabled` (defaults false), `maxInputCharacters` (1–48000), and `maxOutputTokens` (1–32000). At most 24 profiles are supported. Unknown fields, duplicate aliases, invalid bounds, inline credentials, and arbitrary endpoints are rejected.

Credential references must use the `AI_SECRET_` prefix, such as `AI_SECRET_ROUTINE`. Values come only from the server environment and stay in server memory. Never use `VITE_*`, browser forms, logs, or the repository for credentials. Startup errors expose only the setting name. Model/adapter names are declarations, not verified support or a working transport. Compatible/self-hosted endpoints need a later server-controlled adapter.

Owner-authenticated `GET /api/v1/ai/providers` returns safe profiles, a revision, `dispatchEnabled: false`, and `health: 'not_checked'`. States are `disabled`, `credential_missing`, and `configured`. Configured means enabled with a credential present; it does not mean reachable or authorized upstream. The revision fingerprints public configuration and credential-presence state, excluding secrets and secret names. It is not a credential-rotation or health proof. Restart after environment changes.

There is no browser profile editor or provider network request. Routing aliases can be saved before profiles exist; preflight blocks unconfigured destinations. Configuration is currently for the single-owner server, not multi-user credential delegation.

## Spending limits

`GET/PUT /api/v1/ai/budget` reads or versionedly saves `monthlyLimitMicros` and `perRequestLimitMicros`: integer USD millionths, bounded at 1,000,000 USD. Set both; the request limit cannot exceed the monthly limit. Both null means unconfigured; zero blocks paid execution. The monthly boundary is UTC. Defaults are null, not an inferred budget from the owner's cost preference.

The browser converts decimal USD exactly with up to six fractional digits. Writes require owner authorization, expected version, and an operation ID. Lost-response retries reuse their original payload/ID. Reload retains draft amounts and adopts the latest version. Limits do not establish pricing, token estimates, affordability, retention approval, or execution consent. Preflight incurs no provider charge and creates no accounting reservation.

### Internal accounting engine

Migration 018 adds `ai_budget_reservations`. Internal server functions serialize admission and settlement on the owner's budget row. A future caller must supply an owned durable inference-step ID, a policy version, an approved provider/model, and a server-derived worst-case charge. There is no HTTP reserve/settle/release API and no production worker calls these functions. Neither a reservation nor a transition receipt authorizes model transmission.

Admission requires configured limits, a matching version, a maximum charge within the request limit, and `spent + held + new maximum <= monthly limit`. The per-request cap applies to an inference step; a whole conversation/responsibility budget is later scope. Same owner/request ID and payload returns the existing reservation; changing provider, model, estimate or policy payload conflicts. Retrying a released or settled ID never creates a new reservation.

`reserved` holds the maximum before execution. The future dispatcher must durably mark it `uncertain` before transmission. `uncertain` continues to hold the full maximum and cannot be released on timeout, restart, or expiry. Only confirmed usage, including confirmed zero charge, can settle it. `released` is permitted only from an unclaimed reservation. Settlements and claims use versions/idempotency receipts. Receipts are historical results, not dispatch tickets; a future durable request/attempt state machine must independently prevent duplicate paid calls.

Settled actual charges replace the hold. A confirmed amount above the reservation is recorded as an overrun rather than understated; it can block subsequent admission. Each amount is bounded at 1,000,000 USD. Aggregate totals use decimal strings/BigInt to preserve exact arithmetic. Limit reductions do not erase existing holds. Accounting attributes costs to the reservation's admission month, not the provider's invoice month; an old inference ID is not re-reserved at a month boundary. All-month unresolved/uncertain totals remain visible so rollover does not hide outstanding work.

Preferences shows recorded current-month spend/holds and additional earlier-month outstanding holds. Uncertain amounts are already included in held amounts. This is internal app accounting, not provider billing synchronization. Runtime workers do not create reservations while execution is disabled. Export includes safe reservation records without operational hashes or secrets. Pricing, token quotes, provider usage reconciliation, actual paid requests and a reviewed uncertainty-resolution workflow remain pending.

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
| `DISPATCH_DISABLED` | Preliminary checks passed; execution remains disabled. |

Reasons follow this order. A nested routing decision can be `selected` while preflight remains blocked. It proves neither health, affordability nor completed work. A future dispatcher must revalidate policy, sources/ancestor provenance, profile, budget, retention and action permissions immediately before transmission. An old preflight cannot authorize it.

## History and retention

Accepted preflights persist atomically with idempotency receipts. The same owner/operation/payload returns the original result, even after settings change or history hiding. Changed payloads with the same operation ID return `OPERATION_CONFLICT`. Snapshot race exhaustion returns `RETRY_REQUIRED`; retry the same operation. No provider call or paid retry occurs.

`GET /api/v1/ai/preflights` pages active records with `limit` (default 20, maximum 50) and an optional owned `before` ID. Ordering preserves SQL timestamp microseconds and uses ID tie-breaking. `GET /:id` reads an active owned receipt. `DELETE /:id` requires its version/operation ID and retains a tombstone. A hidden cursor still works.

Metadata contains IDs, versions, labels, alias/model, configuration revision, limit/usage snapshots, reason, and counts. Raw prompt/source text is discarded and never returned or logged. Mutation receipts retain a payload hash and metadata result, not input text. Preflights are not executable queued jobs and have no retained prompt to replay after restart.

Planner export includes owned limits and all preflight metadata/tombstones; older format-v1 files default these fields to null/empty. Hide is not permanent deletion. Metadata/tombstones and mutation receipts remain retained; permanent purge/retention controls are pending.

## Verification

Checks use synthetic profiles/credentials, isolated databases, and forbidden-network spies. Browser tests override profiles to an empty registry. Optional PostgreSQL checks cover concurrent duplicate preflights, microsecond paging and budget row-lock admission in a dedicated synthetic schema; these checks were skipped locally. Routine validation never calls real providers, processes real account content, resets the owner's database, or incurs AI charges.
