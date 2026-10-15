# Live context admission, boundary 1: containment and reusable binding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every live OpenRouter exchange (Assistant asks, agent runs, mail rounds, mail category and task suggestions) is sent only to an owner-approved pinned destination, as exact sealed bytes whose sources were resolved in one snapshot, recorded in a per-exchange manifest and revalidated immediately before transmission. Only bound history (turns answered under this boundary, with their transitive sources) is resent; legacy history is withheld, and mail-derived proposals stay read-only.

**Architecture:** A server-only versioned live manifest binds each exchange (owner, request, round, destination, settings revision, bound history, projected sources with private digests, inherited labels). Call sites build the manifest and the request body in one `REPEATABLE READ READ ONLY` snapshot, seal the body into bytes once, and persist the binding in the same transaction as the existing uncertain reservation (`admitLive`). `transmitLive` runs a short, lock-free verification transaction that re-resolves everything in the manifest, then hands the sealed bytes to `exchange`. A failed guard releases the hold, because `fetch` was never called, and is never resent. The destination is a server-declared OpenRouter model + single upstream that the owner approves with one click in Settings (`ai_live_destinations`). An absent, stale or unavailable approval blocks the request.

> **Revision 2026-10-15 (owner decisions):** destination approval is one click in Settings over a server-declared host list (no `AI_PROVIDER_PROFILES`, consent or routing changes); new turns bind their history now instead of waiting for boundary 2. Plan decisions 2–6, Tasks 1, 3, 6, 8–10 and the owner-visible changes below reflect this.

**Tech Stack:** Fastify, PGlite (dev/test) / PostgreSQL (prod), Zod contracts, React 19/Vite, Vitest, Playwright.

**Spec:** [docs/live-context-admission-design.md](../../live-context-admission-design.md) (delivery boundary 1 only); program context [docs/post-agents-development-plan.md](../../post-agents-development-plan.md) §B1/B2 and "Decisions to resolve" item 3.

## Global Constraints

Implementation checkpoint (2026-10-15): Tasks 1–9 now have implementation in the development worktree; final validation and receipts remain in progress. Migration 060 is committed; append-only migration 061 preserves destination versions through revocation. Independent review added serialized-route checks, exact response models, inherited-history eligibility, retained-text verification, revocation-version safety, and deleted-conversation handling. The detailed checkboxes below remain the original proposed workflow, not assertions that each intermediate command or commit ran. Full P5/P6 output lineage remains boundary 2.

- Migrations are append-only: add `060_live_context_admission.sql`; never edit 001–059.
- Tests inject `OpenRouterFetch` (helpers in `apps/api/tests/helpers/openrouter.ts`, `vi.stubGlobal('fetch', …throw…)`); no real provider, paid AI request or owner database.
- Private values (`integrity_hash`, per-source `digest`) never appear in HTTP responses, export, UI, logs or notifications. `ai_live_exchanges` is not exported.
- The manifest and receipts store no prompt, mail text, reply, credential or cookie: only IDs, versions, labels, projection names, ref names, counts, truncation flags and private digests.
- Projections stay exactly as now: task `{ref,title,dueDate,priority}`; event `{ref,title,allDay?,start,end}`; mail header `{ref,from,subject,received}`; mail body cut to `bodyLimit` = 6000 characters. The limits are 150 tasks, 150 events, 20 hits, 5 bodies and 3 rounds. No notes, recipients or other fields are added.
- Operation hashes in `answerTurn`, `mail-classify` and `mail-task-suggest` are computed exactly as now (replay compatibility).
- Serialization happens once in `sealEnvelope`; `exchange` sends `sealed.bytes` unchanged. No call site builds or edits a body after sealing.
- No network I/O inside a database transaction. The guard transaction acquires no budget, conversation, planner or source locks.
- A hold is released only when `fetch` was never called for that exchange. Any error after `fetch` is invoked stays `uncertain`. Nothing is ever resent automatically.
- General gateway dispatch stays disabled (`dispatchEnabled: false`); the live path does not use it.
- Restricted mail is never sent. Personal mail requires `allowPersonalMail` (the existing consent) and an approved destination. The live namespace is separate from general gateway aliases/routing, which stay untouched.
- Preserve Pause-finish-running, lease fencing, migration 058 per-exchange agent reservations and the no-resend rule for uncertain outcomes.
- Academic, memory and MCP context stay excluded. No intermediate PR claims full P5/P6 enforcement.
- Interface copy: concise labels; explanations in keyboard/tap-accessible Help; blocked, pending, offline and conflict states stay visible.
- Run `npm run check` before each commit. Run `npm run test:e2e` for PR 2. The PR 1 race test must actually run against disposable PostgreSQL (`TEST_DATABASE_URL`); a skipped run is not a receipt.

### Plan decisions (making the spec's open choices; confirm in review)

