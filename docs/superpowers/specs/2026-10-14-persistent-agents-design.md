# Persistent agents — design

Approved in conversation 2026-10-14 (D57). First executing slice of the persistent-agent scope in [agent-scope.md](../../agent-scope.md), built on the existing responsibilities backend ([responsibilities.md](../../responsibilities.md)) and the live Assistant pipeline ([ai-assistant.md](../../ai-assistant.md)).

## Goal

Agents that do work on a schedule without the owner present:

- **Daily plan** — each morning, read today's tasks, events, deadlines and new mail; write a short plan and propose changes.
- **Mail triage** — through the day, look at new mail, flag what needs action and propose tasks with quoted deadlines.
- **Deadline watch** — each evening, check the next 7 days and propose study blocks for deadlines at risk.
- **Custom** — goals the owner writes in plain language, on their own schedule.

The first three are templates: pre-filled goal text and schedule that the owner can edit. All four use one engine.

## Decisions

| Topic | Decision |
| --- | --- |
| Authority | Proposals follow the owner's action settings (Settings › AI › Actions): **automatic** categories are applied by the worker with Undo; **approval-required** wait for Apply; **blocked** are dropped and counted; email is always approval-required and never sent. |
| Task default | Owners who never saved action settings move from tasks `blocked` to `approval-required`; saved settings are untouched. Calendar stays `automatic`. |
| Budget | Runs count against the existing $0.25 request and $50 monthly caps, plus a per-agent monthly cap (default $2). Reaching it pauses the agent (`cap-reached`). |
| Placement | Each agent is a pinned conversation in the Assistant page; each run is a turn; owner replies in the thread steer later runs. |
| Notifications | An Inbox notification only when a run applied changes, needs approval, warns, or failed. |
| Runner | In-process worker inside the API server, following the reminder worker's lease pattern. One run at a time. |

Existing rules still apply: text only; mail eligibility by owner labels (Restricted never, Personal only with the existing switch); privacy routing with zero data retention and no silent fallback; append-only migrations; tests never call real providers or spend money.

## 1. Data model and lifecycle

Migration 057 (new; no earlier migration changes):

- `responsibilities` gains `template` (`daily-plan` | `mail-triage` | `deadline-watch` | `custom`), `conversation_id` (the pinned conversation), `time_zone`, `use_mail` (boolean), `monthly_cap_micros` (default 2 000 000).
- `responsibility_runs.status` adds `queued`, `running`, `completed`, `failed` (existing `blocked`/`cancelled` rows remain valid). New columns: `lease_token`, `lease_until`, `attempts`, `turn_id` (the conversation turn produced), `outcome` (`quiet` | `applied` | `needs-approval` | `warning` | `failed`), `error_code`, `finished_at`. New admissions create `queued` runs.
- `responsibility_runs.cancel_reason` adds `cap-reached`; `responsibility_activities.kind` adds `run-started`, `run-completed`, `run-failed`, `cap-reached`.
- `ai_conversations` gains nullable `responsibility_id` (pinned thread). `ai_conversation_turns` gains `trigger` (`owner` | `agent`, default `owner`).
- `responsibility_schedules.local_rule` accepts an optional `times` list (1–6 `HH:MM` values) for daily rules: slots are each listed time on each day. The constraint is replaced in 057; single-time rules are unchanged.
- `notifications.reminder_id` becomes nullable; new nullable `run_id` and `conversation_id`; a check requires exactly one source (reminder, or run plus conversation).
- `ai_action_policies` default for tasks becomes `approval-required` for owners without a saved row (code default; no row rewrite).

Lifecycle:

- Pause, cancel, delete, goal edit or schedule change cancels **queued** runs (existing reasons). A **running** run finishes; its result is saved.
- Delete unpins the conversation and keeps it.
- Resume never back-fills missed slots (existing coalescing).
- Reaching the monthly cap pauses the agent with `cap-reached` and cancels its queued runs. It resumes when the owner raises the cap or resumes it; a new month does not auto-resume.

## 2. Worker and execution

`startAgentWorker(database, config, fetcher)` starts with the API when an OpenRouter key is configured and `AGENT_WORKER` is not `off` (tests set `off` and drive ticks directly). It records `worker_state('agents')`.

Every 30 seconds:

1. **Admit** due schedules of active agents into `queued` runs with the existing admission rules (server time, coalesced missed slots, one run per slot).
2. **Claim** the oldest queued run (`FOR UPDATE SKIP LOCKED`, 10-minute lease). One run executes at a time.
3. **Recheck before any hold**: agent active and at the admitted version, schedule unchanged, under its monthly cap, key configured, model passes the private-host check. A failed check ends the run `failed` with a reason; nothing is spent.
4. **Run** through `answerTurn(owner, { text, timeZone, conversationId, useMail, trigger: 'agent' })`, extracted from `POST /api/v1/assistant/requests` so owner asks and agent runs share holds, caps, the up-to-3-call mail flow, label rules and the last-10-turn history. The ask text is the template's instructions, then the owner's goal, then the run date and time zone; the system prompt states it is a scheduled run with no owner present.
5. **Apply** each proposal by action settings: automatic → applied by the worker through the same versioned planner write the browser uses, with the item's `applyId` as operation ID, stored as `applied` (Undo works as today); approval-required → `proposed`; blocked → dropped and counted ("N not allowed by settings"). Email is never sent. A version conflict fails that item only.
6. **Finish**: set `outcome`, link `turn_id`, add per-agent spend, write the notification when the outcome is not `quiet`, release the lease.

