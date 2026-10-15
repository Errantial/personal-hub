import { approveLiveDestination } from './helpers/openrouter.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { chatUrl, modelsUrl, zdrUrl } from '../src/ai/openrouter-live.js';

// Provider exchanges are injected; global fetch is forbidden.
const origin = 'http://127.0.0.1:5173';
const model = 'anthropic/claude-haiku-5.5';
let app: Awaited<ReturnType<typeof buildApp>>;
let database: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let sent: Record<string, unknown>[];
let chat: (body: Record<string, unknown>) => Response;

const completion = (content: unknown, cost = '0.0002') =>
  new Response(
    `{"id":"gen-mail-1","model":"${model}","usage":{"prompt_tokens":800,"completion_tokens":90,"total_tokens":890,"cost":${cost}},"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":${JSON.stringify(JSON.stringify(content))}}}]}`,
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const call = (method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET',
    url,
    headers: { origin, cookie },
    ...(payload ? { payload } : {}),
  });

beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden.');
    }),
  );
  const config = readConfig({
    NODE_ENV: 'test',
    PGLITE_DATA_DIR: 'memory://',
    AI_SECRET_OPENROUTER: 'sk-or-synthetic-test',
  });
  sent = [];
  chat = () => completion({ results: [] });
  database = await openDatabase(config);
  app = await buildApp(
    { logger: false },
    {
      config,
      database,
      openRouterFetch: async (url, init) => {
        if (url === modelsUrl)
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: model,
                  pricing: { prompt: '0.0000001', completion: '0.0000005' },
                },
              ],
            }),
            { status: 200 },
          );
        if (url === zdrUrl)
          return new Response(
            JSON.stringify({
              data: [
                {
                  model_id: model,
                  tag: 'google-vertex/global',
                  supported_parameters: ['structured_outputs'],
                },
              ],
            }),
            { status: 200 },
          );
        if (url === chatUrl) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          sent.push(body);
          return chat(body);
        }
        throw new Error(`Unexpected ${url}`);
      },
    },
  );
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: { email: 'classify@example.test', password: 'synthetic-password' },
  });
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  await approveLiveDestination(call);
  await call('PUT', '/api/v1/ai/budget', {
    operationId: randomUUID(),
    expectedVersion: 1,
    policy: { monthlyLimitMicros: 50000000, perRequestLimitMicros: 250000 },
  });
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app.close();
});

/** A connector with the given label and uploaded messages; returns refs. */
async function importMail(
  sensitivity: string,
  messages: { key: string; subject: string; verified?: boolean }[],
) {
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
      exists: messages.length,
      inWindow: messages.length,
      lastUid: messages.length,
      messages: messages.map((message, index) => ({
        uid: index + 1,
        messageKey: message.key,
        from: { name: 'Sender', address: 'sender@example.test' },
        to: [],
        cc: [],
        subject: message.subject,
        sentAt: null,
        receivedAt: `2026-10-0${index + 1}T10:00:00.000Z`,
        body: `Body of ${message.subject}`,
        bodyTruncated: false,
        attachmentCount: 0,
        ...(message.verified === false
          ? {}
          : { textOrigin: 'message-body-v1' }),
      })),
    },
  });
  const page = (await call('GET', '/api/v1/email/messages?limit=100')).json();
  return messages.map((message) => {
    const found = page.messages.find(
      (item: { subject: string }) => item.subject === message.subject,
    );
    return { id: found.id as string, expectedVersion: found.version as number };
  });
}
const suggest = (
  ref: { id: string; expectedVersion: number },
  operationId = randomUUID(),
) =>
  call('POST', `/api/v1/email/messages/${ref.id}/task-suggestions`, {
    operationId,
    expectedVersion: ref.expectedVersion,
    timeZone: 'America/Denver',
  });

it('keeps only suggestions that quote the body exactly, and they can be captured', async () => {
  const [message] = await importMail('unlabeled', [
    { key: '<t@x>', subject: 'Form due' },
  ]);
  // The imported body is "Body of Form due".
  chat = () =>
    completion({
      tasks: [
        {
          title: 'Submit form',
          quote: ' Body of Form due ',
          dueDate: '2036-03-06',
          notes: '',
        },
        {
          title: 'Paraphrased',
          quote: 'The form is due',
          dueDate: null,
          notes: '',
        },
        {
          title: 'Bad date',
          quote: 'Form due',
          dueDate: '2036-02-30',
          notes: '',
        },
      ],
    });
  const reply = (await suggest(message!)).json();
  expect(reply.blocked).toBeNull();
  expect(reply.request).toMatchObject({
    status: 'completed',
    resultAvailable: true,
    dropped: 2,
    costMicros: 200,
    suggestions: [
      {
        title: 'Submit form',
        quote: 'Body of Form due',
        dueDate: '2036-03-06',
        notes: '',
      },
    ],
  });
  const text = JSON.stringify(sent[0]);
  expect(text).toContain('Body of Form due');
  expect(text).not.toContain(message!.id);
  // Nothing was created; the owner captures it through the manual route.
  const created = await call(
    'POST',
    `/api/v1/email/messages/${message!.id}/tasks`,
    {
      operationId: randomUUID(),
      expectedVersion: message!.expectedVersion,
      title: 'Submit form',
      quote: 'Body of Form due',
      dueDate: '2036-03-06',
      deadlineConfirmed: true,
    },
  );
  expect(created.statusCode).toBe(201);
});

it('does not send blocked mail and never resends a retry', async () => {
  const [restricted] = await importMail('restricted', [
    { key: '<r@x>', subject: 'Private' },
  ]);
  expect((await suggest(restricted!)).json()).toEqual({
    request: null,
    blocked: 'restricted',
  });
  const [open] = await importMail('unlabeled', [
    { key: '<o@x>', subject: 'Reply needed' },
  ]);
  chat = () => completion({ tasks: [] });
  const operationId = randomUUID();
  expect((await suggest(open!, operationId)).json().request).toMatchObject({
    resultAvailable: true,
    suggestions: [],
  });
  expect((await suggest(open!, operationId)).json().request).toMatchObject({
    resultAvailable: false,
  });
  expect(sent).toHaveLength(1);
  expect(
    (await suggest({ ...open!, expectedVersion: 99 })).json().blocked,
  ).toBe('changed');
});

it('sends only the pinned host and binds the exact selected message and connector', async () => {
  const [message] = await importMail('unlabeled', [
    { key: 'pinned-task', subject: 'Pinned task' },
  ]);
  chat = () => completion({ tasks: [] });
  const result = await suggest(message!);
  expect(result.statusCode).toBe(200);
  expect(sent[0]!.provider).toEqual({
    only: ['google-vertex'],
    order: ['google-vertex'],
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: 'deny',
    zdr: true,
  });
  const [exchange] = await database.query(
    'SELECT manifest FROM ai_live_exchanges',
  );
  expect(exchange!.manifest).toMatchObject({
    sources: [
      {
        projection: 'mail-task-v1',
        id: message!.id,
        version: message!.expectedVersion,
        connector: { id: expect.any(String), version: expect.any(Number) },
      },
    ],
  });
  expect(JSON.stringify(exchange!.manifest)).not.toContain('Pinned task');
});
