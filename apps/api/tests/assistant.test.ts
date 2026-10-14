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
import { toProposal } from '../src/features/assistant.js';

// Every provider exchange is injected; global fetch is forbidden.
const origin = 'http://127.0.0.1:5173';
const model = 'anthropic/claude-haiku-5.5';
const base = { NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' };
let app: Awaited<ReturnType<typeof buildApp>>;
let database: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let chat: (body: Record<string, unknown>) => Promise<Response> | Response;
let sent: Record<string, unknown>[];

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
  const config = readConfig({
    ...base,
    ...(key ? { AI_SECRET_OPENROUTER: key } : {}),
  });
  database = await openDatabase(config);
  sent = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url === modelsUrl) return catalog();
    if (url === zdrUrl) return zdr();
    if (url === chatUrl) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push(body);
      return chat(body);
    }
    throw new Error(`Unexpected ${url}`);
  });
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
      only: ['anthropic', 'google-vertex', 'amazon-bedrock'],
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

it('stores applied state so another device can undo with the same write IDs', async () => {
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
  const item = {
    ...turn.items[0],
    state: 'applied',
    applied: { id: randomUUID(), version: 1 },
  };
  const saved = (
    await call('PUT', `/api/v1/assistant/turns/${turn.id}/items`, {
      expectedVersion: turn.version,
      items: [item],
    })
  ).json().turn;
  expect(saved.items[0]).toEqual(item);
  // A stale device is told to reload; changed write IDs are refused.
  expect(
    (
      await call('PUT', `/api/v1/assistant/turns/${turn.id}/items`, {
        expectedVersion: turn.version,
        items: [item],
      })
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
  expect(
    (
      await call('PUT', `/api/v1/assistant/turns/${turn.id}/items`, {
        expectedVersion: saved.version,
        items: [{ ...item, applyId: randomUUID() }],
      })
    ).statusCode,
  ).toBe(400);
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
