import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Temporal } from '@hub/contracts';
import type { QueryExecutor } from '../src/db/database.js';
import {
  trackedDeadlineContext,
  trackedDeadlineSources,
} from '../src/ai/tracked-deadline-context.js';
import { livePlannerContext } from '../src/ai/live-projections.js';
import { readBoundHistory } from '../src/ai/live-history.js';
import { answerTurn } from '../src/features/assistant.js';
import { runAgentTick } from '../src/features/agent-worker.js';
import { action, answer, startHarness } from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';

const zone = 'America/Denver';
let h: Harness;
let providerId = 100;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in tracked deadline AI tests.');
    }),
  );
});

afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await h?.app.close();
});

const day = (offset: number) =>
  Temporal.Now.plainDateISO(zone).add({ days: offset }).toString();

type Seed = {
  id: string;
  sourceId: string;
  sourceUrl: string;
  dueDate: string;
};

async function sourceRoot() {
  await h.database.query(
    "INSERT INTO canvas_sources(owner_id,enabled,sensitivity) VALUES($1,true,'unlabeled') ON CONFLICT(owner_id) DO NOTHING",
    [h.owner],
  );
}

async function seedDeadline(
  options: {
    title?: string;
    dueDate?: string;
    sourceKind?: 'calendar-feed' | 'calendar-file' | 'browser';
    sensitivity?: 'unlabeled' | 'personal' | 'restricted';
    completed?: boolean;
    unknownDue?: boolean;
  } = {},
): Promise<Seed> {
  await sourceRoot();
  const number = String(providerId++);
  const sourceId = randomUUID();
  const id = randomUUID();
  const dueDate = options.dueDate ?? day(2);
  const sourceUrl = `https://canvas.colorado.edu/courses/10/assignments/${number}`;
  const canonicalKey = `canvas:canvas.colorado.edu:/courses/10/assignments/${number}`;
  const sourceKind = options.sourceKind ?? 'calendar-feed';
  const providerData = options.unknownDue
    ? {
        title: options.title ?? `Deadline ${number}`,
        allDay: false,
        sourceUrl,
      }
    : {
        title: options.title ?? `Deadline ${number}`,
        allDay: true,
        startDate: dueDate,
        endDate: Temporal.PlainDate.from(dueDate).add({ days: 1 }).toString(),
        sourceUrl,
      };
  await h.database.query(
    `INSERT INTO canvas_items(id,owner_id,uid,provider_data,availability,sensitivity,input_kind)
     VALUES($1,$2,$3,$4::jsonb,'available',$5,$6)`,
    [
      sourceId,
      h.owner,
      `deadline-${number}`,
      JSON.stringify(providerData),
      options.sensitivity ?? 'unlabeled',
      sourceKind === 'calendar-file' ? 'calendar-file' : 'calendar-feed',
    ],
  );
  await h.database.query(
    `INSERT INTO tracked_deadlines(id,owner_id,canonical_key,completed_at)
     VALUES($1,$2,$3,$4)`,
    [id, h.owner, canonicalKey, options.completed ? new Date() : null],
  );
  await h.database.query(
    `INSERT INTO tracked_deadline_sources
       (id,owner_id,deadline_id,canvas_item_id,source_kind,is_primary,source_version)
     VALUES($1,$2,$3,$4,$5,true,1)`,
    [randomUUID(), h.owner, id, sourceId, sourceKind],
  );
  return { id, sourceId, sourceUrl, dueDate };
}

