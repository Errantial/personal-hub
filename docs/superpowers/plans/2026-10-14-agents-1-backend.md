# Persistent agents, PR 1: backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scheduled agents run unattended through the existing Assistant pipeline, apply or propose changes by the owner's action settings, and stop at a per-agent monthly cap.

**Architecture:** An agent is a responsibility with a `template`, a pinned conversation and a local schedule. An in-process worker (reminder-worker lease pattern) admits due slots into `queued` runs, claims one at a time, rechecks, calls the shared `answerTurn` (extracted from `POST /api/v1/assistant/requests`), applies proposals through the same versioned planner writes the browser uses, and writes an Inbox notification for non-quiet outcomes.

**Tech Stack:** Fastify, PGlite (dev/test) / PostgreSQL (prod), Zod contracts, Temporal, Vitest.

**Spec:** [docs/superpowers/specs/2026-10-14-persistent-agents-design.md](../specs/2026-10-14-persistent-agents-design.md)

## Global Constraints

- Migrations are append-only: add `057_persistent_agents.sql`; never edit 001–056.
- Tests use the fake OpenRouter fetcher only (pattern in `apps/api/tests/assistant.test.ts`: `vi.stubGlobal('fetch', …throw…)`, `openRouterFetch` injected); no real provider calls, no spend.
- Never log or store prompts, mail bodies or keys outside the existing conversation columns.
- Text only. Mail eligibility unchanged: Restricted never, Personal only with `allowPersonalMail`.
- Email is never sent; external calendars are never written; owner memory is not read or changed (D57 out of scope).
- Per-agent cap default `2_000_000` micros; existing `$0.25` request and `$50` monthly caps still apply through `admitLive`.
- Lease 10 minutes; tick every 30 seconds; one run executes at a time.
- Rate-limit retry: once, 15 minutes later.
- Templates: Daily plan daily 07:00 mail on; Mail triage daily 08:00, 12:00, 16:00, 20:00 mail on; Deadline watch daily 18:00 mail off.
- `local_rule.times`: 1–6 `HH:MM` values.
- Run `npm run check` before each commit.

### Plan decisions (narrowing the spec; confirm in review)

1. **Only agents execute.** The worker admits and runs responsibilities with a non-null `template`. Legacy responsibilities keep creating `blocked` runs through the existing endpoints.
2. **Retry scope.** Only a `rejected`/`rate-limited` result (HTTP 429, confirmed zero charge) and `ASSISTANT_CATALOG_UNAVAILABLE` (before any hold) retry. A `transport` error is `uncertain` in `openrouter-live.ts`; per the spec's no-resend rule it is never retried.
3. **`pause_reason`** column on `responsibilities` (`cap-reached` or null) so the UI can show "Cap reached" without scanning activity.
4. **Per-agent spend is computed**, not stored: settled `actual_micros` plus `uncertain` `reserved_micros` of the reservations behind the agent's run turns (first call and rounds), in the current UTC month (the same month the $50 cap uses). A run that starts under the cap may finish over it by at most one run; the agent then pauses.
5. **Shared write builders.** `applyRequest`/`undoRequest` move from `apps/web/src/lib/assistant.ts` to `packages/contracts` so browser and worker build identical writes. Planner route bodies are extracted into exported functions the worker calls directly.
6. **Run-turn text.** The stored turn `ask` is a short label (`Scheduled run` or `Run now`); the full prompt (template instructions, goal, date) is sent but not stored, keeping `ask ≤ 1000`. Agent goals are limited to 2000 characters.
7. **Agents are unlabeled.** Created responsibilities use `sensitivity: 'unlabeled'`, `labels: ['unlabeled']`, because the goal text is sent to OpenRouter.
8. **No schedule-version recheck.** Admission itself bumps the schedule version, and schedule edits already cancel queued runs; the recheck covers status, responsibility version, pause and cap.
9. **First slot is in the future.** Creating or rescheduling an agent starts at the first slot after now, so creating Daily plan at 3 PM does not run immediately.
10. **Pinned threads cannot be deleted** through `DELETE /assistant/conversations/:id` (409 `AGENT_CONVERSATION`); deleting the agent unpins the thread, which then appears under Conversations.
11. The worker starts under the existing `runtime.runWorker` flag, plus config `AGENT_WORKER` (`on`|`off`, default `on`) and a configured OpenRouter key.

## Review Focus