1. **Single pinned upstream.** Each destination is exactly one model plus one upstream. Requests use `provider: { only: [upstream], order: [upstream], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true }`. The multi-host `providerRouting` allowlist is deleted. A bounded upstream set is deferred.
2. **Server-declared destinations.** The server declares the candidates: the existing `hosts` table in `openrouter-live.ts` (`hostsFor(model)`) for any well-formed model ID from a supported author, under a server constant `liveTermsRevision = 'openrouter-zdr-v1'` (intermediary OpenRouter, ZDR only, `data_collection: 'deny'`, no fallbacks). `destinationRevision = sha256(JSON.stringify(['openrouter', model, upstream, liveTermsRevision]))`. Changing the constant or the host table invalidates approvals whose upstream is no longer declared. Pricing still comes from the catalog and `worstCaseMicros`. ZDR availability for the pinned upstream is checked at send time (`hasPrivateHost(model, upstream)`), so an approved upstream without a ZDR endpoint blocks with no fallback.
3. **One-click owner approval** (owner decision). New table `ai_live_destinations(owner_id PK, model, upstream, revision, version, approved_at)`. `PUT /api/v1/assistant/destination {model, upstream, expectedVersion, operationId}` approves, and in the same transaction sets `ai_assistant_settings.model = model` (bumping its version) so request receipts keep reporting the model actually used. `DELETE /api/v1/assistant/destination?expectedVersion=` revokes. Nothing is pre-approved: the destination is ready only if a row exists, `row.model === settings.model`, `row.upstream ∈ hostsFor(model)` and `row.revision` equals the current computed revision. The existing model picker merges into this panel; `PUT /assistant/settings` with a different model leaves the approval stale (blocked) until re-approved. General gateway aliases, consents and routing rules are not consulted or changed.
4. **Allowed labels.** The approved destination may receive `unlabeled` sources, plus `personal` when `allowPersonalMail` is on. Restricted never. The manifest binds `settingsVersion` (covers `allowPersonalMail`/`useMail`/model) and `destination.version`/`revision`. The guard returns `route-blocked` when the destination row changed, was revoked or no longer matches the settings model, and `context-changed` for a settings-only change.
5. **Mail eligibility is unchanged:** not Restricted, Personal only with `allowPersonalMail`, verified body origin. There is no separate Personal routing rule; the existing switch is the Personal consent for the approved destination.
6. **Bound history now** (owner decision). Turn columns `inference_history ('unbound'|'bound')`, `inference_digest` and `inference_sources`. `finishTurn` marks a turn `bound` only if its kept reply came from a `verified` exchange E: `inference_digest = sha256(owner, turnId, ask, reply)`, and `inference_sources` is the deduplicated union of E's manifest `sources` and `history.sources` as `{kind,id,labels,connector?}` refs (transitive by construction), capped at `maxHistorySources = 1000` (over the cap → `unbound`). Legacy turns stay `unbound`. At ask time `readBoundHistory` walks the conversation newest → oldest within the existing `historyTurns`/`historyChars` limits and stops at the first turn that is unbound, has no reply, overflows the union or has an ineligible source (deleted, labels changed or outside the allowed set, connector version changed, or a mail source while this ask has Use mail off). The manifest records `history: { turns: [{id, digest}], sources: [...refs], withheld: n }`; the guard rechecks each history turn's digest and conversation, and each history source's eligibility (not its content digest: an ordinary edit does not invalidate history; deletion, relabeling, connector change or Use mail off does).
7. **Read-only source-derived proposals.** A turn that sent any mail header or body saves `proposal_access = 'read-only'`. Migration 060 marks existing turns with non-empty `mail` the same way. Owner Apply is hidden, `PUT …/items` rejects any transition to `applied`, and agents never auto-apply them. Owner Apply remains client-composed until boundary 2, so planner endpoints still accept ordinary owner writes.
8. **Identifiable legacy derived records are withheld** (approved default "unknown derived records blocked", where identifiable). Live planner context excludes tasks and events whose ID appears as `items[].applied.id` on any turn with non-empty `mail`. Records from deleted conversations (items cleared) cannot be identified; boundary 2's eligibility marker covers them.
9. **Guard linearization and locks.** The guard is a `REPEATABLE READ` transaction whose first statement establishes the snapshot (the linearization point). It reads without `FOR UPDATE`/`FOR SHARE`. Its only writes are its own `ai_live_exchanges` row (`guard_state='verified'`) and, for agents, its own run row (`progress_stage='provider-request'`), in that order. A serialization failure counts as `context-changed`. Release of a blocked hold is a separate transaction using the existing order: budget → `ai_assistant_requests` → `ai_live_exchanges`. Neither ordering intersects agent completion (runs → turns → action policy → planner rows → responsibilities), so no cycle exists.
10. **Owner authority at the guard.** The guard checks that the owner row exists. HTTP-initiated exchanges also re-run `auth.currentUser(request, tx)` through an injected `authority` callback, so signing out blocks the send. Agent exchanges check the run lease and agent eligibility instead.
11. **Agents.** Agent checks in `ownedFetch` (status, labels, goal) move into the guard, so a failed check releases the hold instead of becoming `uncertain/transport`. Paused agents still send (Pause-finish-running). `ownedFetch` keeps `requireLease` + `progress('checking-provider')` for catalog URLs only. A guard result of `context-changed` requeues once, like `rate-limited`, because nothing was sent. `route-blocked` fails with `ASSISTANT_ROUTE_UNAVAILABLE`.
12. **All four live call sites connect in boundary 1:** Assistant first call, Assistant mail rounds, `mail-classify` and `mail-task-suggest`. Mail task suggestions already persist origin (`mail_task_sources`, migration 052), so their Accept flow is unchanged.
13. **Planner projection adapter.** A batch adapter reuses the existing `openTask`/`openEvent` predicates plus `plannerSensitivity`/`plannerTextIsAttachmentDerived` instead of 300 `resolveAIContext` calls. A parity test pins it to `resolveAIContext`. Mail sources use `resolveAIContext` per message (≤ 25).
14. **New request reasons.** The new reasons are `context-changed` and `route-blocked`. Status is `failed`, the reservation is `released` with `actual_micros = 0`, and cost is 0.

### Owner-visible changes (to report)

1. The Assistant, agents, mail category suggestions and mail task suggestions are **blocked until the owner approves a destination** with one click in Settings › AI › Assistant (model + host, then Approve). No server configuration change. Until then asks fail before any hold with a visible reason, and agent runs fail with `ASSISTANT_ROUTE_UNSET`/`ASSISTANT_ROUTE_UNAVAILABLE`.
2. Requests go to **one pinned host** (for example `google-vertex`) instead of the model author's host list. If that host lacks a zero-retention endpoint, requests block instead of using another host.
3. The **model picker becomes the Destination panel**: model, host, Approve. Changing the model needs a new approval.
4. **Messages from before this release are not sent** with new asks; follow-ups in conversations started afterwards keep working. A short note in older conversations offers New conversation.
5. **Proposals from turns that read mail are read-only**, including existing unapplied ones. Agents leave them for review instead of applying them.
6. **Tasks and events previously applied from mail-reading turns are left out** of Assistant context and counted in "items left out".
7. A follow-up drops earlier messages that depended on mail when Use mail is off, or on a record since deleted or relabeled.
8. If a source changes or the owner signs out between preparation and sending, the exchange stops with "Nothing was sent" and no charge. A first-call stop fails the ask; a later round keeps the earlier answer with a mail note.

## Review Focus

1. **Owner edits a task while a Use-mail ask is between rounds 1 and 2.** Expected: round 2 is withheld with no charge, the round-1 answer is kept and a mail note explains. Test in Task 6.
2. **A follow-up after a Personal-mail answer, with Use mail turned off.** Expected: the earlier mail-dependent turn (and every turn before it) is withheld from the follow-up; a non-mail earlier turn after it is not resent either, because history stops at the first ineligible turn. Test in Task 6.
3. **Server restart after admission or after transmission.** Expected: the hold stays `uncertain`, the operation replays to the same turn, and no exchange is resent. Test in Task 5.
4. **Owner pauses vs edits an agent during its run.** Expected: a pause still sends and saves; a goal edit or relabel withholds the send and releases the hold. Test in Task 7.
5. **Approved host has no ZDR endpoint, or the model changes after approval.** Expected: block (`ASSISTANT_MODEL_NOT_PRIVATE` / `ASSISTANT_ROUTE_UNAVAILABLE`) with no fallback to another declared host. Test in Task 3.

---

## PR split

- **PR 1, foundation (unused by call sites):** Tasks 1–5. Ships migration 060, contracts, sealed transport, destination resolution and status endpoint, projections/manifest, admission binding and guard. Existing call sites keep working through a temporary `exchangeLegacy` path, which PR 3 removes.
- **PR 2, Assistant and agents:** Tasks 6–8, including the UI. Asks and agents block until a destination is approved, so this is the owner-visible change.
- **PR 3, mail call sites, cleanup and claim:** Tasks 9–10. It deletes `exchangeLegacy`/`providerRouting` and records that all live call sites are connected.

---

### Task 1: Migration 060 and contracts

**Files:**

- Create: `apps/api/migrations/060_live_context_admission.sql`
- Modify: `packages/contracts/src/assistant.ts`, `apps/api/src/features/assistant-conversations.ts` (conversation delete clears binding columns)
- Test: `apps/api/tests/upgrade.test.ts`, `apps/api/tests/ai-schemas.test.ts`

**Interfaces:**

