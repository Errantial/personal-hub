import { approveLiveDestination } from './helpers/openrouter.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Temporal } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  chatUrl,
  modelsUrl,
  worstCaseMicros,
  zdrUrl,
} from '../src/ai/openrouter-live.js';
import { answerTurn, toProposal } from '../src/features/assistant.js';
import { finishTurn } from '../src/features/assistant-conversations.js';
import { plannedWrite } from '../src/features/planner-write.js';
import { applyRequest } from '@hub/contracts';
import type { AssistantProposal, Task } from '@hub/contracts';
import type { Config } from '../src/config.js';

// Every provider exchange is injected; global fetch is forbidden.
const origin = 'http://127.0.0.1:5173';
const model = 'anthropic/claude-haiku-5.5';
const base = { NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' };
let app: Awaited<ReturnType<typeof buildApp>>;
let database: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let chat: (body: Record<string, unknown>) => Promise<Response> | Response;
let sent: Record<string, unknown>[];
let config: Config;
let catalogHook: (() => Promise<void>) | null = null;
let fetcherInUse: Parameters<typeof answerTurn>[2];

const catalog = () =>
  new Response(
    JSON.stringify({
      data: [
        {
          id: model,
          architecture: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
          },
          pricing: { prompt: '0.0000001', completion: '0.0000005' },
        },
      ],
    }),
    { status: 200 },
  );
// Haiku has a ZDR host with strict JSON; the Bedrock-only model lacks strict
// JSON and the Fireworks one is not an allowed host.
const bedrockOnly = 'anthropic/claude-bedrock-only';
const zdr = () =>
  new Response(
    JSON.stringify({
      data: [
        {
          model_id: model,
          tag: 'google-vertex/global',
          supported_parameters: ['structured_outputs'],
        },
        {
          model_id: bedrockOnly,
          tag: 'amazon-bedrock',
          supported_parameters: ['max_tokens'],
        },
        {
          model_id: bedrockOnly,
          tag: 'fireworks',
          supported_parameters: ['structured_outputs'],
        },
      ],
    }),
    { status: 200 },
  );
const completion = (content: unknown, cost = '0.000123') =>
  new Response(
    `{"id":"gen-test-1","model":"${model}","usage":{"prompt_tokens":900,"completion_tokens":60,"total_tokens":960,"cost":${cost}},"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":${JSON.stringify(
      typeof content === 'string' ? content : JSON.stringify(content),
    )}}}]}`,
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const action = (fields: Record<string, unknown>) => ({
  type: 'task.create',
  ref: null,
  title: null,
  dueDate: null,
  clearDueDate: false,
  priority: null,
  completed: null,
  start: null,
  end: null,
  allDay: null,
  notes: null,
  ...fields,
});

async function start(key: string | null = 'sk-or-synthetic-test') {
  config = readConfig({
    ...base,
    ...(key ? { AI_SECRET_OPENROUTER: key } : {}),
  });
  database = await openDatabase(config);
  sent = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url === modelsUrl) {
      await catalogHook?.();
      return catalog();
    }
    if (url === zdrUrl) return zdr();
    if (url === chatUrl) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push(body);
      return chat(body);
    }
    throw new Error(`Unexpected ${url}`);
  });
  fetcherInUse = fetcher;
  app = await buildApp(
    { logger: false },
    { config, database, openRouterFetch: fetcher },
  );
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'assistant@example.test',
      password: 'synthetic-password',
    },
  });
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  if (key) await approveLiveDestination(call);
  return fetcher;
}
const call = (method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET',
    url,
    headers: { origin, cookie },
    ...(payload ? { payload } : {}),
  });
const setBudget = () =>
  call('PUT', '/api/v1/ai/budget', {
    operationId: randomUUID(),
    expectedVersion: 1,
    policy: { monthlyLimitMicros: 50000000, perRequestLimitMicros: 250000 },
  });
const ask = (text: string, operationId = randomUUID()) =>
  call('POST', '/api/v1/assistant/requests', {
    operationId,
    text,
    timeZone: 'America/Denver',
  });

beforeEach(() => {
  catalogHook = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in assistant tests.');
    }),
  );
  chat = () => completion({ reply: 'Nothing to do.', actions: [] });
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app.close();
});

it(
  'reports a missing key and blocks unset budgets before any request',
  { timeout: 20000 },
  async () => {
    const fetcher = await start(null);
    const settings = await call('GET', '/api/v1/assistant/settings');
    expect(settings.json().settings).toEqual({
      model,
      version: 1,
      configured: false,
      allowPersonalMail: false,
      useMail: false,
    });
    expect((await ask('Plan my week')).json().error.code).toBe(
      'ASSISTANT_NOT_CONFIGURED',
    );
    await app.close();
    await start();
    expect((await ask('Plan my week')).json().error.code).toBe('BUDGET_UNSET');
    expect(sent).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalledWith(chatUrl, expect.anything());
  },
);

it('proposes checked changes, withholds labeled items and settles the reported cost', async () => {
  await start();
  await setBudget();
  const task = (
    await call('POST', '/api/v1/tasks', {
      title: 'Lab report',
      dueDate: '2036-03-10',
      operationId: randomUUID(),
    })
  ).json().task;
  await call('POST', '/api/v1/tasks', {
    title: 'Private appointment',
    sensitivity: 'personal',
    operationId: randomUUID(),
  });
  const startsAt = Temporal.Now.instant().add({ hours: 48 }).round('minute');
  const event = (
    await call('POST', '/api/v1/calendar', {
      title: 'Advisor meeting',
      startsAt: startsAt.toString(),
      endsAt: startsAt.add({ minutes: 30 }).toString(),
      timeZone: 'America/Denver',
      operationId: randomUUID(),
    })
  ).json().event;
  const moved = startsAt
    .add({ hours: 1 })
    .toZonedDateTimeISO('America/Denver')
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' });
  chat = () =>
    completion({
      reply: 'Added a task, moved the lab report and the meeting.',
      actions: [
        action({ title: 'Buy notebook', dueDate: '2036-03-01' }),
        action({ type: 'task.update', ref: 't1', dueDate: '2036-03-12' }),
        action({ type: 'event.update', ref: 'e1', start: moved }),
        action({ type: 'task.update', ref: 't9', title: 'Invented' }),
      ],
    });
  const reply = await ask(
    'Add buy notebook, push the lab report, move my meeting',
  );
  expect(reply.statusCode).toBe(200);
  const request = reply.json().request;
  expect(request).toMatchObject({
    status: 'completed',
    reason: null,
    resultAvailable: true,
    withheld: 1,
    dropped: 1,
    costMicros: 123,
    heldMicros: 0,
  });
  expect(request.proposals.map((p: { kind: string }) => p.kind)).toEqual([
    'task.create',
    'task.update',
    'event.update',
  ]);
  expect(request.proposals[1]).toMatchObject({
    target: { id: task.id, version: task.version },
    changes: { dueDate: '2036-03-12' },
  });
  expect(request.proposals[2].changes).toEqual({
    startsAt: new Date(
      startsAt.add({ hours: 1 }).epochMilliseconds,
    ).toISOString(),
    endsAt: new Date(
      startsAt.add({ minutes: 90 }).epochMilliseconds,
    ).toISOString(),
  });
  expect(request.proposals[2].target.id).toBe(event.id);

  // Only unlabeled items and refs leave the server, pinned with no fallback.
  const body = sent[0]!;
  const text = JSON.stringify(body);
  expect(text).not.toContain('Private appointment');
  expect(text).not.toContain(task.id);
  expect(text).not.toContain(event.id);
  expect(body).toMatchObject({
    model,
    provider: {
      only: ['google-vertex'],
      allow_fallbacks: false,
      data_collection: 'deny',
      zdr: true,
    },
    usage: { include: true },
  });
  // Vertex and Anthropic don't accept temperature; with require_parameters
  // it would leave no endpoint (404).
  expect(body).not.toHaveProperty('temperature');
  const budget = (await call('GET', '/api/v1/ai/budget')).json();
  expect(budget.usage).toMatchObject({ spentMicros: '123', heldMicros: '0' });
  // Nothing was applied: the task is unchanged until the owner applies it.
  expect(
    (await call('GET', `/api/v1/tasks`))
      .json()
      .tasks.find((t: { id: string }) => t.id === task.id).dueDate,
  ).toBe('2036-03-10');
});