1. **Creating an agent after today's slot** — expected: the first run is the next future slot, not an immediate run. Test in Task 6.
2. **Server restart mid-run** — expected: the run is marked `failed`/`LEASE_EXPIRED`, a notification appears, and nothing is resent. Test in Task 5.
3. **Owner edits a task between the model reading it and the worker applying** — expected: only that item fails with a conflict; the others apply. Test in Task 4.
4. **Owner pauses or edits the agent while a run is queued vs. running** — expected: queued runs are cancelled; a running run finishes and saves. Test in Task 5.
5. **Mail triage four times a day across a DST change** — expected: each listed local time fires once per day and none is duplicated or lost. Test in Task 2.

---

### Task 1: Migration 057 and contracts

**Files:**
- Create: `apps/api/migrations/057_persistent_agents.sql`
- Create: `packages/contracts/src/agents.ts`; export from `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/responsibilities.ts` (run status, cancel reason, activity kinds, run fields)
- Modify: `packages/contracts/src/responsibility-local-schedule.ts` (`times`)
- Modify: `packages/contracts/src/features.ts` (`notificationSchema`)
- Modify: `packages/contracts/src/assistant.ts` (turn `trigger`, `notAllowed`; conversation `agent`)
- Modify: `packages/contracts/src/ai-actions.ts` (`defaultAIActionPolicy.tasks = 'approval-required'`)
- Test: `apps/api/tests/upgrade.test.ts`, `apps/api/tests/ai-actions.test.ts`

**Interfaces:**
- Produces (SQL, migration 057):
  - `responsibilities`: `template text CHECK IN ('daily-plan','mail-triage','deadline-watch','custom')`, `conversation_id uuid REFERENCES ai_conversations(id)`, `time_zone text`, `use_mail boolean NOT NULL DEFAULT false`, `monthly_cap_micros bigint NOT NULL DEFAULT 2000000 CHECK (>0)`, `pause_reason text CHECK IN ('cap-reached')`; CHECK `template IS NULL OR (conversation_id IS NOT NULL AND time_zone IS NOT NULL)`.
  - `responsibility_runs`: status adds `queued`,`running`,`completed`,`failed`; new `lease_token uuid`, `lease_until timestamptz`, `not_before timestamptz`, `attempts int NOT NULL DEFAULT 0`, `turn_id uuid REFERENCES ai_conversation_turns(id)`, `outcome text CHECK IN ('quiet','applied','needs-approval','warning','failed')`, `error_code text`, `finished_at timestamptz`. Replace the status/cancelled CHECK so `cancelled` still requires `cancelled_at`+`cancel_reason`, `completed`/`failed` require `finished_at`+`outcome`, `failed` requires `error_code`. `cancel_reason` adds `cap-reached`. Index `(status, not_before, created_at) WHERE status IN ('queued','running')`.
  - `responsibility_activities.kind` adds `run-started`,`run-completed`,`run-failed`,`cap-reached`.
  - `ai_conversations.responsibility_id uuid REFERENCES responsibilities(id)` (nullable); `ai_conversation_turns.trigger text NOT NULL DEFAULT 'owner' CHECK IN ('owner','agent')`, `not_allowed integer NOT NULL DEFAULT 0 CHECK (BETWEEN 0 AND 10)`.
  - `responsibility_schedules_local_state` replaced: also allows key `times`, a JSON array of 1–6 distinct ascending `HH:MM` strings whose first element equals `localTime`.
  - `notifications.reminder_id` drops NOT NULL (UNIQUE stays); adds `run_id uuid UNIQUE REFERENCES responsibility_runs(id)`, `conversation_id uuid REFERENCES ai_conversations(id)`; CHECK `(reminder_id IS NOT NULL AND run_id IS NULL AND conversation_id IS NULL) OR (reminder_id IS NULL AND run_id IS NOT NULL AND conversation_id IS NOT NULL)`.
  - `ai_action_policies.policy` column default changes to tasks `approval-required` (existing rows untouched).
