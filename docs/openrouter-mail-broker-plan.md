# Small OpenRouter mail broker

Owner direction: 2026-10-16. The owner selected the small OpenRouter model approach and authorized this plan. Implementation was subsequently authorized and is now in development; see [runtime, setup and remaining gates](openrouter-mail-broker.md). The following preserves the planning baseline; configuration, live approval and deployment are not implied.

## Outcome and baseline

Replace the TypeSafe-specific mail relevance adapter with a small structured-output OpenRouter model. Preserve the broker's bounded retrieval, owner grants, two-hop permissions, original-text forwarding, accounting, provenance and recovery. Keep the receiving Assistant's model unchanged. This is a broker substitution, not a general Assistant model migration.

The checked-out main is `0cdc1c5`, through migration 062. Local branch `ai/jev-broker-workflow` at `a55ce38` contains J1-J4, migrations 064-066 and the Jev broker plan, foundation, workflow and controls documents. Those files are absent from this checkout. The handoff reports later main/PR state; neither that report nor local refs establish current remote or production state. Before implementation, fetch and reconcile the latest main and relevant PRs, then adapt the actual integrated broker. Do not rebuild J1-J4 from the older checkout or reuse migration numbers. Preserve historical implementation receipts.

## Provider choice and simpler setup

Start evaluation with `google/gemini-2.5-flash-lite`, pinned through OpenRouter to `google-vertex`, which is already an allowed Google host in `openrouter-live.ts`. Do not use a moving alias, automatic routing or another upstream. The published model page lists $0.10/M input and $0.40/M output on 2026-10-16. These are planning prices, not an account quote or a verified live endpoint. Recheck supported parameters, endpoint availability, ZDR eligibility and complete billing before enablement. If this candidate fails a gate, leave the broker blocked and propose a named replacement; never switch automatically.

Reuse the server-held OpenRouter credential if configured. No TypeSafe account, key, enterprise ZDR agreement or `TYPESAFE_VERIFICATION` is required for the replacement. Reuse the existing OpenRouter catalog, pinned transport and accounting where compatible; do not remove destination-specific checks merely because the credential is shared.

Create a separate broker destination configuration/approval. Bind approval to role, exact model, upstream, retention terms and relevant pricing revisions. Existing downstream approval is not approval for a different broker model. OpenRouter and the upstream both receive disclosed text; ZDR does not provide confidential computing. Existing Jev approval never migrates into OpenRouter approval.

## Selection contract

Keep deterministic local retrieval and existing broker limits: up to 500 candidates, pages of 25, up to 50 forwarded messages, 6,000 characters per forwarded body, 128 KiB aggregate results and at most two retrievals per agent run, including continuations. Preserve the existing 20 KiB serialized broker-envelope cap and bounded excerpts; clamp further to provider/context, lineage, deadline and budget capacity. Limits are ceilings, not promises of exhaustive search.

For each bounded batch, submit only eligible text, the bounded retrieval intent, a fixed versioned relevance rubric and server-assigned candidate keys. Request strict JSON containing exactly one judgment per candidate: key and one of `irrelevant`, `possibly_relevant`, `directly_relevant`, `insufficient_evidence`. No summaries, tools, actions or free-form explanations are needed. Select only `directly_relevant`; order ties deterministically using existing candidate order. Preserve no-match and partial coverage outcomes. Excerpts can miss relevant body text; report clipping and do not claim complete semantic recall.

Validate JSON and the exact expected key set, rejecting unknown, duplicate or missing keys, invalid enums, extra fields, refusals, truncated responses and inconsistent model identity. Use existing strict decoding protections, including duplicate-key rejection where available. Invalid selection forwards nothing from that batch. Do not apply Jev probability thresholds to generated judgments or treat self-reported confidence as calibrated. Version the new rubric/decision policy; invalidate selection reuse across adapter, rubric, candidate snapshot or destination changes.

Copy original selected text on the server. A model cannot choose arbitrary database IDs, set labels, expand scope, alter limits or authorize forwarding. Email and agent requests remain untrusted data. Model quality supports usefulness; server checks enforce authority even when a model follows an injected instruction.

## Permissions, lineage and accounting

Before the broker sees candidates, intersect the saved owner/agent grant, request labels, message/connector provenance, broker-approved labels and receiving-destination-approved labels. Keep Restricted and unknown/attachment-derived provenance blocked initially. Personal requires explicit permission at both hops. Reuse complete candidate dependency tracking, not just the selected winners. Selection cannot remove inherited labels.

Revalidate grants, source versions/hashes, connector identity, both routes and approvals, consent, inherited history, deadline and worker lease at every disclosure boundary. Changed sources invalidate prior judgments. No raw-mail bypass, fallback to Jev or fallback to the former direct search/read workflow is permitted. Revocation blocks subsequent admissions while usage already sent can settle.

