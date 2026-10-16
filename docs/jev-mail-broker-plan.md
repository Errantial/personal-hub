# Jev-mediated mail access and next steps

Owner direction recorded 2026-10-15. This is the finalized implementation plan. J1/J2 foundations are now implemented in development; see [implemented boundaries and pending integration](jev-mail-broker.md). J3 workflows are implemented in development on ai/jev-broker-workflow with local validation complete; [workflow boundaries](jev-mail-workflow.md) apply. J4 controls remain planned, and no live TypeSafe disclosure is approved by this document. The broker precedes remaining P8 study proposals. Academic context, selection and source-linked task proposals merged in PRs 39-41; merging is separate from deployment.

## Product contract

An agent submits a bounded natural-language mail request to a server-owned broker. The broker retrieves eligible imported messages, asks TypeSafe Jev for typed relevance judgments, and supplies a larger bounded selection of original mail text to the agent. Forwarding means providing agent context, never sending an email. The agent receives no mailbox credentials, database access, arbitrary message-read endpoint or full candidate pool.

New mail-enabled agents use the broker by default. Access stays off until the owner enables a scope and the required provider approvals are ready. No direct-mail permission is added. Existing mail-enabled agents migrate to an explicit broker-approval-required state; their old Use mail switch does not silently approve TypeSafe disclosure. Mail-disabled agents remain off. Blocked Jev never falls back to the previous search/read path. Owner manual mailbox browsing remains available.

The intermediary broadens retrieval beyond subject/sender keyword matching and five bodies per run. It does not expand privacy labels or prove complete external mailbox ingestion. Jev selects relevance; server code owns authorization, limits, provenance, accounting and dispatch.

## Request and selection workflow

1. Bind the agent's mail request and supported filters to its owner, saved grant, agent/run lease, goal, approved receiving destination and budget. Server code clamps all requested limits. The request and prior context retain their inherited labels when sent to Jev; a retrieval request cannot launder sensitive context.
2. Page imported mail with stable ordering and guarded cursors. Before any Jev disclosure, intersect owner scope, verified message/connector provenance, Jev-approved labels and receiving-agent-approved labels. Broader access means more eligible messages, not permission to cross label boundaries. Use local deterministic retrieval; no cloud embeddings or extra provider is introduced.
3. Begin with bounded metadata and plain-text excerpts. Read more body only under the same grant, limits and paid-admission model when necessary. Record clipping. Treat email and agent requests as data: they cannot change the rubric, permissions or allowed actions.
4. Ask Jev for independent, comparable per-candidate relevance Scores against a versioned rubric. Keep no-match and insufficient-evidence behavior. The model never invents message IDs or grants permission. Evaluate thresholds on synthetic fixtures, then separately authorized owner evaluation; cookbook thresholds are not guarantees.
5. Validate the exact expected answer set, model identity, finite scores/distributions and candidate binding. Reject unknown, duplicate or missing references. Server code applies thresholds, ranking, tie breaks and count/byte ceilings, then copies original eligible mail text rather than generated summaries.
6. Recheck source/body hashes, connector identity, grants, request/source labels, both routes, lease and budget before each transmission. Jev selection and downstream forwarding are separate disclosures with separate manifests and admissions. Changed sources invalidate prior judgments; a later snapshot cannot silently bless earlier selection.
7. Return selected messages and safe coverage: imported scope/freshness, inspected/selected counts, omissions where safely reportable, truncation, remaining cursor and stop reason. Only forwarded messages reach the agent. No matches does not mean the whole external inbox was checked.

## Starting operational defaults

These defaults require implementation validation. Owner/agent limits may reduce them. Effective limits are the minimum of broker bounds, provider context, existing manifest/history capacity, receiving-model context, deadline and remaining budgets.

- Inspect up to 500 candidates per logical retrieval, in pages of up to 25. A broad request need not use keyword-only prefiltering. Traverse larger imported scopes across explicit bounded continuations, not an unbounded run.
- Forward up to 50 messages per retrieval, initially at most 6,000 characters per body and 128 KiB aggregate result bytes. Context or spending limits can yield fewer; say why.
- Initially cap each Jev envelope at 20 KiB UTF-8 including state/questions, splitting further for actual token limits. Do not enable long-context mode by default.
- Initially allow at most two broker retrievals per agent run, including continuations. Server code owns continuation counters/cursors. Preserve the shared and per-agent spending limits and run deadline.
- Record bounds, rubric and threshold versions. Do not claim private-mail calibration from synthetic tests.

The initial grant names imported connectors and supported date ranges. Do not expose Inbox-only, unread-only or folder scopes until ingestion has reliable metadata for them. Unsupported filters block visibly instead of silently becoming all-mail access. Gmail completeness and provider-side move/deletion reconciliation remain separate work.

## Provider approval, routing and spending

TypeSafe is a separate disclosure destination: add a server-declared profile, server-held credential, pinned versioned Jev model, versioned owner approval and verified account-specific terms. Existing OpenRouter approval and Allow Personal mail do not approve TypeSafe. Keep the downstream model unchanged. Personal mail requires applicable consent/routing at both hops; Restricted, unknown-provenance and attachment-derived content stay blocked initially. Jev never determines sensitivity.

TypeSafe's current docs describe zero data retention for enterprise customers. Verify the actual account terms against the hub's existing policy before live disclosure. Incompatible or unverified terms keep dispatch blocked; a key alone does not authorize disclosure. Implementation and synthetic testing can proceed without live account configuration.

