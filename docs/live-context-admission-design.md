# Live context admission and retained provenance

Owner-confirmed refinement (2026-10-15): boundary 1 uses one-click approval of the server-declared live model and single upstream in Settings, with new bound history available immediately. The [boundary plan](superpowers/plans/2026-10-15-live-context-admission-boundary-1.md) records this narrow compatibility adapter; it supersedes this specification's earlier provider-profile setup proposal. General gateway routing/dispatch remains separate and unchanged. Boundary 2 is implemented on `ai/derived-output-lineage` (not deployed; validation in progress): durable derived-record lineage and server-owned Apply, described under "Output application" below.

Implementation specification for P5/P6 of the approved [development plan](post-agents-development-plan.md). This document describes proposed work; it does not claim deployed enforcement. P3 source baseline: `65ab10d`. Academic, memory and MCP context stay excluded until this boundary passes its acceptance checks.

## Existing disclosure paths

`features/assistant.ts:answerTurn` serves both owner asks and scheduled agents. Its operation hash binds ask/options for replay, not the actual outgoing envelope. Planner context and conversation history are read separately. Later mail rounds resend the initial context, history, prior model replies and earlier mail results. Rechecking only newly selected bodies cannot protect the cumulative disclosure.

`features/assistant-conversations.ts:readHistory` currently resends the last bounded asks/replies without retained source bindings. `finishTurn` retains proposals but no complete source lineage. Owner Apply writes directly through ordinary task/calendar endpoints before separately updating turn item state. Agent Apply uses the durable worker transaction. Both must use the same future provenance enforcement.

The general gateway already has source resolution, label intersection, integrity binding, provider consent and synthetic accounting. Its dispatch remains disabled. Its context assembler is not a drop-in replacement: it admits different fields and limits sources to twenty, while live planner context may include 150 tasks and 150 events. Preserve the existing narrow projections rather than silently adding notes, recipients or other fields.

## Delivery boundaries

1. Containment and reusable binding: withhold unbound history, prepare exact live envelopes in consistent snapshots, retain per-exchange manifests, and revalidate all cumulative sources immediately before transmission. Add explicit route configuration rather than interpreting an absent policy as approval. Keep source-derived proposals read-only until the next boundary can preserve their origin.
2. Durable history and output lineage: allow only fully bound history; make owner Apply server-owned; persist inherited origins and labels with planner writes; enforce them through edits, Undo, deletion and restore. Existing derived records with uncertain origin remain ineligible for inference.
3. Only after both boundaries pass, consider explicit manual academic selection, followed separately by explicit memory selection. No automatic source expansion is part of this specification.

These may require multiple reviewable PRs, but no intermediate release may claim full P5/P6 enforcement. A foundation can remain unused until all live call sites are connected.

## One envelope, one exchange binding

Introduce an internal versioned live manifest. It binds owner, request/exchange ID, conversation, operation/round identity, exact serialized request bytes, model, OpenRouter intermediary and allowed upstream route, settings/policy/consent revisions, projection versions, source identities/versions, immutable captures and inherited labels. Agent requests additionally bind the current goal semantics and availability without treating Pause as cancellation.

Preserve the current operation hash for idempotency compatibility. Store a separate private integrity hash using the existing `ai/context-binding.ts` pattern. Never expose it in HTTP, export, UI, logs or notifications. Serialization happens once; the transport sends those exact bytes. No reconstruction or mutation after binding is permitted.

Build planner selections, source resolution and projections in the same repeatable snapshot. Reuse `resolveAIContext` and `evaluateAIRouting`; add live projection adapters for the fields actually sent. A projection identity distinguishes planner summaries, mail search headers and bounded mail bodies. Include truncation decisions and serialized dates/ref ordering. Do not infer attachment safety from plain text alone.

Mail search/read must return internal message and connector identities/versions plus complete owner labels. A later round's manifest includes every earlier disclosure retained in its body, even if a message is no longer selected for a body read. Prior model replies conservatively inherit all sources of their exchange.

Admission persists the manifest binding atomically with the existing uncertain reservation and attributed request. The final transmission guard rechecks current owner authority, conversation availability, exact projection integrity, source/ancestor state, label intersection, settings/consent/route availability, agent eligibility and the unchanged serialized bytes. Provider calls remain outside retryable database transactions. A failed final guard must never cause automatic resending; reservation release requires affirmative proof that transport did not start. Otherwise retain uncertainty.

Concurrent revocation has a defined linearization point when the final guard establishes its consistent verification snapshot. A revocation committed before that snapshot must be observed and block the send. A later mutation may miss an already-admitted send; do not claim that it retracts bytes. Finish verification and transmit immediately without intervening context assembly or unrelated work. Avoid long database transactions spanning network I/O. Document and test lock ordering against owner budget, agent leases, conversation and planner/source mutation locks before connecting the guard.

## Explicit routing compatibility

