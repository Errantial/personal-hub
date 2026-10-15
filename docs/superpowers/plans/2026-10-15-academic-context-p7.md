# Explicit manual academic context in live asks (P7 backend) — Implementation Plan

**Goal:** An owner ask may explicitly select version-pinned manual academic work. Each selected item is projected as allowlisted planning text (title, kind, deadline-or-unknown, effort-or-unknown, owner-recorded status, priority and a stable ref) into the live OpenRouter payload; every item is bound in the existing sealed manifest with its inherited labels and class version; the transmission guard re-verifies identity, version, class version and labels in one snapshot; applied proposals inherit academic labels and origin. No scores, notes, class/instructor text, provider artifacts, attachments or arbitrary rows are sent. Restricted-labelled work is never sent; Personal-labelled work needs `allowPersonalMail`. This slice is backend and tests only; the composer picker and coverage display follow in a separate UI slice.

**Architecture:** Reuse the boundary-1/2 live path unchanged in shape. The ask gains a small `academic` selection of `{id, expectedVersion, expectedCourseVersion}` refs. In the existing `REPEATABLE READ READ ONLY` prepare snapshot, a new `academicContext` projector reads each selected work/class, applies the same eligibility the verified gateway uses (`academic-work` in [context.ts](../../../apps/api/src/ai/context.ts)), computes inherited labels, withholds items outside `liveAllowedLabels`, and returns projection objects plus manifest sources with a new `academic-work-v1` projection. `buildAssistantRequest` adds an `academic` array with `w1…` refs. The guard re-projects through an injected `reprojectAcademic` callback (mirroring `reprojectMail`). `finishTurn` persists the sent academic summaries in a new `ai_conversation_turns.academic` column, exactly as it persists `mail`, so a later UI can show what was sent even after the work is deleted.

**Tech Stack:** Fastify, PGlite (dev/test) / PostgreSQL (prod), Zod contracts, React 19/Vite, Vitest, Playwright.

**Spec:** [post-agents development plan](../../post-agents-development-plan.md) §C1 (C2/P8 and the UI are follow-ups); [live admission design](../../live-context-admission-design.md); verified projection [ai-academic-context.md](../../ai-academic-context.md).

## Global Constraints

- Migrations are append-only: add `063_academic_ask_context.sql`; never edit 001–062.
- Tests inject `OpenRouterFetch`; no real provider, paid AI request or owner database.
- Academic projection is narrower than the gateway: include `title, kind, dueDate (nullable), estimatedMinutes (nullable), status, priority` and a stable ref only. Exclude `notes`, `grade`, class/instructor text, Canvas/provider data, submission artifacts and attachments. Missing deadline/effort stay `null`, never "none".
- Labels: an item's labels are the owner's work labels strengthened by the class summary labels, matching `resolveAIContext`'s academic branch. `Restricted` never sends. `Personal` sends only when `allowPersonalMail`. An item outside `liveAllowedLabels` is withheld and counted, never silently included.
- Identity/version are hard errors, not withholding: a missing/foreign/deleted work item, a deleted/archived class, or a stale `expectedVersion`/`expectedCourseVersion` throws before any hold (`404 NOT_FOUND` / `409 VERSION_CONFLICT` / `409 ACADEMIC_CLASS_ARCHIVED`).
- Selection is capped at 20 items with unique work IDs.
- No new request `reason` values and no routing-policy or general-gateway changes. The general gateway keeps `dispatchEnabled: false`.
- The live planner tasks/events context, mail rounds, boundary-2 server-owned Apply and inherited-label floor are unchanged; academic provenance joins the same manifest/origin machinery.
- Interface copy: concise labels; explanations in keyboard/tap-accessible Help; blocked/pending/offline states stay visible.

### Plan decisions (confirm in review)