Failures:

- Provider errors end the run `failed` with the reason. Rate limits and transport errors get one automatic retry 15 minutes later.
- An uncertain outcome (the request may have reached OpenRouter) is never resent; its hold stays (current behavior).
- An expired lease after a restart marks the run `failed` (`LEASE_EXPIRED`) and does not resend.

## 3. API and UI

API (contracts in `packages/contracts`; owner-authorized; versioned receipts):

- `POST /api/v1/agents` — create from a template or custom goal (title, goal, schedule, useMail, monthlyCapMicros, timeZone). One transaction creates the responsibility, local schedule and pinned conversation, then activates it.
- `GET /api/v1/agents` — agents with status, next run, last outcome, spend this month and cap.
- `PUT /api/v1/agents/:id` — edit. Pause, resume and delete reuse the responsibility endpoints.
- `POST /api/v1/agents/:id/run` — Run now (a manual queued run, same rechecks).
- `GET /api/v1/agents/worker` — worker health.
- `GET /api/v1/assistant/conversations` adds an `agent` summary for pinned threads; turns add `trigger`; notification items add an optional thread link.

UI:

- **Assistant list**: a pinned **Agents** group above Conversations — name, state ("Next 7:00 AM", "Paused", "Cap reached", "Failed"), an unread dot after a new run — and **New agent**.
- **Agent dialog** (new, and from the thread header): template picker that pre-fills title, goal and schedule; goal text; schedule (daily or weekly at one or more local times); Use mail; monthly cap; spend this month; Pause/Resume, Run now, Delete.
- **Agent thread**: the existing chat. Run turns show a muted "Scheduled run · Tue 7:00 AM" line instead of a "You" bubble. Auto-applied items show "Applied" with Undo; dropped items are counted in the details line. A failed run shows a short reason with Retry (Run now).
- **Settings › AI › Actions** (new): Tasks and Calendar as Automatic / Ask first / Off; "Email: always asks first" (fixed). Help says this governs agent runs; Assistant answers always ask first.
- **Inbox**: agent notifications link to the thread.

Templates live in code (text plus default schedule):

| Template | Default schedule | Mail |
| --- | --- | --- |
| Daily plan | Daily 07:00 | On |
| Mail triage | Daily 08:00, 12:00, 16:00, 20:00 | On; proposes tasks only with quoted deadlines |
| Deadline watch | Daily 18:00 | Off; next 7 days, proposes study blocks |

## 4. Testing and rollout

Synthetic only (fake OpenRouter fetcher):

- API: admission and coalescing; claim/lease and single concurrency; each recheck (paused, version changed, cap reached, no key, model not private); auto-apply split including a conflicting item; Undo of an auto-applied item; uncertain outcome not resent; expired lease marked failed; one retry for rate limits; notifications only for non-quiet outcomes; per-agent spend and cap pause; multi-time daily schedules across DST; export includes agents; restart persistence; populated migration upgrade through 057.
- E2E (stubbed agent endpoints, `AGENT_WORKER=off`): create from a template; pinned group and states; Run now produces a run turn; Undo of an applied item; Settings › AI › Actions save; Inbox notification links to the thread; accessibility and dark sweeps include the dialog.

Rollout in three PRs:

1. Backend — migration 057, `answerTurn` extraction, worker, agents API, tests.
2. UI — Agents group, dialog, thread run turns, Settings › AI › Actions.
3. Notifications and templates polish; docs (ui-agent-ledger, ai-assistant, responsibilities, agent-scope, backlog, D57).

No agent exists after deploy until the owner creates one, so nothing spends money until then.

## Out of scope (recorded for future work)

These are deliberately **not** part of this slice. Do not implement them as side effects of agent work; each needs its own owner decision, design and spec. The same list is recorded in [agent-scope.md](../../agent-scope.md), [backlog.md](../../backlog.md) and D57 in [decisions.md](../../decisions.md).

- **Event triggers** — runs started by events (new mail, a Canvas change, a task edit). Agents run only on schedules or Run now.
- **Parallel runs** — more than one agent run at a time.
- **Delegation** — agents starting or instructing other agents, or sub-agents.
- **MCP tools** — in either direction (hub as MCP server, or agents calling external MCP tools).
- **Web browsing** — fetching pages, a text browser, or any network access beyond OpenRouter.
- **Sending email** — including invitations, attendee updates and cancellations; drafts remain owner-approved through the existing email draft flow.
- **External calendar writes** — Proton or Outlook calendars; only hub calendar records are written.
- **Memory edits** — agents reading or changing owner memory automatically.
- **Voice** and other non-text input or output.
- **Separate agent personas** — distinct roles with their own instructions, tool permissions or memory; all agents share the one assistant model and settings.
- **Learning** — proposed reusable skills or preference learning from runs.
- **Auto-resume at month start** after a cap pause.
- **Native/push notifications** — notifications stay in the hub Inbox.
