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
  app = await buildApp(
    { logger: false },
    {
      config,
      database: await openDatabase(config),
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
const classify = (messages: unknown[], operationId = randomUUID()) =>
  call('POST', '/api/v1/email/classify', { operationId, messages });

it('sends only allowed, verified mail and returns suggestions without saving them', async () => {
  const [open, old] = await importMail('unlabeled', [
    { key: '<a@x>', subject: 'Invoice 42' },
    { key: '<b@x>', subject: 'Old import', verified: false },
  ]);
  const [personal] = await importMail('personal', [
    { key: '<c@x>', subject: 'Dinner Friday?' },
  ]);
  const [restricted] = await importMail('restricted', [
    { key: '<d@x>', subject: 'Medical results' },
  ]);
  chat = () =>
    completion({
      results: [
        {
          ref: 'm1',
          category: 'receipts',
          reason: 'Invoice number and total.',
        },
        { ref: 'm7', category: 'personal', reason: 'Invented ref.' },
      ],
    });
  const reply = (await classify([open, old, personal, restricted])).json();
  expect(reply.blocked).toEqual([
    { id: old!.id, reason: 'provenance' },
    { id: personal!.id, reason: 'personal-not-allowed' },
    { id: restricted!.id, reason: 'restricted' },
  ]);
  expect(reply.request).toMatchObject({
    status: 'completed',
    resultAvailable: true,
    costMicros: 200,
    dropped: 1,
    suggestions: [
      {
        id: open!.id,
        expectedVersion: open!.expectedVersion,
        category: 'receipts',
        reason: 'Invoice number and total.',
      },
    ],
  });
  const text = JSON.stringify(sent[0]);
  expect(text).toContain('Invoice 42');
  for (const hidden of ['Old import', 'Dinner Friday?', 'Medical results'])
    expect(text).not.toContain(hidden);
  expect(text).not.toContain(open!.id);
  expect(sent[0]).toMatchObject({
    provider: {
      only: ['anthropic', 'google-vertex', 'amazon-bedrock'],
      allow_fallbacks: false,
      zdr: true,
    },
  });
  // Nothing is categorized until the owner applies a suggestion.
  const stored = (await call('GET', '/api/v1/email/messages?limit=100')).json();
  expect(
    stored.messages.find((m: { id: string }) => m.id === open!.id).category,
  ).toBeNull();
});

it('sends Personal mail only after the owner allows it, and never resends a retry', async () => {
  const [personal] = await importMail('personal', [
    { key: '<p@x>', subject: 'Weekend plans' },
  ]);
  const operationId = randomUUID();
  expect((await classify([personal], operationId)).json()).toEqual({
    request: null,
    blocked: [{ id: personal!.id, reason: 'personal-not-allowed' }],
  });
  expect(sent).toHaveLength(0);
  const settings = (await call('GET', '/api/v1/assistant/settings')).json()
    .settings;
  expect(
    (
      await call('PUT', '/api/v1/assistant/settings', {
        model: settings.model,
        expectedVersion: settings.version,
        allowPersonalMail: true,
      })
    ).json().settings.allowPersonalMail,
  ).toBe(true);
  chat = () =>
    completion({
      results: [{ ref: 'm1', category: 'personal', reason: 'Friend plans.' }],
    });
  const again = randomUUID();
  expect(
    (await classify([personal], again)).json().request.suggestions,
  ).toHaveLength(1);
  const retry = (await classify([personal], again)).json();
  expect(retry.request).toMatchObject({
    resultAvailable: false,
    suggestions: [],
  });
  expect(sent).toHaveLength(1);
  // A changed message is reported, not sent.
  expect(
    (await classify([{ id: personal!.id, expectedVersion: 99 }])).json()
      .blocked,
  ).toEqual([{ id: personal!.id, reason: 'changed' }]);
});

it('charges invalid output without suggestions', async () => {
  const [message] = await importMail('unlabeled', [
    { key: '<i@x>', subject: 'Newsletter' },
  ]);
  chat = () => completion('not structured');
  expect((await classify([message])).json().request).toMatchObject({
    status: 'completed',
    reason: 'invalid',
    resultAvailable: false,
    costMicros: 200,
  });
});
