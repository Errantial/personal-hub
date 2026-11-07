# Optional Jev mail broker — implementation plan

> **Owner direction update — 2026-10-20:** Jev live operation is API-key based. The earlier `TYPESAFE_VERIFICATION`, `credentialRevision`, account-specific privacy/token-bound/billing attestation, and synthetic-quality-as-a-live-prerequisite requirements in this historical implementation plan are superseded. Current runtime requires a configured `jev-mail` profile/API key plus the ordinary selector, provider consent, routing, budget, downstream and mail-grant controls. Durable protocol identity/no-resend/cross-adapter isolation remain mandatory. Where older text below conflicts with this update, this update wins.

**Goal:** Add TypeSafe Jev as an owner-selectable mail relevance broker while keeping the deployed OpenRouter/Gemini broker as the default and preserving the receiving Assistant as a separate destination. A broker switch must never re-send an uncertain request, reclassify a stored receipt under another provider, inherit another provider's consent, or weaken the existing grant, provenance, label, budget, lineage, continuation, owner-session or agent-lease guards.

**Current baseline:** The deployed broker is `mail-broker` → `google/gemini-2.5-flash-lite` through OpenRouter pinned to `google-vertex`. The provider-neutral J1–J4 workflow survived the Jev→OpenRouter replacement: grants, stable candidate snapshots, two-hop label checks, shared downstream headroom, at-most-once batch admission, restart-safe uncertainty, full-candidate lineage, continuations and agent lease/cap fencing remain in the current code. Historical Jev code is recoverable at commits `568d121` (J1/J2), `65fa42c` (J3) and `a55ce38` (J4). The current focused broker suite passes 69/69; the broader broker/evaluation baseline passes 78/78 and the current broker Playwright file passes 6/6.

**Research checkpoint (2026-10-19):** TypeSafe's current HTTP endpoint remains `POST https://api.typesafe.ai/v1/systemone`. Current versioned models are `jev-1.14.0` and `jev-1.13.0`; Jev 1.14 is the newest release. The moving aliases currently differ: `jev-latest` points to 1.13 while `jev-preview` points to 1.14, so this plan treats exact `jev-1.14.0` only as the initial candidate. Both versioned models are documented at $0.042 per million input tokens with free output, with default context limits of 64k per request and 32k per question. The API returns typed `Score` answers with `score`, `probabilities`, `confidence` and `legend`, plus request `input_tokens` / `output_tokens`. Runtime now uses the configured API key directly; no separate account-evidence object is required.