1. **Version-pinned work items** (owner decision): the client sends explicit `{id, expectedVersion, expectedCourseVersion}`, mirroring the verified gateway's `academic-work` refs. There is no class-level "include all open work" mode in this slice.
2. **Withhold on labels, block on identity.** A label the destination may not receive withholds that item and increments `withheld`; a missing/stale item or archived class blocks the ask with a visible error before any hold.
3. **Owner asks only.** Scheduled agents do not select academic context in this slice (C3 is later). The agent branch is unaffected.
4. **Applied academic proposals are applicable, not read-only.** Boundary 2 output lineage is merged, so an ask that sent academic sources may still produce applicable proposals; their inherited labels come from the manifest sources including `academic-work`. Only mail-dependent turns stay read-only (unchanged).
5. **Persist what was sent.** A new nullable `academic` jsonb column mirrors `mail`, storing `{id, ref, title, kind, dueDate, estimatedMinutes, status, priority}` per sent item, so a later UI can show coverage without re-reading mutable work.
6. **No academic truncation.** The 20-item cap and the existing `maxLiveSources` bound the payload; individual items are small, so no per-item truncation flag is added.

## PR split

- **This plan (P7 backend):** Tasks 1–6. Contracts, projector, manifest/guard, `answerTurn` wiring, persistence, tests. No owner-visible UI change yet (the API accepts and reports academic selection).
- **Follow-up UI slice:** composer source picker, coverage/withheld display, turn rendering of sent academic sources.
- **Follow-up P8:** grounded academic proposals reusing `academic-work/:id/planner-work`.

---

### Task 1: Contracts and migration 063

**Files:**

- Modify: `packages/contracts/src/assistant.ts`
- Create: `apps/api/migrations/063_academic_ask_context.sql`
- Test: `apps/api/tests/ai-schemas.test.ts`, `apps/api/tests/upgrade.test.ts`

**Interfaces:**

- Produces (contracts):
  - `assistantAcademicRefSchema = z.strictObject({ id: z.string().uuid(), expectedVersion: posInt, expectedCourseVersion: posInt })`.
  - `assistantRequestInputSchema` adds `academic: z.array(assistantAcademicRefSchema).max(20).default([])` with a unique-`id` refine.
  - `assistantAcademicSentSchema = z.object({ id: uuid, ref: z.string(), title: z.string(), kind: z.enum(['assignment','exam','project','other']), dueDate: dateOnly.nullable(), estimatedMinutes: z.number().int().nonnegative().nullable(), status: z.enum(['planned','in_progress','submitted','cancelled']), priority: z.number().int().min(1).max(5) })`.
  - `assistantTurnSchema` adds `academic: z.array(assistantAcademicSentSchema).default([])`.
- Produces (SQL): `ALTER TABLE ai_conversation_turns ADD COLUMN academic jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(academic) = 'array' AND jsonb_array_length(academic) <= 20)`.

- [ ] **Step 1: Write failing tests**
  - `ai-schemas.test.ts › academic selection requires both versions and unique ids`: a ref without `expectedCourseVersion` fails; a duplicate `id` fails; `academic` defaults to `[]`.
  - `upgrade.test.ts › upgrades populated turns through 063 without rewriting them`: existing `mail/items/ask/reply` stay byte-identical; the new column defaults to `[]`; inserting a turn with 21 academic entries fails the CHECK.
- [ ] **Step 2: Run** `npx vitest run ai-schemas upgrade`. Expected: FAIL.
- [ ] **Step 3: Implement the contract fields and migration 063.**
- [ ] **Step 4: Run the tests, then `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(assistant): academic ask selection contract and migration 063`

### Task 2: Academic projector and manifest extensions

**Files:**

- Modify: `apps/api/src/ai/live-projections.ts`, `apps/api/src/ai/live-manifest.ts`
- Test: `apps/api/tests/live-admission.test.ts`

**Interfaces:**

- Produces (`live-manifest.ts`):
  - `liveProjectionSchema` adds `'academic-work-v1'`; `kind` adds `'academic-work'`.
  - `liveSourceSchema` and `liveHistorySourceSchema` add optional `academicCourse: z.strictObject({ id: uuid, version: posInt })`.