async function addConflictingSource(
  seed: Seed,
  tx: QueryExecutor = h.database,
) {
  const sourceId = randomUUID();
  const conflicting = Temporal.PlainDate.from(seed.dueDate)
    .add({ days: 1 })
    .toString();
  await tx.query(
    `INSERT INTO canvas_items(id,owner_id,uid,provider_data,availability,sensitivity,input_kind)
     VALUES($1,$2,$3,$4::jsonb,'available','unlabeled','calendar-feed')`,
    [
      sourceId,
      h.owner,
      `conflict-${providerId++}`,
      JSON.stringify({
        title: 'Conflicting source',
        allDay: true,
        startDate: conflicting,
        endDate: Temporal.PlainDate.from(conflicting)
          .add({ days: 1 })
          .toString(),
        sourceUrl: seed.sourceUrl,
      }),
    ],
  );
  await tx.query(
    `INSERT INTO tracked_deadline_sources
       (id,owner_id,deadline_id,canvas_item_id,source_kind,is_primary,source_version)
     VALUES($1,$2,$3,$4,'calendar-feed',false,1)`,
    [randomUUID(), h.owner, seed.id, sourceId],
  );
}

type Template = 'daily-plan' | 'deadline-watch' | 'custom';
async function seedAgent(template: Template) {
  const id = randomUUID();
  const conversationId = randomUUID();
  await h.database.query(
    "INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,'Synthetic agent')",
    [conversationId, h.owner],
  );
  await h.database.query(
    `INSERT INTO responsibilities
       (id,owner_id,title,goal,sensitivity,labels,status,template,conversation_id,time_zone,monthly_cap_micros)
     VALUES($1,$2,'Deadline watch','Protect upcoming deadlines','unlabeled',ARRAY['unlabeled'],'active',$3,$4,$5,2000000)`,
    [id, h.owner, template, conversationId, zone],
  );
  await h.database.query(
    'UPDATE ai_conversations SET responsibility_id=$1 WHERE id=$2',
    [id, conversationId],
  );
  return {
    id,
    conversationId,
    template,
    goal: 'Protect upcoming deadlines',
    version: 1,
  };
}

async function agentTurn(agent: Awaited<ReturnType<typeof seedAgent>>) {
  return answerTurn(h.database, h.config, h.fetcher, h.owner, {
    operationId: randomUUID(),
    prompt: 'Check upcoming work.',
    ask: 'Scheduled run',
    timeZone: zone,
    conversationId: agent.conversationId,
    useMail: false,
    trigger: 'agent',
    agentId: agent.id,
    agentGoal: agent.goal,
    agentVersion: agent.version,
    agentTemplate: agent.template,
  });
}

function sentPayload(body: Record<string, unknown>) {
  const messages = body.messages as { role: string; content: string }[];
  return JSON.parse(messages.at(-1)!.content) as Record<string, unknown>;
}

async function setPolicy(tasks: string, calendar: string) {
  const current = (await h.call('GET', '/api/v1/ai/actions')).json();
  const saved = await h.call('PUT', '/api/v1/ai/actions', {
    operationId: randomUUID(),
    expectedVersion: current.version,
    policy: {
      tasks,
      calendar,
      reminders: 'approval-required',
      email: 'approval-required',
    },
  });
  expect(saved.statusCode).toBe(200);
}

async function queueRun(agent: { id: string }) {
  const runId = randomUUID();
  await h.database.query(
    `INSERT INTO responsibility_runs
       (id,owner_id,responsibility_id,responsibility_version,trigger,input_hash,labels,status)
     SELECT $1,owner_id,id,version,'manual',$3,labels,'queued'
     FROM responsibilities WHERE id=$2`,
    [runId, agent.id, 'c'.repeat(64)],
  );
  return runId;
}

