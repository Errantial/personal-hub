# Brokered Assistant and agent mail (J3)

Historical TypeSafe delivery record. The owner selected a small OpenRouter replacement on 2026-10-16; current development behavior and remaining gates are in [OpenRouter mail broker](openrouter-mail-broker.md). Older validation receipts below apply to the Jev implementation.

Implemented in development on `ai/jev-broker-workflow`, stacked on J1/J2. Not deployed. Routine validation uses fake providers and synthetic mail; actual TypeSafe account terms, full-envelope token/billing evidence, owner provider approval, label routing and explicit mail grants remain required for live use. J4 controls and staged acceptance remain pending.

## Workflow

`POST /api/v1/assistant/requests` with `useMail: true` now uses the broker before one receiving OpenRouter exchange. The old model search/read loop is removed from this runtime. Scheduled and Run now agents use the same workflow, under their agent grant and current run lease. Missing grants return `MAIL_BROKER_APPROVAL_REQUIRED`; unavailable Jev blocks rather than falling back. The old Use mail switch approves neither a grant nor TypeSafe disclosure. Mail-disabled requests and ordinary owner Mail browsing retain their existing behavior.

Only the raw owner ask or server-read saved agent goal becomes the Jev intent. Conversation history, planner records, academic selections and model-generated requests are not used to construct that intent. An agent cannot invent source labels, request identities, leases, connector scopes or budget bounds. Unknown model search/read references are ignored; no raw read tool is available. Email and requests remain data, never authority to change the rubric or permissions.

The workflow pins request identity, conversation and a two-minute mail deadline before paid admission. It inspects a stable imported window and evaluates pages of at most 25. Effective candidate capacity leaves room for current planner/academic sources, 50 forwarded bodies and a broker reference within the existing 350-source ceiling. Forwarding retains the original body limits (6,000 UTF-16 units without split surrogate pairs, 50 messages and 128 KiB), with safe imported-mail coverage. A conservative answer allowance covers the base envelope plus 140 KiB of mail/coverage overhead before the first Jev call. Budgets too small for that bound block; dynamic byte reduction to fit a smaller allowance is not implemented.

The receiving model gets selected original text and coverage without candidate IDs or connector IDs. Every evaluated candidate remains a private dependency, including rejected candidates affecting ranking. A no-match answer still depends on its judgment receipts. Mail-derived proposals remain read-only, including scheduled agents with automatic task permission. No email is sent.

## Accounting and recovery

Migration 066 adds durable workflow identity and immutable forwarding bindings, plus a structured broker summary on conversation turns. It does not change migrations 064/065 or manufacture grants from old settings. Workflow, retrieval, batch and forwarding tables retain metadata only. Selected subjects/bodies are not copied into these audit tables; the existing conversation mail summary retains owner-readable subject/sender metadata.

Jev batches and the answer share the existing owner, logical-request and agent allowances. Answer admission consumes the reserved downstream hold once, verifying identity, attribution, current budget policy, model, provider, status and sufficient amount. It does not reserve or charge that amount twice. Turn cost includes settled Jev usage and receiving-model usage; agent spending already includes both through the shared ledger.

An exact workflow retry reuses its identity and confirmed pages. A completed turn replays without another provider call. An uncertain batch is never resent or forwarded, and its uncertain charge stays held. A known failed selection releases unused answer headroom. Confirmed receipts may resume while their original deadline, context and policy remain valid; expired or changed context blocks. A process lost after answer admission retains the existing uncertain/no-resend request behavior. There is no automatic paid retry or fallback.

Before every Jev send, owner session authority (for owner asks), scope, source hashes, both routes, account verification, budget and agent lease are checked. Immediately before the answer send, the existing sealed-envelope guard additionally checks the immutable forwarding receipt, all evaluated original bindings, grant version, current Jev approval/evidence, downstream destination, owner budget policy and current run context. A failed guard releases the unsent answer hold while preserving already-settled Jev charges. Pause permits a currently leased run to finish; a changed goal, labels, lease or cap blocks further disclosure.

## History and continuations

A `mail-broker-v1` manifest entry points to the immutable forwarding binding and conservatively inherits all evaluated labels. Its private digest survives into transitive history. History checks the grant and complete original source bindings, including losing candidates. Deletion, body/version changes, relabeling, connector changes or grant revocation withhold derived history. The actual receiving transmission also checks both current routes and provider approval/evidence. History does not require the old agent lease or retrieval deadline to remain active. Expanded broker dependencies count toward the 1,000-source history ceiling; excess history is withheld without discarding lineage. Legacy direct-mail history without a broker grant receipt remains readable but is no longer inference eligible.

Turns expose optional `mailBroker: {receipt, continuation}` alongside existing `mail`, `mailWithheld` and `mailNote`. The structured receipt reports imported scope/freshness, inspection/judgment/selection counts, clipping, limits and external completeness as unverified. `continuation` is an opaque, owner-bound token when older data remains. An owner can submit it as optional `mailContinuation` on another mail-enabled ask. It cannot list candidates or read a guessed message.

Older-window continuation requires a completed scan of the prior snapshot, its immutable forwarding receipt, the same current grant revision and agent identity. It uses the original import-time ceiling and exact received-time/UUID boundary, so later backfills and newer arrivals do not enter that scan and prior candidates do not repeat. Forged, foreign and revoked tokens block. Within-snapshot page cursors remain internal. Agent retrieval admission still caps a run at two retrievals; the initial agent workflow makes one goal-based retrieval rather than granting a model an unbounded continuation loop.

## Remaining gates

J4 must add grant/approval controls and clear migration/coverage/continuation UI to existing settings and conversations, with blocked/pending/partial/failed/uncertain states and keyboard/tap/320px checks. Existing UI already displays actionable API errors and the concise coverage note; no new controls or private candidate viewer were added. Production deployment, actual account verification, owner live acceptance and private-mail relevance evaluation are separate work. External Gmail completeness remains unverified.

Validation (2026-10-15, local): `npm run check` passed lint, workspace types, 810 unit/API tests, formatting and production builds; three opt-in PostgreSQL cases were skipped because no disposable PostgreSQL was available locally and remain CI-only. Sequential `npm run test:e2e` passed all 156 isolated Chromium cases. No real provider, mailbox or owner database was used. Remote CI acceptance remains pending.
