import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyRequest,
  assistantProposalSchema,
  reminderResponseSchema,
  taskResponseSchema,
} from '@hub/contracts';
import { startHarness } from './helpers/openrouter.js';
import { assistantContext } from '../src/ai/assistant-context.js';
import { readBoundHistory } from '../src/ai/live-history.js';
import { turnDigest } from '../src/ai/live-manifest.js';
import { toProposal } from '../src/features/assistant.js';
import { plannedWrite } from '../src/features/planner-write.js';
import { reminderColumns } from '../src/features/reminders.js';
import { runReminderBatch } from '../src/features/reminders.js';
import {
  applyByPolicy,
  proposalPolicyMode,
  proposalTier,
} from '../src/features/agent-run.js';
import { recordCapabilityAudit } from '../src/features/capability-audit.js';
import {
  executeCapability,
  modelCapabilityProposal,
  undoCapability,
} from '../src/ai/capabilities.js';
import { readStudyPreferences } from '../src/features/study-engine.js';
import { readTurn } from '../src/features/assistant-conversations.js';
import { proposalDigest } from '../src/features/ai-planner-origin.js';

async function seedTask(
  h: Awaited<ReturnType<typeof startHarness>>,
  title: string,
) {
  const reply = await h.call('POST', '/api/v1/tasks', {
    title,
    dueDate: '2030-01-01',
    operationId: randomUUID(),
  });
  expect(reply.statusCode).toBe(200);
  return reply.json().task as { id: string; title: string; version: number };
}

async function seedTurn(h: Awaited<ReturnType<typeof startHarness>>) {
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const reservation = randomUUID();
  await h.database.query(
    'INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,$3)',
    [conversationId, h.owner, 'Capability test'],
  );
  await h.database.query(
    `INSERT INTO ai_budget_reservations
      (id,owner_id,request_id,request_hash,month,provider,model,policy_version,reserved_micros,actual_micros,status)
     VALUES($1,$2,$3,$4,'2026-11-01','synthetic','synthetic/model',1,1000,0,'released')`,
    [reservation, h.owner, turnId, 'h'.repeat(64)],
  );
  await h.database.query(
    `INSERT INTO ai_assistant_requests
      (id,owner_id,operation_id,request_hash,model,reservation_id,status,cost_micros)
     VALUES($1,$2,$3,$4,'synthetic/model',$5,'completed',0)`,
    [turnId, h.owner, randomUUID(), 'h'.repeat(64), reservation],
  );
  await h.database.query(
    `INSERT INTO ai_conversation_turns
      (id,owner_id,conversation_id,position,ask,reply,inference_history,inference_digest,inference_sources)
     VALUES($1,$2,$3,0,'Test','Done','bound',$4,'[]'::jsonb)`,
    [
      turnId,
      h.owner,
      conversationId,
      turnDigest(h.owner, turnId, 'Test', 'Done'),
    ],
  );
  return turnId;
}