it('projects only bounded concrete network deadlines and leaves generic planner context unchanged', async () => {
  h = await startHarness();
  const completed = await seedDeadline({ title: 'Completed', completed: true });
  const file = await seedDeadline({
    title: 'File only',
    sourceKind: 'calendar-file',
  });
  const browser = await seedDeadline({
    title: 'Browser only',
    sourceKind: 'browser',
  });
  const unknown = await seedDeadline({ title: 'Unknown', unknownDue: true });
  const personal = await seedDeadline({
    title: 'Personal',
    sensitivity: 'personal',
    dueDate: day(-3),
  });
  const restricted = await seedDeadline({
    title: 'Restricted',
    sensitivity: 'restricted',
    dueDate: day(-4),
  });
  const conflict = await seedDeadline({ title: 'Conflict' });
  await addConflictingSource(conflict);
  const overdue = await seedDeadline({ title: 'Overdue', dueDate: day(-2) });
  const outside = await seedDeadline({
    title: 'Outside horizon',
    dueDate: day(8),
  });
  for (let index = 0; index < 51; index++)
    await seedDeadline({ title: `Eligible ${String(index).padStart(2, '0')}` });

  const context = await trackedDeadlineContext(
    h.database,
    h.owner,
    ['unlabeled'],
    zone,
  );
  expect(context.items).toHaveLength(50);
  expect(new Set(context.items.map((item) => item.ref)).size).toBe(50);
  for (const omitted of [
    completed,
    file,
    browser,
    unknown,
    personal,
    restricted,
    conflict,
    outside,
  ])
    expect(context.items.some((item) => item.id === omitted.id)).toBe(false);
  expect(context.items.some((item) => item.id === overdue.id)).toBe(true);
  expect(context.withheld).toBeGreaterThanOrEqual(7);
  const personalAllowed = await trackedDeadlineContext(
    h.database,
    h.owner,
    ['unlabeled', 'personal'],
    zone,
  );
  expect(personalAllowed.items.some((item) => item.id === personal.id)).toBe(
    true,
  );
  expect(personalAllowed.items.some((item) => item.id === restricted.id)).toBe(
    false,
  );

  const generic = await livePlannerContext(h.database, h.owner, { limit: 150 });
  expect(Object.keys(generic).sort()).toEqual([
    'courses',
    'events',
    'reminders',
    'tasks',
    'trimmed',
    'withheld',
  ]);
});

it('sends tracked-deadline-v1 to every agent template and never exposes Canvas or internal IDs', async () => {
  h = await startHarness();
  const deadline = await seedDeadline({ title: 'Network deadline' });
  for (const template of ['daily-plan', 'custom', 'deadline-watch'] as const) {
    const agent = await seedAgent(template);
    const before = h.state.sent.length;
    await agentTurn(agent);
    expect(h.state.sent).toHaveLength(before + 1);
    const body = h.state.sent.at(-1)!;
    const payload = sentPayload(body);
    expect(payload.deadlines).toEqual([
      expect.objectContaining({ ref: 'd1', title: 'Network deadline' }),
    ]);
    expect(JSON.stringify(body)).not.toContain(deadline.sourceUrl);
    expect(JSON.stringify(body)).not.toContain(deadline.sourceId);
    expect(JSON.stringify(body)).not.toContain(deadline.id);
  }
});

