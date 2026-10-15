import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { liveManifestSchema } from '../src/ai/live-manifest.js';
import {
  livePlannerContext,
  mailSources,
  projectEvent,
  projectTask,
} from '../src/ai/live-projections.js';
import { resolveAIContext } from '../src/features/ai-routing.js';
import { startHarness } from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';

// Live planner and mail projections (docs/live-context-admission-design.md).

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.app.close();
  harness = undefined;
});

const soon = (hours: number) =>
  new Date(Date.now() + hours * 3600000).toISOString().slice(0, 19) + 'Z';

async function seedPlanner(h: Harness) {
  const task = async (fields: object) =>
    (
      await h.call('POST', '/api/v1/tasks', {
        operationId: randomUUID(),
        ...fields,
      })
    ).json().task as { id: string };
  const event = async (fields: object) =>
    (
      await h.call('POST', '/api/v1/calendar', {
        operationId: randomUUID(),
        startsAt: soon(24),
        endsAt: soon(25),
        timeZone: 'UTC',
        ...fields,
      })
    ).json().event as { id: string };
  const course = (
    await h.call('POST', '/api/v1/courses', {
      operationId: randomUUID(),
      name: 'Synthetic course',
      sensitivity: 'unlabeled',
    })
  ).json().course as { id: string };
  return {
    open: [await task({ title: 'Open task' }), await event({ title: 'Open' })],
    closed: [
      await task({ title: 'Personal task', sensitivity: 'personal' }),
      await event({ title: 'Personal', sensitivity: 'personal' }),
      await event({ title: 'Course study', courseId: course.id }),
    ],
  };
}

describe('live planner context', () => {
  it('matches resolveAIContext for every record it sends', async () => {
    harness = await startHarness();
    const seeded = await seedPlanner(harness);
    const context = await livePlannerContext(harness.database, harness.owner, {
      limit: 150,
    });
    const sent = [...context.tasks, ...context.events];
    expect(sent.map((record) => record.id).sort()).toEqual(
      seeded.open.map((record) => record.id).sort(),
    );
    expect(context.withheld).toBe(seeded.closed.length);
    for (const record of sent) {
      const resolved = await resolveAIContext(harness.database, harness.owner, {
        kind: context.tasks.includes(record as never) ? 'task' : 'event',
        id: record.id,
        expectedVersion: record.version,
      });
      expect(resolved.sensitivity).toBe('unlabeled');
      expect(resolved.attachmentDerived).toBe(false);
    }
  });

  it('withholds records applied from turns that read mail', async () => {
    harness = await startHarness();
    const { open } = await seedPlanner(harness);
    const [task] = open;
    const turn = async (mail: string) => {
      const id = randomUUID();
      const reservation = randomUUID();
      await harness!.database.query(
        "INSERT INTO ai_budget_reservations(id,owner_id,request_id,request_hash,month,provider,model,policy_version,reserved_micros,actual_micros,status) VALUES($1,$2,$3,'h',date_trunc('month',CURRENT_DATE)::date,'openrouter','anthropic/claude-haiku-5.5',1,10,0,'released')",
        [reservation, harness!.owner, id],
      );
      await harness!.database.query(
        "INSERT INTO ai_assistant_requests(id,owner_id,operation_id,request_hash,model,reservation_id,status) VALUES($1,$2,$3,'h','anthropic/claude-haiku-5.5',$4,'failed')",
        [id, harness!.owner, randomUUID(), reservation],
      );
      const conversation = randomUUID();
      await harness!.database.query(
        "INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,'Synthetic')",
        [conversation, harness!.owner],
      );
      await harness!.database.query(
        'INSERT INTO ai_conversation_turns(id,owner_id,conversation_id,position,items,mail) VALUES($1,$2,$3,0,$4,$5)',
        [
          id,
          harness!.owner,
          conversation,
          JSON.stringify([{ state: 'applied', applied: { id: task!.id, version: 1 } }]),
          mail,
        ],
      );
    };
    await turn('[]');
    const before = await livePlannerContext(harness.database, harness.owner, {
      limit: 150,
    });
    expect(before.tasks.map((t) => t.id)).toContain(task!.id);
    await turn('[{"id":"synthetic"}]');
    const after = await livePlannerContext(harness.database, harness.owner, {
      limit: 150,
    });
    expect(after.tasks.map((t) => t.id)).not.toContain(task!.id);
    expect(after.withheld).toBe(before.withheld + 1);
  });

  it('keeps the projected fields unchanged', () => {
    const task = {
      id: randomUUID(),
      title: 'Synthetic task',
      dueDate: '2026-10-20',
      priority: 'high',
      notes: 'never sent',
    };
    expect(projectTask(task as never, 't1')).toEqual({
      ref: 't1',
      title: 'Synthetic task',
      dueDate: '2026-10-20',
      priority: 'high',
    });
    const timed = {
      title: 'Synthetic meeting',
      allDay: false,
      startsAt: '2026-10-20T14:00:00Z',
      endsAt: '2026-10-20T15:30:00Z',
      notes: 'never sent',
    };
    expect(projectEvent(timed as never, 'e1', 'America/New_York')).toEqual({
      ref: 'e1',
      title: 'Synthetic meeting',
      start: '2026-10-20T10:00',
      end: '2026-10-20T11:30',
    });
    const allDay = {
      title: 'Synthetic trip',
      allDay: true,
      startDate: '2026-10-20',
      endDate: '2026-10-23',
    };
    expect(projectEvent(allDay as never, 'e2', 'UTC')).toEqual({
      ref: 'e2',
      title: 'Synthetic trip',
      allDay: true,
      start: '2026-10-20',
      end: '2026-10-22',
    });
  });
});