- Produces (SQL):
  - `ALTER TABLE ai_assistant_requests ADD CONSTRAINT ai_assistant_requests_owner_id_key UNIQUE (owner_id,id)`. Replace `ai_assistant_requests_reason_check` with the old list plus `'context-changed','route-blocked'`.
  - `CREATE TABLE ai_live_exchanges (request_id uuid PRIMARY KEY, owner_id uuid NOT NULL, format_version smallint NOT NULL CHECK (format_version = 1), manifest jsonb NOT NULL, integrity_hash text NOT NULL CHECK (integrity_hash ~ '^[a-f0-9]{64}$'), destination_revision text NOT NULL CHECK (destination_revision ~ '^[a-f0-9]{64}$'), source_count integer NOT NULL CHECK (source_count BETWEEN 0 AND 350), guard_state text NOT NULL DEFAULT 'admitted' CHECK (guard_state IN ('admitted','verified','blocked')), guarded_at timestamptz, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (owner_id, request_id) REFERENCES ai_assistant_requests(owner_id, id), CHECK ((guard_state = 'admitted') = (guarded_at IS NULL)))`.
  - `CREATE TABLE ai_live_destinations (owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, model text NOT NULL CHECK (model ~ '^[a-z0-9][a-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$' AND length(model) <= 100), upstream text NOT NULL CHECK (upstream ~ '^[a-z][a-z0-9-]{0,47}$'), revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'), version integer NOT NULL CHECK (version > 0), approved_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`. It is not exported (approval is not portable owner data).
  - `ai_conversation_turns` adds `inference_history text NOT NULL DEFAULT 'unbound' CHECK (IN ('unbound','bound'))`, `inference_digest text CHECK (~ '^[a-f0-9]{64}$')`, `inference_sources jsonb CHECK (jsonb_typeof = 'array' AND jsonb_array_length <= 1000)` with `CHECK ((inference_history = 'bound') = (inference_digest IS NOT NULL AND inference_sources IS NOT NULL))`, and `proposal_access text NOT NULL DEFAULT 'applicable' CHECK (IN ('applicable','read-only'))`, then `UPDATE … SET proposal_access='read-only' WHERE jsonb_array_length(mail) > 0`. Conversation deletion clears `inference_digest`/`inference_sources` and resets `inference_history='unbound'` together with the text it already clears.
- Produces (contracts):
  - `assistantReasonSchema` adds `'context-changed'` and `'route-blocked'`.
  - `assistantTurnSchema` adds `inferenceHistory: z.enum(['unbound','bound']).default('unbound')` and `proposalAccess: z.enum(['applicable','read-only']).default('applicable')`. Digests and sources are never in the contract.
  - `assistantMailSentSchema` adds `truncated: z.boolean().default(false)`.
  - `liveDestinationStatusSchema = z.object({ status: z.enum(['ready','blocked']), reason: z.enum(['key-missing','approval-required','approval-stale','model-unsupported']).nullable(), approved: z.object({ model, upstream }).nullable(), model: assistantModelSchema /* current settings model */, hosts: z.array(z.string()) /* declared for that model */, personalMail: z.boolean(), version: z.number().int().nonnegative() /* 0 = never approved */ })`. `reason` is null exactly when `status` is `'ready'`.
  - `liveDestinationApproveSchema = z.strictObject({ model, upstream: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), expectedVersion: z.number().int().nonnegative(), operationId: uuid.optional() })`.

- [ ] **Step 1: Write failing tests**
  - `upgrade.test.ts › upgrades populated assistant turns and requests through 060 without rewriting them`: before 060, seed one turn with `mail='[{…}]'` and one without, plus one completed request. After migrating, `ask/reply/proposals/items/mail` are byte-identical. The mail turn has `proposal_access='read-only'` and the other `'applicable'`. Both have `inference_history='unbound'` and null digest/sources. Setting `inference_history='bound'` without a digest fails the CHECK. Inserting a request with `reason='context-changed'` succeeds; `reason='nope'` fails the CHECK. Inserting an `ai_live_exchanges` row for another owner's request fails the FK.
  - `ai-schemas.test.ts › destination status requires a reason when blocked` and rejects an upstream with `/`.
- [ ] **Step 2: Run** `npx vitest run upgrade ai-schemas`. Expected: FAIL (no 060, no export).
- [ ] **Step 3: Write migration 060 and the contract changes.** Drop the reason CHECK by its default name, as 053 does for its constraints.
- [ ] **Step 4: Run the same tests, then `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): migration 060 and live admission contracts`

### Task 2: Sealed envelopes and pinned transport

**Files:**

- Create: `apps/api/src/ai/live-envelope.ts`
- Modify: `apps/api/src/ai/openrouter-live.ts`, `apps/api/src/ai/context-binding.ts`
- Test: `apps/api/tests/live-admission.test.ts` (new)

**Interfaces:**

- Produces:
  - `type SealedEnvelope = Readonly<{ requestId: string; owner: string; bytes: string; model: string; maxTokens: number; manifest: LiveManifest; integrityHash: string }>`. `LiveManifest` comes from Task 4; until then Task 2 uses `unknown` and Task 4 narrows it.
  - `sealEnvelope(owner: string, requestId: string, body: { model: string; max_tokens: number }, manifest: LiveManifest): SealedEnvelope`. It runs `JSON.stringify` once, computes `integrityHash = boundLiveHash(owner, requestId, bytes, manifest)` and returns `Object.freeze`d output.
  - `boundLiveHash(owner, requestId, bytes, manifest): string` in `context-binding.ts`: sha256 of `JSON.stringify([owner, requestId, bytes, manifest])`, the same pattern as `boundAIContextHash`.
  - `pinnedRouting(upstream: string)` returns `{ only: [upstream], order: [upstream], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true }`.
  - `hasPrivateHost(fetcher, model, upstream: string, now?)`: true only for a ZDR endpoint with `model_id === model`, `tag.split('/')[0] === upstream`, `upstream ∈ hostsFor(model)` and `structured_outputs`. The cached list stores `model → Set<upstream>`.
  - `liveTermsRevision = 'openrouter-zdr-v1'` and `destinationRevision(model, upstream)` (Plan decision 2).
  - `exchange(fetcher, key, sealed: SealedEnvelope, timeoutMs = 45000): Promise<ExchangeResult>`. It sends `body: sealed.bytes` and decodes with `sealed.model`/`sealed.maxTokens`. The old object-body function is renamed `exchangeLegacy` (unchanged behavior) for the unconverted call sites until PR 3.

- [ ] **Step 1: Write failing tests** in `live-admission.test.ts`
  - `exchange sends the sealed bytes exactly`: seal a body, then mutate the original object after sealing. The fetcher captures `init.body`, and it `===` `sealed.bytes`, which does not contain the mutation.
  - `sealed envelopes are frozen and the hash binds bytes and manifest`: `Object.isFrozen(sealed)`. Recomputing `boundLiveHash` with one changed byte or a manifest with reordered `sources` yields a different hash.
  - `pinnedRouting pins one upstream without fallback`: `pinnedRouting('google-vertex')` deep-equals the object above.
  - `hasPrivateHost checks the pinned upstream`: with ZDR tag `google-vertex/global`, `(model,'google-vertex')` is true and `(model,'anthropic')` is false. A tag `azure/x` for an anthropic model is false.
  - `destinationRevision binds model, upstream and terms`: changing any of the three changes the revision.