General provider aliases and live OpenRouter host tags are separate namespaces. A model author, available ZDR endpoint or server key does not establish owner approval. Existing Personal-mail consent remains an additional ceiling; it cannot override a restrictive routing rule.

Use a server-declared, owner-approved mapping to an exact live OpenRouter destination: intermediary, model and pinned upstream policy, with a safe revision/disclosure snapshot. Reuse existing provider profiles/consents where their declaration exactly matches this destination. Do not automatically create approved aliases or approve an empty routing policy. A missing, stale, incompatible or unavailable mapping visibly blocks admission. Configure the mapping through existing owner-authorized settings contracts before enabling the new path; account-specific destinations remain an owner configuration gate.

The implementation must decide whether the first adapter requires a single pinned upstream or an explicitly approved bounded upstream set. Existing general OpenRouter profiles pin one upstream; supporting a set requires a new declared contract and consent revision. Never quietly equate the current live multi-host allowlist with a single-provider alias. Do not enable general gateway dispatch to solve this mismatch.

## Retained history

Legacy conversations stay readable. Unbound history is withheld from inference with a visible limitation and a fresh-conversation option. Do not certify old text by replaying its current source list or inventing its origin.

New eligible history binds the exact retained ask/reply fragments and the transitive sources that informed them. Bound manifests use finite, deduplicated source unions and explicit limits; overflow withholds history or blocks clearly rather than dropping provenance. Avoid unbounded recursive resolution. Source deletion, relabeling, connector revocation, future memory disable/forget, route changes or unavailable captures invalidate dependent redisclosure. Use mail off excludes mail-dependent history. Re-enabling a source does not silently certify an earlier unbound fragment.

Current owner-authored input is an intentional submission, not automatically inspected evidence of source origin. Explain that pasted text cannot be reliably identified as copied mail or files. Future explicit selections carry enforceable lineage; do not claim automatic detection of private pasted information.

## Output application

An answer/proposal inherits the conservative union of all sources, owner labels and provenance admitted for the answer, including earlier rounds and history. Persist the saved proposal and lineage together. Do not trust a client-supplied source manifest or a reconstructed proposal body.

Provide an owner-authorized Apply operation that loads the saved proposal by owned turn/item identity and expected version, rechecks current sources/permissions and target versions, and atomically commits the planner effect, origin capture, inherited label floor, receipt and item state. Agent automatic Apply calls the same internal operation inside its existing lease-fenced transaction. Preserve current partial-item conflict behavior through savepoints and durable operation IDs.

Undo may reverse owner planner fields but cannot erase inherited labels or origins. Ordinary edits, detachments, deletion and restore preserve retained provenance and current inherited restrictions. Label propagation must also cover tombstones. Uncertain legacy derived origins cannot be reconstructed from present unlabeled values or missing/deleted conversation text. Establish a conservative eligibility marker without claiming every pre-migration record is owner-entered; ordinary owner viewing/editing stays available.

## Persistence and UI contracts

Add append-only migrations after the then-current migration head. Store exchange bindings, projection/source references, versions, inherited labels, safe destination revisions and explicit bound/unbound state. Use owned composite foreign keys where applicable. Store no duplicated prompts, mail text, credentials or private integrity values in diagnostic receipts. Conversation deletion clears retained text under the existing contract while preserving sufficient nontext provenance/tombstones to keep dependent records conservative.

UI contracts must distinguish owner-readable history from inference-eligible history, show bounded used/withheld source summaries and truncation, surface stale/blocked Apply without losing proposals, and retain pending/offline/conflict states. Preserve notification/read-on-open behavior, Pause-finish-running, uncertainty warnings, Apply/Undo receipts and 320px/e-ink accessibility. Agent/status/history durable offline caching is not introduced here.

## Required synthetic acceptance

- A Personal-mail answer is retained, Use mail is then disabled, and a new ask never resends that answer or its dependent source text.
- Message/connector edits or relabeling between rounds two and three block the cumulative envelope, including previously sent headers/results.
- Source byte changes without version increments, settings/model/route/consent changes, altered ref ordering and post-hash envelope mutation are rejected.
- Incompatible label routes, missing mapping and unavailable approved upstreams block without fallback or inferred approval.
- A committed uncertain exchange survives restart without resupply/resend; settlement and operation replay preserve their current identities.
- History source unions remain bounded, deduplicated and transitive; legacy/missing/deleted bindings fail closed while owner viewing remains available.
- Owner Apply and agent automatic Apply reject stale or foreign lineage, retain atomic receipts, and cannot drop inherited restrictions through edit/Undo/restore/detach.
- Populated upgrades preserve prior data and applied migration bytes, explicitly retain legacy unknowns and use isolated databases.

Run `npm run check`, applicable disposable PostgreSQL race checks and `npm run test:e2e` for touched UI/auth flows. All exchanges are injected; no owner database, real provider or paid AI request is part of routine validation. Production deployment, configured destination consent and live owner acceptance remain separate receipts.
