# Full-app agent capabilities

Status: inventory and phase-1 implementation, 2026-11-07. Phase 1 (registry, task/event delete/restore, study preferences, audit snapshots and undo) is implemented; the matrix marks the remaining phases. This follows the deployed context/reminder slice (PR #73, release `f99fdf7`).

## Inventory

The app exposes planner records (tasks, reminders, calendar series/occurrences, classes/topics, academic work, tracked deadlines, responsibilities/agents), mailbox records (connectors, messages, drafts, rules, broker grants), memory, study plans/goals, AI settings/routing/budget/actions, account/session state, and Recently deleted. The Android shell exposes the same bundled UI with native notifications and cookies; no separate server entity.

## Capability matrix

| Entity | Read | Create | Update | Delete | Restore / bulk |
| --- | --- | --- | --- | --- | --- |
| Tasks | context (`planner-task-v1`) | existing `task.create` | existing `task.update` | **new** `task.delete` (Tier 2) | **new** `task.restore`; batch missing |
| Task reminders | context (`planner-reminder-v1`) | existing `reminder.create` | existing `reminder.update` | existing `reminder.cancel` (Tier 2 always approval) | n/a |
| Calendar events | context (`planner-event-v1`) | existing `event.create` | existing `event.update` | **new** `event.delete` (Tier 2) | **new** `event.restore`; batch missing |
| Occurrences | context | n/a | existing occurrence edit | existing occurrence delete | missing undo |
| Classes/topics | context (`planner-course-v1`) | missing | missing | missing | missing |
| Academic work | selected context only | missing | missing | missing | batch/restore missing |
| Tracked deadlines | context (`tracked-deadline-v1`) | n/a | missing | n/a | complete/reopen missing |
| Responsibilities/agents | agent UI | missing | missing | missing | pause/resume missing |
| Notifications | API/UI | n/a | **new** mark read (Tier 1) | n/a | bulk read missing |
| Preferences | API/UI | n/a | **new** `preference.update` (Tier 1) | n/a | revert is a normal update |
| Memory | API/UI | missing | missing | missing | forget/history missing |
| Study settings/goals | API/UI | missing | missing | missing | plan approval missing |
| Mail messages | within existing broker grant | n/a | **new** label/read/archive (Tier 2/3 by action) | archive only | rules/drafts missing |
| Mail drafts | within existing grant | missing | missing | missing | send is Tier 3, never auto |
| Recently deleted | API/UI | n/a | n/a | n/a | **new** generic restore |
| Account/auth/sessions | API/UI | prohibited | prohibited | prohibited | prohibited |
| AI routing/budget/actions/consent | API/UI | prohibited | prohibited | prohibited | prohibited |

Risk tiers:

- **Tier 1** reads and owner-data creates/updates: allowed by default in a direct chat; background agents follow the normal action policy. Includes tasks, reminders, events, planner items, classes, notes, preferences and notification read.
- **Tier 2** deletes, restores, bulk changes over ~10 records and mail archiving: soft delete through Recently deleted where available and per-action approval.
- **Tier 3** sending/replying to mail, outward-facing actions, Canvas submissions, account/password/auth/sessions/tokens and AI permission policies: approval every time; the agent can never widen its own permissions.

## Framework

One server capability registry (`apps/api/src/ai/capabilities.ts`) with a zod schema per capability, owner-scoped target lookup, optimistic version, risk tier, apply/undo, before/after snapshot and audit row. Existing task/event/reminder proposal tools remain the first registry entries; new tools use the same execution and audit path rather than separate handlers. The model receives a compact capability list and returns generic `{capability, arguments}` calls; invalid or unavailable capabilities are dropped and counted. The audit log stores operation ID, capability, target, tier, decision and before/after snapshots (no prompt/mail text); `undo last agent action` and the Settings audit view use that snapshot.

Settings > AI > Actions gains grouped grants and an "Allow Tier 1 changes automatically" toggle. Tier 2/3 remain approval-required; account/auth and AI policy capabilities are never exposed.

Migration 078 additively adds snapshot/undo columns to `ai_capability_audit`; no applied migration changes. Rollback remains code-only for the additive schema.

## Rollout

1. Registry, audit snapshots/undo, Tier 1 preference/notification tools, task/event delete and restore.
2. Classes/topics, academic work and tracked deadlines.
3. Responsibilities, memory and study settings.
4. Mail labels/read/archive within the existing broker grant; drafts/send remain Tier 3 and out of scope for auto-apply.
5. Full tests, production DB-copy migration check and staged release.


## Phase 1 receipt

Implemented `apps/api/src/ai/capabilities.ts` with owner-scoped definitions for `task.delete`, `task.restore`, `event.delete`, `event.restore` and `study.preferences.update`. The model receives generic `tools: [{capability, arguments}]` calls; arguments may reference context refs for deletes and are resolved server-side. Tier 1 uses the new `capabilities` grant; Tier 2 deletes/restores always require approval; Tier 3 capabilities are never exposed. Migration 078 adds before/after snapshots, operation/tool identity and undo state to the 077 audit table.

`GET /api/v1/ai/capabilities/audit` returns recent decisions; `POST /api/v1/ai/capabilities/undo` reverses a stored snapshot. Settings > AI > Actions shows the new grant group, a Tier-1 automatic button and the audit list with Undo. Marked task/event updates continue through the existing audited proposal path; their existing proposal Undo is unchanged.

Still missing from the full matrix: classes/topics, academic-work CRUD/batch/restore, tracked-deadline overrides/completion, responsibilities, memory, study goals/plans, notification reads, and mail labels/read/archive/drafts. These are the next phases; the registry and audit/undo schema are ready for them.


## Auto-approve toggle (added 2026-11-07)

Settings > AI > Actions has an owner-only **Auto-approve agent changes** switch, default OFF. When ON, Tier 1 and Tier 2 proposals that would normally wait for approval are applied automatically for both direct owner asks and scheduled agents. Tier 3 actions still prompt; the agent has no capability that can read or change this switch, and a setting change is itself audited with before/after policy state. Auto-applied actions carry `auto_approved=true` in `ai_capability_audit`, remain undoable through the proposal UI or the audit Undo button, and deletes remain soft deletes in Recently deleted. A separate Tier 3 opt-in is not built.