- [ ] **Step 2: Run** `npx vitest run live-admission`. Expected: FAIL.
- [ ] **Step 3: Implement.** The legacy `prepareLive` keeps the old multi-host check through `hasAnyPrivateHost` (the old function, renamed), and unconverted call sites use `exchangeLegacy`, until Task 9.
- [ ] **Step 4: Run** `npx vitest run live-admission assistant mail-classify mail-task-suggest`, then `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): sealed live envelopes and pinned OpenRouter routing`

### Task 3: Live destination resolution and status

**Files:**

- Create: `apps/api/src/ai/live-destination.ts`
- Modify: `apps/api/src/features/assistant.ts` (register `GET`/`PUT`/`DELETE /api/v1/assistant/destination`)
- Modify: `apps/api/tests/helpers/openrouter.ts` (`approveLiveDestination`)
- Test: `apps/api/tests/live-destination.test.ts` (new)

**Interfaces:**

- Consumes: `liveDestinationStatusSchema`, `liveDestinationApproveSchema` (Task 1); `hostsFor`, `destinationRevision` (Task 2); `readAssistantSettings`.
- Produces:
  - `type LiveDestination = { model: string; upstream: string; revision: string; version: number }`.
  - `liveAllowedLabels(settings): Sensitivity[]` returns `['unlabeled']` plus `'personal'` when `allowPersonalMail`.
  - `readLiveDestination(tx, config, owner): Promise<{ status: LiveDestinationStatus; destination: LiveDestination | null }>` applies Plan decision 3. Reasons: `key-missing` (no `AI_SECRET_OPENROUTER`), `model-unsupported` (`hostsFor(settings.model)` null), `approval-required` (no row), `approval-stale` (row model ≠ settings model, upstream no longer declared, or revision mismatch).
  - `resolveLiveDestination(tx, config, owner): Promise<LiveDestination>` throws `409 ASSISTANT_NOT_CONFIGURED` for `key-missing`, `409 ASSISTANT_MODEL_UNSUPPORTED` for `model-unsupported`, `409 ASSISTANT_ROUTE_UNSET` "Approve a destination in Settings › AI › Assistant." for `approval-required`, and `409 ASSISTANT_ROUTE_UNAVAILABLE` "The approved destination changed. Approve it again in Settings › AI › Assistant." for `approval-stale`.
  - `GET /api/v1/assistant/destination` (owner-authorized, read-only) returns the parsed status.
  - `PUT /api/v1/assistant/destination` (owner-authorized, `liveDestinationApproveSchema`): `upstream ∈ hostsFor(model)` else `400 DESTINATION_UNDECLARED`; a version mismatch gives `409 VERSION_CONFLICT`. In one transaction it upserts the row (`version+1`, new revision, `approved_at=now`) and saves `ai_assistant_settings.model` (version bump; other settings unchanged). Returns the status.
  - `DELETE /api/v1/assistant/destination?expectedVersion=n` revokes: deletes the row and returns the blocked status. A missing row is idempotent.
  - Test helper: `approveLiveDestination(app, cookie, { model?, upstream? = 'google-vertex' }): Promise<void>` calls GET then PUT.

- [ ] **Step 1: Write failing tests** in `live-destination.test.ts`
  - `blocks until approved`: with a key and no row, status is `{status:'blocked',reason:'approval-required',version:0}`, `hosts` equals `hostsFor(model)`, and `resolveLiveDestination` throws `ASSISTANT_ROUTE_UNSET`. After `approveLiveDestination` the status is `ready` with `approved:{model,upstream:'google-vertex'}`.
  - `rejects undeclared hosts`: PUT `upstream:'azure'` for an anthropic model gives 400 `DESTINATION_UNDECLARED`; no row is written.
  - `a model change makes the approval stale`: approve, then PUT `/assistant/settings` with another model. Status is `approval-stale` and resolve throws `ASSISTANT_ROUTE_UNAVAILABLE` (no fallback). Re-approving restores `ready`.
  - `a terms revision change makes the approval stale`: overwrite the row's `revision` with another hex value, giving `approval-stale`.
  - `revoke blocks`: DELETE gives `approval-required`.
  - `approval saves the model and checks the version`: PUT with `model:'openai/gpt-5'`, `upstream:'azure'` sets the settings model; a stale `expectedVersion` gives 409.
  - `personalMail follows the existing switch`.
  - `requires a session`: GET/PUT/DELETE without a cookie give 401, and no response contains `revision`, `integrity` or `AI_SECRET`.
- [ ] **Step 2: Run** `npx vitest run live-destination`. Expected: FAIL.
- [ ] **Step 3: Implement.** The status never returns `revision`.
- [ ] **Step 4: Run** the test, then `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): one-click owner approval of the live destination`

### Task 4: Live projections and manifest

**Files:**

- Create: `apps/api/src/ai/live-manifest.ts`, `apps/api/src/ai/live-projections.ts`
- Modify: `apps/api/src/features/assistant.ts` (move `readContext` and the task/event payload mapping into `live-projections.ts`; `buildAssistantRequest` calls the projectors), `apps/api/src/features/assistant-mail.ts` (identity on hits)
- Test: `apps/api/tests/live-admission.test.ts`

**Interfaces:**

- Produces (`live-manifest.ts`, server-only, not in contracts):
  - `liveProjectionSchema = z.enum(['planner-task-v1','planner-event-v1','mail-header-v1','mail-body-v1','mail-classify-v1','mail-task-v1'])`.
  - `liveSourceSchema = z.strictObject({ projection, kind: z.enum(['task','event','mail-message']), id: uuid, version: posInt, ref: z.string().max(10), labels: z.array(sensitivitySchema).min(1).max(3), connector: z.strictObject({ id: uuid, version: posInt }).optional(), truncated: z.boolean().optional(), digest: sha256Hex })`.
  - `liveManifestSchema = z.strictObject({ formatVersion: z.literal(1), owner: uuid, requestId: uuid, kind: z.enum(['planner','planner-round','mail-classify','mail-tasks']), round: z.number().int().min(1).max(3), conversationId: uuid.nullable(), priorRequestIds: z.array(uuid).max(2), destination: z.strictObject({ model, upstream, revision: sha256Hex, version: posInt }), settingsVersion: posInt, request: z.strictObject({ provenance: z.enum(['owner-entered','agent-goal','none']), labels: z.array(sensitivitySchema).min(1).max(3), agent: z.strictObject({ id: uuid, goalDigest: sha256Hex }).optional() }), timeZone: z.string().nullable(), history: z.strictObject({ turns: z.array(z.strictObject({ id: uuid, digest: sha256Hex })).max(historyTurns), sources: z.array(liveHistorySourceSchema).max(1000), withheld: z.number().int().nonnegative() }), sources: z.array(liveSourceSchema).max(350), bytes: z.number().int().positive() })`. A refine requires unique `(projection,id)` pairs.
  - `liveHistorySourceSchema = z.strictObject({ kind: z.enum(['task','event','mail-message']), id: uuid, labels: z.array(sensitivitySchema).min(1).max(3), connector: z.strictObject({ id: uuid, version: posInt }).optional() })`: identity and labels only, no digest.
  - `maxLiveSources = 350`, `maxHistorySources = 1000`.
  - `historyRefs(manifest): LiveHistorySource[]`: the deduplicated union of `sources` (digest/projection dropped) and `history.sources`, as stored on a bound turn.
  - `sourceDigest(owner, requestId, projection, id, projected: unknown): string`: sha256 of `JSON.stringify([owner, requestId, projection, id, projected])`.