- Produces (contracts, `agents.ts`):
  - `agentTemplateSchema = z.enum(['daily-plan','mail-triage','deadline-watch','custom'])`
  - `agentScheduleSchema = z.strictObject({ frequency: z.enum(['daily','weekly']), weekday: z.number().int().min(1).max(7).optional() /* required when weekly */, times: z.array(hhmm).min(1).max(6) })`. The array is sorted and deduplicated on parse.
  - `agentWriteSchema = { operationId, title (1–160), goal (1–2000), template, schedule, useMail, monthlyCapMicros (int, 100_000–50_000_000), timeZone }`; `agentUpdateSchema = agentWriteSchema minus template, plus expectedVersion`.
  - `agentSchema = { id, version, template, title, goal, status: 'active'|'paused', pauseReason: 'cap-reached'|null, schedule, useMail, monthlyCapMicros, spentMicros, timeZone, conversationId, nextRunAt: string|null, lastRun: { id, status, outcome, errorCode, finishedAt, turnId } | null }`
  - `agentsResponseSchema = { agents: Agent[] }`, `agentResponseSchema = { agent }`, `agentRunResponseSchema = { agent, runId }`, `agentWorkerSchema = { lastTick, errorCode, healthy }`.
  - `agentTemplates: Record<Exclude<AgentTemplate,'custom'>, { title, goal, instructions, schedule, useMail }>` and `customInstructions: string`. Template text is fixed in Task 7.
  - `notificationSchema`: `reminderId: uuid.nullable()`, `runId: uuid.nullable().default(null)`, `conversationId: uuid.nullable().default(null)`.
  - `assistantTurnSchema` adds `trigger: z.enum(['owner','agent']).default('owner')`, `notAllowed: z.number().int().nonnegative().default(0)`; the conversation list item adds `agent: { id, title, status, pauseReason, nextRunAt, lastOutcome, lastRunAt } | null` (default null).

- [ ] **Step 1: Write failing tests**
  - `upgrade.test.ts`: extend the populated-upgrade case. Seed a legacy responsibility, a `blocked` run, a reminder notification and an `ai_action_policies` row (tasks `blocked`) before 057. After migrating, assert each row is unchanged, the saved policy is still `blocked`, and inserting a run notification without `conversation_id` fails the CHECK.
  - `ai-actions.test.ts`: `GET /api/v1/ai/actions` for a fresh owner returns `policy.tasks === 'approval-required'`; update existing assertions that expected `blocked`.
- [ ] **Step 2: Run** `npm run test -w apps/api -- upgrade ai-actions`. Expected: FAIL (no 057; default still blocked).
- [ ] **Step 3: Write migration 057 and the contract changes.** Drop unnamed CHECKs by looking them up in `pg_constraint` with `EXECUTE format(...)`, as migration 041 does.
- [ ] **Step 4: Run the same tests, then `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agents): migration 057 and agent contracts`

### Task 2: Multi-time local schedules

**Files:**
- Modify: `apps/api/src/features/responsibility-local-cadence.ts`
- Test: `apps/api/tests/responsibility-local-schedule.test.ts`

**Interfaces:**
- Consumes: `responsibilityLocalRuleSchema` with optional `times` (Task 1).
- Produces: `localReviewSlot(rule, index)` where slot `index` is day `floor(index / n)` (stepped by `interval`, ×7 for weekly) at `times[index % n]`, with `n = times?.length ?? 1` and `times ?? [localTime]`. Also `firstSlotAfter(rule, now: number): { index: number; at: string } | null`. `advanceLocalReview` keeps its signature; its day estimate multiplies by `n`.

- [ ] **Step 1: Failing tests**
  - `multi-time daily slots`: `times ['08:00','12:00','16:00','20:00']` in `America/Denver` from `2026-11-01`. `localReviewSlot` for indexes 0–7 returns 08:00…20:00 local on Nov 1 then Nov 2. Across the Nov 1 fall-back, every local time appears exactly once per day.
  - `advance coalesces missed multi-time slots`: due index 0, now = Nov 2 13:00 local. Expect next index 6 (Nov 2 16:00) and `skippedIntervals` 5.
  - `firstSlotAfter skips today's past times`: now = Nov 1 13:00 local, so the result is index 2 (16:00).
  - `single-time rules unchanged`: the existing tests still pass.