it('never resends a retried operation and rejects a changed one', async () => {
  await start();
  await setBudget();
  const operationId = randomUUID();
  expect((await ask('Plan my week', operationId)).json().request).toMatchObject(
    { resultAvailable: true, reply: 'Nothing to do.' },
  );
  // The stored answer comes back; the model is not called again.
  const again = (await ask('Plan my week', operationId)).json().request;
  expect(again).toMatchObject({
    status: 'completed',
    resultAvailable: true,
    reply: 'Nothing to do.',
  });
  expect((await ask('Plan next week', operationId)).json().error.code).toBe(
    'OPERATION_CONFLICT',
  );
  expect(sent).toHaveLength(1);
});

it('keeps conversations on the server, resends earlier turns and deletes their text', async () => {
  await start();
  await setBudget();
  const conversationId = randomUUID();
  const first = (
    await call('POST', '/api/v1/assistant/requests', {
      operationId: randomUUID(),
      text: 'What is due this week?',
      timeZone: 'America/Denver',
      conversationId,
    })
  ).json();
  expect(first.turn).toMatchObject({
    conversationId,
    ask: 'What is due this week?',
  });
  chat = () => completion({ reply: 'Moved it.', actions: [] });
  const second = (
    await call('POST', '/api/v1/assistant/requests', {
      operationId: randomUUID(),
      text: 'Move the first one to Friday',
      timeZone: 'America/Denver',
      conversationId,
    })
  ).json();
  // The follow-up carries the earlier ask and reply, not earlier context.
  const messages = sent[1]!.messages as { role: string; content: string }[];
  expect(messages.slice(1, 3)).toEqual([
    { role: 'user', content: 'What is due this week?' },
    { role: 'assistant', content: 'Nothing to do.' },
  ]);
  const list = (await call('GET', '/api/v1/assistant/conversations')).json();
  expect(list.conversations).toEqual([
    expect.objectContaining({
      id: conversationId,
      title: 'What is due this week?',
      turnCount: 2,
    }),
  ]);
  const thread = (
    await call('GET', `/api/v1/assistant/conversations/${conversationId}`)
  ).json();
  expect(thread.turns.map((turn: { ask: string }) => turn.ask)).toEqual([
    'What is due this week?',
    'Move the first one to Friday',
  ]);
  expect(thread.turns[1].request.reply).toBe('Moved it.');
  expect(second.turn.id).toBe(thread.turns[1].id);
  // Another owner's ID cannot be continued, and deletion clears the text.
  expect(
    (
      await call(
        'DELETE',
        `/api/v1/assistant/conversations/${conversationId}`,
        {
          expectedVersion: 1,
        },
      )
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
  expect(
    (
      await call(
        'DELETE',
        `/api/v1/assistant/conversations/${conversationId}`,
        {
          expectedVersion: thread.conversation.version,
        },
      )
    ).json(),
  ).toEqual({ deleted: true });
  expect(
    (await call('GET', `/api/v1/assistant/conversations/${conversationId}`))
      .statusCode,
  ).toBe(404);
  const [stored] = await database.query(
    'SELECT count(*)::int AS n FROM ai_conversation_turns WHERE conversation_id=$1 AND (ask IS NOT NULL OR reply IS NOT NULL)',
    [conversationId],
  );
  expect(stored!.n).toBe(0);
  expect(
    (
      await call('POST', '/api/v1/assistant/requests', {
        operationId: randomUUID(),
        text: 'Hello again',
        timeZone: 'America/Denver',
        conversationId,
      })
    ).statusCode,
  ).toBe(404);
  expect(sent).toHaveLength(2);
});

it('applies and undoes saved proposals on the server while refusing client item-state writes', async () => {
  await start();
  await setBudget();
  chat = () =>
    completion({
      reply: 'Added it.',
      actions: [action({ type: 'task.create', title: 'Buy notebook' })],
    });
  const { turn } = (await ask('Add buy notebook')).json();
  expect(turn.items).toEqual([
    expect.objectContaining({ state: 'proposed', applied: null }),
  ]);
  const forged = {
    ...turn.items[0],
    state: 'applied',
    applied: { id: randomUUID(), version: 1 },
  };
  expect(
    (
      await call('PUT', `/api/v1/assistant/turns/${turn.id}/items`, {
        expectedVersion: turn.version,
        items: [forged],
      })
    ).json().error.code,
  ).toBe('SERVER_OWNED_APPLY');
  expect(
    (
      await call('PUT', `/api/v1/assistant/turns/${turn.id}/items`, {
        expectedVersion: turn.version,
        items: [{ ...turn.items[0], applyId: randomUUID() }],
      })
    ).statusCode,
  ).toBe(400);

  const applyOp = randomUUID();
  const applied = (
    await call('POST', `/api/v1/assistant/turns/${turn.id}/apply`, {
      expectedVersion: turn.version,
      indexes: [0],
      operationId: applyOp,
    })
  ).json().turn;
  expect(applied.items[0]).toMatchObject({
    state: 'applied',
    applied: { id: expect.any(String), version: 1 },
    error: null,
  });
  // Replaying the same apply operationId returns the saved turn without conflict.
  const replayed = (
    await call('POST', `/api/v1/assistant/turns/${turn.id}/apply`, {
      expectedVersion: turn.version,
      indexes: [0],
      operationId: applyOp,
    })
  ).json().turn;
  expect(replayed.version).toBe(applied.version);
  // A stale device with a new operationId is told to reload.
  expect(
    (
      await call('POST', `/api/v1/assistant/turns/${turn.id}/apply`, {
        expectedVersion: turn.version,
        indexes: [0],
        operationId: randomUUID(),
      })
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
  expect(
    (
      await call('PUT', `/api/v1/assistant/turns/${turn.id}/items`, {
        expectedVersion: turn.version,
        items: applied.items,
      })
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');

  const undone = (
    await call('POST', `/api/v1/assistant/turns/${turn.id}/undo`, {
      expectedVersion: applied.version,
      indexes: [0],
      operationId: randomUUID(),
    })
  ).json().turn;
  expect(undone.items[0]).toMatchObject({
    state: 'undone',
    applied: applied.items[0].applied,
    error: null,
  });
});

it('refuses to apply a saved proposal whose content was changed after capture', async () => {
  await start();
  await setBudget();
  const marker = `TAMPER_${randomUUID().slice(0, 8)}`;
  chat = () =>
    completion({
      reply: 'Added it.',
      actions: [action({ type: 'task.create', title: marker })],
    });
  const { turn } = (await ask('Add a tracked task')).json();
  const [saved] = await database.query<{ proposals: unknown }>(
    'SELECT proposals FROM ai_conversation_turns WHERE id=$1',
    [turn.id],
  );
  const proposals = (
    typeof saved!.proposals === 'string'
      ? JSON.parse(saved!.proposals)
      : saved!.proposals
  ) as AssistantProposal[];
  const tampered = proposals[0]!;
  if (tampered.kind !== 'task.create')
    throw new Error('expected a task.create');
  tampered.task.title = `${marker}_CHANGED`;
  await database.query(
    'UPDATE ai_conversation_turns SET proposals=$2,version=version+1 WHERE id=$1',
    [turn.id, JSON.stringify(proposals)],
  );
  const result = (
    await call('POST', `/api/v1/assistant/turns/${turn.id}/apply`, {
      expectedVersion: turn.version + 1,
      indexes: [0],
      operationId: randomUUID(),
    })
  ).json().turn;
  expect(result.items[0]).toMatchObject({ state: 'failed', applied: null });
  expect(result.items[0].error).toMatch(/origin could not be verified/);
  const created = await database.query(
    'SELECT id FROM tasks WHERE title LIKE $1',
    [`${marker}%`],
  );
  expect(created).toHaveLength(0);
});

it('keeps derived records bound and labelled after their conversation is deleted', async () => {
  await start();
  await setBudget();
  const marker = `LINEAGE_${randomUUID().slice(0, 8)}`;
  chat = () =>
    completion({
      reply: 'Added it.',
      actions: [action({ type: 'task.create', title: marker })],
    });
  const { turn } = (await ask('Add a tracked task')).json();
  const applied = (
    await call('POST', `/api/v1/assistant/turns/${turn.id}/apply`, {
      expectedVersion: turn.version,
      indexes: [0],
      operationId: randomUUID(),
    })
  ).json().turn;
  expect(applied.items[0].state).toBe('applied');
  const recordId = applied.items[0].applied.id as string;
  const [task] = await database.query<{
    ai_origin: string;
    ai_labels: string[];
  }>('SELECT ai_origin,ai_labels FROM tasks WHERE id=$1', [recordId]);
  expect(task).toMatchObject({ ai_origin: 'bound-derived' });
  expect(task!.ai_labels).toContain('unlabeled');
  expect(
    await database.query(
      'SELECT turn_id FROM ai_planner_origins WHERE record_id=$1',
      [recordId],
    ),
  ).toHaveLength(1);

  const conversation = (
    await call('GET', `/api/v1/assistant/conversations/${turn.conversationId}`)
  ).json().conversation;
  expect(
    (
      await call(
        'DELETE',
        `/api/v1/assistant/conversations/${turn.conversationId}`,
        { expectedVersion: conversation.version },
      )
    ).statusCode,
  ).toBe(200);

  const [kept] = await database.query<{
    ai_origin: string;
    ai_labels: string[];
  }>('SELECT ai_origin,ai_labels FROM tasks WHERE id=$1', [recordId]);
  expect(kept).toMatchObject({ ai_origin: 'bound-derived' });
  expect(kept!.ai_labels).toContain('unlabeled');
});

/** A connector with the given label and uploaded messages. */
async function importMail(sensitivity: string, subjects: string[]) {
  const { token } = (
    await call('POST', '/api/v1/email/connectors', {
      name: `Bridge ${sensitivity}`,
      sensitivity,
      operationId: randomUUID(),
    })
  ).json();
  await app.inject({
    method: 'POST',
    url: '/api/v1/email/connector/batch',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      path: 'INBOX',
      role: null,
      uidValidity: '1',
      exists: subjects.length,
      inWindow: subjects.length,
      lastUid: subjects.length,
      messages: subjects.map((subject, index) => ({
        uid: index + 1,
        messageKey: `<${randomUUID()}@example.test>`,
        from: { name: 'School Office', address: 'office@example.test' },
        to: [],
        cc: [],
        subject,
        sentAt: null,
        receivedAt: `2026-10-0${index + 1}T10:00:00.000Z`,
        body: `Body of ${subject}: return it by Friday.`,
        bodyTruncated: false,
        attachmentCount: 0,
        textOrigin: 'message-body-v1',
      })),
    },
  });
}
const askWithMail = (text: string, useMail = true) =>
  call('POST', '/api/v1/assistant/requests', {
    operationId: randomUUID(),
    text,
    timeZone: 'America/Denver',
    useMail,
  });

it('with Use mail, searches, reads only chosen allowed mail and lists what was sent', async () => {
  await start();
  await setBudget();
  await importMail('unlabeled', ['Field trip waiver', 'Lunch menu']);
  await importMail('restricted', ['Waiver medical form']);
  await importMail('personal', ['Waiver from family']);
  const answers = [
    { reply: 'Checking mail.', actions: [], mailSearch: ['waiver'] },
    { reply: 'Reading it.', actions: [], read: ['m1', 'm9'] },
    { reply: 'The field trip waiver is due Friday.', actions: [] },
  ];
  chat = () => completion(answers[sent.length - 1]);
  const { turn } = (await askWithMail('When is the waiver due?')).json();
  expect(sent).toHaveLength(3);
  expect(turn.request.reply).toBe('The field trip waiver is due Friday.');
  // Three calls, one turn: costs add up.
  expect(turn.request.costMicros).toBe(369);
  expect(turn.useMail).toBe(true);
  expect(turn.mailWithheld).toBe(2);
  expect(turn.mail).toEqual([
    expect.objectContaining({
      subject: 'Field trip waiver',
      from: 'School Office',
      read: true,
    }),
  ]);
  const text = sent.map((body) => JSON.stringify(body.messages)).join('\n');
  expect(text).toContain('Field trip waiver');
  expect(text).toContain('return it by Friday');
  expect(text).not.toContain('medical');
  expect(text).not.toContain('family');
  expect(text).not.toContain('Lunch menu');
  // Only the first call may ask for a search, only the second for reads.
  const schema = (index: number) =>
    (
      sent[index]!.response_format as {
        json_schema: { schema: { required: string[] } };
      }
    ).json_schema.schema.required;
  expect(schema(0)).toContain('mailSearch');
  expect(schema(1)).toContain('read');
  expect(schema(2)).toEqual(['reply', 'actions']);
  // The stored conversation shows the same list.
  const thread = (
    await call('GET', `/api/v1/assistant/conversations/${turn.conversationId}`)
  ).json();
  expect(thread.turns[0].mail).toEqual(turn.mail);
});

it('without Use mail, mail is never searched or mentioned', async () => {
  await start();
  await setBudget();
  await importMail('unlabeled', ['Field trip waiver']);
  const { turn } = (await askWithMail('When is the waiver due?', false)).json();
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent[0])).not.toContain('Mail:');
  expect(JSON.stringify(sent[0])).not.toContain('mailSearch');
  expect(turn.mail).toEqual([]);
});

it('keeps the earlier answer and says why when a later mail call fails', async () => {
  await start();
  await setBudget();
  await importMail('unlabeled', ['Field trip waiver']);
  chat = () =>
    sent.length === 1
      ? completion({
          reply: 'Checking mail.',
          actions: [],
          mailSearch: ['waiver'],
        })
      : new Response('{}', { status: 400 });
  const { turn } = (await askWithMail('When is the waiver due?')).json();
  expect(sent).toHaveLength(2);
  expect(turn.request.reply).toBe('Checking mail.');
  expect(turn.request.reason).toBe('rejected');
  expect(turn.mailNote).toMatch(/Mail reading stopped/);
  expect(turn.mail).toEqual([
    expect.objectContaining({ subject: 'Field trip waiver', read: false }),
  ]);
});

it('remembers the Use mail choice in the assistant settings', async () => {
  await start();
  const saved = (
    await call('PUT', '/api/v1/assistant/settings', {
      model,
      expectedVersion: 1,
      useMail: true,
    })
  ).json().settings;
  expect(saved).toMatchObject({ useMail: true, version: 2 });
  expect(
    (await call('GET', '/api/v1/assistant/settings')).json().settings.useMail,
  ).toBe(true);
});

it('withholds source-linked events and unknown label history even when their root labels are unlabeled', async () => {
  await start();
  await setBudget();
  const instant = Temporal.Now.instant().add({ hours: 48 }).round('minute');
  const course = (
    await call('POST', '/api/v1/courses', {
      operationId: randomUUID(),
      name: 'Synthetic private class',
      sensitivity: 'unlabeled',
    })
  ).json().course;
  const linked = (
    await call('POST', '/api/v1/calendar', {
      operationId: randomUUID(),
      title: 'EXCLUDED_CLASS_EVENT',
      startsAt: instant.toString(),
      endsAt: instant.add({ hours: 1 }).toString(),
      timeZone: 'UTC',
      courseId: course.id,
      sensitivity: 'unlabeled',
    })
  ).json().event;
  const legacy = (
    await call('POST', '/api/v1/calendar', {
      operationId: randomUUID(),
      title: 'EXCLUDED_UNKNOWN_EVENT',
      startsAt: instant.add({ hours: 2 }).toString(),
      endsAt: instant.add({ hours: 3 }).toString(),
      timeZone: 'UTC',
      sensitivity: 'unlabeled',
    })
  ).json().event;
  expect(linked.id).toBeDefined();
  expect(legacy.id).toBeDefined();
  await database.query(
    "UPDATE courses SET sensitivity='personal',version=version+1 WHERE id=$1",
    [course.id],
  );
  await database.query('UPDATE events SET academic_labels=NULL WHERE id=$1', [
    legacy.id,
  ]);
  const result = await ask('Plan my day');
  expect(result.statusCode).toBe(200);
  expect(result.json().request.withheld).toBe(2);
  expect(JSON.stringify(sent)).not.toContain('EXCLUDED_CLASS_EVENT');
  expect(JSON.stringify(sent)).not.toContain('EXCLUDED_UNKNOWN_EVENT');
});

it('withholds mail-derived tasks even when their privacy label is unlabeled', async () => {
  await start();
  await setBudget();
  const created = await call('POST', '/api/v1/email/connectors', {
    operationId: randomUUID(),
    name: 'Synthetic mail',
    sensitivity: 'unlabeled',
  });
  const { token, connector } = created.json();
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/v1/email/connector/batch',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      path: 'INBOX',
      role: null,
      uidValidity: '1',
      exists: 1,
      inWindow: 1,
      lastUid: 1,
      messages: [
        {
          uid: 1,
          textOrigin: 'message-body-v1',
          messageKey: `<${randomUUID()}@example.test>`,
          from: null,
          to: [],
          cc: [],
          subject: 'EXCLUDED_MAIL_SUBJECT',
          sentAt: null,
          receivedAt: '2026-10-13T12:00:00.000Z',
          body: 'EXCLUDED_MAIL_QUOTE',
          bodyTruncated: false,
          attachmentCount: 0,
        },
      ],
    },
  });
  expect(uploaded.statusCode).toBe(200);
  const [message] = await database.query(
    'SELECT id FROM email_messages WHERE connector_id=$1',
    [connector.id],
  );
  const made = await call(
    'POST',
    `/api/v1/email/messages/${message!.id}/tasks`,
    {
      operationId: randomUUID(),
      expectedVersion: 1,
      title: 'EXCLUDED_MAIL_TASK',
      quote: 'EXCLUDED_MAIL_QUOTE',
    },
  );
  expect(made.statusCode).toBe(201);
  const result = await ask('Plan my day');
  expect(result.statusCode).toBe(200);
  expect(result.json().request.withheld).toBe(1);
  expect(JSON.stringify(sent)).not.toContain('EXCLUDED_MAIL');
});