- Produces (`live-projections.ts`):
  - `projectTask(task: Task, ref: string)` and `projectEvent(event: CalendarRecord, ref: string, timeZone: string)` return exactly today's payload objects.
  - `livePlannerContext(tx, owner, select: { limit: 150 } | { tasks: string[]; events: string[] }): Promise<{ tasks: Task[]; events: CalendarRecord[]; withheld: number }>`. It applies today's queries and `openTask`/`openEvent`, plus the exclusion from Plan decision 8: `id NOT IN (SELECT (i->'applied'->>'id')::uuid FROM ai_conversation_turns t, jsonb_array_elements(t.items) i WHERE t.owner_id=$1 AND jsonb_array_length(t.mail)>0 AND jsonb_typeof(i->'applied')='object')`. Excluded rows count in `withheld`. The `{tasks,events}` form returns only still-eligible rows, for the guard.
  - `plannerSources(owner, requestId, context, timeZone): LiveSource[]` (refs `t1…`, `e1…`, labels `['unlabeled']`).
  - `mailSources(tx, owner, requestId, projection, items: { id: string; version: number; ref: string; projected: unknown; truncated?: boolean }[]): Promise<LiveSource[]>`. It calls `resolveAIContext(tx, owner, { kind: 'mail-message', id, expectedVersion: version })` and takes `labels`/`mailConnector` from it.
- Modifies: `MailHit` adds `version: number`. `readMail` results add `version` and `truncated: boolean`.

- [ ] **Step 1: Write failing tests**
  - `planner adapter matches resolveAIContext`: seed unlabeled, Personal, mail-sourced, academic-sourced, Canvas-sourced, course-linked event and recurring event fixtures. Every task/event `livePlannerContext({limit:150})` returns resolves through `resolveAIContext` with `labels` `['unlabeled']` and `attachmentDerived` false. Every fixture it omits is counted in `withheld`.
  - `withholds records applied from mail-reading turns`: insert a turn with `mail='[{…}]'` whose `items[0].applied.id` is task T. T is absent and `withheld` grows by 1. The same task applied from a turn with `mail='[]'` is present.
  - `projections are unchanged`: `buildAssistantRequest` output for a fixed context and `now` deep-equals a snapshot taken before the refactor (inline expected JSON for one task, one timed event and one all-day event).
  - `mail sources carry connector identity and complete labels`: a Personal-connector, unlabeled-message hit yields `labels:['personal']` and `connector:{id,version}`. A message with `text_origin` null throws `PROVENANCE_UNAVAILABLE`.
  - `manifest rejects overflow and duplicates`: 351 sources or a duplicate `(projection,id)` fails `liveManifestSchema.safeParse`.
- [ ] **Step 2: Run** `npx vitest run live-admission assistant`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Existing `assistant.test.ts` stays green; its labeled/source-linked withholding tests now exercise `livePlannerContext`.
- [ ] **Step 4: Run** the tests, then `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): live projections and server-only exchange manifest`

### Task 5: Admission binding and the final transmission guard

**Files:**

- Create: `apps/api/src/ai/live-guard.ts`
- Modify: `apps/api/src/ai/live-request.ts`
- Test: `apps/api/tests/live-admission.test.ts`, `apps/api/tests/live-guard-postgres.test.ts` (new, opt-in on `TEST_DATABASE_URL`)

**Interfaces:**

- Consumes: `SealedEnvelope` (Task 2), `resolveLiveDestination`/`liveAllowedLabels` (Task 3), `livePlannerContext`, `mailSources`, `sourceDigest` (Task 4).
- Produces:
  - `LiveReason` adds `'context-changed' | 'route-blocked'`.
  - `prepareLiveDestination(database, config, fetcher, owner, maxTokens: number): Promise<{ key; settings; destination: LiveDestination; cost: ModelPrice }>`. It runs a short read-only transaction for `resolveLiveDestination`, then calls `modelPrice(destination.model)` and `hasPrivateHost(destination.model, destination.upstream)` outside any transaction. It reuses the existing error codes; its `ASSISTANT_MODEL_NOT_PRIVATE` copy is "The approved destination has no zero-retention endpoint for this model." The legacy `prepareLive` stays unchanged for unconverted call sites and is deleted in Task 9.
  - `admitLive(database, owner, request & { sealed?: SealedEnvelope })`. When `sealed` is present, in the same transaction after the request insert, it inserts `ai_live_exchanges(request_id, owner_id, 1, manifest, integrity_hash, destination_revision, source_count)`, after asserting `sealed.requestId === request.id` and `sealed.manifest.destination.model === request.model`. `sealed` becomes required in Task 9, once every call site passes it.
  - `type GuardContext = { authority?: (tx: QueryExecutor) => Promise<boolean>; agentRun?: { runId: string; token: string; now: () => Date } }`.
  - `verifyLive(tx, config, sealed, context): Promise<null | 'context-changed' | 'route-blocked'>`. It runs these checks in order and returns at the first failure:
    1. Stored row `guard_state='admitted'` and `integrity_hash === boundLiveHash(owner, requestId, sealed.bytes, sealed.manifest)`.
    2. Owner exists, and `authority?.(tx)` holds.
    3. Conversation, if any, is owned and not deleted.
    4. `ai_assistant_settings.version === settingsVersion`.
    5. The destination row still exists with the bound `version` and `revision`, matches the settings model, and the server key is present; a failure returns `route-blocked`. Every request, source and history-source label is in `liveAllowedLabels(settings)`.
       5a. Every history turn exists in the same, non-deleted conversation with `inference_history='bound'` and an equal `inference_digest`. Every history source still exists (not deleted), has equal labels, an equal connector version for mail, and mail history sources require `useMail` for this ask.
    6. Every planner source is still returned by `livePlannerContext({tasks,events})` with equal version and equal `sourceDigest` of its re-projection.
    7. Every mail source re-resolves (version, connector version, labels equal) and re-projects to an equal digest. Bodies are re-read and cut to 6000 characters, and they still satisfy the Personal ceiling.
    8. For agents, the responsibility is not deleted, `status IN ('active','paused')`, it is unlabeled and `sourceDigest(…, 'agent-goal', id, goal) === goalDigest`. The run is `running` with the token and `lease_until > now()`.
  - `transmitLive(database, config, fetcher, key, sealed, context): Promise<ExchangeResult | { status: 'withheld'; reason: 'context-changed' | 'route-blocked' }>`. It opens `REPEATABLE READ` and runs `verifyLive`. On success it updates `guard_state='verified', guarded_at=now` and, for agents, `progress_stage='provider-request'` with the lease predicate; zero rows counts as `context-changed`. It commits, then returns `exchange(fetcher, key, sealed)` immediately. On failure, or on SQLSTATE `40001`, it calls `releaseUnsent` and returns `withheld`.
  - `releaseUnsent(database, owner, requestId, reason)` runs `lockBudget` → request `FOR UPDATE` → reservation `released`, `actual_micros=0` → request `failed`/`reason` → exchange `guard_state='blocked', guarded_at=now`.
  - Header comment in `live-guard.ts` records the lock order from Plan decision 9.