- [ ] **Step 2: Run** `npm run test -w apps/api -- responsibility-local-schedule`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agents): multi-time local schedules`

### Task 3: Shared planner writes and `answerTurn`

**Files:**
- Create: `packages/contracts/src/assistant-writes.ts` (move `PlannedRequest`, `applyRequest`, `undoRequest`, `taskFields`, `eventFields` from `apps/web/src/lib/assistant.ts`; the web file re-exports them)
- Modify: `apps/api/src/planner/routes.ts` (extract task POST/PUT/DELETE bodies)
- Modify: `apps/api/src/features/calendar.ts` (extract calendar POST/PUT and DELETE bodies)
- Create: `apps/api/src/features/planner-write.ts`
- Modify: `apps/api/src/features/assistant.ts` (extract `answerTurn`; agent prompt)
- Modify: `apps/api/src/features/assistant-conversations.ts` (`startTurn` takes `trigger`; `turnColumns` adds `trigger`, `not_allowed`)
- Test: `apps/api/tests/assistant.test.ts`, `apps/web/tests/assistant.test.ts`

**Interfaces:**
- Produces:
  - `saveTask(database, owner, method: 'POST'|'PUT'|'DELETE', id: string|null, body: unknown): Promise<{ task: Task }>` in `planner/routes.ts`, wrapping the existing `mutate` call unchanged. Route handlers call it.
  - `saveEvent(database, owner, method: 'POST'|'PUT'|'DELETE', id: string|null, body: unknown): Promise<{ event: CalendarRecord }>` in `calendar.ts`. The "explicit sensitivity" check reads `body`, as now.
  - `plannedWrite(database, owner, request: PlannedRequest): Promise<{ id: string; version: number }>` in `planner-write.ts`. It parses the path (`/api/v1/tasks[/:id]` or `/api/v1/calendar[/:id]`) and dispatches; any other path throws.
  - `answerTurn(database, config, fetcher, owner, input: { operationId: string; prompt: string; ask: string; timeZone: string; conversationId: string; useMail: boolean; trigger: 'owner'|'agent' }): Promise<AssistantTurn>` in `assistant.ts`. It contains the existing body from hashing through `readTurn`. The hash includes `trigger`; `ask` is stored and `prompt` is sent. The HTTP route calls it with `prompt = ask = input.text`, `trigger: 'owner'` and a generated conversation ID when none is given.
  - `buildAssistantRequest(..., mail?, agent = false)`: when `agent` is true, the system message appends `agentInstructions` = "This is a scheduled run; the owner is not present. Propose only changes that clearly serve the goal. If nothing needs doing, return no actions and say so in one sentence."

- [ ] **Step 1: Failing tests**
  - `apps/web/tests/assistant.test.ts`: imports `applyRequest`/`undoRequest` from `@hub/contracts`; existing cases unchanged.
  - `assistant.test.ts › answerTurn stores the short ask and sends the prompt`: call `answerTurn` directly with `ask: 'Scheduled run'`, `prompt: 'GOAL-TEXT'`, `trigger: 'agent'`. The sent user payload `request` equals `'GOAL-TEXT'`, the system message contains "scheduled run", and the stored turn has `ask === 'Scheduled run'` and `trigger === 'agent'`.
  - `plannedWrite applies a task.update with the target version and conflicts after an edit`: create a task, build `applyRequest` for a `task.update` proposal and call `plannedWrite`. Expect version 2. Repeating with the same operation ID replays it. A second proposal built from the stale target version throws `409 VERSION_CONFLICT`.
- [ ] **Step 2: Run** `npm run test -w apps/api -- assistant` and `npm run test -w apps/web -- assistant`. Expected: FAIL.
- [ ] **Step 3: Implement the extractions.** Behaviour of the existing routes must not change: all existing planner, calendar and assistant tests stay green.
- [ ] **Step 4: Run `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit** `refactor(agents): shared planner writes and answerTurn`

### Task 4: Run execution: apply by policy, spend and outcome

**Files:**
- Create: `apps/api/src/features/agent-run.ts`
- Test: `apps/api/tests/agents.test.ts` (new; same fake-fetcher setup as `assistant.test.ts`, extracted to `apps/api/tests/helpers/openrouter.ts` if shared)