- Produces (`live-projections.ts`):
  - `type AcademicProjected = { ref: string; title: string; kind: string; dueDate: string | null; estimatedMinutes: number | null; status: string; priority: number }`.
  - `projectAcademic(work, ref): AcademicProjected` — exactly the allowlisted fields above.
  - `academicContext(tx, owner, select: { id: string; expectedVersion: number; expectedCourseVersion: number }[], allowed: Sensitivity[], allowPersonalMail: boolean): Promise<{ items: { work: AcademicWork; courseVersion: number; labels: Sensitivity[]; ref: string }[]; withheld: number; sent: AssistantAcademicSent[] }>`:
    - For each ref, read `academic_work JOIN courses` where both are owned and not deleted. Missing/foreign → `404 NOT_FOUND`. `version !== expectedVersion` → `409 VERSION_CONFLICT` "Reload academic context." Archived class → `409 ACADEMIC_CLASS_ARCHIVED`.
    - Labels = work `academicLabels` strengthened by the class summary labels (same as the gateway's academic branch).
    - If any label is `restricted`, or `personal` while `!allowPersonalMail`, or not in `allowed` → increment `withheld`, skip.
    - Ref is positional `w1…` for the items actually sent.
  - `academicSources(owner, requestId, sent): LiveSource[]` — `projection:'academic-work-v1'`, `kind:'academic-work'`, `labels`, `academicCourse:{id,version}`, digest `sourceDigest(owner, requestId, 'academic-work-v1', id, projected)`.

- [ ] **Step 1: Write failing tests**
  - `academic projection excludes notes, grades and class text`: a seeded work item with notes and a grade projects to exactly the six allowlisted fields plus ref.
  - `academic selection is version and class guarded`: stale work version, stale class version, deleted work and archived class each throw the expected code; no row is held.
  - `restricted and disallowed personal work is withheld and counted`: restricted work and personal work with `allowPersonalMail` off are absent and increment `withheld`; with `allowPersonalMail` on the personal work is sent.
  - `manifest accepts academic sources and rejects a duplicate`: an academic `LiveSource` parses; two sources with the same `(projection,id)` fail `liveManifestSchema`.
- [ ] **Step 2: Run** `npx vitest run live-admission`. Expected: FAIL.
- [ ] **Step 3: Implement the projector and manifest extensions.**
- [ ] **Step 4: Run the tests, then `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): project explicit academic work into the live manifest`

### Task 3: Guard re-verification of academic sources

**Files:**

- Modify: `apps/api/src/ai/live-guard.ts`, `apps/api/src/features/assistant.ts` (pass the callback)
- Test: `apps/api/tests/live-admission.test.ts`

**Interfaces:**

- Consumes: `academicContext`, `projectAcademic`, `sourceDigest`.
- Produces:
  - `GuardContext` adds `reprojectAcademic?: (tx, sources: LiveSource[]) => Promise<LiveSource[]>`. It re-reads each academic source, requires active work and class, equal `version`, equal `academicCourse.version` and equal `labels`, and re-digests `projectAcademic`. A vanished or changed item omits it from the result.
  - `verifyLive` step: every academic source re-projects to an equal digest; a mismatch returns `context-changed`.
  - `answerTurn` passes `reprojectAcademic` in the `transmitLive` context, built on `academicContext` for the bound refs (labels resolved the same way).

- [ ] **Step 1: Write failing tests**
  - `rejects an academic edit without a version change`: `UPDATE academic_work SET title=…` (no version bump) gives `withheld/context-changed`, no fetch, reservation `released`.
  - `rejects a class relabel`: relabeling the class between prepare and transmit gives `context-changed`.
  - `rejects a deleted selected work item`: soft-deleting the work gives `context-changed`.
- [ ] **Step 2: Run** `npx vitest run live-admission`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests, then `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): guard academic sources at transmission`

### Task 4: Wire academic selection through `answerTurn`

**Files:**

- Modify: `apps/api/src/features/assistant.ts`, `apps/api/src/features/assistant-conversations.ts` (`finishTurn`, `turnColumns`, `toTurn`, `startTurn`)
- Test: `apps/api/tests/assistant.test.ts`

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces:
  - `answerTurn` input adds `academic?: { id: string; expectedVersion: number; expectedCourseVersion: number }[]`.
  - The operation hash conditionally includes `academic` only when non-empty (so existing no-academic retries keep the same hash).
  - In the prepare snapshot: `const academic = await academicContext(tx, owner, input.academic ?? [], liveAllowedLabels(settings), settings.allowPersonalMail)`, then `buildAssistantRequest(..., academic.items)` adds an `academic` array, and `manifest.sources = [...plannerSources(...), ...academicSources(owner, id, academic.items)]`. `admitLive` `withheld` = planner `withheld` + academic `withheld`.
  - `buildAssistantRequest` gains an `academic: AcademicProjected[]` parameter and a short system-instruction line ("Academic items are the owner's manual records; a missing deadline or effort is unknown, not zero; do not state grades"). Mail rounds reuse the unchanged academic payload.
  - `finishTurn(..., { ..., academic: academic.sent })` writes the column; `toTurn` returns `academic`.
  - `POST /api/v1/assistant/requests` passes `input.academic`.

- [ ] **Step 1: Write failing tests**
  - `an ask sends selected academic work and binds it`: seed two open work items; POST with both refs; the request body's `academic` array has the allowlisted fields and `w1/w2` refs; `ai_live_exchanges.manifest.sources` has two `academic-work-v1` entries with labels and `academicCourse`; the turn's `academic` echoes both.
  - `a selected item is withheld, not sent, when Personal is not allowed`: `allowPersonalMail` off, one unlabeled and one personal item selected → the personal item is absent from the body and `withheld` is 1.
  - `a stale selected work version blocks before any hold`: POST with an outdated `expectedVersion` → `409 VERSION_CONFLICT`; no `ai_assistant_requests` or reservation row.
  - `no academic selection leaves the request unchanged`: a POST with no `academic` has an empty `academic` array and the same hash as before this change (a pre-recorded operation replays).
  - `bound academic labels reach an applied proposal`: with an unlabeled selected work item and a `task.create` proposal, Apply writes a task whose `ai_labels` include the work's labels and `ai_origin='bound-derived'`.
- [ ] **Step 2: Run** `npx vitest run assistant`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(assistant): accept explicit academic sources in live asks`

### Task 5: Attendance in agent and owner isolation checks

**Files:**

- Test: `apps/api/tests/assistant.test.ts`, `apps/api/tests/agent-worker.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Write tests**
  - `an owner cannot select another owner's work`: selecting a foreign work ID gives `404 NOT_FOUND`; no hold.
  - `agent turns never carry academic sources`: an agent run's body has an empty `academic` array and its manifest has no `academic-work-v1` entry, even when work exists.
- [ ] **Step 2: Run** the tests. Expected: PASS (guards against regressions).
- [ ] **Step 3: Commit** `test(assistant): cover academic-context ownership and agent isolation`

### Task 6: Docs and validation receipt

**Files:**

- Modify: `docs/ai-assistant.md`, `docs/ai-academic-context.md`, `docs/ui-agent-ledger.md`, `docs/implementation-log.md`, `docs/backlog.md`

- [ ] **Step 1: Document** the academic selection contract, the projection allowlist, the withhold-vs-block rule and the manifest/guard binding. Note that the composer picker and coverage UI are the next slice and that P8 is later.
- [ ] **Step 2: Run** `npm run check` and record the counts in `docs/implementation-log.md`.
- [ ] **Step 3: Commit** `docs(ai): record academic ask context`

## Exit checks

- Unknown (`null`) deadline and effort are preserved and never coerced to zero or "none"; a date-only deadline stays date-only.
- Archived class, deleted/foreign work and stale work/class versions block before admission with no hold, and are never fabricated into context.
- Restricted work never sends; Personal work sends only with `allowPersonalMail`; a withheld item is counted and visible on the request.
- A work edit, class relabel or deletion between prepare and transmit withholds the send with no charge (guard), matching the existing mail/planner behaviour.
- Applied proposals inherit the academic labels and `bound-derived` origin; Undo/delete/restore preserve the floor (boundary 2).
- No scores, notes, provider artifacts, attachments or class/instructor text appear in any body, manifest, turn or log.
- `npm run check` passes; no owner database, real provider or paid request is used.