it('releases refused requests and keeps the hold when the outcome is unknown', async () => {
  await start();
  await setBudget();
  chat = () => new Response('{"error":{}}', { status: 402 });
  expect((await ask('One')).json().request).toMatchObject({
    status: 'failed',
    reason: 'payment-required',
    heldMicros: 0,
    costMicros: null,
  });
  chat = () => {
    throw new TypeError('socket hang up');
  };
  const unknown = (await ask('Two')).json().request;
  expect(unknown).toMatchObject({ status: 'uncertain', reason: 'transport' });
  expect(unknown.heldMicros).toBeGreaterThan(0);
  const usage = (await call('GET', '/api/v1/ai/budget')).json().usage;
  expect(usage).toMatchObject({
    spentMicros: '0',
    heldMicros: String(unknown.heldMicros),
  });
  // Invalid structured output is still charged, with no proposals.
  chat = () => completion('not json', '0.00005');
  expect((await ask('Three')).json().request).toMatchObject({
    status: 'completed',
    reason: 'invalid',
    costMicros: 50,
    resultAvailable: false,
  });
});

it('blocks a request whose worst case exceeds the per-request limit', async () => {
  await start();
  await call('PUT', '/api/v1/ai/budget', {
    operationId: randomUUID(),
    expectedVersion: 1,
    policy: { monthlyLimitMicros: 50000000, perRequestLimitMicros: 1 },
  });
  expect((await ask('Plan my week')).json().error.code).toBe(
    'REQUEST_BUDGET_EXCEEDED',
  );
  expect(sent).toHaveLength(0);
});