it.each([
  'source-title',
  'source-due',
  'source-version',
  'completion',
  'label',
  'conflict',
  'override',
  'template',
] as const)(
  'final guard blocks a %s change before provider handoff and releases the hold',
  async (change) => {
    h = await startHarness();
    const deadline = await seedDeadline({ title: 'Guarded deadline' });
    const agent = await seedAgent('deadline-watch');
    const turn = await answerTurn(h.database, h.config, h.fetcher, h.owner, {
      operationId: randomUUID(),
      prompt: 'Check upcoming work.',
      ask: 'Scheduled run',
      timeZone: zone,
      conversationId: agent.conversationId,
      useMail: false,
      trigger: 'agent',
      agentId: agent.id,
      agentGoal: agent.goal,
      agentVersion: agent.version,
      agentTemplate: agent.template,
      authority: async (tx: QueryExecutor) => {
        if (change === 'source-title')
          await tx.query(
            `UPDATE canvas_items
             SET provider_data=jsonb_set(provider_data,'{title}','"Changed source title"'::jsonb)
             WHERE id=$1`,
            [deadline.sourceId],
          );
        else if (change === 'source-due')
          await tx.query(
            `UPDATE canvas_items
             SET provider_data=provider_data || $2::jsonb
             WHERE id=$1`,
            [
              deadline.sourceId,
              JSON.stringify({
                startDate: day(3),
                endDate: day(4),
              }),
            ],
          );
        else if (change === 'source-version')
          await tx.query(
            'UPDATE canvas_items SET version=version+1 WHERE id=$1',
            [deadline.sourceId],
          );
        else if (change === 'completion')
          await tx.query(
            'UPDATE tracked_deadlines SET completed_at=CURRENT_TIMESTAMP WHERE id=$1',
            [deadline.id],
          );
        else if (change === 'label')
          await tx.query(
            "UPDATE canvas_items SET sensitivity='personal' WHERE id=$1",
            [deadline.sourceId],
          );
        else if (change === 'conflict')
          await addConflictingSource(deadline, tx);
        else if (change === 'override')
          await tx.query(
            "UPDATE tracked_deadlines SET title_override='Changed override',version=version+1 WHERE id=$1",
            [deadline.id],
          );
        else
          await tx.query(
            "UPDATE responsibilities SET template='daily-plan',version=version+1 WHERE id=$1",
            [agent.id],
          );
        return true;
      },
    });
    expect(turn.request).toMatchObject({
      status: 'failed',
      reason: 'context-changed',
    });
    expect(h.chatCalls()).toBe(0);
    expect(
      (await h.database.query('SELECT status FROM ai_budget_reservations'))[0],
    ).toMatchObject({ status: 'released' });
  },
);

it('invalidates bound history when a tracked deadline source version changes', async () => {
  h = await startHarness();
  const deadline = await seedDeadline({ title: 'History deadline' });
  const agent = await seedAgent('deadline-watch');
  await agentTurn(agent);
  const before = await readBoundHistory(
    h.database,
    h.owner,
    agent.conversationId,
    {
      allowed: ['unlabeled'],
      useMail: false,
    },
  );
  expect(before.history).toHaveLength(1);
  expect(
    before.sources.some((source) => source.kind === 'tracked-deadline'),
  ).toBe(true);
  await h.database.query(
    'UPDATE canvas_items SET version=version+1 WHERE id=$1',
    [deadline.sourceId],
  );
  expect(
    await readBoundHistory(h.database, h.owner, agent.conversationId, {
      allowed: ['unlabeled'],
      useMail: false,
    }),
  ).toMatchObject({ history: [], sources: [], withheld: 1 });
});