- [ ] **Step 1: Write failing tests** in `live-admission.test.ts`. Each test admits a synthetic planner exchange through `admitLive` with a sealed envelope, then calls `transmitLive` with a fetcher spy.
  - `admission persists the binding atomically`: force the `ai_live_exchanges` insert to fail (manifest owner ≠ request owner). Then no reservation or request row exists.
  - `rejects a post-hash mutation`: pass a copy of `sealed` with one changed byte in `bytes`. The result is `withheld/context-changed`, the fetcher is never called, the reservation is `released` with `actual_micros=0` and `guard_state='blocked'`.
  - `rejects a source byte change without a version change`: `UPDATE tasks SET title='x'` without bumping the version. The digest mismatch gives `context-changed` and no fetch.
  - `rejects relabel, delete and connector edits`: each of task `sensitivity='personal'`, task soft-delete, message relabel and connector version bump gives `context-changed`.
  - `rejects settings, routing and consent changes`: each of a settings save, a routing save with the same content (version bump), consent revoke and a config profile revision change gives a result in `{context-changed, route-blocked}` (assert the specific reason per case), never a fetch.
  - `blocks when the owner signs out`: `authority` returns false, giving `context-changed`.
  - `a thrown fetch stays uncertain`: the fetcher throws after it is called. The result is `uncertain/transport` with the reservation still `uncertain` and `guard_state='verified'`.
  - `restart keeps uncertainty without resend`: admit, transmit with a fetcher that throws, then close and reopen the PGlite database (same directory). `findReplay` returns the stored receipt with `status:'uncertain'` and the fetcher call count stays 1.
- [ ] **Step 2: Write** `live-guard-postgres.test.ts` (pattern from `agent-worker-postgres.test.ts`, disposable schema)
  - `guard takes no contended locks`: a second connection holds `ai_budget_policies FOR UPDATE`, `ai_conversations FOR UPDATE` and the task row `FOR UPDATE` in open transactions. `transmitLive` still resolves within 2000 ms and fetches.
  - `a revocation committed before the guard snapshot blocks`: relabel and commit, then transmit, giving `context-changed`.
  - `an uncommitted revocation does not retract an admitted send`: the relabel stays open while `transmitLive` runs, so it fetches. After commit, the next exchange's guard blocks.
- [ ] **Step 3: Run** `npx vitest run live-admission` and `TEST_DATABASE_URL=… npx vitest run live-guard-postgres`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** both, then `npm run check`. Expected: PASS. Record the PostgreSQL run (not skipped) in `docs/implementation-log.md`, together with PR 1's note that no call site uses the guard yet.
- [ ] **Step 6: Commit** `feat(ai): bind live exchanges at admission and guard transmission`

### Task 6: Connect the Assistant (first call and mail rounds)

**Files:**

- Modify: `apps/api/src/features/assistant.ts` (`answerTurn`, route handler), `apps/api/src/features/assistant-conversations.ts` (`finishTurn`, `turnColumns`, `toTurn`, items PUT), `apps/api/src/features/assistant-mail.ts`
- Test: `apps/api/tests/assistant.test.ts`, `apps/api/tests/ai-mail-context.test.ts`

**Interfaces:**

- Consumes: Tasks 2–5.
- Produces:
  - `answerTurn(…, input & { authority?: (tx: QueryExecutor) => Promise<boolean>; agentRun?: GuardContext['agentRun'] })`. The HTTP handler passes `authority: async (tx) => !!(await auth.currentUser(request, tx))`. The hash is unchanged.
  - Sequence:
    1. Replay check.
    2. `openConversation`.
    3. `prepareLiveDestination(…, 1500)`.
    4. One `REPEATABLE READ READ ONLY` transaction runs `livePlannerContext({limit:150})`, reads settings and the earlier-turn count, builds the body with `history = []` and the manifest, and seals.
    5. `admitLive` with the seal.
    6. `startTurn`.
    7. `transmitLive`.
    8. Settle (a `withheld` result is already settled by `releaseUnsent`).
    9. For rounds 2 and 3, one snapshot transaction runs search or read, filters by the existing mail eligibility (Plan decision 5), re-derives every earlier source's manifest entry, appends the new sources, sets `priorRequestIds` and seals.
    10. `admitLive` → `recordRound` → `transmitLive`.
  - On a withheld round 1, the turn is saved with no answer and `request.reason` is `context-changed`/`route-blocked`. On a withheld round 2 or 3, `mailNote` is "Mail reading stopped: a source changed. Nothing more was sent." and the earlier answer is kept.
  - `finishTurn(…, { …, proposalAccess })` saves `proposal_access = sent.size > 0 ? 'read-only' : 'applicable'`. The turn API returns `inferenceHistory` and `proposalAccess`, and mail entries carry `truncated`.
  - `PUT /api/v1/assistant/turns/:id/items`: on a read-only turn, any item moving from `proposed` to `applied` returns `409 PROPOSAL_READ_ONLY` "These suggestions came from mail and can't be applied yet."
  - `readHistory` is replaced by `readBoundHistory(tx, owner, conversationId, { allowed, useMail }): Promise<{ history: { ask; reply }[]; turns: { id; digest }[]; sources: LiveHistorySource[]; withheld: number }>` (Plan decision 6), run inside the step-4 snapshot. `withheld` counts earlier answered turns not included. Step 4 builds the body with that history, and step 9 reuses the same history for later rounds.
  - `finishTurn` takes `binding: { requestId } | null`: the exchange whose reply is kept. In its transaction it reads that exchange's manifest; when `guard_state='verified'` and `historyRefs(manifest).length <= maxHistorySources`, it saves `inference_history='bound'`, `inference_digest` and `inference_sources`; otherwise `'unbound'`.