it('blocks a model without an allowed zero-retention host before any hold', async () => {
  await start();
  await setBudget();
  await call('PUT', '/api/v1/assistant/settings', {
    model: bedrockOnly,
    expectedVersion: 1,
  });
  await approveLiveDestination(call, {
    model: bedrockOnly,
    upstream: 'amazon-bedrock',
  });
  expect((await ask('Plan my week')).json().error.code).toBe(
    'ASSISTANT_MODEL_NOT_PRIVATE',
  );
  expect(sent).toHaveLength(0);
  const reservations = await database.query(
    'SELECT id FROM ai_budget_reservations',
  );
  expect(reservations).toHaveLength(0);
});

it('saves a supported model with optimistic versions', async () => {
  await start();
  const put = (value: string, expectedVersion: number) =>
    call('PUT', '/api/v1/assistant/settings', {
      model: value,
      expectedVersion,
    });
  expect((await put('meta-llama/llama-5', 1)).json().error.code).toBe(
    'ASSISTANT_MODEL_UNSUPPORTED',
  );
  expect((await put('anthropic/claude-sonnet-5.5', 1)).json().settings).toEqual(
    {
      model: 'anthropic/claude-sonnet-5.5',
      version: 2,
      configured: true,
      allowPersonalMail: false,
      useMail: false,
    },
  );
  expect((await put(model, 1)).json().error.code).toBe('VERSION_CONFLICT');
});

it('converts all-day events and rejects skipped local times', () => {
  const context = { tasks: [], events: [], withheld: 0 };
  expect(
    toProposal(
      action({
        type: 'event.create',
        title: 'Conference',
        allDay: true,
        start: '2036-04-02',
        end: '2036-04-03',
      }),
      context,
      'America/Denver',
    ),
  ).toMatchObject({
    event: { allDay: true, startDate: '2036-04-02', endDate: '2036-04-04' },
  });
  expect(
    toProposal(
      action({ type: 'event.create', title: 'Gap', start: '2036-03-09T02:30' }),
      context,
      'America/Denver',
    ),
  ).toBeNull();
  // The worst-case bound covers every byte as a token plus all output.
  expect(
    worstCaseMicros(
      { prompt: 0.0000001, completion: 0.0000005, request: 0 },
      9500,
      1500,
    ),
  ).toBe(Math.ceil((10000 * 0.0000001 + 1500 * 0.0000005) * 1.25 * 1e6));
});

const ownerId = async () =>
  String((await database.query('SELECT id FROM users LIMIT 1'))[0]!.id);

it('answerTurn stores the short ask and sends the prompt for agent runs', async () => {
  await start();
  await setBudget();
  const turn = await answerTurn(
    database,
    config,
    fetcherInUse,
    await ownerId(),
    {
      operationId: randomUUID(),
      prompt: 'GOAL-TEXT',
      ask: 'Scheduled run',
      timeZone: 'America/Denver',
      conversationId: randomUUID(),
      useMail: false,
      trigger: 'agent',
    },
  );
  const messages = sent[0]!.messages as { role: string; content: string }[];
  expect(JSON.parse(messages.at(-1)!.content).request).toBe('GOAL-TEXT');
  expect(messages[0]!.content).toContain('scheduled run');
  expect(turn).toMatchObject({ ask: 'Scheduled run', trigger: 'agent' });
  // Owner asks still read as owner turns.
  const owned = (await ask('Plan my week')).json().turn;
  expect(owned).toMatchObject({ ask: 'Plan my week', trigger: 'owner' });
  expect(
    (sent[1]!.messages as { content: string }[])[0]!.content,
  ).not.toContain('scheduled run');
});

