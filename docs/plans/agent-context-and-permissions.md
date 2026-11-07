# Agent context and permissions

Status: implemented 2026-11-07. This is the release slice for server-side assistant context assembly and owner-granted agent writes.

## Context today and gaps

`answerTurn` currently builds one read-only planner snapshot with `livePlannerContext`: up to 150 open tasks and 150 ordinary events in a -1/+30 day window. Owners can additionally select academic work, memory and (for the deadline-watch template) tracked deadlines. Mail is available only through the existing broker grant and Use mail path. Conversation history is the newest bound turns that fit in 10 turns and 8,000 characters; older turns are dropped without a summary.

Gaps:

- Reminders attached to open tasks are not sent, so the model cannot avoid duplicate reminders or update one intentionally.
- Classes, tracked Canvas deadlines and academic work are invisible unless manually selected.
- There is no server-side token/byte budget with section priority. A large task/event window can crowd out history or the request.
- Long conversations lose earlier instructions instead of retaining a compact deterministic summary.
- The run record exposes spend and outcomes but not the source kinds that formed the context.
- The model can create/update tasks and events but cannot create, update or cancel a task reminder, or delete a task/event.

## Target context assembly

Add a server-side `assistantContext` builder used by both owner asks and agent runs. It keeps the existing proposal refs (`t*`, `e*`, `a*`, `m*`, `d*`) and adds:

1. `now` plus the owner timezone (already present; keep it first).
2. Open tasks ordered by due date, with title, due date, optional local due time, priority, and a compact list of their queued/paused reminders (`r*`).
3. Upcoming ordinary calendar events (today through 30 days, existing eligibility rules).
4. Classes (`c*`: name, archived flag) and tracked Canvas deadlines (`d*`: title, due, completion, source availability/conflict) within the owner's labels.
5. Mail only when the existing Use mail grant and broker retrieval are active. The broker's selected messages remain the mail summary; no new mailbox read path is introduced.
6. A deterministic history summary for turns trimmed from the resend window.

Budget and trimming:

- Target 6,000 estimated tokens for the assembled system+context payload (the existing 1,500 output-token cap is unchanged). Estimate conservatively from serialized characters.
- Assemble in priority order: time/timezone; tasks and reminders; events; classes/deadlines; history summary; mail. Drop whole items from the lowest-priority section first, never split a JSON object, and record `trimmed` counts.
- Keep at most the current source limits (350 live sources, 1,000 history sources). Every included item has a manifest source with a private digest.
- History reads up to 40 bound turns, selects newest-first within its own token budget, and emits a deterministic summary of the omitted/truncated turns (ask -> reply, clipped, no new provider call). The summary is sent as a system message and is not treated as a new source.

Audit:

- `ai_live_exchanges.manifest.sources` already records every included source. `GET /api/v1/agents/:id/runs` will return a redacted `contextSources` list per run: `{kind, projection, ref, truncated}` only, no record IDs, titles or text.
- Requests/turns keep their existing source manifest; no prompt or mail text is added to the run row.

## Permissions and tools

Extend the existing `ai_action_policies.policy` with:

- `reminders`: `automatic | approval-required | blocked`, default `approval-required`. Covers reminder create/update/cancel. When automatic and the owner has granted it, low-risk reminders on the owner's own tasks apply without per-action approval.
- `deletions`: `approval-required | blocked`, default `approval-required`. Covers task.delete and event.delete. The server never applies a delete automatically; the owner must approve it.
- Existing `tasks` and `calendar` continue to cover task/event create and update.
- `email` remains approval-required.

New proposals and action schema entries:

- `reminder.create`: target task ref, title, local scheduled wall time and timezone; resolved server-side to the task and owner. Apply creates one reminder through the ordinary versioned reminder write.
- `reminder.update`: target reminder ref, optional title and scheduled time; versioned update. Apply preserves the target task.
- `reminder.cancel`: target reminder ref; apply uses the existing cancel control. Undo recreates an equivalent reminder.
- `task.delete`: target task ref; only with the existing version, approval required.
- `event.delete`: target event ref; only with the existing version, approval required.

Invariants:

- Every lookup is owner-scoped; refs resolve only to records in the admitted context.
- Destructive proposals always go through the approval flow even if a policy row says automatic.
- Every applied/proposed/blocked/failed capability decision writes an `ai_capability_audit` row with owner, optional agent, turn, capability, target kind/id, decision and a short reason. No prompt/mail text is stored.
- Reminder writes use the existing `reminders` table and worker; web and Android delivery remain the same path. Tests must prove an agent-created reminder becomes a delivered notification.

## Migration

Append `077_ai_capability_audit.sql` after 076. It adds only `ai_capability_audit` and its indexes; no applied migration is edited. The policy JSON is additive (new keys receive defaults), so existing owner rows remain valid.

Rollback: application rollback to the previous release is safe because the migration is additive and old code ignores the new table/keys. Do not drop the audit table during a rollback; retain it for audit and forward fixes.

## Tests and release checks

- Unit: budget/trim priority, history summary determinism, source manifest entries, context source redaction.
- Integration: granted vs not granted for each new tool; owner scoping/foreign refs; audit rows; reminder create/update/cancel through the worker; task/event delete approval; agent run `contextSources`.
- Full unit/API suite, browser suite, lint, typecheck, formatting and build.
- Migration check against a fresh `pg_dump` copy of production: 76 applied, 077 pending, no checksum changes.
- Release: back up release dir and DB, deploy, migrate, restart, health/log checks, then one synthetic smoke action creating a reminder on a test task and deleting the test data.


## Implementation receipt

Implemented in `apps/api/src/ai/assistant-context.ts`, `live-projections.ts`, `live-history.ts`, `live-guard.ts`, `features/assistant.ts`, `features/assistant-write.ts`, `agent-run.ts`, `agent-worker.ts`, `features/reminders.ts`, `features/capability-audit.ts`, `packages/contracts/src/{assistant,assistant-writes,ai-actions,agents}.ts`, `AIActionSettings`, and migration `077_ai_capability_audit.sql`.

- The context builder reads up to 150 tasks/events, then fits a 24,000-character projected budget with 60 tasks, 60 events, 40 reminders and 30 classes; `trimmed` reports dropped items. Reminders, classes and tracked deadlines are manifest sources and are re-projected by the final guard; history eligibility understands the new kinds.
- History reads 40 bound turns, keeps 12,000 characters, and produces a deterministic summary of older bound turns.
- Reminder create/update/cancel proposals use the ordinary versioned reminder table and worker. Automatic reminders require the owner grant; cancel always asks first. Task/event create/update remain the existing proposal path.
- `ai_capability_audit` records applied/proposed/blocked/failed decisions with owner, optional agent, turn, capability, action, target and reason. `AgentRun.contextSources` exposes redacted `{kind, projection, ref, truncated}` rows.
- Tests: `agent-context-permissions.test.ts` covers context inclusion/trimming, history summary, reminder write/update/cancel/delivery/owner scoping, policy modes and audit rows; AI action and tracked-deadline tests were updated for the additive policy key and broader deadline context.