describe('agent context and reminder permissions', () => {
  it('assembles tasks, reminders, classes and proposes reminder tools', async () => {
    const h = await startHarness();
    const task = await seedTask(h, 'Context task');
    const reminder = await h.call('POST', '/api/v1/reminders', {
      title: 'Existing reminder',
      scheduledAt: '2030-01-01T09:00:00.000Z',
      targetKind: 'task',
      targetId: task.id,
      operationId: randomUUID(),
    });
    expect(reminder.statusCode).toBe(200);
    const course = await h.call('POST', '/api/v1/courses', {
      name: 'Context class',
      operationId: randomUUID(),
    });
    expect(course.statusCode).toBe(200);

    const context = await assistantContext(h.database, h.owner, 'UTC');
    const taskIndex = context.tasks.findIndex((item) => item.id === task.id);
    const reminderIndex = context.reminders?.findIndex(
      (item) => item.targetId === task.id,
    );
    expect(taskIndex).toBeGreaterThanOrEqual(0);
    expect(reminderIndex).toBeGreaterThanOrEqual(0);
    expect(context.courses?.some((item) => item.name === 'Context class')).toBe(
      true,
    );

    const create = toProposal(
      {
        type: 'reminder.create',
        ref: `t${taskIndex + 1}`,
        title: 'Agent reminder',
        start: '2030-01-01T09:30',
        dueDate: null,
        clearDueDate: false,
        priority: null,
        completed: null,
        end: null,
        allDay: null,
        notes: null,
      },
      context,
      'UTC',
    );
    expect(assistantProposalSchema.parse(create)).toMatchObject({
      kind: 'reminder.create',
      target: { id: task.id },
      reminder: { title: 'Agent reminder' },
    });

    const recurring = toProposal(
      {
        type: 'reminder.create',
        ref: `t${taskIndex + 1}`,
        title: 'Weekly planning reminder',
        start: '2030-01-06T19:00',
        dueDate: null,
        clearDueDate: false,
        priority: null,
        completed: null,
        end: null,
        allDay: null,
        notes: null,
        recurrence: 'FREQ=WEEKLY;BYDAY=SU;COUNT=4',
        reminderOffsets: null,
        scope: null,
      },
      context,
      'America/Denver',
    );
    expect(assistantProposalSchema.parse(recurring)).toMatchObject({
      kind: 'reminder.create',
      reminder: {
        recurrence: {
          frequency: 'weekly',
          byDay: ['SU'],
          count: 4,
          timeZone: 'America/Denver',
        },
      },
    });
    const seriesDelete = modelCapabilityProposal(
      'task.delete',
      JSON.stringify({ ref: `t${taskIndex + 1}`, scope: 'series' }),
      context,
    );
    expect(seriesDelete).toMatchObject({
      kind: 'capability',
      capability: 'task.delete',
      tier: 2,
      arguments: { scope: 'series' },
    });

    const existing = context.reminders![reminderIndex!]!;
    const update = toProposal(
      {
        type: 'reminder.update',
        ref: `r${reminderIndex! + 1}`,
        title: 'Changed reminder',
        start: '2030-01-01T10:00',
        dueDate: null,
        clearDueDate: false,
        priority: null,
        completed: null,
        end: null,
        allDay: null,
        notes: null,
      },
      context,
      'UTC',
    );
    expect(assistantProposalSchema.parse(update)).toMatchObject({
      kind: 'reminder.update',
      target: { id: existing.id },
    });
    const cancel = toProposal(
      {
        type: 'reminder.cancel',
        ref: `r${reminderIndex! + 1}`,
        title: null,
        start: null,
        dueDate: null,
        clearDueDate: false,
        priority: null,
        completed: null,
        end: null,
        allDay: null,
        notes: null,
      },
      context,
      'UTC',
    );
    expect(assistantProposalSchema.parse(cancel)).toMatchObject({
      kind: 'reminder.cancel',
      target: { id: existing.id },
    });
    const policy = {
      tasks: 'automatic',
      calendar: 'automatic',
      reminders: 'automatic',
      capabilities: 'automatic',
    };
    expect(
      proposalPolicyMode(assistantProposalSchema.parse(create), policy),
    ).toBe('automatic');
    expect(
      proposalPolicyMode(assistantProposalSchema.parse(cancel), policy),
    ).toBe('approval-required');
    expect(
      proposalPolicyMode(assistantProposalSchema.parse(create), {
        ...policy,
        reminders: 'blocked',
      }),
    ).toBe('blocked');
    const tier = (tier: number) =>
      assistantProposalSchema.parse({
        kind: 'capability',
        capability: 'study.preferences.update',
        arguments: {},
        summary: 'Preference change',
        tier,
      });
    expect(proposalPolicyMode(tier(1), policy)).toBe('automatic');
    expect(proposalPolicyMode(tier(2), policy)).toBe('approval-required');
    expect(proposalPolicyMode(tier(3), policy)).toBe('approval-required');
    expect(
      modelCapabilityProposal('settings.auto_approve', '{}', context),
    ).toBeNull();
    await h.app.close();
  });

  it('writes, updates, cancels and delivers an agent reminder through the worker', async () => {
    const h = await startHarness();
    const task = await seedTask(h, 'Reminder target');
    const context = await assistantContext(h.database, h.owner, 'UTC');
    const taskIndex = context.tasks.findIndex((item) => item.id === task.id);
    const target = context.tasks[taskIndex]!;
    const make = (title: string, scheduledAt: string) =>
      assistantProposalSchema.parse({
        kind: 'reminder.create',
        target,
        reminder: { title, scheduledAt },
      });
    const created = await plannedWrite(
      h.database,
      h.owner,
      applyRequest(
        make('Agent-created reminder', '2020-01-01T00:00:00.000Z'),
        randomUUID(),
      ),
    );
    const [row] = await h.database.query(
      `SELECT ${reminderColumns} FROM reminders WHERE owner_id=$1 AND id=$2`,
      [h.owner, created.id],
    );
    const current = reminderResponseSchema.parse({ reminder: row }).reminder;
    const update = applyRequest(
      assistantProposalSchema.parse({
        kind: 'reminder.update',
        target: current,
        changes: { title: 'Agent-updated reminder' },
      }),
      randomUUID(),
    );
    const updated = await plannedWrite(h.database, h.owner, update);
    expect(updated.version).toBe(current.version + 1);
    await runReminderBatch(h.database);
    const notifications = (await h.call('GET', '/api/v1/notifications')).json()
      .notifications as { reminderId: string; title: string }[];
    expect(
      notifications.some(
        (item) =>
          item.reminderId === created.id &&
          item.title === 'Agent-updated reminder',
      ),
    ).toBe(true);

    const second = await plannedWrite(
      h.database,
      h.owner,
      applyRequest(make('Cancel me', '2030-01-01T00:00:00.000Z'), randomUUID()),
    );
    const [secondRow] = await h.database.query(
      `SELECT ${reminderColumns} FROM reminders WHERE owner_id=$1 AND id=$2`,
      [h.owner, second.id],
    );
    const secondReminder = reminderResponseSchema.parse({
      reminder: secondRow,
    }).reminder;
    const cancel = await plannedWrite(
      h.database,
      h.owner,
      applyRequest(
        assistantProposalSchema.parse({
          kind: 'reminder.cancel',
          target: secondReminder,
        }),
        randomUUID(),
      ),
    );
    expect(cancel.id).toBe(second.id);
    const [cancelled] = await h.database.query(
      'SELECT status FROM reminders WHERE owner_id=$1 AND id=$2',
      [h.owner, second.id],
    );
    expect(cancelled!.status).toBe('cancelled');

    const foreign = assistantProposalSchema.parse({
      kind: 'reminder.create',
      target: { ...target, id: randomUUID() },
      reminder: {
        title: 'Foreign target',
        scheduledAt: '2030-01-01T00:00:00.000Z',
      },
    });
    await expect(
      plannedWrite(h.database, h.owner, applyRequest(foreign, randomUUID())),
    ).rejects.toThrow();
    await h.app.close();
  });

  it('trims the planner window to the context budget', async () => {
    const h = await startHarness();
    for (let index = 0; index < 70; index++)
      await h.database.query(
        `INSERT INTO tasks(id,owner_id,title,due_date,priority,completed,sensitivity)
         VALUES($1,$2,$3,'2030-01-01',$4,false,'unlabeled')`,
        [
          randomUUID(),
          h.owner,
          `${String(index).padStart(2, '0')} ${'x'.repeat(150)}`,
          index % 2 ? 'normal' : 'high',
        ],
      );
    const context = await assistantContext(h.database, h.owner, 'UTC');
    expect(context.tasks.length).toBeLessThanOrEqual(60);
    expect(context.trimmed).toBeGreaterThanOrEqual(10);
    await h.app.close();
  });

  it('executes and undoes permissioned capabilities with owner scoping and audit snapshots', async () => {
    const h = await startHarness();
    const turnId = await seedTurn(h);
    const task = await seedTask(h, 'Capability delete task');
    const deleted = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'task.delete',
      { id: task.id, expectedVersion: 1 },
      randomUUID(),
    );
    const [tombstone] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM tasks WHERE id=$1',
      [task.id],
    );
    expect(tombstone!.deletedAt).not.toBeNull();
    const [audit] = await h.database.query(
      'SELECT capability,decision,undoable,before,after FROM ai_capability_audit WHERE id=$1',
      [deleted.id],
    );
    expect(audit).toMatchObject({
      capability: 'general',
      decision: 'applied',
      undoable: true,
    });
    const beforeSnapshot = audit!.before as { id: string };
    const afterSnapshot = audit!.after as { deletedAt: string | null };
    expect(beforeSnapshot.id).toBe(task.id);
    expect(afterSnapshot.deletedAt).not.toBeNull();
    await undoCapability(h.database, h.owner, deleted.id, randomUUID());
    const [restored] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM tasks WHERE id=$1',
      [task.id],
    );
    expect(restored!.deletedAt).toBeNull();
    const [undoAudit] = await h.database.query(
      'SELECT action,decision,tool,operation_id AS "operationId" FROM ai_capability_audit WHERE owner_id=$1 AND tool=\'undo\' ORDER BY created_at DESC LIMIT 1',
      [h.owner],
    );
    expect(undoAudit).toMatchObject({
      action: 'restore',
      decision: 'applied',
      tool: 'undo',
    });
    expect(undoAudit!.operationId).not.toBeNull();

    const before = await readStudyPreferences(h.database, h.owner);
    const changed = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'study.preferences.update',
      { sessionMinutes: 25 },
      randomUUID(),
    );
    const after = await readStudyPreferences(h.database, h.owner);
    expect(after.sessionMinutes).toBe(25);
    expect(after.version).toBe(before.version + 1);
    await undoCapability(h.database, h.owner, changed.id);
    const undone = await readStudyPreferences(h.database, h.owner);
    expect(undone.sessionMinutes).toBe(before.sessionMinutes);

    await expect(
      executeCapability(
        h.database,
        h.owner,
        turnId,
        'task.delete',
        { id: randomUUID(), expectedVersion: 1 },
        randomUUID(),
      ),
    ).rejects.toThrow();
    await h.app.close();
  });

  it('auto-approves tier 1/2 proposals only when the owner toggle is on', async () => {
    const h = await startHarness();
    const first = await seedTurn(h);
    const firstTask = await seedTask(h, 'Auto-approved delete');
    const proposal = assistantProposalSchema.parse({
      kind: 'capability',
      capability: 'task.delete',
      arguments: { id: firstTask.id, expectedVersion: 1 },
      summary: 'Delete task',
      tier: 2,
    });
    const item = {
      state: 'proposed',
      applied: null,
      error: null,
      applyId: randomUUID(),
      undoId: randomUUID(),
    };
    await h.database.query(
      'UPDATE ai_conversation_turns SET proposals=$2::jsonb,items=$3::jsonb WHERE owner_id=$1 AND id=$4',
      [h.owner, JSON.stringify([proposal]), JSON.stringify([item]), first],
    );
    await h.database.query(
      `INSERT INTO ai_turn_origins(owner_id,turn_id,request_id,capture,proposal_digests)
       VALUES($1,$2,$2,$3::jsonb,$4::jsonb)`,
      [
        h.owner,
        first,
        JSON.stringify({
          requestId: first,
          labels: ['unlabeled'],
          sources: [],
          useMail: false,
          destination: {
            model: 'synthetic/model',
            upstream: 'google-vertex',
            revision: 'a'.repeat(64),
            version: 1,
          },
        }),
        JSON.stringify({
          [item.applyId]: proposalDigest(
            h.owner,
            first,
            item.applyId,
            proposal,
          ),
        }),
      ],
    );
    const policy = {
      tasks: 'approval-required',
      calendar: 'approval-required',
      reminders: 'approval-required',
      capabilities: 'approval-required',
      email: 'approval-required',
    };
    await h.database.query(
      `INSERT INTO ai_action_policies(owner_id,policy,auto_approve)
       VALUES($1,$2::jsonb,true) ON CONFLICT(owner_id) DO UPDATE SET policy=EXCLUDED.policy,auto_approve=true`,
      [h.owner, JSON.stringify(policy)],
    );
    await applyByPolicy(
      h.database,
      h.owner,
      (await readTurn(h.database, h.owner, first))!,
    );
    const [deleted] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM tasks WHERE id=$1',
      [firstTask.id],
    );
    expect(deleted!.deletedAt).not.toBeNull();
    const [audit] = await h.database.query(
      'SELECT auto_approved AS "autoApproved" FROM ai_capability_audit WHERE owner_id=$1 AND tool=$2',
      [h.owner, 'task.delete'],
    );
    expect(audit!.autoApproved).toBe(true);

    const second = await seedTurn(h);
    const secondTask = await seedTask(h, 'Prompted delete');
    const secondProposal = assistantProposalSchema.parse({
      kind: 'capability',
      capability: 'task.delete',
      arguments: { id: secondTask.id, expectedVersion: 1 },
      summary: 'Delete task',
      tier: 2,
    });
    const secondItem = {
      ...item,
      applyId: randomUUID(),
      undoId: randomUUID(),
    };
    await h.database.query(
      'UPDATE ai_conversation_turns SET proposals=$2::jsonb,items=$3::jsonb WHERE owner_id=$1 AND id=$4',
      [
        h.owner,
        JSON.stringify([secondProposal]),
        JSON.stringify([secondItem]),
        second,
      ],
    );
    await h.database.query(
      `INSERT INTO ai_turn_origins(owner_id,turn_id,request_id,capture,proposal_digests)
       VALUES($1,$2,$2,$3::jsonb,$4::jsonb)`,
      [
        h.owner,
        second,
        JSON.stringify({
          requestId: second,
          labels: ['unlabeled'],
          sources: [],
          useMail: false,
          destination: {
            model: 'synthetic/model',
            upstream: 'google-vertex',
            revision: 'a'.repeat(64),
            version: 1,
          },
        }),
        JSON.stringify({
          [secondItem.applyId]: proposalDigest(
            h.owner,
            second,
            secondItem.applyId,
            secondProposal,
          ),
        }),
      ],
    );
    await h.database.query(
      'UPDATE ai_action_policies SET auto_approve=false WHERE owner_id=$1',
      [h.owner],
    );
    await applyByPolicy(
      h.database,
      h.owner,
      (await readTurn(h.database, h.owner, second))!,
    );
    const [stillActive] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM tasks WHERE id=$1',
      [secondTask.id],
    );
    expect(stillActive!.deletedAt).toBeNull();
    expect(assistantProposalSchema.parse(secondProposal).kind).toBe(
      'capability',
    );
    expect(
      await h.database.query(
        "SELECT 1 FROM ai_capability_audit WHERE owner_id=$1 AND tool='settings.auto_approve'",
        [h.owner],
      ),
    ).toHaveLength(0);
    await h.app.close();
  });

  it('undoes a whole recurring task series with its occurrences and reminders', async () => {
    const h = await startHarness();
    const turnId = await seedTurn(h);
    const created = await h.call('POST', '/api/v1/tasks', {
      title: 'Series undo',
      notes: '',
      dueDate: '2027-12-01',
      priority: 'normal',
      completed: false,
      sensitivity: 'unlabeled',
      reminderOffsets: [60],
      recurrence: {
        frequency: 'daily',
        interval: 1,
        count: 3,
        until: null,
        timeZone: 'America/Denver',
      },
      operationId: randomUUID(),
    });
    expect(created.statusCode).toBe(200);
    const first = taskResponseSchema.parse(created.json()).task;
    const done = await h.call('PUT', `/api/v1/tasks/${first.id}`, {
      title: first.title,
      notes: first.notes,
      dueDate: first.dueDate,
      priority: first.priority,
      completed: true,
      sensitivity: first.sensitivity,
      expectedVersion: first.version,
      operationId: randomUUID(),
    });
    expect(done.statusCode).toBe(200);
    const second = (await h.call('GET', '/api/v1/tasks'))
      .json()
      .tasks.find(
        (task: { seriesId: string | null; dueDate: string | null }) =>
          task.seriesId === first.seriesId && task.dueDate === '2027-12-02',
      );
    expect(second).toMatchObject({ id: expect.any(String) });
    const deleted = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'task.delete',
      { id: second.id, expectedVersion: second.version, scope: 'series' },
      randomUUID(),
    );
    const [audit] = await h.database.query(
      'SELECT before,after FROM ai_capability_audit WHERE id=$1',
      [deleted.id],
    );
    expect(
      (audit!.before as { occurrences: unknown[] }).occurrences,
    ).toHaveLength(2);
    const [seriesDeleted] = await h.database.query(
      `SELECT deleted_at AS "deletedAt" FROM recurrence_series
       WHERE owner_id=$1 AND id=$2`,
      [h.owner, first.seriesId],
    );
    expect(seriesDeleted!.deletedAt).not.toBeNull();
    await undoCapability(h.database, h.owner, deleted.id, randomUUID());
    const active = (await h.call('GET', '/api/v1/tasks'))
      .json()
      .tasks.filter(
        (task: { seriesId: string | null }) => task.seriesId === first.seriesId,
      );
    expect(active).toHaveLength(2);
    const [seriesRestored] = await h.database.query(
      `SELECT deleted_at AS "deletedAt",cancelled_from AS "cancelledFrom"
       FROM recurrence_series WHERE owner_id=$1 AND id=$2`,
      [h.owner, first.seriesId],
    );
    expect(seriesRestored).toMatchObject({
      deletedAt: null,
      cancelledFrom: null,
    });
    const openTaskIds = active
      .filter((task: { completed: boolean }) => !task.completed)
      .map((task: { id: string }) => task.id);
    const reminders = await h.database.query(
      `SELECT status FROM reminders WHERE owner_id=$1 AND target_id=ANY($2::uuid[])`,
      [h.owner, openTaskIds],
    );
    expect(reminders.length).toBeGreaterThan(0);
    expect(reminders.every((row) => row.status === 'queued')).toBe(true);

    const openSecond = active.find(
      (task: { id: string }) => task.id === second.id,
    );
    const futureDelete = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'task.delete',
      {
        id: second.id,
        expectedVersion: openSecond.version,
        scope: 'future',
      },
      randomUUID(),
    );
    await undoCapability(h.database, h.owner, futureDelete.id, randomUUID());
    expect(
      (await h.call('GET', '/api/v1/tasks'))
        .json()
        .tasks.filter(
          (task: { seriesId: string | null }) =>
            task.seriesId === first.seriesId,
        ),
    ).toHaveLength(2);
    const [futureSeries] = await h.database.query(
      `SELECT cancelled_from AS "cancelledFrom" FROM recurrence_series
       WHERE owner_id=$1 AND id=$2`,
      [h.owner, first.seriesId],
    );
    expect(futureSeries!.cancelledFrom).toBeNull();
    await h.app.close();
  });

  it('requires approval before an update ends a recurring series', async () => {
    const h = await startHarness();
    const created = await h.call('POST', '/api/v1/tasks', {
      title: 'Shorten series',
      notes: '',
      dueDate: '2027-12-10',
      priority: 'normal',
      completed: false,
      sensitivity: 'unlabeled',
      recurrence: {
        frequency: 'daily',
        interval: 1,
        count: 4,
        until: null,
        timeZone: 'America/Denver',
      },
      operationId: randomUUID(),
    });
    const task = taskResponseSchema.parse(created.json()).task;
    const proposal = assistantProposalSchema.parse({
      kind: 'task.update',
      target: task,
      changes: { recurrence: null },
      scope: 'future',
    });
    expect(proposalTier(proposal)).toBe(2);
    expect(
      proposalPolicyMode(proposal, {
        tasks: 'automatic',
        calendar: 'automatic',
        reminders: 'automatic',
        capabilities: 'automatic',
      }),
    ).toBe('approval-required');
    const turnId = await seedTurn(h);
    const item = {
      state: 'proposed',
      applied: null,
      error: null,
      applyId: randomUUID(),
      undoId: randomUUID(),
    };
    await h.database.query(
      'UPDATE ai_conversation_turns SET proposals=$2::jsonb,items=$3::jsonb WHERE owner_id=$1 AND id=$4',
      [h.owner, JSON.stringify([proposal]), JSON.stringify([item]), turnId],
    );
    await h.database.query(
      `INSERT INTO ai_turn_origins(owner_id,turn_id,request_id,capture,proposal_digests)
       VALUES($1,$2,$2,$3::jsonb,$4::jsonb)`,
      [
        h.owner,
        turnId,
        JSON.stringify({
          requestId: turnId,
          labels: ['unlabeled'],
          sources: [],
          useMail: false,
          destination: {
            model: 'synthetic/model',
            upstream: 'google-vertex',
            revision: 'a'.repeat(64),
            version: 1,
          },
        }),
        JSON.stringify({
          [item.applyId]: proposalDigest(
            h.owner,
            turnId,
            item.applyId,
            proposal,
          ),
        }),
      ],
    );
    await h.database.query(
      `INSERT INTO ai_action_policies(owner_id,policy,auto_approve)
       VALUES($1,$2::jsonb,false)
       ON CONFLICT(owner_id) DO UPDATE SET policy=EXCLUDED.policy,auto_approve=false`,
      [
        h.owner,
        JSON.stringify({
          tasks: 'automatic',
          calendar: 'automatic',
          reminders: 'automatic',
          capabilities: 'automatic',
          email: 'approval-required',
        }),
      ],
    );
    await applyByPolicy(
      h.database,
      h.owner,
      (await readTurn(h.database, h.owner, turnId))!,
    );
    expect((await readTurn(h.database, h.owner, turnId))!.items[0]!.state).toBe(
      'proposed',
    );
    await h.database.query(
      'UPDATE ai_action_policies SET auto_approve=true WHERE owner_id=$1',
      [h.owner],
    );
    await applyByPolicy(
      h.database,
      h.owner,
      (await readTurn(h.database, h.owner, turnId))!,
    );
    expect((await readTurn(h.database, h.owner, turnId))!.items[0]!.state).toBe(
      'applied',
    );
    const remaining = (await h.call('GET', '/api/v1/tasks'))
      .json()
      .tasks.find((row: { id: string }) => row.id === task.id);
    expect(remaining).toMatchObject({ recurrence: null, seriesId: null });
    await h.app.close();
  });

  it('keeps tier 3 proposals waiting with auto-approve on', async () => {
    const h = await startHarness();
    const turnId = await seedTurn(h);
    const proposal = assistantProposalSchema.parse({
      kind: 'capability',
      capability: 'mail.send',
      arguments: {},
      summary: 'Send mail',
      tier: 3,
    });
    await h.database.query(
      'UPDATE ai_conversation_turns SET proposals=$2::jsonb,items=$3::jsonb WHERE owner_id=$1 AND id=$4',
      [
        h.owner,
        JSON.stringify([proposal]),
        JSON.stringify([
          {
            state: 'proposed',
            applied: null,
            error: null,
            applyId: randomUUID(),
            undoId: randomUUID(),
          },
        ]),
        turnId,
      ],
    );
    await h.database.query(
      `INSERT INTO ai_action_policies(owner_id,policy,auto_approve)
       VALUES($1,$2::jsonb,true)
       ON CONFLICT(owner_id) DO UPDATE SET auto_approve=true`,
      [
        h.owner,
        JSON.stringify({
          tasks: 'approval-required',
          calendar: 'approval-required',
          reminders: 'approval-required',
          capabilities: 'approval-required',
          email: 'approval-required',
        }),
      ],
    );
    const saved = await readTurn(h.database, h.owner, turnId);
    await applyByPolicy(h.database, h.owner, saved!);
    const after = await readTurn(h.database, h.owner, turnId);
    expect(after!.items[0]!.state).toBe('proposed');
    await h.app.close();
  });

  it('summarizes older bound history instead of sending every turn', async () => {
    const h = await startHarness();
    const conversationId = randomUUID();
    await h.database.query(
      'INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,$3)',
      [conversationId, h.owner, 'Long conversation'],
    );
    let firstTurnId = '';
    for (let index = 0; index < 15; index++) {
      const id = randomUUID();
      if (index === 0) firstTurnId = id;
      const reservation = randomUUID();
      const ask = `Question ${index} ${'a'.repeat(800)}`;
      const reply = `Answer ${index} ${'b'.repeat(800)}`;
      await h.database.query(
        `INSERT INTO ai_budget_reservations
          (id,owner_id,request_id,request_hash,month,provider,model,policy_version,reserved_micros,actual_micros,status)
         VALUES($1,$2,$3,$4,'2026-11-01','synthetic','synthetic/model',1,1000,0,'released')`,
        [reservation, h.owner, id, 'h'.repeat(64)],
      );
      await h.database.query(
        `INSERT INTO ai_assistant_requests
          (id,owner_id,operation_id,request_hash,model,reservation_id,status,cost_micros)
         VALUES($1,$2,$3,$4,'synthetic/model',$5,'completed',0)`,
        [id, h.owner, randomUUID(), 'h'.repeat(64), reservation],
      );
      await h.database.query(
        `INSERT INTO ai_conversation_turns
          (id,owner_id,conversation_id,position,ask,reply,inference_history,inference_digest,inference_sources)
         VALUES($1,$2,$3,$4,$5,$6,'bound',$7,'[]'::jsonb)`,
        [
          id,
          h.owner,
          conversationId,
          index,
          ask,
          reply,
          turnDigest(h.owner, id, ask, reply),
        ],
      );
    }
    await recordCapabilityAudit(
      h.database,
      h.owner,
      firstTurnId,
      assistantProposalSchema.parse({
        kind: 'task.create',
        task: {
          title: 'Audit task',
          notes: '',
          dueDate: null,
          priority: 'normal',
        },
      }),
      'applied',
    );
    const [audit] = await h.database.query(
      'SELECT capability,action,decision FROM ai_capability_audit WHERE owner_id=$1',
      [h.owner],
    );
    expect(audit).toMatchObject({
      capability: 'task',
      action: 'create',
      decision: 'applied',
    });
    const history = await readBoundHistory(
      h.database,
      h.owner,
      conversationId,
      { allowed: ['unlabeled'], useMail: false },
    );
    expect(history.history.length).toBeLessThan(15);
    expect(history.summary).toContain('Question 0');
    expect(history.withheld).toBeGreaterThan(0);
    await h.app.close();
  });
});