it('keeps dN creates ask-first, then automatic task/event effects retain immutable deadline lineage without Canvas writes', async () => {
  h = await startHarness();
  const deadline = await seedDeadline({ title: 'Lineage deadline' });
  const agent = await seedAgent('deadline-watch');
  const today = Temporal.Now.plainDateISO(zone).toString();
  const actions = [
    action({
      type: 'task.create',
      ref: 'd1',
      title: 'Prepare submission',
      dueDate: deadline.dueDate,
    }),
    action({
      type: 'event.create',
      ref: 'd1',
      title: 'Preparation block',
      start: `${today}T09:00`,
      end: `${today}T10:00`,
      allDay: false,
    }),
  ];
  h.state.chat = () => answer('Prepare before the deadline.', actions);
  const providerBefore = await h.database.query(
    'SELECT provider_data,version FROM canvas_items WHERE id=$1',
    [deadline.sourceId],
  );

  await setPolicy('approval-required', 'approval-required');
  const firstRun = await queueRun(agent);
  await runAgentTick(h.database, h.config, h.fetcher, new Date());
  const [first] = await h.database.query(
    'SELECT outcome,turn_id FROM responsibility_runs WHERE id=$1',
    [firstRun],
  );
  expect(first).toMatchObject({ outcome: 'needs-approval' });
  const firstTurn = (
    await h.call(
      'GET',
      `/api/v1/assistant/conversations/${agent.conversationId}`,
    )
  )
    .json()
    .turns.find((turn: { id: string }) => turn.id === first!.turn_id);
  expect(firstTurn.request.proposals).toEqual([
    expect.objectContaining({
      kind: 'task.create',
      deadlineSource: expect.objectContaining({
        id: deadline.id,
        expectedVersion: 1,
      }),
    }),
    expect.objectContaining({
      kind: 'event.create',
      deadlineSource: expect.objectContaining({
        id: deadline.id,
        expectedVersion: 1,
      }),
    }),
  ]);
  expect(
    await h.database.query('SELECT id FROM tracked_deadline_planner_links'),
  ).toEqual([]);

  await setPolicy('automatic', 'automatic');
  const secondRun = await queueRun(agent);
  await runAgentTick(h.database, h.config, h.fetcher, new Date());
  const [second] = await h.database.query(
    'SELECT outcome FROM responsibility_runs WHERE id=$1',
    [secondRun],
  );
  expect(second).toMatchObject({ outcome: 'applied' });
  const links = await h.database.query(
    'SELECT deadline_id,task_id,event_id,snapshot,labels FROM tracked_deadline_planner_links ORDER BY task_id NULLS LAST,event_id NULLS LAST',
  );
  expect(links).toHaveLength(2);
  for (const link of links) {
    expect(link.deadline_id).toBe(deadline.id);
    expect(link.labels).toEqual(['unlabeled']);
    expect(link.snapshot).toMatchObject({
      id: deadline.id,
      version: 1,
      title: 'Lineage deadline',
      due: { kind: 'date', dueDate: deadline.dueDate },
      sourceDependencies: [
        expect.objectContaining({
          kind: 'calendar-feed',
          id: deadline.sourceId,
          version: 1,
        }),
      ],
    });
  }
  expect(
    await h.database.query(
      'SELECT provider_data,version FROM canvas_items WHERE id=$1',
      [deadline.sourceId],
    ),
  ).toEqual(providerBefore);

  await h.database.query(
    "UPDATE tracked_deadlines SET title_override='Later owner edit',version=version+1 WHERE id=$1",
    [deadline.id],
  );
  expect(
    (
      await h.database.query<{ snapshot: { title: string } }>(
        'SELECT snapshot FROM tracked_deadline_planner_links',
      )
    ).map((row) => row.snapshot.title),
  ).toEqual(['Lineage deadline', 'Lineage deadline']);
});

it('keeps automatic agents without memory authority', async () => {
  h = await startHarness();
  const agent = await seedAgent('deadline-watch');
  await expect(
    answerTurn(h.database, h.config, h.fetcher, h.owner, {
      operationId: randomUUID(),
      prompt: 'Check upcoming work.',
      ask: 'Scheduled run',
      timeZone: zone,
      conversationId: agent.conversationId,
      useMail: false,
      trigger: 'agent',
      agentId: agent.id,
      agentGoal: agent.goal,
      agentVersion: agent.version,
      agentTemplate: agent.template,
      memory: [
        {
          id: randomUUID(),
          expectedVersion: 1,
          expectedSettingsVersion: 1,
        },
      ],
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(h.chatCalls()).toBe(0);
});

it('seals exact tracked deadline version and network dependencies in the manifest', async () => {
  h = await startHarness();
  const deadline = await seedDeadline({ title: 'Manifest deadline' });
  const context = await trackedDeadlineContext(
    h.database,
    h.owner,
    ['unlabeled'],
    zone,
  );
  const requestId = randomUUID();
  expect(trackedDeadlineSources(h.owner, requestId, context.items)).toEqual([
    expect.objectContaining({
      projection: 'tracked-deadline-v1',
      kind: 'tracked-deadline',
      id: deadline.id,
      version: 1,
      ref: 'd1',
      deadlineSources: [
        { kind: 'calendar-feed', id: deadline.sourceId, version: 1 },
      ],
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  ]);
});