it('plannedWrite applies a task update at the target version, replays and conflicts after an edit', async () => {
  await start();
  const owner = await ownerId();
  const task = (
    await call('POST', '/api/v1/tasks', {
      title: 'Lab report',
      operationId: randomUUID(),
    })
  ).json().task as Task;
  const proposal = {
    kind: 'task.update',
    target: task,
    changes: { priority: 'high' },
  } as AssistantProposal;
  const operationId = randomUUID();
  const written = await plannedWrite(
    database,
    owner,
    applyRequest(proposal, operationId),
  );
  expect(written).toEqual({ id: task.id, version: 2 });
  expect(
    await plannedWrite(database, owner, applyRequest(proposal, operationId)),
  ).toEqual(written);
  await expect(
    plannedWrite(database, owner, applyRequest(proposal, randomUUID())),
  ).rejects.toMatchObject({ statusCode: 409, code: 'VERSION_CONFLICT' });
  const event = await plannedWrite(
    database,
    owner,
    applyRequest(
      {
        kind: 'event.create',
        event: {
          title: 'Study block',
          timeZone: 'America/Denver',
          startsAt: '2036-03-09T16:00:00.000Z',
          endsAt: '2036-03-09T17:00:00.000Z',
          allDay: false,
          startDate: null,
          endDate: null,
        },
      } as AssistantProposal,
      randomUUID(),
    ),
  );
  expect(
    (await call('GET', `/api/v1/calendar/${event.id}`)).json().event.title,
  ).toBe('Study block');
});

const continueAsk = (conversationId: string, useMail = false) =>
  call('POST', '/api/v1/assistant/requests', {
    operationId: randomUUID(),
    text: 'Follow up',
    timeZone: 'UTC',
    conversationId,
    useMail,
  });

it('blocks before any hold without an approved destination', async () => {
  await start();
  await setBudget();
  await call('DELETE', '/api/v1/assistant/destination', { expectedVersion: 1 });
  expect((await ask('Blocked')).json().error.code).toBe(
    'ASSISTANT_ROUTE_UNSET',
  );
  expect(await database.query('SELECT id FROM ai_assistant_requests')).toEqual(
    [],
  );
  expect(await database.query('SELECT id FROM ai_budget_reservations')).toEqual(
    [],
  );
});

it('withholds legacy history but keeps it readable', async () => {
  await start();
  await setBudget();
  const first = (await ask('LEGACY-ASK')).json().turn;
  await database.query(
    "UPDATE ai_conversation_turns SET inference_history='unbound',inference_digest=NULL,inference_sources=NULL WHERE id=$1",
    [first.id],
  );
  const second = (await continueAsk(first.conversationId)).json().turn;
  expect(JSON.stringify(sent[1])).not.toContain('LEGACY-ASK');
  const [exchange] = await database.query(
    'SELECT manifest FROM ai_live_exchanges WHERE request_id=$1',
    [second.id],
  );
  expect(exchange!.manifest).toMatchObject({
    history: { turns: [], withheld: 1 },
  });
  expect(
    (
      await call(
        'GET',
        `/api/v1/assistant/conversations/${first.conversationId}`,
      )
    ).json().turns[0].ask,
  ).toBe('LEGACY-ASK');
});

it('ordinary source edits preserve history but deletion withholds its transitive history', async () => {
  await start();
  await setBudget();
  const task = (
    await call('POST', '/api/v1/tasks', {
      title: 'Bound task',
      operationId: randomUUID(),
    })
  ).json().task;
  const first = (await ask('BOUND-ASK')).json().turn;
  expect(first.inferenceHistory).toBe('bound');
  await database.query(
    "UPDATE tasks SET title='Edited task',version=version+1 WHERE id=$1",
    [task.id],
  );
  await continueAsk(first.conversationId);
  expect(JSON.stringify(sent[1])).toContain('BOUND-ASK');
  await database.query(
    'UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1',
    [task.id],
  );
  const third = (await continueAsk(first.conversationId)).json().turn;
  expect(JSON.stringify(sent[2])).not.toContain('BOUND-ASK');
  const [exchange] = await database.query(
    'SELECT manifest FROM ai_live_exchanges WHERE request_id=$1',
    [third.id],
  );
  expect(exchange!.manifest).toMatchObject({
    history: { turns: [], withheld: 2 },
  });
});

it('a changed planner source blocks a later cumulative mail exchange and releases its hold', async () => {
  await start();
  await setBudget();
  await importMail('unlabeled', ['Waiver']);
  const task = (
    await call('POST', '/api/v1/tasks', {
      title: 'Original source',
      operationId: randomUUID(),
    })
  ).json().task;
  chat = async () => {
    await database.query(
      "UPDATE tasks SET title='Changed source',version=version+1 WHERE id=$1",
      [task.id],
    );
    return completion({
      reply: 'EARLIER-REPLY',
      actions: [],
      mailSearch: ['waiver'],
    });
  };
  const turn = (await askWithMail('Find waiver')).json().turn;
  expect(sent).toHaveLength(1);
  expect(turn.request.reply).toBe('EARLIER-REPLY');
  expect(turn.request.reason).toBe('context-changed');
  expect(turn.mailNote).toMatch(/source changed/);
  expect(turn.mail).toEqual([]);
  const [later] = await database.query(
    "SELECT b.status FROM ai_assistant_requests r JOIN ai_budget_reservations b ON b.id=r.reservation_id WHERE r.kind='planner-round'",
  );
  expect(later!.status).toBe('released');
});

it('mail-derived proposals are read-only and mail history is withheld when Use mail is off', async () => {
  await start();
  await setBudget();
  await importMail('personal', ['Private waiver']);
  const settings = (await call('GET', '/api/v1/assistant/settings')).json()
    .settings;
  await call('PUT', '/api/v1/assistant/settings', {
    model,
    expectedVersion: settings.version,
    allowPersonalMail: true,
  });
  chat = () =>
    completion(
      sent.length === 1
        ? { reply: 'Searching', actions: [], mailSearch: ['waiver'] }
        : sent.length === 2
          ? { reply: 'Reading', actions: [], read: ['m1'] }
          : {
              reply: 'PRIVATE-ANSWER',
              actions: [action({ title: 'Mail-created item' })],
            },
    );
  const first = (await askWithMail('Find waiver')).json().turn;
  expect(first.proposalAccess).toBe('read-only');
  expect(first.inferenceHistory).toBe('bound');
  expect(
    (
      await call('PUT', `/api/v1/assistant/turns/${first.id}/items`, {
        expectedVersion: first.version,
        items: first.items.map((item: object) => ({
          ...item,
          state: 'applied',
          applied: { id: randomUUID(), version: 1 },
        })),
      })
    ).json().error.code,
  ).toBe('PROPOSAL_READ_ONLY');
  chat = () => completion({ reply: 'Follow-up', actions: [] });
  const second = (await continueAsk(first.conversationId, true)).json().turn;
  expect(JSON.stringify(sent[3])).toContain('PRIVATE-ANSWER');
  expect(second.proposalAccess).toBe('read-only');
  const third = (await continueAsk(first.conversationId, false)).json().turn;
  expect(JSON.stringify(sent[4])).not.toContain('PRIVATE-ANSWER');
  expect(JSON.stringify(sent[4])).not.toContain('Private waiver');
  const [exchange] = await database.query(
    'SELECT manifest FROM ai_live_exchanges WHERE request_id=$1',
    [third.id],
  );
  expect(exchange!.manifest).toMatchObject({
    history: { turns: [], withheld: 2 },
  });
});

it('binds every cumulative source without prompt or mail text in manifests', async () => {
  await start();
  await setBudget();
  await importMail('unlabeled', ['SECRET-SUBJECT']);
  chat = () =>
    completion(
      sent.length === 1
        ? { reply: 'Search', actions: [], mailSearch: ['SECRET'] }
        : sent.length === 2
          ? { reply: 'Read', actions: [], read: ['m1'] }
          : { reply: 'Done', actions: [] },
    );
  const turn = (await askWithMail('SECRET-ASK')).json().turn;
  const rows = await database.query(
    'SELECT manifest FROM ai_live_exchanges ORDER BY created_at,request_id',
  );
  const manifests = rows
    .map(
      (row) =>
        row.manifest as {
          round: number;
          sources: { projection: string; id: string }[];
          priorRequestIds: string[];
        },
    )
    .sort((a, b) => a.round - b.round);
  expect(manifests).toHaveLength(3);
  expect(manifests[2]!.priorRequestIds).toHaveLength(2);
  for (const source of manifests[1]!.sources)
    expect(manifests[2]!.sources).toContainEqual(
      expect.objectContaining({ projection: source.projection, id: source.id }),
    );
  expect(JSON.stringify(manifests)).not.toContain('SECRET-SUBJECT');
  expect(JSON.stringify(manifests)).not.toContain('SECRET-ASK');
  expect(JSON.stringify(turn)).not.toContain('digest');
  expect(JSON.stringify(turn)).not.toContain('integrity');
});