- [ ] **Step 1: Update setup and write failing tests** (all existing tests call `approveLiveDestination` first; the existing "resends earlier turns" test now covers bound history)
  - `blocks before any hold until a destination is approved`: with no approval, POST `/assistant/requests` returns 409 `ASSISTANT_ROUTE_UNSET`, and no `ai_assistant_requests` or `ai_budget_reservations` row exists.
  - `sends the pinned route and bound history`: in a two-ask conversation, the first turn is `inferenceHistory:'bound'`, the second body contains the first ask and reply, its manifest `history.turns` has the first turn, and `provider` deep-equals `pinnedRouting('google-vertex')`.
  - `legacy turns are withheld`: a conversation whose first turn is inserted as legacy (`unbound`) sends no earlier messages, records `history.withheld = 1`, and GET still returns the legacy turn.
  - `history stops at a deleted source`: a turn whose context included task T is bound; delete T; the follow-up omits that turn (and any older ones) and counts them in `withheld`. Editing T's title instead keeps the turn in history.
  - `history overflow binds nothing`: a turn whose source union would exceed 1000 refs is saved `unbound`.
  - `deleting a conversation clears binding`: after delete, turn rows have `inference_history='unbound'` and null digest/sources.
  - `a Personal-mail answer is not resent after Use mail is turned off` (spec acceptance 1): run a mail ask that reads a Personal message (`allowPersonalMail` and personal route on), then ask again without mail. The second request's bytes contain neither the earlier reply nor the message subject.
  - `a task edit between rounds 1 and 2 withholds round 2` (Review Focus 1): the fetcher edits task t1's title (version bump) during round 1. Round 2 makes no fetch, its request is `failed/context-changed` with reservation `released`, the turn reply is round 1's and `mailNote` matches /source changed/.
  - `relabeling a searched message between rounds 2 and 3 blocks the cumulative envelope` (spec acceptance 2): relabel a header-only hit, which is not chosen for a body read. Round 3 is withheld.
  - `a mail-dependent turn is not resent with Use mail off` (Review Focus 2): ask with mail (reads a Personal message), then an ordinary ask with mail, then ask with Use mail off. The third body contains neither earlier turn (history stops at the newest mail-dependent turn) and `withheld = 2`.
  - `turning Personal mail off between rounds blocks the next round`: the fetcher saves `allowPersonalMail:false` during round 1; round 2 is withheld `context-changed`.
  - `mail-reading turns are read-only`: after a mail ask with proposals, `proposalAccess` is `'read-only'` and PUT items with `state:'applied'` gives 409 `PROPOSAL_READ_ONLY`. A no-mail turn stays `'applicable'` and Apply still works.
  - `signing out before transmission blocks the send`: the fetcher's catalog call deletes the session. The chat URL is never called and the request is `failed/context-changed`.
  - `manifests bind every source and no text`: after a three-round ask, there are three `ai_live_exchanges` rows. Round 3's sources ⊇ round 2's ⊇ round 1's, `priorRequestIds` has length 2, and `JSON.stringify(manifest)` contains no ask text, subject or body. GET turn JSON contains no `digest` or `integrity`.