describe('live mail sources', () => {
  it('carry connector identity and both labels, and require a verified origin', async () => {
    harness = await startHarness();
    const connector = randomUUID();
    const verified = randomUUID();
    const unverified = randomUUID();
    await harness.database.query(
      "INSERT INTO email_connectors(id,owner_id,name,token_hash,sensitivity,since) VALUES($1,$2,'Synthetic',$3,'personal','2026-10-01')",
      [connector, harness.owner, 'a'.repeat(64)],
    );
    for (const [id, origin] of [
      [verified, 'message-body-v1'],
      [unverified, null],
    ])
      await harness.database.query(
        "INSERT INTO email_messages(id,owner_id,connector_id,message_key,subject,received_at,body,body_truncated,folders,sensitivity,text_origin) VALUES($1,$2,$3,$4,'Synthetic','2026-10-13T12:00:00Z','Synthetic body',false,ARRAY['INBOX'],'unlabeled',$5)",
        [id, harness.owner, connector, `<${id}@example.test>`, origin],
      );
    const [source] = await mailSources(
      harness.database,
      harness.owner,
      randomUUID(),
      [{ projection: 'mail-header-v1', id: verified, ref: 'm1', projected: {} }],
    );
    expect(source).toMatchObject({
      kind: 'mail-message',
      labels: ['unlabeled', 'personal'],
      connector: { id: connector, version: 1 },
    });
    await expect(
      mailSources(harness.database, harness.owner, randomUUID(), [
        { projection: 'mail-header-v1', id: unverified, ref: 'm1', projected: {} },
      ]),
    ).rejects.toMatchObject({ code: 'PROVENANCE_UNAVAILABLE' });
  });
});

describe('live manifest', () => {
  const source = (id = randomUUID()) => ({
    projection: 'planner-task-v1' as const,
    kind: 'task' as const,
    id,
    version: 1,
    ref: 't1',
    labels: ['unlabeled' as const],
    digest: 'a'.repeat(64),
  });
  const manifest = (sources: ReturnType<typeof source>[]) => ({
    formatVersion: 1,
    owner: randomUUID(),
    requestId: randomUUID(),
    kind: 'planner',
    round: 1,
    conversationId: null,
    priorRequestIds: [],
    destination: {
      model: 'anthropic/claude-haiku-5.5',
      upstream: 'google-vertex',
      revision: 'b'.repeat(64),
      version: 1,
    },
    settingsVersion: 1,
    useMail: false,
    request: { provenance: 'owner-entered', labels: ['unlabeled'] },
    timeZone: 'UTC',
    history: { turns: [], sources: [], withheld: 0 },
    sources,
    bytes: 1,
  });

  it('rejects overflow and duplicate sources', () => {
    expect(liveManifestSchema.safeParse(manifest([source()])).success).toBe(
      true,
    );
    expect(
      liveManifestSchema.safeParse(
        manifest(Array.from({ length: 351 }, () => source())),
      ).success,
    ).toBe(false);
    const id = randomUUID();
    expect(
      liveManifestSchema.safeParse(manifest([source(id), source(id)])).success,
    ).toBe(false);
  });
});