it('a provider reply cannot resurrect a conversation deleted while it was pending', async () => {
  await start();
  await setBudget();
  const conversationId = randomUUID();
  chat = async () => {
    const [conversation] = await database.query(
      'SELECT version FROM ai_conversations WHERE id=$1',
      [conversationId],
    );
    expect(
      (
        await call(
          'DELETE',
          `/api/v1/assistant/conversations/${conversationId}`,
          { expectedVersion: conversation!.version },
        )
      ).statusCode,
    ).toBe(200);
    return completion({
      reply: 'DELETED-REPLY',
      actions: [action({ title: 'DELETED-PROPOSAL' })],
    });
  };
  const result = await call('POST', '/api/v1/assistant/requests', {
    operationId: randomUUID(),
    text: 'DELETED-ASK',
    conversationId,
    timeZone: 'UTC',
  });
  expect(result.statusCode).toBe(404);
  const [turn] = await database.query(
    'SELECT ask,reply,proposals,inference_history FROM ai_conversation_turns WHERE conversation_id=$1',
    [conversationId],
  );
  expect(turn).toMatchObject({
    ask: null,
    reply: null,
    proposals: [],
    inference_history: 'unbound',
  });
  expect(
    (await database.query('SELECT status FROM ai_budget_reservations'))[0]!
      .status,
  ).toBe('settled');
});

it('history overflow saves no partial binding', async () => {
  await start();
  await setBudget();
  await call('POST', '/api/v1/tasks', {
    title: 'One source',
    operationId: randomUUID(),
  });
  const turn = (await ask('Overflow')).json().turn;
  const [exchange] = await database.query(
    'SELECT manifest FROM ai_live_exchanges WHERE request_id=$1',
    [turn.id],
  );
  const manifest = exchange!.manifest as { history: { sources: unknown[] } };
  manifest.history.sources = Array.from({ length: 1000 }, () => ({
    kind: 'task',
    id: randomUUID(),
    labels: ['unlabeled'],
  }));
  await database.query(
    'UPDATE ai_live_exchanges SET manifest=$2 WHERE request_id=$1',
    [turn.id, JSON.stringify(manifest)],
  );
  await finishTurn(
    database,
    await ownerId(),
    turn.id,
    { reply: 'Overflow', proposals: [] },
    {
      mail: [],
      mailWithheld: 0,
      mailNote: null,
      binding: { requestId: turn.id },
    },
  );
  const [saved] = await database.query(
    'SELECT inference_history,inference_digest,inference_sources FROM ai_conversation_turns WHERE id=$1',
    [turn.id],
  );
  expect(saved).toMatchObject({
    inference_history: 'unbound',
    inference_digest: null,
    inference_sources: null,
  });
});

it('turning Personal mail off during the first exchange blocks the next one', async () => {
  await start();
  await setBudget();
  await importMail('personal', ['Private waiver']);
  const settings = (await call('GET', '/api/v1/assistant/settings')).json()
    .settings;
  await call('PUT', '/api/v1/assistant/settings', {
    model,
    expectedVersion: settings.version,
    allowPersonalMail: true,
  });
  chat = async () => {
    await database.query(
      'UPDATE ai_assistant_settings SET allow_personal_mail=false,version=version+1',
    );
    return completion({
      reply: 'Searching',
      actions: [],
      mailSearch: ['waiver'],
    });
  };
  const turn = (await askWithMail('Find waiver')).json().turn;
  expect(sent).toHaveLength(1);
  expect(turn.request.reason).toBe('context-changed');
  expect(turn.mailNote).toMatch(/source changed/);
});

it('relabeling an unchosen header hit blocks the cumulative body exchange', async () => {
  await start();
  await setBudget();
  await importMail('unlabeled', ['Waiver first', 'Waiver second']);
  chat = async () => {
    if (sent.length === 1)
      return completion({
        reply: 'Search',
        actions: [],
        mailSearch: ['waiver'],
      });
    if (sent.length === 2) {
      await database.query(
        "UPDATE email_messages SET sensitivity='restricted',version=version+1 WHERE subject='Waiver first'",
      );
      return completion({ reply: 'Reading', actions: [], read: ['m1'] });
    }
    return completion({ reply: 'Unexpected', actions: [] });
  };
  const turn = (await askWithMail('Find waiver')).json().turn;
  expect(sent).toHaveLength(2);
  expect(turn.request.reason).toBe('context-changed');
  expect(turn.request.reply).toBe('Reading');
  expect(turn.mailNote).toMatch(/source changed/);
});

it('deleting a conversation during preparation releases the admitted but unsent hold', async () => {
  await start();
  await setBudget();
  const conversationId = randomUUID();
  catalogHook = async () => {
    expect(
      (
        await call(
          'DELETE',
          `/api/v1/assistant/conversations/${conversationId}`,
          { expectedVersion: 1 },
        )
      ).statusCode,
    ).toBe(200);
  };
  const result = await call('POST', '/api/v1/assistant/requests', {
    operationId: randomUUID(),
    text: 'No resurrected ask',
    conversationId,
    timeZone: 'UTC',
  });
  expect(result.statusCode).toBe(404);
  expect(sent).toEqual([]);
  expect(
    await database.query('SELECT status FROM ai_budget_reservations'),
  ).toEqual([{ status: 'released' }]);
  expect(await database.query('SELECT id FROM ai_conversation_turns')).toEqual(
    [],
  );
});

it('signing out during preparation blocks transmission and releases the hold', async () => {
  await start();
  await setBudget();
  catalogHook = async () => {
    await database.query('DELETE FROM sessions');
  };
  const result = await ask('Private ask');
  expect(result.json().request).toMatchObject({
    status: 'failed',
    reason: 'context-changed',
  });
  expect(sent).toEqual([]);
  expect(
    await database.query('SELECT status FROM ai_budget_reservations'),
  ).toEqual([{ status: 'released' }]);
});

it('rejects malformed destination preview models before response parsing', async () => {
  await start();
  expect(
    (await call('GET', '/api/v1/assistant/destination?model=invalid'))
      .statusCode,
  ).toBe(400);
});