**Interfaces:**
- Consumes: `answerTurn`, `plannedWrite`, `applyRequest`, `readAIActionPolicy`, `agentTemplates`/`customInstructions`.
- Produces:
  - `agentSpend(tx, owner, responsibilityId): Promise<number>`: micros this UTC month (decision 4).
  - `agentPrompt(agent: { template; goal }, now: Temporal.Instant, timeZone): string`: template `instructions`, a blank line, `Goal: <goal>`, a blank line, `Run: <local date time, weekday> (<timeZone>)`.
  - `applyByPolicy(database, owner, turn: AssistantTurn): Promise<{ applied: number; proposed: number; notAllowed: number; failed: number }>`. Grouping: `task.*` uses `policy.tasks`; `event.*` uses `policy.calendar`. `blocked` items are removed from the turn's proposals and items and counted in `not_allowed`. `automatic` items go through `plannedWrite(applyRequest(p, item.applyId))`: success sets `state:'applied'` and `applied:{id,version}`; an `ApiError` sets `state:'failed'` and `error` to the message. `approval-required` items stay `proposed`. The turn's items are written once with `version+1`.
  - `outcomeOf(counts, turn): RunOutcome`, in precedence order:
    1. `needs-approval` if `proposed > 0`
    2. `applied` if `applied > 0`
    3. `warning` if `failed > 0` or `turn.mailNote`
    4. `quiet` otherwise
  - `notificationTitle(title, outcome, counts): string`:
    - `"<title>: N change(s) applied"`
    - `"<title>: N change(s) to review"`
    - `"<title>: needs attention"` (warning)
    - `"<title>: run failed"`

- [ ] **Step 1: Failing tests** in `agents.test.ts`, driven through `applyByPolicy` on a turn produced by `answerTurn` with the fake model:
  - `automatic calendar applies, ask-first tasks stay proposed, blocked are counted`: policy `{tasks:'approval-required', calendar:'automatic'}`; the model returns one `event.create` and one `task.create`. Expect the event to exist with `item.state 'applied'` and the task `proposed`; outcome `needs-approval`. With tasks `blocked`: one proposal remains and `notAllowed 1`.
  - `a conflicting item fails alone`: two `task.update`s; the owner edits the first task before apply. Expect the first `failed` with a version-conflict error and the second `applied`; outcome `applied`.
  - `Undo of an auto-applied item works through the existing endpoints`: run `undoRequest(proposal, item.applied, item.undoId)` via `app.inject`; the event is deleted.
  - `agentSpend counts settled and uncertain holds of run turns only`: an owner ask in the same conversation is not counted.