- [ ] **Step 2: Run** `npx vitest run assistant ai-mail-context`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(assistant): admit live asks through sealed, guarded envelopes`

### Task 7: Connect agent runs

**Files:**

- Modify: `apps/api/src/features/agent-worker.ts` (`execute`, `ownedFetch`, result mapping), `apps/api/src/features/agent-run.ts` (`applyInTransaction`)
- Test: `apps/api/tests/agent-worker.test.ts`, `apps/api/tests/agent-budget.test.ts`, `apps/api/tests/agent-worker-postgres.test.ts`

**Interfaces:**

- Consumes: `answerTurn` with `agentRun` (Task 6). The manifest `request` is `{ provenance: 'agent-goal', labels: ['unlabeled'], agent: { id, goalDigest } }`.
- Produces:
  - `ownedFetch` calls `requireLease` + `progress('checking-provider')` only for `modelsUrl`/`zdrUrl`. For `chatUrl` it passes through, because the guard checks lease and agent eligibility and writes `provider-request`.
  - Result mapping: `request.reason === 'context-changed'` → `requeue` when `attempts === 1`, else `failRun('LIVE_CONTEXT_CHANGED')`. `'route-blocked'` → `failRun('ASSISTANT_ROUTE_UNAVAILABLE')`. `ASSISTANT_ROUTE_UNSET`/`ASSISTANT_ROUTE_UNAVAILABLE` thrown before admission → `failRun(code)` with no retry.
  - `applyInTransaction` treats a turn with `proposal_access='read-only'` as approval-required for every unsaved item (counted in `proposed`, never written).

- [ ] **Step 1: Update setup and write failing tests**
  - `pause during a run still sends and saves` (Review Focus 4a): pause inside the catalog fetch. The chat URL is called once and the run is `completed`.
  - `a goal edit during a run withholds the send and releases the hold` (Review Focus 4b): edit the goal inside the catalog fetch. There is no chat call, the reservation is `released`, the run is requeued once (`progress_stage='retry-scheduled'`), and on a second occurrence it fails `LIVE_CONTEXT_CHANGED`.
  - `relabeling the agent before transmission withholds without uncertainty`: set `sensitivity='personal'` in the catalog fetch. The request is `failed/context-changed`, not `uncertain/transport`.
  - `a lost lease before transmission never sends`: expire the lease in the catalog fetch. There is no chat call and the run fails `AGENT_LEASE_LOST` or `LIVE_CONTEXT_CHANGED` (assert the one the code produces), with the reservation `released`.
  - `an unapproved destination fails the run visibly`: with no approval, the run fails `ASSISTANT_ROUTE_UNSET`, is not requeued and gets a notification.
  - `mail-derived agent proposals are never auto-applied`: Tasks `automatic`, a mail-enabled run reads a body and proposes `task.create`. No task is created, the item stays `proposed` and the outcome is `needs-approval`.
  - Existing 058 per-exchange cap, lease-fencing and no-resend tests stay green; `agent-worker-postgres.test.ts` runs with `approveLiveDestination`.
- [ ] **Step 2: Run** `npx vitest run agent-worker agent-budget`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `TEST_DATABASE_URL=… npx vitest run agent-worker-postgres live-guard-postgres`, then `npm run check`. Expected: PASS (PostgreSQL not skipped).
- [ ] **Step 5: Commit** `feat(agents): guard agent exchanges at transmission`

### Task 8: Assistant UI for blocked routes, withheld history and read-only proposals

**Files:**

- Modify: `apps/web/src/components/AssistantSettings.tsx` (replace the model form with `AssistantDestination`), `AssistantView.tsx`/`AssistantComposer.tsx` (blocked line), `AssistantTurn.tsx` (read-only card, new reasons, truncated mail), `AgentActivity.tsx` (codes), `apps/web/src/lib/assistant.ts`
- Modify: `docs/ui-agent-ledger.md`, `docs/ai-assistant.md`, `docs/implementation-log.md`, `docs/decisions.md` (record Plan decisions 1, 4, 6, 7 and 8)
- Test: `apps/web/tests/assistant.test.ts`, `tests/e2e/assistant.spec.ts`, `tests/e2e/agents.spec.ts`

**Interfaces:**

- Consumes: `GET /api/v1/assistant/destination` (`liveDestinationStatusSchema`), turn `proposalAccess`/`inferenceHistory`, mail `truncated`, the new reasons and codes.
- Produces (copy is exact):
  - Settings › AI › Assistant "Destination" panel replaces the model form: Model (text input, as today), Host (radio list from `hosts`; empty → "No supported host for this model"), and an "Approve" button (disabled offline or when nothing changed). When ready: `{model} via OpenRouter → {upstream}` and a "Revoke" button. When blocked: "Blocked" plus a reason label (`approval-required` "Not approved", `approval-stale` "Approval out of date", `model-unsupported` "Model not supported", `key-missing` "Server key missing"). Help: "Requests go only to this host through OpenRouter, with zero data retention. If it is unavailable, nothing is sent; there is no fallback." The existing Personal mail switch stays and is the Personal consent for this destination.
  - Composer: when status is blocked, a visible line "Assistant blocked: {reason label}" with a Settings link; Send is disabled.
  - Conversation containing any `unbound` answered turn: the note "Older messages aren't sent with new asks." with Help ("Messages from before this update, or ones whose sources were deleted, relabeled or need Use mail, can't be sent again. They stay readable.") and a "New conversation" button.
  - Read-only turn: the proposals card shows "From mail · read only" with Help ("Suggestions based on mail can't be applied until their origin can be kept. Create the item yourself if you want it."). Checkboxes and Apply are not rendered.
  - Reason labels: `context-changed` "A source changed before sending. Nothing was sent.", `route-blocked` "The approved destination changed. Nothing was sent.". Mail details list "Body sent (cut)" when `truncated`.
  - AgentActivity: `ASSISTANT_ROUTE_UNSET` "No approved destination", `ASSISTANT_ROUTE_UNAVAILABLE` "Destination unavailable", `LIVE_CONTEXT_CHANGED` "Context changed before sending".

- [ ] **Step 1: Write failing tests**
  - `apps/web/tests/assistant.test.ts › read-only turns build no apply requests`: the helper that selects applicable items returns `[]` for `proposalAccess:'read-only'`.
  - `tests/e2e/assistant.spec.ts`:
    - `blocked destination disables Send and links to Settings`, using a mocked destination `{status:'blocked',reason:'route-unset'}`.
    - `read-only proposals show no Apply`.
    - `earlier-messages note offers a new conversation`.
    - `destination panel replaces the model picker` (no "Save model" button).
    - Each passes at 320 px width, and Help opens by keyboard (Enter) and tap.
  - `tests/e2e/agents.spec.ts › route failure reason is shown on the agent`.
- [ ] **Step 2: Run** `npx vitest run apps/web` and `npm run test:e2e -- assistant agents`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update the ledger: the destination status contract, required states (ready/blocked × reasons, offline/stale), the read-only card, the withheld-history note, and the known limitation that owner Apply is client-composed until boundary 2.
- [ ] **Step 4: Run** `npm run check`, then `npm run test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(assistant): show destination, withheld history and read-only proposals`

### Task 9: Connect mail category and task suggestions; remove the legacy path

**Files:**

- Modify: `apps/api/src/features/mail-classify.ts`, `apps/api/src/features/mail-task-suggest.ts`, `apps/api/src/ai/openrouter-live.ts` (delete `exchangeLegacy`, `providerRouting`, `hasAnyPrivateHost`), `apps/api/src/ai/live-request.ts` (delete legacy `prepareLive`; `admitLive.sealed` required)
- Test: `apps/api/tests/mail-classify.test.ts`, `apps/api/tests/mail-task-suggest.test.ts`

**Interfaces:**

- Consumes: Tasks 2–5. `GuardContext.authority` comes from the request session.
- Produces:
  - Both routes:
    1. `prepareLiveDestination(…, maxOutputTokens)`.
    2. One `REPEATABLE READ READ ONLY` snapshot runs `eligibleMail`, builds the body with `pinnedRouting(destination.upstream)`, and builds the manifest with `mailSources(…, 'mail-classify-v1' | 'mail-task-v1', …)`. `request.provenance` is `'none'` and `request.labels` is `['unlabeled']`. Projected values are exactly the sent excerpt fields.
    3. Seal → `admitLive` → `transmitLive` → settle.
  - A withheld result returns the receipt with `status:'failed'`, the reason and no suggestions.

- [ ] **Step 1: Update setup and write failing tests**
  - `mail-classify › blocks before any hold without an approved destination` (409 `ASSISTANT_ROUTE_UNSET`, no reservation).
  - `mail-classify › a message edited after preparation is withheld at the guard`: edit in the catalog fetch, so there is no chat call and the result is `failed/context-changed`.
  - `mail-task-suggest › sends the pinned route and binds the message`: `provider` equals `pinnedRouting('google-vertex')` and the manifest has one `mail-task-v1` source with connector identity.
  - `no call site uses the multi-host allowlist`: `rg "providerRouting|exchangeLegacy" apps/api/src` returns nothing (asserted by a test reading the source tree, or by the grep step below).
- [ ] **Step 2: Run** `npx vitest run mail-classify mail-task-suggest`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `rg -n "providerRouting|exchangeLegacy|hasAnyPrivateHost" apps/api/src` (expected: no output), then `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mail): admit mail suggestions through guarded live envelopes`

### Task 10: Boundary 1 receipts and operator steps

**Files:**

- Modify: `docs/implementation-log.md`, `docs/ui-agent-ledger.md`, `docs/ai-assistant.md`, `docs/deployment.md` (operator steps), `docs/live-context-admission-design.md` (status line only: boundary 1 delivered, boundary 2 pending)

- [ ] **Step 1: Write the operator steps** in `deployment.md`:
  1. No server configuration change; `AI_SECRET_OPENROUTER` stays as is.
  2. After deploy, the owner opens Settings › AI › Assistant, picks a host and selects Approve.
  3. Confirm the Destination panel shows the model, the OpenRouter host and Ready.
  4. Agents' failed runs from the gap are not retried automatically.
- [ ] **Step 2: Record** in `implementation-log.md` that all four live call sites are connected. List the checks run, the PostgreSQL race receipts (not skipped), and the e2e results. List the remaining limitations: owner Apply is client-composed, records derived from deleted conversations are unidentified, and there is no recovery release for `admitted` never-verified rows. Do not claim P5/P6 enforcement: boundary 2 remains.
- [ ] **Step 3: Run** `npm run check`, `npm run test:e2e` and `TEST_DATABASE_URL=… npx vitest run postgres`. Expected: PASS, with PostgreSQL tests executed.
- [ ] **Step 4: Commit** `docs(ai): record live admission boundary 1 receipts`

---

## Self-review notes

- **Spec coverage (boundary 1):**

  | Spec item                                                                                                  | Task        |
  | ---------------------------------------------------------------------------------------------------------- | ----------- |
  | Withhold unbound history                                                                                   | 6, 8        |
  | Exact envelopes in consistent snapshots                                                                    | 4, 6, 9     |
  | Per-exchange manifests persisted atomically with the reservation                                           | 1, 5        |
  | Final guard over cumulative sources, authority, conversation, labels, settings/consent/route, agent, bytes | 5, 6, 7     |
  | Linearization and lock order documented and tested on PostgreSQL                                           | 5           |
  | Explicit route configuration, no inferred approval, no fallback                                            | 3           |
  | Single pinned upstream decision                                                                            | 2, 3        |
  | Narrow mail consent mapped to routes                                                                       | 6, 9        |
  | Source-derived proposals read-only                                                                         | 6, 7, 8     |
  | Private hash never exposed                                                                                 | 5, 6        |
  | All live call sites connected before any claim                                                             | 6, 7, 9, 10 |
  | Populated upgrade                                                                                          | 1           |

  Acceptance bullets 1–5 and 8 are covered. Bullets 6–7 (bound history unions, server Apply lineage) are boundary 2.

- **Boundary 2 hooks:** `inference_history`, `proposal_access`, `priorRequestIds`, manifest `history`, the `ai_live_exchanges` owned FK and `guard_state='admitted'` as recovery evidence.
- **Type names used across tasks:** `SealedEnvelope`, `LiveManifest`, `LiveDestination`, `GuardContext`, `transmitLive`, `releaseUnsent`, `liveAllowedLabels`, `readBoundHistory`, `historyRefs`, `livePlannerContext`, `mailSources`, `sourceDigest` and `boundLiveHash`.