**Authoritative research sources checked 2026-10-19:** [TypeSafe API reference](https://docs.typesafe.ai/api), [models and version aliases](https://docs.typesafe.ai/models), [Score primitive](https://docs.typesafe.ai/primitives/score), [RAG passage-classification cookbook](https://docs.typesafe.ai/cookbooks/classifying_rag_passages), and [submitted-data retention guidance](https://help.typesafe.ai/articles/5974925716-how-is-submitted-data-used-or-retained). Recheck them before live enablement rather than treating this plan as a perpetual vendor contract.

**Tech stack:** Fastify, PGlite/PostgreSQL, Zod shared contracts, React/Vite, Vitest, Playwright. Use direct HTTP for TypeSafe; do not add the TypeSafe SDK because its documented default retry behavior conflicts with the broker's durable no-resend rule.

## Resolved design decisions

1. **One versioned owner-level broker selector.** Add dedicated `mail_broker_settings` state with `selectedAlias`. Do not put provider choice in each mail grant and do not use generic routing `preferred` as the selector. Existing owner/agent grants remain provider-neutral connector/date authority. All mail-enabled owner asks and agents use the owner's currently selected broker.
2. **Existing OpenRouter behavior is the default.** Owners with no settings row read as `{ version: 1, selectedAlias: 'mail-broker' }`. Merely deploying this code does not select or approve Jev.
3. **Two independently approved broker destinations.** Keep the existing alias `mail-broker` for OpenRouter and restore `jev-mail` for TypeSafe. Each has its own server profile, provider consent and routing permission. Selecting Jev cannot reuse OpenRouter consent; switching back cannot reuse Jev consent.
4. **Pin provider identity before any batch can be sent.** Every newly created retrieval stores the broker alias, adapter, selector version, profile revision, consent version, verification revision/digest, non-secret credential/account revision and protocol revisions in its immutable `limits.broker` object. The exact identity participates in the sealed envelope/admission hash and the new forwarding-policy identity. It does **not** enter the existing operation `request_hash`; an exact operation retry must still find its original durable receipt and then fail or replay according to that receipt's pinned policy.
5. **No batch-column rewrite is required.** Keep migrations 064–066 untouched. Their `profile_revision`, `approval_version`, `verification_revision`, rubric/bounds/threshold columns remain part of each batch receipt. The new retrieval-level broker identity removes ambiguity across adapters. Legacy retrievals without `limits.broker` are never eligible for a new provider send; a completed legacy selection may only remain history-eligible when its existing batch revisions and profile/consent/verification evidence prove the current OpenRouter policy. An uncertain or prepared legacy batch is never resumed by guessing an adapter.
6. **Provider-specific protocol behind one adapter contract.** Keep retrieval, grants, budgeting, final guard, settlement, forwarding and workflow provider-neutral. OpenRouter and Jev supply only profile validation/preflight, envelope fitting/building, exact protocol revisions, transport and decoding.
7. **Jev uses a frozen Score policy.** Start with the historically reviewed four-level relevance rubric and frozen selection rule `score >= 2 && p(2)+p(3) >= 0.75`, but issue new revision IDs for the reintroduced adapter so no historical Jev receipt can pass the new policy by name alone. Do not tune the threshold against the 60-case acceptance corpus after seeing its results.
8. **Preserve current forwarding order.** Jev's score decides selection only. Forward selected original messages in the stable snapshot order, matching the current broker, rather than reordering mail by model score. This keeps the provider choice focused on relevance classification and avoids a second user-visible semantic difference.
9. **Known charges settle; unknown charges stay held.** Settle a Jev charge despite an unusable model/answer only when bounded, duplicate-key-safe outer JSON yields unambiguous usage **and** fresh account evidence attests that those usage counts plus the configured rates cover every billable component. Then calculate the full known charge and settle it even if the answer is invalid or exceeds the admitted token bound; discard the selection. Missing, malformed or otherwise untrusted billing/usage—and non-success responses unless separately proven unbilled—stay `uncertain` with the original hold. No automatic retry follows either case.
10. **No fallback.** If selected Jev is unavailable, unverified, unapproved, over budget, rate-limited, overloaded, timed out or uncertain, stop. Never fall back to OpenRouter for that retrieval.

## Global constraints

- Add only append-only migrations after 072. Never edit migrations 001–072.
- No real mailbox, owner database, API key or paid provider call in routine development tests.
- Restricted mail, unknown/legacy body provenance and attachment/file-derived text remain blocked before broker disclosure. Personal mail still needs permission at both broker and downstream hops.
- `Use mail` remains a preference only; it never creates a broker grant, provider consent, routing permission or selector change.
- Server code owns broker aliases, endpoint, model pin, labels, grant scope, budgets, run/lease data and exact serialized bytes. No HTTP caller may supply an endpoint/model/adapter for execution.
- Durable batch state becomes `uncertain` before handoff. Timeout, transport failure, non-success without trusted billing, unreadable response or missing/untrusted usage keeps the hold and never authorizes resend.
- Keep receipts metadata-only: no subject, body, request text, API key or raw provider response in broker tables, mutation receipts or logs.
- Imported-mail coverage stays explicitly `externalCompleteness: 'unverified'`.
- Keep the downstream Assistant reservation and approval independent from the selector; changing the mail classifier must not change the receiving Assistant model/host.
- Do not use TypeSafe's long-context danger-zone header. The broker retains its smaller product envelope.
- Preserve current per-label routing semantics: readiness may be useful with only Unlabeled enabled even when Personal is not routed. Readiness blocks when no eligible label remains; an individual retrieval blocks when its actual request/source labels are not allowed at both broker and downstream hops.

---

### Task 1: Add versioned broker selection state and contracts

**Files:**

- Create: `apps/api/migrations/076_mail_broker_settings.sql` (migrations 073–075 are reserved by the coordinated task/deadline release train; see `2026-10-19-deadline-tracking-calendar-agent-jev-orchestration.md`)
- Modify: `packages/contracts/src/mail-broker.ts`, `packages/contracts/src/index.ts` if needed
- Modify: `apps/api/src/features/mail-broker.ts`
- Modify: `apps/api/src/features/export.ts` and the planner-export contract to include this safe owner preference
- Test: `apps/api/tests/mail-broker.test.ts`, `apps/api/tests/upgrade.test.ts`, existing export tests

**SQL contract:**

Create `mail_broker_settings` with `owner_id` PK/FK, positive `version`, `selected_alias` constrained to `mail-broker` or `jev-mail`, and `updated_at`. Do not insert rows during migration. Runtime reads a missing row as version 1 + `mail-broker`; the first successful change from that default creates version 2. This preserves current deployed behavior without inventing Jev approval.

**API contract:**

- Add `mailBrokerAliasSchema = z.enum(['mail-broker','jev-mail'])`.
- Add `mailBrokerSettingsSchema = { version: positiveInt, selectedAlias: mailBrokerAliasSchema }`.
- `GET /api/v1/mail-broker/settings` returns the versioned selection.
- `PUT /api/v1/mail-broker/settings` accepts `{ operationId, expectedVersion, selectedAlias }`, uses the ordinary owner-authorized/idempotent mutation helper, rejects a missing server profile for the selected known alias with a broker-destination-unavailable error, and returns the saved setting.
- Selection writes are online-only; stale versions return `VERSION_CONFLICT` and never partially change grants or provider consent.
- Two distinct first writes with `expectedVersion:1` must serialize safely: use an owner-row lock or `INSERT ... ON CONFLICT DO NOTHING RETURNING` followed by an explicit `VERSION_CONFLICT` for the loser. `mutate()` operation-ID serialization alone is insufficient for two different operation IDs.
- Add the saved `{ version, selectedAlias }` to the portable owner export. It is safe metadata; export no credentials or account-verification material.

**Tests:**

- Missing row returns OpenRouter/version 1; exact retry is idempotent; changed payload under an operation ID conflicts.
- First save creates version 2; later save increments; stale version and foreign session behavior match existing settings patterns; concurrent distinct first writes produce exactly one winner and one `VERSION_CONFLICT`.
- Selecting Jev does **not** create or mutate `ai_provider_consents`, `ai_routing_policies`, grants or budgets.
- Populated migration keeps existing grants/batches/reservations/forwardings byte-for-byte and adds no consent or provider call.

**Suggested commit:** `feat(mail): add versioned broker destination selection`

### Task 2: Introduce the provider-neutral broker adapter seam without changing OpenRouter behavior

**Files:**

- Create: `apps/api/src/ai/broker-adapter.ts`
- Modify/refactor: `apps/api/src/ai/broker-protocol.ts`
- Modify: `apps/api/src/ai/broker-policy.ts`, `apps/api/src/ai/broker-execution.ts`, `apps/api/src/ai/mail-broker.ts`, `apps/api/src/ai/broker-lineage.ts`, `apps/api/src/ai/broker-workflow.ts`
- Test: `apps/api/tests/mail-broker.test.ts`

**Adapter interface:** Define common `BrokerExchange` and `BrokerAdapter` types plus an explicit persisted decision union. New writes use:

- OpenRouter: `{ method:'enum', id, judgment, selected }`.
- Jev: `{ method:'score', id, score, confidence, relevantProbability, selected }`, where `relevantProbability = p(2)+p(3)`; raw probability maps/legends are validated transiently and need not be retained.

`selectedBrokerMail` consumes only `id` + `selected` and preserves snapshot order. Add a compatibility decoder for existing untagged OpenRouter `{ id, judgment, selected }` rows; do not rewrite old receipts. The adapter must expose:

- stable `kind` and supported alias;
- `rubricRevision`, `boundsRevision`, `thresholdRevision`;
- `fitCandidates(profile, intent, candidates)`;
- `buildEnvelope(profile, intent, candidates)`;
- `preflight(fetcher, policy)` — OpenRouter keeps today's catalog/ZDR/host/price checks; Jev will use local account evidence and no owner-data network probe;
- `exchange(fetcher, secret, exactBytes, model, candidates, quote, timeout?)` returning the normalized confirmed/uncertain result.

Keep the current OpenRouter implementation as the first adapter. It must continue using the exact Gemini/Vertex pin, strict enum output, no fallback/cache/reasoning, public catalog verification, authoritative reported cost and current protocol revision strings.

**Refactor acceptance:** Run the existing 69-case broker suite before adding Jev. It must remain green with no fixture or assertion weakening. In particular preserve restart/no-resend, all-candidate lineage, continuation, owner authority, two-hop labels and agent cap/lease behavior.

**Suggested commit:** `refactor(mail): isolate broker provider adapter`

### Task 3: Restore Jev as a current, strictly verified adapter

**Files:**

- Create: `apps/api/src/ai/jev-broker-protocol.ts` (or equivalent adapter module)
- Modify: `apps/api/src/ai/jev-policy.ts` (remove “legacy-only” runtime status; keep config parsing sanitized)
- Modify: `apps/api/src/config.ts` and `apps/api/src/ai/profiles.ts` for active verification and non-secret credential/account revision binding
- Modify: `apps/api/src/ai/broker-policy.ts`
- Test: create `apps/api/tests/jev-mail-broker.test.ts`

**Initial production profile identity:**

- alias: `jev-mail`
- adapter: `typesafe`
- upstreamProvider: `null`
- model: exact `jev-1.14.0` (do not use `jev-latest` or `jev-preview`)
- credential: an `AI_SECRET_JEV`-style server environment variable through the existing profile mechanism
- credential/account revision: a non-secret operator-controlled `credentialRevision` that must change whenever the Jev API key, organization/account or privacy/billing scope changes. Include it in the internal profile policy-revision hash without hashing/logging the credential itself, and require the same revision in `TYPESAFE_VERIFICATION`.
- application envelope: at most 20 KiB
- configured input billing bound: 32,000 tokens unless fresh account/model evidence justifies a different conservative bound
- input price for the dated initial profile: 42,000 microdollars per million tokens ($0.042/M)
- output price for the dated initial profile: 0
- `maxOutputTokens: 1000` (the historical Jev profile bound; retain it as a conservative response-usage sanity bound even while output price is zero)
- retain a bounded response body (128 KiB) and product timeout (20 s unless testing shows a deliberate product change is required)

Recheck these values when preparing the live profile; documentation facts from 2026-10-19 are not a perpetual quote.

**Credential/account binding implementation:** Extend the server-only `profileSchema` with an optional bounded non-secret `credentialRevision` string. Preserve the exact existing OpenRouter `mail-broker` `policyRevision` hash input when this field is absent, so deploying Jev support does not stale current OpenRouter consent or lineage. Require a non-null revision for `jev-mail` and fold it into that Jev profile's `policyRevision` while keeping the raw credential and credential-env name out of the fingerprint/response exactly as today. Extend `TYPESAFE_VERIFICATION` with the same `credentialRevision`; keep parsing startup-compatible with any legacy verification object, but active Jev readiness must reject missing/mismatched credential revisions. `brokerPolicy` requires equality. Operator procedure must generate a new revision whenever the Jev key, organization/account or applicable ZDR/billing scope changes. This deliberately avoids hashing or logging the secret while preventing a normal credential rotation from silently reusing evidence for another account. Adding the `jev-mail` registry entry may advance a registry-wide revision, but it must not change the existing `mail-broker` per-profile revision.

**Jev envelope:** Reuse the reviewed J1/J2 shape: `state: { request: intent }`; one `Score` question per candidate (`m1…`), with candidate subject/from/receivedAt, at most 1,000 Unicode code points of body, and a clipped flag in structured instructions. Both request and candidate are explicitly untrusted data. Keep the four-level relevance rubric. Use new protocol revisions such as `jev-mail-relevance-score-v2`, `jev-mail-bounds-v2`, `jev-score-2-p75-v2`.

**Strict decoder:**

- Reject duplicate JSON object keys before normal parsing.
- Require the exact pinned response model.
- Require exactly one answer for every candidate key, no missing/foreign/duplicate key.
- Require `type:'score'`, finite score/confidence, exact legend matching the sent rubric, probabilities in `[0,1]` summing to 1 within a tight tolerance, and score equal to the probability-weighted level within tolerance.
- Parse usage independently enough that a trustworthy usage record can settle a known charge even when the answer/model is invalid. Compute `actualMicros = ceil(input_tokens * verifiedInputRate / 1_000_000)`; output is zero-cost only while the active verified profile says so.
- Selection is `score >= 2 && p2+p3 >= 0.75`; return normalized decisions in original candidate order. Do not persist raw provider responses.

**Transport:** Direct `fetch` to the fixed TypeSafe endpoint, bearer auth, JSON, `redirect:'error'`, one attempt only, AbortController timeout, bounded response. Do not use an SDK and do not honor the vendor's automatic 429/529 retry recommendation inside this workflow.

**Jev readiness:** Require all of the following before admission: configured `typesafe` profile + key; exact versioned model; current retention disclosure; fresh `TYPESAFE_VERIFICATION` bound to the exact profile revision **and matching credentialRevision**; current independent Jev consent; at least one label route usable through the selected alias; current quote within owner/request budgets; downstream destination ready. An individual retrieval still blocks when its actual request/source labels are not routed at both hops. `TYPESAFE_VERIFICATION` must represent fresh operator evidence that the actual account/path has the required ZDR/data-use terms, the complete serialized envelope fits both current Jev context limits (64k per request and 32k per question; the conservative ≤32k application bound is intended to satisfy both), and returned usage plus the configured price represent **all** billable components. If TypeSafe introduces request/question/output/surcharge fees that the existing `aiPricePolicySchema` cannot express, block Jev and extend accounting before proceeding.

**Tests:** fixed endpoint/no redirects/no retry; 20 KiB fit; Unicode clipping; exact model pin (aliases rejected); missing/foreign/duplicate answers; bad legend/probability/weighted score; oversized response; timeout/transport/non-success; missing usage; known invalid-output charge settlement only with authoritative account evidence; known overrun settlement + discarded selection under the same evidence; independent consent; stale/mismatched/expired account verification; credential/account revision change invalidates verification and consent binding; wrong adapter/key/profile; routing where Unlabeled remains ready while Personal is unavailable; per-request Personal blocking; downstream/budget blockers. No network calls.

**Suggested commit:** `feat(mail): add verified Jev broker adapter`

### Task 4: Pin broker identity into retrieval, admission, continuation and lineage

**Files:**

- Modify: `apps/api/src/ai/mail-broker.ts`, `broker-execution.ts`, `broker-lineage.ts`, `broker-workflow.ts`, `broker-policy.ts`
- Test: `apps/api/tests/mail-broker.test.ts`, `apps/api/tests/jev-mail-broker.test.ts`, `apps/api/tests/live-history.test.ts`

**New retrieval binding:** `beginBrokerRetrieval` reads `mail_broker_settings` inside the same repeatable policy snapshot and writes `limits.broker` containing at least:

`{ alias, adapter, selectorVersion, profileRevision, consentVersion, credentialRevision, verificationRevision, verificationDigest, rubricRevision, boundsRevision, thresholdRevision }`.

Do **not** add this dynamic object to `request_hash`, which remains `brokerDigest([input, trustedContext])` so an exact operation retry after a selector change still finds the original durable retrieval. Include the broker object in the sealed envelope/admission hash. `guardBrokerRetrieval` re-resolves the **same alias** and requires current selector version, profile/consent/account verification, routes and protocol revisions to equal the pinned values before any new broker send. Keep the existing Assistant `limits.settingsVersion` guard separate; `selectorVersion` is a new field, not a rename of the Personal-mail/Assistant settings version.

**Execution changes:** Resolve the adapter from the pinned selected profile before fitting/building a page. `reserveBatch` and the final pre-send guard compare adapter revisions dynamically rather than against the OpenRouter constants. Budget reservations use the selected broker alias/model; downstream holds remain OpenRouter/Assistant-owned. `executeBrokerBatch` invokes only the pinned adapter's preflight/exchange.

**Continuation/lineage:** Continuations require the original alias, `selectorVersion` **and the complete prior broker identity** (profile, consent, credential/account evidence, verification and rubric/bounds/threshold revisions) in addition to existing grant, agent and stable-boundary checks before opening the next window. A selector change invalidates unfinished retrievals and continuations; A→B→A does not revive them because the selector version is monotonic.

Completed conversation history is different: changing which classifier will handle **future** retrievals must not by itself erase already-bound history. Extend new `ForwardingBinding` JSON with a schema/version tag (for example `policyVersion: 2`) plus the original structured broker identity. `brokerLineageEligible` revalidates the forwarding's **original** alias/profile/consent/credential evidence/routes, current downstream authorization, grant and all judged sources including losers, without requiring that alias to still be the currently selected classifier. Revoking/changing the original broker policy withholds the history; merely selecting the other broker does not.

Preserve legacy forwarding compatibility explicitly. Existing bindings have only the opaque v1 `policy` digest. Add a legacy OpenRouter digest validator using the historical digest composition and accept it only when the associated batch revisions prove the current OpenRouter protocol and all normal source/grant/policy checks pass. New bindings use only the v2 structured identity; never rewrite old forwarding receipts.

**Legacy rule:** A retrieval created before `limits.broker` existed may never cause a new broker handoff. Uncertain/prepared legacy state remains a receipt. A completed legacy selection is history-eligible only if its stored profile/consent/verification plus rubric/bounds/threshold revisions prove the current OpenRouter adapter and all ordinary grant/source/policy checks still pass. Never infer legacy Jev from a moving model alias or current selector.

**Cross-adapter tests (mandatory):**

1. Prepare under OpenRouter, switch to Jev before send → zero provider handoff, unsent holds released, retrieval blocked.
2. Admit OpenRouter/mark uncertain, switch to Jev → no Jev handoff, original uncertain hold retained, retry/restart does not send.
3. Complete OpenRouter, bind its forwarding, switch to Jev → the old retrieval cannot continue or authorize a **new** Jev selection, while already-bound conversation history remains eligible only through revalidation of the original OpenRouter consent/profile/routes/sources.
4. Jev equivalents of 1–3.
5. Switch A→B→A → old A unfinished retrieval/continuation stays stale due selector version; a completed v2 forwarding remains governed by its original A policy rather than the current selector.
6. Same-adapter retry remains idempotent and sends once.
7. Broker switch does not change the downstream Assistant destination/model/reservation.
8. A historical Jev-shaped receipt and an OpenRouter-shaped receipt cannot pass each other's protocol revisions.
9. Revoke the original broker after a completed forwarding → history becomes ineligible even if another broker is selected and ready.
10. A pre-076 OpenRouter forwarding that matches the historical v1 digest can remain eligible; changing the digest algorithm alone does not invalidate it. A legacy uncertain/prepared receipt still cannot send.

**Suggested commit:** `feat(mail): bind retrievals to the selected broker`

### Task 5: Make Mail access expose and approve the selected broker

**Files:**

- Modify: `packages/contracts/src/mail-broker.ts`
- Modify: `apps/web/src/components/MailBrokerSettings.tsx`, `BrokerDestinationApproval.tsx`
- Modify: `docs/ui-agent-ledger.md`
- Test: `tests/e2e/mail-broker.spec.ts`

**Readiness contract:** Replace the OpenRouter-only destination shape with `{ alias, adapter: 'openrouter'|'typesafe', model, upstream: string|null }`; keep `endpointStatus:'unchecked'` because configured readiness does not prove a live paid endpoint. Add broker selector version/alias where useful to make stale UI state visible. Add owner-facing copy for `ACCOUNT_VERIFICATION_REQUIRED`.

**UI:** In Settings → AI → Mail access, add one concise **Mail classifier** selector with OpenRouter/Gemini and Jev choices. The selection save is versioned, online-only and has conflict reload. The displayed Broker destination approval component must use the selected alias from server state instead of hardcoding `mail-broker`; route text is OpenRouter + upstream for the current option and TypeSafe direct for Jev. Approval/revoke targets the selected alias and never mutates the other alias's consent. Keep grants below this section unchanged.

**Help copy:** Explain that changing the classifier changes which approved service judges eligible imported mail for **both owner asks and every mail-enabled agent**; it does not change the Assistant that receives selected mail. Unavailable selected classifier means the mail ask/run stops. Do not expose implementation-only receipt details.

**Browser tests:** OpenRouter→Jev→OpenRouter persistence; no consent inheritance; blocked Jev account-verification copy; approve/revoke selected alias; stale selection/consent conflicts; offline selector/approval disabled; existing grants remain unchanged; downstream Assistant display unchanged; keyboard/tap Help; axe/overflow at 1280 and 320 e-ink. Existing coverage/older-mail behavior stays green.

**Suggested commit:** `feat(web): choose and approve the mail classifier`

### Task 6: Extend synthetic quality tooling for Jev without weakening the paid-experiment guard

**Files:**

- Modify or factor: `scripts/prepare-mail-broker-evaluation.mjs`
- Create: `scripts/run-jev-mail-broker-evaluation.mjs` (prefer a separate explicit runner over an ambiguous provider flag)
- Reuse: `scripts/evaluate-mail-broker.mjs`, `tests/fixtures/mail-broker-evaluation.json`
- Test: `scripts/tests/mail-broker-evaluation.test.mjs`; create `scripts/tests/jev-mail-broker-runner.test.mjs`

The Jev preparation path must build the **production Jev envelope/decoder** from the same 60-case corpus, keep expected judgments out of sent artifacts, bind case ID + `corpusSha256` + exact request SHA-256 + model/rubric/bounds/threshold revisions, and remain network-free. Tighten `evaluate-mail-broker.mjs` so a receipt is scoreable only when those metadata fields match the current canonical corpus/adapter evaluation identity; `valid:true` plus corpus version alone is insufficient. The offline scorer can stay provider-neutral because it consumes selected keys.

The Jev live synthetic runner must be a separately authorized experiment only: bundled corpus only, `AI_SECRET_JEV` from process environment only, exclusive new journal directory, fsync admission before each send, explicit microdollar cap, dated verified quote, no mailbox/database/arbitrary file input, no automatic retry/resume after any uncertain admission, and metadata-only result/journal. Do not reuse the OpenRouter key, endpoint preflight or provider response decoder.

**Quality acceptance before private mail:** Freeze the Jev threshold first. Then require all 60 cases to produce confirmed/decodable outputs, zero uncertain/invalid cases, precision ≥ 0.90 and recall ≥ 0.90 for `directly_relevant`, and no accepted foreign/duplicate references. Record cost separately. The existing OpenRouter result (precision ~0.9434, recall 1.0) is a comparison point, not Jev evidence. If Jev fails, do **not** tune against these 60 cases and call the rerun an independent pass; create separate calibration material and retain a fresh holdout before changing the threshold.

**Suggested commit:** `test(mail): add Jev broker quality evaluation`

### Task 7: Documentation, configuration and upgrade compatibility

**Files:**

- Add/update authoritative multi-broker runtime documentation (prefer `docs/mail-broker.md`; mark `openrouter-mail-broker.md` and historical Jev docs appropriately rather than rewriting their receipts)
- Modify: `docs/product.md`, `docs/decisions.md`, `docs/backlog.md`, `docs/ui-agent-ledger.md`, `docs/implementation-log.md` when implementation is actually complete
- Modify deployment/operator documentation only after the code/config is ready
- Test: `apps/api/tests/upgrade.test.ts`, deployment/release-check tests

Document a secret-free `jev-mail` profile sample using the exact versioned model, direct TypeSafe adapter, conservative token bound, dated price and retention disclosure. Document that `TYPESAFE_VERIFICATION` is operator evidence, not something inferred from the public website or from credential presence. A profile change invalidates consent and requires a new synthetic quality gate before production enablement.

Populate the upgrade fixture with an owner grant plus prepared/uncertain/completed broker rows, reservations, forwarding and turn summaries before migration 076. After upgrade assert: old rows/holds/selected IDs remain unchanged, no Jev consent/selection is invented, the default selector is OpenRouter/version 1, no legacy uncertain batch becomes resendable, and old policy lineage cannot cross adapters.

`apps/api/tests/upgrade.test.ts` is PGlite-only today, so PostgreSQL coverage must be made real rather than claimed indirectly. Create `apps/api/tests/mail-broker-upgrade-postgres.test.ts` using `TEST_DATABASE_URL` + a disposable schema (or refactor the populated upgrade harness to accept `TEST_DATABASE_URL`) and add that exact test to the PostgreSQL CI command in `.github/workflows/ci.yml`. The PostgreSQL case must exercise migration 076 with populated broker rows and drop its disposable schema afterward.

**Suggested commit:** `docs(mail): document selectable broker operation`

### Task 8: Complete code qualification before any live configuration

Run sequentially on the finished code tree:

1. Focused broker/API/evaluation suites through the root test script so contracts build first:

   `npm test -- apps/api/tests/mail-broker.test.ts apps/api/tests/jev-mail-broker.test.ts apps/api/tests/live-history.test.ts apps/api/tests/upgrade.test.ts scripts/tests/mail-broker-evaluation.test.mjs scripts/tests/mail-broker-runner.test.mjs scripts/tests/jev-mail-broker-runner.test.mjs`

   Then run the new PostgreSQL populated-upgrade test against a fresh disposable `TEST_DATABASE_URL` (or through the exact CI job added in Task 7).
2. `npx playwright test tests/e2e/mail-broker.spec.ts`.
3. `npm run check` (lint, all workspace types, Vitest, formatting, production builds).
4. `npm run test:e2e` sequentially.
5. Linux + Windows + disposable PostgreSQL CI. Do not waive the PostgreSQL path because selection/migration/admission state is durable policy.
6. Re-run restart/no-resend, competing claim and agent lease/cap focused cases after the final adapter changes, even if the broad suite already contains them.
7. `git diff --check` and an independent code/security review focused on cross-adapter receipt isolation and billing settlement.

No real provider call belongs in this task. A green code suite proves enforcement with fake transports, not current Jev quality/account privacy.

### Task 9: Separately gated live enablement and acceptance

These are operator/owner gates after the implementation has passed Task 8. Each paid/private step needs explicit authorization at that time.

1. **Reverify TypeSafe current facts:** exact `/v1/systemone` contract, pinned version availability/entitlement, Score wire shape, current price and every billable component, account quota/credits, error/lost-response semantics. Keep direct HTTP/no retries even though vendor docs recommend retrying 429/529.
2. **Establish account-specific privacy evidence:** confirm the actual credential/account's ZDR/retention/data-use/log/cache terms and expiration; create a fresh `TYPESAFE_VERIFICATION` bound to the exact public profile revision. Public “no training” language alone is insufficient.
3. **Run the separately authorized 60-case Jev synthetic evaluation** under its explicit cap. Stop on uncertainty. Require the quality gate above.
4. **Install Jev enabled/configured but unselected and unapproved**, with its secret and non-secret `credentialRevision` provisioned privately; deploy through normal sealed release/preflight/backup/restore gates while the selector remains `mail-broker`. `enabled:false` is not an intermediate approval state because enabling later changes the policy fingerprint. Before any Jev approval, verify the installed profile revision + credential revision match the account-evidence record and the synthetic-evaluation identity.
5. **Owner approval/routing:** explicitly approve `jev-mail`, allow only intended labels, then select Jev in Mail access. Do not change Restricted routing. Confirm `$0` new holds before the canary.
6. **Bounded owner canary:** narrow the existing owner mail grant to an agreed connector/date window, make one owner Use-mail ask, inspect coverage/usefulness/cost/holds, and confirm no retry on browser timeout or uncertain provider state. Do not expand the grant from a successful technical result alone.
7. **Switch-back check:** select OpenRouter again and verify a prior Jev retrieval cannot be continued/resent under OpenRouter and no Jev consent is revoked implicitly.
8. **Agent canary only after owner usefulness acceptance:** one mail-enabled agent under Ask first, bounded cap/grant, verify lease/no-fallback/accounting/notification behavior. Automatic actions remain a separate authority choice.
9. Record deployment/live receipts without private mail, answer text, credentials, session IDs or internal provider request IDs.

## Required handoff result

An implementation agent should finish with all of the following true:

- OpenRouter remains the default and passes its existing behavior/tests unchanged.
- Jev is selectable only through versioned owner state and has independent provider consent/routing/account evidence.
- New retrievals are immutably bound to exactly one broker adapter/policy revision before send.
- Cross-adapter switching can block/invalidate, but can never replay/reinterpret/resend an old batch.
- Both adapters share the same grants, source/provenance checks, downstream hold, budgets, lineage, continuations and agent fencing.
- Jev transport is direct, single-attempt, bounded and strictly decoded; trusted known charges settle even when selection is discarded.
- UI clearly separates classifier choice from receiving Assistant choice and works offline/conflict/a11y at standard and 320px e-ink sizes.
- Synthetic Jev quality is independently demonstrated before any private mail disclosure.
- Live private-mail use remains blocked until fresh account-specific ZDR and billing evidence is installed and owner-approved.