- [ ] **Step 2: Run** `npm run test -w apps/api -- agents`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agents): apply proposals by action settings`

### Task 5: Worker: admit, claim, recheck, run, finish

**Files:**
- Create: `apps/api/src/features/agent-worker.ts`
- Modify: `apps/api/src/features/responsibilities.ts` (`newRun` status, `cancelRuns`, admission helper)
- Modify: `apps/api/src/config.ts` (`AGENT_WORKER: z.enum(['on','off']).default('on')`)
- Modify: `apps/api/src/app.ts` (start/stop under `runtime.runWorker`)
- Test: `apps/api/tests/agents.test.ts`

**Interfaces:**
- Consumes: Task 2 cadence, Task 4 functions.
- Produces:
  - `admitSlot(tx, owner, value: Responsibility, saved: ResponsibilitySchedule, now: number): Promise<ResponsibilityRun>`, extracted from the `admit-due` handler loop body. The route keeps its version checks and calls it.
  - `newRun` inserts `status = value.template ? 'queued' : 'blocked'`. `cancelRuns` cancels `status IN ('blocked','queued')`.
  - `runAgentTick(database, config, fetcher, now = new Date()): Promise<{ admitted: number; ran: string | null }>`. The steps:
    1. Fail expired leases: set `status 'failed'`, `error_code 'LEASE_EXPIRED'`, `outcome 'failed'`, add activity `run-failed` and a notification.
    2. Admit every due schedule of `status='active' AND template IS NOT NULL AND deleted_at IS NULL` responsibilities, ordered by id.
    3. Claim: in one transaction, upsert then lock `worker_state` row `agents` `FOR UPDATE`. If any run is `running` with `lease_until > now`, stop. Otherwise select the oldest `queued` run with `not_before IS NULL OR not_before <= now` (`FOR UPDATE SKIP LOCKED`). Set `running`, `attempts+1`, a lease token and `lease_until = now + 10 min`; add activity `run-started`.
    4. Recheck: responsibility `active`, version equal to `run.responsibility_version`, `pause_reason IS NULL`, and `agentSpend < monthly_cap_micros`. If spend is at or over the cap, pause the agent and finish the run as `cancelled` with reason `cap-reached`. A failed recheck finishes `failed` with codes `AGENT_PAUSED`, `AGENT_CHANGED` or `CAP_REACHED`. The key and model checks stay inside `answerTurn` via `prepareLive`.
    5. Run `answerTurn` with `operationId` = deterministic UUID from `run.id` + `attempts` (the `roundOperation` pattern), `ask: run.trigger === 'manual' ? 'Run now' : 'Scheduled run'`, `prompt: agentPrompt(...)`, `trigger: 'agent'` and the agent's `timeZone`, `conversationId` and `useMail`.
    6. Apply with `applyByPolicy`.
    7. Finish, only if the lease token still matches: `completed` with `outcome`, `turn_id` and `finished_at`; activity `run-completed`; insert the notification `(run_id, conversation_id, title)` when the outcome is not `quiet`. Then, if `agentSpend >= cap`, set the responsibility to `paused` with `pause_reason 'cap-reached'`, cancel queued runs with reason `cap-reached` and add activity `cap-reached`.
    8. Errors:
       - An `ApiError` `ASSISTANT_CATALOG_UNAVAILABLE`, or a turn whose request is `failed`/`rate-limited` on `attempts === 1`, re-queues the run with `not_before = now + 15 min`.
       - Any other `ApiError`, a failed or uncertain turn, or a second failure finishes the run `failed` with `error_code` (the error code, or `PROVIDER_<REASON>`), `outcome 'failed'`, activity `run-failed` and a notification.
       - An `uncertain` turn is never retried.
    9. Upsert `worker_state('agents')` (error_code `WORKER_FAILED` on throw).
  - `startAgentWorker(database, config, fetcher): { stop(): Promise<void> }`: 30 s `setTimeout` loop like `startReminderWorker`. `app.ts` starts it only when `runtime.runWorker && config.AGENT_WORKER === 'on' && config.AI_SECRET_OPENROUTER`.

- [ ] **Step 1: Failing tests** (all via `runAgentTick(database, config, fetcher, now)` with explicit `now`; `runWorker` not set):
  - `admits a due slot once and coalesces missed slots`: two ticks at the same `now` give one run; a tick three days late gives one run with `skippedIntervals 2`.
  - `runs one at a time`: two agents due; the first tick runs one; a concurrent claim while a lease is live returns `ran: null`.
  - `rechecks before any hold`: for each of paused-after-admission (run cancelled by pause, so none claimed), version changed (`AGENT_CHANGED`) and cap reached (`cap-reached`, agent paused), the fake chat endpoint is not called and no reservation exists.
  - `no key or a non-private model fails without a hold`: `ASSISTANT_NOT_CONFIGURED` and `ASSISTANT_MODEL_NOT_PRIVATE` error codes; no reservation.
  - `rate limit retries once after 15 minutes`: chat returns 429. The run is `queued` with `not_before = now+15m`; a tick at +14m does nothing; at +15m it runs again; a second 429 gives `failed` `PROVIDER_RATE_LIMITED`.
  - `uncertain outcome is not resent`: chat throws. The run is `failed`, the chat call count stays 1 after more ticks, and the hold stays `uncertain`.
  - `expired lease after restart is failed, not resent`: claim, then abandon (simulate by setting `lease_until` past); the next tick marks it `LEASE_EXPIRED` with a notification.
  - `running run finishes after pause`: pause the agent between claim and finish (inject via a fake fetcher that pauses through the API before replying). The run is `completed` and its turn saved.
  - `notifications only for non-quiet outcomes`: a quiet run gives no notification row; a needs-approval run gives one with `run_id` and `conversation_id`.
  - `cap pause`: cap 1000 micros; the fake cost exceeds it. After the run, the agent is `paused`, `pauseReason 'cap-reached'`, a later due slot is not admitted, and there is no auto-resume at the next month (advance `now` 31 days: still paused).
  - `restart persistence`: close and rebuild the app on the same PGlite dir; queued runs survive and run on the next tick.
- [ ] **Step 2: Run** `npm run test -w apps/api -- agents responsibilities`. Expected: new tests FAIL; existing responsibility tests PASS.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agents): in-process agent worker`

### Task 6: Agents API, conversation and notification fields, export

**Files:**
- Create: `apps/api/src/features/agents.ts` (`registerAgents`), register in `app.ts`
- Modify: `apps/api/src/features/assistant-conversations.ts` (list includes pinned threads with `agent`; pinned delete 409)
- Modify: `apps/api/src/features/reminders.ts` (`notificationColumns` adds `run_id`, `conversation_id`)
- Modify: `apps/api/src/features/responsibilities.ts` (export columns; delete unpins)
- Test: `apps/api/tests/agents.test.ts`, `apps/api/tests/features.test.ts` (export)