Reserve a complete conservative worst-case cost before each Jev and downstream exchange. Charge both to the same owner monthly budget, logical request allowance and agent allowance. Do not increase the $50 ceiling or saved allowance for this feature. Verify all billable state/question/envelope overhead and settlement semantics before production. Missing authoritative usage/cost or uncertain transport retains a hold. Disable SDK default retries; use no redirects and bounded timeouts/responses. Approval binds endpoint, model, terms and quote revisions; rubric changes invalidate selection caches. Unavailable/revoked/stale destinations block or queue, never switch providers or bypass Jev.

## Provenance and recovery

Add metadata-only retrieval/batch/selection receipts: intent digest, owner/agent/run, grant/scope revision, candidate snapshot/cursor, rubric/model/route versions, complete source bindings, decisions, forwarded IDs, usage/holds and terminal/partial status. Never log raw requests, mail, credentials or cookies. Follow existing conversation-retention rules for owner-readable forwarded text; do not duplicate bodies into broker audit tables.

Selection/ranking depends on evaluated candidates, not just winners. Retain the complete dependency set and conservative inherited labels for judgments affecting selection. Independent per-item questions limit unnecessary cross-item dependence. If lineage exceeds current manifest/history capacity, stop with partial coverage; never discard dependencies to fit. Deletion, relabeling, connector changes and grant revocation must prevent redisclosure through broker-derived history. Legacy unbound history remains readable but inference-ineligible.

Use append-only migrations for grants and receipts; invent no old provenance. Reconcile confirmed receipts after restart/lost responses without recharging or reforwarding. Resume only from safe checkpoints. Preserve lease fencing and Pause-finish-running semantics; revocation prevents subsequent admissions while already-sent usage can settle. Failed selection never authorizes raw mailbox access.

## Delivery slices

| Slice | Deliverable | Acceptance gate |
| --- | --- | --- |
| J1 | Shared request/grant/result contracts, append-only grants/receipts, synthetic paged candidate selection and coverage | Ownership, scope, guarded cursors, two-destination label intersection, text-only origin, clipping and incomplete-ingestion checks; no dispatch |
| J2 | Jev adapter through gateway admission, separate provider approval and combined accounting | Fake transport checks for strict results, route/terms/model changes, exhausted budgets, missing usage, uncertainty, timeout/restart and no resend; verify account terms/quote before live enablement |
| J3 | Owner-ask and scheduled-agent broker workflow, larger bounded forwarding and complete lineage | No raw-mail bypass, two-hop final guards, grant/history revocation, injection/forged refs, stable continuations/retries and lease fencing |
| J4 | Existing Agent/AI settings, run/turn coverage, migration of Use mail choices and staged release | Off/blocked/pending/partial/failed/uncertain states; isolated keyboard/tap/320px tests; Linux/Windows/PostgreSQL CI; backed-up staged deployment and separate owner live acceptance |

Routine validation uses fake providers and synthetic mail. Run npm run check for code; UI/auth changes also require npm run test:e2e sequentially on isolated databases/ports. Cover zero matches, more than five relevant messages, over-50 results, over-500 candidates, unsupported folder/unread filters, oversized/non-ASCII text, malicious requests/mail, foreign identities, relabeling at both hops, downstream changes after Jev, missing approval/retention readiness, budget exhaustion mid-scan, lost responses, populated upgrades and restart recovery. No routine real-provider calls, paid requests or owner-database seeding.

## Finalized next sequence

1. **Jev broker J1-J4:** implement the intermediary, validate it, configure/verify actual provider readiness, then staged deployment and owner acceptance. Minimal truthful coverage/freshness is required here, not deferred to P10.
2. **P8 part 2:** finish deterministic study suggestions through current preview/draft/approval/cancellation with source freshness, capacity/conflict checks and lineage. See [the study proposal plan](superpowers/plans/2026-10-15-academic-study-proposals.md).
3. **P9:** explicit per-ask memory selection and forget/disable enforcement through derived history; no automatic agent memory expansion.
4. **P10:** prove required Proton/Gmail completeness and improve move/deletion reconciliation. Broker scope reports eligible imported data until this is verified.
5. **P11/P12:** Canvas collector runtime/ingestion/reconciliation separately; Outlook access/tenant proof before an adapter.
6. **P13-P16:** scoped client/export/auth design, inbound reads first, optional writes separately, then one approved outbound read server.

Reliability and deployment acceptance gates apply throughout. This requested broker is a scoped exception to the earlier no-new-provider plan: TypeSafe integration development is authorized, not blanket live disclosure or unrelated provider migration. Direct mailbox access, email sends, automatic sensitivity classification and unbounded scans remain excluded.

## Research references (checked 2026-10-15)

- [TypeSafe API](https://docs.typesafe.ai/api): typed state/questions/answers and retry behavior.
- [Models](https://docs.typesafe.ai/models): pin a tested version; verify context, input-token pricing and account-specific retention. Moving aliases are not stable approvals.
- [Selection before generation](https://docs.typesafe.ai/cookbooks/classifying_rag_passages): relevant pattern; example thresholds are not product guarantees.
- [Score](https://docs.typesafe.ai/primitives/score) and [legal terms](https://docs.typesafe.ai/legal): rubric semantics and account verification.