async function seedAcademic(
  options: {
    owner?: string;
    courseSensitivity?: string;
    workSensitivity?: string;
    academicLabels?: string[];
    title?: string;
    kind?: string;
    notes?: string;
    dueDate?: string | null;
    estimatedMinutes?: number | null;
    status?: string;
    priority?: number;
    workVersion?: number;
    courseVersion?: number;
    workDeleted?: boolean;
    courseArchived?: boolean;
  } = {},
) {
  const owner = options.owner ?? (await ownerId());
  const courseId = randomUUID();
  const workId = randomUUID();
  await database.query(
    'INSERT INTO courses(id,owner_id,name,sensitivity,version,deleted_at) VALUES($1,$2,$3,$4,$5,$6)',
    [
      courseId,
      owner,
      'Synthetic class',
      options.courseSensitivity ?? 'unlabeled',
      options.courseVersion ?? 1,
      options.courseArchived ? '2026-10-01T00:00:00Z' : null,
    ],
  );
  await database.query(
    `INSERT INTO academic_work(id,owner_id,course_id,title,kind,notes,due_date,estimated_minutes,priority,status,sensitivity,academic_labels,version,deleted_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      workId,
      owner,
      courseId,
      options.title ?? 'Synthetic work',
      options.kind ?? 'assignment',
      options.notes ?? 'Private working note',
      options.dueDate ?? null,
      options.estimatedMinutes ?? null,
      options.priority ?? 3,
      options.status ?? 'planned',
      options.workSensitivity ?? 'unlabeled',
      options.academicLabels ?? [],
      options.workVersion ?? 1,
      options.workDeleted ? '2026-10-01T00:00:00Z' : null,
    ],
  );
  return { courseId, workId };
}

const askAcademic = (text: string, academic: unknown[]) =>
  call('POST', '/api/v1/assistant/requests', {
    operationId: randomUUID(),
    text,
    timeZone: 'America/Denver',
    academic,
  });

const lastPayload = (body: Record<string, unknown>) =>
  JSON.parse(
    (body.messages as { content: string }[]).at(-1)!.content,
  ) as Record<string, unknown>;

it('sends selected academic work, projects only planning fields and replays the ask', async () => {
  await start();
  await setBudget();
  const owner = await ownerId();
  const { courseId, workId } = await seedAcademic({
    title: 'Final essay',
    kind: 'exam',
    notes: 'SECRET working notes',
    dueDate: '2026-11-01',
    estimatedMinutes: 90,
    priority: 2,
  });
  chat = () => completion({ reply: 'Planned it.', actions: [] });
  const operationId = randomUUID();
  const selection = [
    { id: workId, expectedVersion: 1, expectedCourseVersion: 1 },
  ];
  const { request, turn } = (
    await call('POST', '/api/v1/assistant/requests', {
      operationId,
      text: 'Plan my essay',
      timeZone: 'America/Denver',
      academic: selection,
    })
  ).json();
  expect(request).toMatchObject({ status: 'completed', withheld: 0 });
  const sentWork = {
    id: workId,
    ref: 'w1',
    title: 'Final essay',
    kind: 'exam',
    dueDate: '2026-11-01',
    estimatedMinutes: 90,
    status: 'planned',
    priority: 2,
  };
  expect(turn.academic).toEqual([sentWork]);
  expect(lastPayload(sent[0]!).academic).toEqual([
    {
      ref: 'w1',
      title: 'Final essay',
      kind: 'exam',
      dueDate: '2026-11-01',
      estimatedMinutes: 90,
      status: 'planned',
      priority: 2,
    },
  ]);
  // Notes never leave the server.
  expect(JSON.stringify(sent[0])).not.toContain('SECRET');
  const [exchange] = await database.query<{
    manifest: { sources: Record<string, unknown>[] };
  }>(
    'SELECT manifest FROM ai_live_exchanges WHERE owner_id=$1 AND request_id=$2',
    [owner, request.id],
  );
  expect(
    exchange!.manifest.sources.find((s) => s.kind === 'academic-work'),
  ).toMatchObject({
    projection: 'academic-work-v1',
    id: workId,
    version: 1,
    ref: 'w1',
    labels: ['unlabeled'],
    academicCourse: { id: courseId, version: 1 },
  });
  // Retrying the same selection again replays the recorded turn.
  const retried = (
    await call('POST', '/api/v1/assistant/requests', {
      operationId,
      text: 'Plan my essay',
      timeZone: 'America/Denver',
      academic: selection,
    })
  ).json().turn;
  expect(retried.id).toBe(turn.id);
  expect(sent).toHaveLength(1);
});

it('withholds restricted and disallowed personal work until personal mail is allowed', async () => {
  await start();
  await setBudget();
  const restricted = await seedAcademic({
    title: 'Restricted essay',
    academicLabels: ['restricted'],
  });
  const personal = await seedAcademic({
    title: 'Personal reading',
    academicLabels: ['personal'],
  });
  const plain = await seedAcademic({ title: 'Open lab' });
  chat = () => completion({ reply: 'Ok.', actions: [] });
  const selection = [restricted, personal, plain].map((s) => ({
    id: s.workId,
    expectedVersion: 1,
    expectedCourseVersion: 1,
  }));
  const { request, turn } = (
    await call('POST', '/api/v1/assistant/requests', {
      operationId: randomUUID(),
      text: 'Plan my week',
      timeZone: 'America/Denver',
      academic: selection,
    })
  ).json();
  expect(request).toMatchObject({ status: 'completed', withheld: 2 });
  expect(turn.academic.map((a: { ref: string }) => a.ref)).toEqual(['w1']);
  expect(turn.academic[0]).toMatchObject({ id: plain.workId });
  expect(lastPayload(sent[0]!).academic).toHaveLength(1);
  const wire = JSON.stringify(sent[0]);
  expect(wire).not.toContain('Restricted essay');
  expect(wire).not.toContain('Personal reading');

  const settings = (await call('GET', '/api/v1/assistant/settings')).json()
    .settings;
  await call('PUT', '/api/v1/assistant/settings', {
    model,
    expectedVersion: settings.version,
    allowPersonalMail: true,
  });
  const second = (
    await call('POST', '/api/v1/assistant/requests', {
      operationId: randomUUID(),
      text: 'Plan again',
      timeZone: 'America/Denver',
      academic: [restricted, personal].map((s) => ({
        id: s.workId,
        expectedVersion: 1,
        expectedCourseVersion: 1,
      })),
    })
  ).json();
  expect(second.request).toMatchObject({ withheld: 1 });
  expect(second.turn.academic.map((a: { title: string }) => a.title)).toEqual([
    'Personal reading',
  ]);
  expect(sent).toHaveLength(2);
});

it('blocks a stale, deleted or archived academic selection before any hold', async () => {
  await start();
  await setBudget();
  const stale = await seedAcademic({ title: 'Moved on', workVersion: 3 });
  const archived = await seedAcademic({ courseArchived: true });
  const deleted = await seedAcademic({ workDeleted: true });
  const select = (id: string) => [
    { id, expectedVersion: 1, expectedCourseVersion: 1 },
  ];
  expect(
    (await askAcademic('Plan', select(stale.workId))).json().error.code,
  ).toBe('VERSION_CONFLICT');
  expect(
    (await askAcademic('Plan', select(archived.workId))).json().error.code,
  ).toBe('ACADEMIC_CLASS_ARCHIVED');
  expect(
    (await askAcademic('Plan', select(deleted.workId))).json().error.code,
  ).toBe('NOT_FOUND');
  expect(sent).toHaveLength(0);
  expect(
    await database.query('SELECT 1 FROM ai_assistant_requests'),
  ).toHaveLength(0);
});

it('treats an omitted academic selection as an empty one', async () => {
  await start();
  await setBudget();
  chat = () => completion({ reply: 'Ok.', actions: [] });
  const operationId = randomUUID();
  const first = (
    await call('POST', '/api/v1/assistant/requests', {
      operationId,
      text: 'Plan my week',
      timeZone: 'America/Denver',
      academic: [],
    })
  ).json().turn;
  const second = (
    await call('POST', '/api/v1/assistant/requests', {
      operationId,
      text: 'Plan my week',
      timeZone: 'America/Denver',
    })
  ).json().turn;
  expect(second.id).toBe(first.id);
  expect(second.academic).toEqual([]);
  expect(sent).toHaveLength(1);
});

it('binds academic labels onto a proposal applied from the turn', async () => {
  await start();
  await setBudget();
  const { workId } = await seedAcademic({ title: 'Term paper' });
  chat = () =>
    completion({
      reply: 'Added it.',
      actions: [action({ title: 'Draft outline' })],
    });
  const { turn } = (
    await call('POST', '/api/v1/assistant/requests', {
      operationId: randomUUID(),
      text: 'Break it down',
      timeZone: 'America/Denver',
      academic: [{ id: workId, expectedVersion: 1, expectedCourseVersion: 1 }],
    })
  ).json();
  expect(turn.proposalAccess).toBe('applicable');
  const applied = (
    await call('POST', `/api/v1/assistant/turns/${turn.id}/apply`, {
      expectedVersion: turn.version,
      indexes: [0],
      operationId: randomUUID(),
    })
  ).json().turn;
  expect(applied.items[0]).toMatchObject({ state: 'applied' });
  const [row] = await database.query<{
    ai_origin: string;
    ai_labels: string[];
  }>('SELECT ai_origin,ai_labels FROM tasks WHERE owner_id=$1 AND id=$2', [
    await ownerId(),
    applied.items[0].applied.id,
  ]);
  expect(row).toMatchObject({ ai_origin: 'bound-derived' });
  expect(row!.ai_labels).toEqual(['unlabeled']);
});

it('refuses an academic selection owned by someone else', async () => {
  await start();
  await setBudget();
  const other = randomUUID();
  await database.query(
    "INSERT INTO users(id,email,password_hash) VALUES($1,'intruder@example.test','unused')",
    [other],
  );
  const foreign = await seedAcademic({ owner: other, title: 'Not mine' });
  const result = (
    await askAcademic('Plan', [
      { id: foreign.workId, expectedVersion: 1, expectedCourseVersion: 1 },
    ])
  ).json();
  expect(result.error.code).toBe('NOT_FOUND');
  expect(sent).toHaveLength(0);
  expect(
    await database.query('SELECT 1 FROM ai_assistant_requests'),
  ).toHaveLength(0);
});

it('never sends academic sources on an agent run', async () => {
  await start();
  await setBudget();
  await seedAcademic({ title: 'Should not leave' });
  const owner = await ownerId();
  const turn = await answerTurn(database, config, fetcherInUse, owner, {
    operationId: randomUUID(),
    prompt: 'GOAL-TEXT',
    ask: 'Scheduled run',
    timeZone: 'America/Denver',
    conversationId: randomUUID(),
    useMail: false,
    trigger: 'agent',
  });
  expect(turn.academic).toEqual([]);
  expect(lastPayload(sent[0]!).academic).toEqual([]);
  const [exchange] = await database.query<{
    manifest: { sources: { kind: string }[] };
  }>(
    'SELECT manifest FROM ai_live_exchanges WHERE owner_id=$1 AND request_id=$2',
    [owner, turn.id],
  );
  expect(
    exchange!.manifest.sources.some((s) => s.kind === 'academic-work'),
  ).toBe(false);
});

it('applies an academic task through the source operation and retains its link through retry, Undo and restore', async () => {
  await start();
  await setBudget();
  const { workId, courseId } = await seedAcademic({
    title: 'Essay',
    dueDate: '2036-05-20',
    estimatedMinutes: 90,
  });
  chat = () =>
    completion({
      reply: 'Review the task.',
      actions: [
        action({ ref: 'w1', title: 'Draft outline', dueDate: '2036-05-18' }),
      ],
    });
  const { turn } = (
    await askAcademic('Make an outline task', [
      { id: workId, expectedVersion: 1, expectedCourseVersion: 1 },
    ])
  ).json();
  expect(turn.request.proposals[0].academicSource).toEqual({
    id: workId,
    expectedWorkVersion: 1,
    expectedCourseVersion: 1,
    title: 'Essay',
  });
  const apply = {
    expectedVersion: turn.version,
    indexes: [0],
    operationId: randomUUID(),
  };
  const result = await call(
    'POST',
    `/api/v1/assistant/turns/${turn.id}/apply`,
    apply,
  );
  expect(result.statusCode).toBe(200);
  const saved = result.json().turn;
  expect(saved.items[0]).toMatchObject({ state: 'applied', error: null });
  const task = saved.items[0].applied;
  expect(
    (
      await call('POST', `/api/v1/assistant/turns/${turn.id}/apply`, apply)
    ).json().turn.items[0].applied,
  ).toEqual(task);
  const source = (
    await call('GET', `/api/v1/tasks/${task.id}/academic-source`)
  ).json().source;
  expect(source).toMatchObject({
    workId,
    snapshot: {
      id: workId,
      courseId,
      dueDate: '2036-05-20',
      estimatedMinutes: 90,
    },
  });
  expect(
    (await call('GET', `/api/v1/tasks/${task.id}`)).json().task,
  ).toMatchObject({ dueDate: '2036-05-18', completed: false });
  const undone = (
    await call('POST', `/api/v1/assistant/turns/${turn.id}/undo`, {
      expectedVersion: saved.version,
      indexes: [0],
      operationId: randomUUID(),
    })
  ).json().turn;
  expect(undone.items[0].state).toBe('undone');
  const deleted = (await call('GET', `/api/v1/tasks/${task.id}`)).json().task;
  expect(deleted.deletedAt).not.toBeNull();
  const restored = await call('POST', `/api/v1/tasks/${task.id}/restore`, {
    operationId: randomUUID(),
    expectedVersion: deleted.version,
  });
  expect(restored.statusCode).toBe(200);
  expect(
    (await call('GET', `/api/v1/tasks/${task.id}/academic-source`)).json()
      .source.id,
  ).toBe(source.id);
  const [work] = await database.query(
    'SELECT status,estimated_minutes FROM academic_work WHERE id=$1',
    [workId],
  );
  expect(work).toEqual({ status: 'planned', estimated_minutes: 90 });
  const [count] = await database.query(
    'SELECT count(*)::int AS count FROM academic_planner_sources WHERE work_id=$1',
    [workId],
  );
  expect(count!.count).toBe(1);
});

it.each(['work-edit', 'class-edit', 'closed', 'archived', 'deleted'])(
  'refuses an academic task when its source is %s before Apply',
  async (change) => {
    await start();
    await setBudget();
    const { workId, courseId } = await seedAcademic();
    chat = () =>
      completion({
        reply: 'Review.',
        actions: [action({ ref: 'w1', title: 'Source task' })],
      });
    const { turn } = (
      await askAcademic('Add a task', [
        { id: workId, expectedVersion: 1, expectedCourseVersion: 1 },
      ])
    ).json();
    if (change === 'work-edit')
      await database.query(
        'UPDATE academic_work SET version=version+1 WHERE id=$1',
        [workId],
      );
    if (change === 'class-edit')
      await database.query('UPDATE courses SET version=version+1 WHERE id=$1', [
        courseId,
      ]);
    if (change === 'closed')
      await database.query(
        "UPDATE academic_work SET status='submitted',version=version+1 WHERE id=$1",
        [workId],
      );
    if (change === 'archived')
      await database.query(
        'UPDATE courses SET deleted_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1',
        [courseId],
      );
    if (change === 'deleted')
      await database.query(
        'UPDATE academic_work SET deleted_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1',
        [workId],
      );
    const response = await call(
      'POST',
      `/api/v1/assistant/turns/${turn.id}/apply`,
      {
        expectedVersion: turn.version,
        indexes: [0],
        operationId: randomUUID(),
      },
    );
    if (change === 'work-edit' || change === 'closed') {
      expect(response.statusCode).toBe(200);
      expect(response.json().turn.items[0]).toMatchObject({
        state: 'failed',
        applied: null,
      });
    } else expect(response.statusCode).toBe(409);
    const [count] = await database.query(
      'SELECT count(*)::int AS count FROM tasks WHERE owner_id=$1',
      [await ownerId()],
    );
    expect(count!.count).toBe(0);
  },
);

it('drops invented, withheld and closed academic references instead of creating unlinked fallback tasks', async () => {
  await start();
  await setBudget();
  const closed = await seedAcademic({ status: 'submitted' });
  const hidden = await seedAcademic({
    workSensitivity: 'restricted',
    academicLabels: ['restricted'],
  });
  chat = () =>
    completion({
      reply: 'No open work.',
      actions: [
        action({ ref: 'w1', title: 'Closed' }),
        action({ ref: 'w2', title: 'Withheld' }),
        action({ ref: 'w99', title: 'Invented' }),
      ],
    });
  const { turn } = (
    await askAcademic(
      'Make tasks',
      [closed, hidden].map((source) => ({
        id: source.workId,
        expectedVersion: 1,
        expectedCourseVersion: 1,
      })),
    )
  ).json();
  expect(turn.request.proposals).toEqual([]);
  expect(turn.request.dropped).toBe(3);
  expect(turn.academic).toHaveLength(1);
});