**Interfaces:**
- Consumes: Task 1 contracts, Task 2 `firstSlotAfter`, Task 4 `agentSpend`.
- Produces (all owner-authorized; writes through `mutate` with `operationId`):
  - `POST /api/v1/agents` (`agentWriteSchema`) → `agentResponseSchema`. One transaction creates:
    1. the conversation (title = agent title, `responsibility_id` set)
    2. the responsibility (template fields, unlabeled)
    3. the local schedule with `times`, `startDate` = today in `timeZone` (weekly: the next `weekday`), and `next_local_index`/`next_due_at` from `firstSlotAfter(rule, now)`
    4. status `active`, with activities `created`, `schedule-set` and `resumed`
  - `GET /api/v1/agents` → `agentsResponseSchema`, ordered by title.
  - `PUT /api/v1/agents/:id` (`agentUpdateSchema`): goal/title/schedule/useMail/cap/timeZone. Bumps the version and cancels queued runs (`source-changed`, or `schedule-changed` when the schedule changed). If `pause_reason='cap-reached'` and the new cap exceeds `agentSpend`, it sets `active` and clears `pause_reason`.
  - `POST /api/v1/agents/:id/run` (`{ operationId, expectedVersion }`): manual `queued` run. Requires `active`, otherwise 409 `AGENT_PAUSED`.
  - `GET /api/v1/agents/worker` → `agentWorkerSchema`; `healthy` when `lastTick` is under 90 s old and there is no error.
  - Pause/resume/delete stay on `/api/v1/responsibilities/:id…`. Resume clears `pause_reason` and recomputes `next_due_at` with `firstSlotAfter` (no back-fill). Delete sets `ai_conversations.responsibility_id = NULL`.

- [ ] **Step 1: Failing tests**
  - `creates Daily plan at 15:00 local with the first run tomorrow 07:00`: `nextRunAt` equals the next day 07:00 in the zone; `GET /assistant/conversations` lists it with `agent.title`.
  - `edit cancels queued runs; raising the cap resumes a cap-reached agent`.
  - `Run now queues a manual run that the next tick executes`, producing a turn with `trigger 'agent'` and `ask 'Run now'`.
  - `pinned conversation cannot be deleted; deleting the agent unpins and keeps it`.
  - `rejects foreign IDs` (second owner gets 404) and `rejects goals over 2000 characters`.
  - `export includes agent fields and run outcomes` (features.test.ts export case).
  - `GET /notifications returns runId and conversationId for agent notifications and null for reminders`.
- [ ] **Step 2: Run** `npm run test -w apps/api -- agents features`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agents): agents API`

### Task 7: Template text, docs stub and PR

**Files:**
- Modify: `packages/contracts/src/agents.ts` (final `agentTemplates` text)
- Modify: `docs/responsibilities.md` (one paragraph: agents execute; legacy reviews unchanged), `docs/implementation-log.md` (receipt)
- Test: `apps/api/tests/agents.test.ts`

**Interfaces:**
- Produces: `agentTemplates`:
  - `daily-plan.instructions`: "Read today's tasks, events and deadlines (and recent mail if provided). Write a short plan for today in the reply. Propose changes only where something is clearly missing or misplaced."
  - `mail-triage.instructions`: "Look at recent mail. In the reply, list messages that need action. Propose a task only when the mail states a deadline; quote the deadline text in the task notes."
  - `deadline-watch.instructions`: "Check deadlines in the next 7 days. For each one at risk, propose a study block (event.create) before it, avoiding existing events."
  - `customInstructions`: "Work toward the owner's goal below using the tasks, events and mail provided."
  - Default goals equal the template titles' purpose in one sentence each; titles "Daily plan", "Mail triage", "Deadline watch".

- [ ] **Step 1: Failing test** `each template's prompt contains its instructions, the goal and the run date`.
- [ ] **Step 2: Run** `npm run test -w apps/api -- agents`. Expected: FAIL.
- [ ] **Step 3: Write the template text and doc paragraphs.**
- [ ] **Step 4: Run `npm run check`.** Expected: PASS.
- [ ] **Step 5: Commit, push branch `agents/backend`, open a PR to `main` (body ends with the Claude Code line), and link it with `link_pull_request`.**