Reserve each complete broker exchange before sending, including system/schema overhead and maximum billable output and any applicable fees. Do not carry over Jev's zero-output-cost assumption. Bound output tokens to fit every candidate's judgment; split batches when necessary. Charge broker and receiving exchanges to the same logical request allowance, owner monthly limit and agent allowance without double-counting. Keep the $50 monthly ceiling and saved request limits unchanged. Use authoritative reported usage/cost; missing trustworthy billing or uncertain transport retains its hold. Valid usage may settle even if selection is invalid.

Reuse no-retry/no-redirect transport, bounded response/time limits, exact serialized-envelope binding, idempotency receipts and restart reconciliation. Existing uncertain Jev calls retain their original destination/accounting and are never replayed against OpenRouter. Old selection receipts cannot authorize new forwarding under a changed adapter. Keep existing grants as saved scope; enabling a new destination still requires explicit approval. Add an append-only migration only if the actual schema requires one; never edit migrations 064-066 or rewrite old audit metadata.

## Delivery sequence and acceptance

1. **Reconcile and specify.** Confirm integrated J1-J4, remote merge state and schema. Map Jev-specific references in contracts/config, `jev-protocol.ts`, `jev-policy.ts`, `jev-execution.ts`, `mail-broker.ts`, workflow, receipts and UI. Define a provider-neutral broker interface without broad refactoring. Exit: documented compatibility/migration decisions and no missing legacy receipt path.
2. **Implement the adapter and readiness.** Add strict selection request/decoder and broker-specific OpenRouter approval using existing gateway guards/transport. Retire TypeSafe verification as a readiness prerequisite only for this new adapter. Exit: fake transport proves pinned ZDR routing, schema support checks, full-envelope reservation, independent destination approvals, blocking on stale/failed catalog reads, invalid output, refusals and missing usage.
3. **Integrate and preserve history.** Reuse J3 owner asks, scheduled agents, continuations, grants and lineage. Exit: forged/foreign references, injection, relabeling/deletion/revocation between hops, lease loss, downstream changes, budget exhaustion mid-scan and restart/lost-response cases cannot broaden disclosure, resend paid calls or lose holds. Exercise populated upgrades on disposable PostgreSQL as well as embedded tests.
4. **Update owner controls and evaluate.** Replace Jev-specific setup/copy with broker model/host approval and real blockers. Preserve scope editing, version conflicts, offline read-only settings, visible coverage, older-mail continuation and keyboard/tap/e-ink behavior. Build at least 60 synthetic labeled retrieval cases covering exact matches, paraphrases, noise, no-match, ambiguity, injection, clipping and multiple relevant messages. Require at least 90% precision and 90% recall for direct relevance on this bounded synthetic set, no invalid accepted references and no authority-boundary failures. These are proposed release criteria, not achieved results or private-mail calibration. Fake responses validate code paths; actual model-quality evaluation requires separately authorized paid synthetic calls. Until that evaluation, quality remains unverified.
5. **Validate and enable.** Run `npm run check`, then `npm run test:e2e` for UI/auth changes, sequentially with isolated ports/databases. Require Linux/Windows/PostgreSQL CI, sealed release/service-user preflight, backup/isolated restore and staged readiness. Then configure/approve the exact broker destination, scope and limits and perform separately authorized live acceptance: owner ask first, then one Ask-first agent. Record selected source IDs/counts, costs/holds, coverage and outcomes without mail text or credentials. Roll back code only under schema compatibility; disabling the broker stops new mail admissions without erasing receipts or enabling another path.

## UI contract and limitations

Settings > AI > Mail access shows broker model/OpenRouter/host separately from the receiving model, saved grant and exact approval state. Preserve off, loading, approval required, stale approval, missing key, unavailable/non-ZDR/unsupported endpoint, budget blocked, pending, partial, failed and uncertain states. Missing broker approval links to the actionable control. Existing Use mail does not grant a new disclosure destination. Offline writes remain disabled; conflicts preserve drafts and offer reload.

Answers/runs keep inspected, judged and forwarded counts, clipping, stop reason, imported freshness, completeness warning and safe continuation. Do not describe a partial scan or zero matches as whole-inbox coverage. No new visual redesign, email sending, cloud embeddings, attachment processing, automatic sensitivity classification, memory access or external writes is included.

## References checked 2026-10-16

- [Model and planning prices](https://openrouter.ai/google/gemini-2.5-flash-lite).
- [ZDR enforcement and limits](https://openrouter.ai/docs/guides/features/zdr).
- [Structured output support](https://openrouter.ai/docs/guides/features/structured-outputs).
- Existing local implementation anchors: `apps/api/src/ai/openrouter-live.ts`, `live-request.ts`, `live-destination.ts`; J1-J4 documents on `ai/jev-broker-workflow`.
