import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyRequest,
  assistantProposalSchema,
  reminderResponseSchema,
} from '@hub/contracts';
import { startHarness } from './helpers/openrouter.js';
import { assistantContext } from '../src/ai/assistant-context.js';
import { readBoundHistory } from '../src/ai/live-history.js';
import { turnDigest } from '../src/ai/live-manifest.js';
import { toProposal } from '../src/features/assistant.js';
import { plannedWrite } from '../src/features/planner-write.js';
import { reminderColumns } from '../src/features/reminders.js';
import { runReminderBatch } from '../src/features/reminders.js';
import { proposalPolicyMode } from '../src/features/agent-run.js';
import { recordCapabilityAudit } from '../src/features/capability-audit.js';

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
