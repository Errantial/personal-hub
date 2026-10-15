# Persistent agents, PR 3: notifications and docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent notifications in Inbox and Today link to their thread, and the docs describe agents as implemented with the D57 out-of-scope list intact.

**Architecture:** PR 1 already writes agent notifications (`runId`, `conversationId`). This PR renders them as links, marks them read when their thread is opened, keeps them out of the browser `Notification` alert (native or push notifications are out of scope), and updates the docs.

**Tech Stack:** React 19, Playwright, Markdown docs.

**Spec:** [docs/superpowers/specs/2026-10-14-persistent-agents-design.md](../specs/2026-10-14-persistent-agents-design.md). Contracts come from [PR 1 Task 1](2026-10-14-agents-1-backend.md).

## Global Constraints

- Requires PRs 1 and 2 merged.
- Notifications stay in the hub Inbox. No browser, OS or push notification is shown for agent notifications.
- Reminder notification behaviour is unchanged.
- Docs keep completed work distinct from proposals (AGENTS.md); the out-of-scope list stays word-for-word consistent across the spec, agent-scope.md, backlog.md and D57.
- Run `npm run check` and `npm run test:e2e`.

## Review Focus

1. **Inbox open when an agent notification arrives** — expected: no browser `Notification` pops up (reminders still do). Test in Task 1.
2. **Notification for a thread whose agent was deleted** — expected: the link still opens the kept conversation. Test in Task 1.
3. **Opening the thread from somewhere other than Inbox** — expected: that run's notification is marked read, so the unread count drops. Test in Task 1.
4. **Many notifications from Mail triage at four runs a day** — expected: history paging keeps working with mixed reminder and agent rows. Test in Task 1.
5. **A future agent reading the docs** — expected: they find the out-of-scope list next to every "agents implemented" statement. Check in Task 2.

---

### Task 1: Inbox and Today links, read state, no browser alert

**Files:**
- Modify: `apps/web/src/components/InboxView.tsx`, `apps/web/src/components/TodayView.tsx`
- Modify: `apps/web/src/components/AssistantView.tsx` (mark agent notifications read on open)
- Modify: `apps/api/src/features/reminder-inbox.ts` only if history paging needs the new columns (it reads `notificationColumns`, updated in PR 1)
- Test: `tests/e2e/inbox.spec.ts`, `tests/e2e/today.spec.ts`, `apps/api/tests/reminder-inbox.test.ts`

**Interfaces:**
- Consumes: `HubNotification.conversationId`, `HubNotification.runId`, `POST /api/v1/notifications/read` (`notificationIds`).
- Produces:
  - **Links.** An agent notification row (`conversationId !== null`) renders its title as a `Link` to `{ name: 'assistant', id: conversationId }`; reminder rows are unchanged. Today's unread list does the same.
  - **No browser alert.** `alertNew` skips items with `runId !== null`.
  - **Read on open.** When `AssistantView` loads a conversation that has unread notifications, it posts `notifications/read` for them once. It reads the unread notifications filtered by `conversationId` from `GET /api/v1/notifications`.

- [ ] **Step 1: Failing tests**
  - `inbox.spec.ts › agent notification links to its thread and raises no browser alert`: grant notification permission in the context and spy on `window.Notification`. Seed one reminder and one agent notification. Only the reminder triggers the spy, and clicking the agent row opens `/assistant/<conversationId>`.
  - `inbox.spec.ts › opening the thread marks it read`: the unread count drops by one after visiting the thread directly.
  - `today.spec.ts › Today unread list links agent notifications`.
  - `reminder-inbox.test.ts › history pages across mixed reminder and agent notifications`: insert 30 mixed rows. Two pages return all rows once, in `created_at DESC, id DESC` order.
- [ ] **Step 2: Run** `npx playwright test inbox today` and `npm run test -w apps/api -- reminder-inbox`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(agents): Inbox and Today link agent notifications`

### Task 2: Docs

**Files:**
- Modify:
  - `docs/ai-assistant.md`: agent runs share the pipeline; run turns; trigger.
  - `docs/responsibilities.md`: agents execute; queued/running/completed/failed; legacy reviews remain blocked.
  - `docs/agent-scope.md`: mark the D57 slice implemented and keep its out-of-scope list.
  - `docs/ai-actions.md`: action settings now govern agent runs; task default.
  - `docs/ui-agent-ledger.md`: notification links and read-on-open.
  - `docs/backlog.md`: move persistent agents to done with the release; keep the out-of-scope sentence.
  - `docs/decisions.md`: D57 status implemented.
  - `docs/implementation-log.md`: receipts for PRs 1–3 with test counts.

- [ ] **Step 1: Check the out-of-scope wording.** Run `grep -n "Out of scope\|out of scope" docs/agent-scope.md docs/backlog.md docs/decisions.md docs/superpowers/specs/2026-10-14-persistent-agents-design.md`. Expected: all four files list the same 13 items.
- [ ] **Step 2: Write the doc updates.** Each "implemented" statement links to the spec's out-of-scope section.
- [ ] **Step 3: Run `npm run check`** (includes Prettier on Markdown). Expected: PASS.
- [ ] **Step 4: Commit** `docs(agents): agents implemented; out-of-scope list retained`

### Task 3: Full validation, PR, deploy

- [ ] **Step 1: Run `npm run check` and `npm run test:e2e`.** Expected: all PASS.
- [ ] **Step 2: Push `agents/notifications`, open a PR to `main`, and link it.**
- [ ] **Step 3: After the owner merges, deploy** with the standard release procedure: build, tar, `npm ci --omit=dev`, `verify-restore.sh`, symlink swap, restart, `/api/ready`, Caddy reload, live bundle hash check. Then confirm `GET /api/v1/agents/worker` reports healthy within 90 s. No agent exists until the owner creates one, so nothing spends money at deploy.
