import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { plannerExportSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { migrate } from '../src/db/migrate.js';

import { executeSyntheticOpenRouterRequest } from '../src/ai/synthetic-openrouter-execution.js';
import type { OpenRouterTestIO } from '../src/ai/openrouter-protocol.js';
import {
  confirmSyntheticOpenRouterAttempt,
  confirmSyntheticAttempt,
  beginSyntheticAttempt,
} from '../src/ai/synthetic-execution.js';

import { readAIBudget } from '../src/features/ai-budget.js';

const profile = {
  alias: 'test',
  adapter: 'openrouter',
  upstreamProvider: 'test-provider/test-region',
  model: 'synthetic-only',
  credentialEnv: 'AI_SECRET_TEST',
  enabled: true,
  maxInputCharacters: 48000,
  maxOutputTokens: 2000,
  pricing: {
    revision: 'test-v1',
    validUntil: '2050-01-01T00:00:00.000Z',
    inputTokenLimit: 48000,
    inputMicrosPerMillionTokens: 1000000,
    outputMicrosPerMillionTokens: 1000000,
  },
  retentionDisclosure: {
    revision: 'test-v1',
    summary: 'Synthetic test disclosure',
  },
};
const environment = {
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  AI_SECRET_TEST: 'synthetic-only',
  AI_PROVIDER_PROFILES: JSON.stringify([profile]),
};
const config = readConfig(environment),
  origin = 'http://127.0.0.1:5173',
  text = 'Private synthetic prompt not retained';
const output = {
  answer: 'Private consented synthetic answer',
  suggestions: [],
};
let db: Awaited<ReturnType<typeof openDatabase>>,
  app: Awaited<ReturnType<typeof buildApp>>,
  owner: string,
  cookie: string,
  otherCookie: string,
  registry: string;
const network = vi.fn(() => {
  throw Error('Network forbidden');
});
const headers = (session = cookie) => ({ origin, cookie: session });
const change = (expectedVersion: number) => ({
  operationId: randomUUID(),
  expectedVersion,
});
const write = (
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload: object,
  session = cookie,
) => app.inject({ method, url, payload, headers: headers(session) });
const get = (url: string, session = cookie) =>
  app.inject({ url, headers: headers(session) });
const requestBody = (extra: object = {}) => ({
  operationId: randomUUID(),
  expectedPolicyVersion: 2,
  expectedBudgetVersion: 2,
  expectedRegistryRevision: registry,
  text,
  sensitivity: 'unlabeled',
  sources: [],
  ...extra,
});
async function request(extra: object = {}) {
  const response = await write(
    'POST',
    '/api/v1/ai/requests',
    requestBody(extra),
  );
  expect(response.statusCode).toBe(201);
  return response.json();
}
const confirmed = (extra: object = {}) => ({
  generationId: 'gen-durable-test',
  usage: { inputTokens: 5, outputTokens: 3, actualMicros: 10001 },
  outputState: 'validated' as const,
  output,
  ...extra,
});
const packet = (extra: object = {}) => ({
  id: 'gen-durable-test',
  model: 'synthetic-only',
  usage: {
    prompt_tokens: 5,
    completion_tokens: 3,
    total_tokens: 8,
    cost: 0.01,
  },
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify(output) },
    },
  ],
  ...extra,
});
const response = (value = packet()) =>
  new Response(JSON.stringify(value).replace('0.01', '0.0100000000000000001'), {
    headers: { 'Content-Type': 'application/json' },
  });
const execute = (
  saved: { id: string },
  io: OpenRouterTestIO = async () => response(),
  options = {},
) =>
  executeSyntheticOpenRouterRequest(
    db,
    config,
    owner,
    saved.id,
    1,
    text,
    io,
    options,
  );
beforeAll(async () => {
  vi.stubGlobal('fetch', network);
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const enrollment = await write(
    'POST',
    '/api/v1/auth/setup',
    { email: 'answers@example.test', password: 'synthetic-answers-password' },
    '',
  );
  expect(enrollment.statusCode).toBe(201);
  owner = enrollment.json().user.id;
  cookie = String(enrollment.headers['set-cookie']).split(';')[0]!;
  registry = (await get('/api/v1/ai/providers')).json().revision;
  const route = { allowed: ['test'], preferred: 'test' };
  expect(
    (
      await write('PUT', '/api/v1/ai/routing', {
        ...change(1),
        policy: { unlabeled: route, personal: route, restricted: route },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await write('PUT', '/api/v1/ai/budget', {
        ...change(1),
        policy: { monthlyLimitMicros: 50000000, perRequestLimitMicros: 250000 },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await write('PUT', '/api/v1/ai/provider-consents/test', {
        ...change(1),
        approved: true,
        expectedRegistryRevision: registry,
      })
    ).statusCode,
  ).toBe(200);
  const id = randomUUID(),
    token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    id,
    'other-answers@example.test',
    'unused',
  ]);
  await db.query(
    'INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,$3)',
    [
      createHash('sha256').update(token).digest('hex'),
      id,
      new Date(Date.now() + 3600000),
    ],
  );
  otherCookie = `hub_session=${token}`;
});
afterAll(async () => {
  expect(network).not.toHaveBeenCalled();
  await app?.close();
  vi.unstubAllGlobals();
});

it('upgrades populated pre-protocol attempts without inventing reported usage or changing spend/versions', async () => {
  const saved = await request();
  await beginSyntheticAttempt(db, config, owner, saved.id, 1, text);
  const legacy = await confirmSyntheticAttempt(db, config, owner, saved.id, {
    outcome: 'completed',
    inputTokens: 1,
    outputTokens: 2,
  });
  const budget = await readAIBudget(db, owner);
  // Isolated synthetic schema only: emulate the populated pre-042 state.
  await db.exec(
    "ALTER TABLE ai_attempts DROP COLUMN protocol_metadata; DELETE FROM schema_migrations WHERE name='042_ai_protocol_metadata.sql';",
  );
  await migrate(db);
  const upgraded = (await get(`/api/v1/ai/requests/${saved.id}`)).json();
  expect(upgraded).toMatchObject({
    version: legacy.version,
    attempt: {
      version: legacy.attempt!.version,
      actualMicros: 3,
      protocolMetadata: null,
    },
  });
  expect((await readAIBudget(db, owner)).usage).toEqual(budget.usage);
  await migrate(db);
});

it('atomically settles exact reported costs/native tokens and saves only consented answers', async () => {
  const saved = await request({ saveAnswer: true });
  const io = vi.fn(async () => response());
  const result = await execute(saved, io);
  expect(result.request).toMatchObject({
    status: 'completed',
    attempt: {
      actualMicros: 10001,
      inputTokens: 5,
      outputTokens: 3,
      protocolMetadata: {
        synthetic: true,
        protocol: 'openrouter',
        generationId: 'gen-durable-test',
        outputState: 'validated',
      },
      resultMetadata: { retained: true, status: 'validated' },
    },
  });
  expect(result.result?.output).toEqual(output);
  expect(
    (await get(`/api/v1/ai/requests/${saved.id}/answer`)).json().answer.output,
  ).toEqual(output);
  expect(
    JSON.stringify((await get(`/api/v1/ai/requests/${saved.id}`)).json()),
  ).not.toContain(output.answer);
  const [reservation] = await db.query(
    'SELECT status,actual_micros::text FROM ai_budget_reservations WHERE request_id=$1',
    [saved.id],
  );
  expect(reservation).toMatchObject({
    status: 'settled',
    actual_micros: '10001',
  });
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(
    exported.records.aiSavedAnswers.some(
      (answer) => answer.requestId === saved.id,
    ),
  ).toBe(true);
  expect(JSON.stringify(exported)).not.toContain(text);
  await execute(saved, io);
  expect(io).toHaveBeenCalledTimes(1);
});

it('returns temporary guidance once without retaining output in status/history', async () => {
  const saved = await request(),
    io = vi.fn(async () => response());
  const result = await execute(saved, io);
  expect(result.result?.retained).toBe(false);
  expect(result.request.attempt?.resultMetadata?.retained).toBe(false);
  expect((await get(`/api/v1/ai/requests/${saved.id}/answer`)).statusCode).toBe(
    404,
  );
  expect((await execute(saved, io)).result).toBeNull();
  expect(io).toHaveBeenCalledTimes(1);
});

it('settles charges for invalid/provider-error/blocked results without retaining text', async () => {
  for (const [state, extra] of [
    ['provider-error', { error: { message: 'Private provider error' } }],
    [
      'invalid',
      {
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'Private malformed output' },
          },
        ],
      },
    ],
    [
      'blocked',
      {
        choices: [
          {
            index: 0,
            finish_reason: 'length',
            message: { role: 'assistant', content: JSON.stringify(output) },
          },
        ],
      },
    ],
  ] as const) {
    const saved = await request({ saveAnswer: true });
    const result = await execute(saved, async () => response(packet(extra)));
    expect(result.result).toBeNull();
    expect(result.request.status).toBe(
      state === 'provider-error' ? 'failed' : 'completed',
    );
    expect(result.request.attempt?.actualMicros).toBe(10001);
    expect(result.request.attempt?.protocolMetadata?.outputState).toBe(state);
    expect(result.request.attempt?.resultMetadata?.retained).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Private provider error');
    expect(
      (await get(`/api/v1/ai/requests/${saved.id}/answer`)).statusCode,
    ).toBe(404);
  }
});

it('preserves full uncertainty after missing billing/timeouts and never transmits on retry', async () => {
  for (const stalled of [false, true]) {
    const saved = await request({ saveAnswer: true });
    const io = vi.fn(async () =>
      stalled
        ? new Promise<Response>(() => {})
        : response(packet({ usage: undefined })),
    );
    const result = await execute(saved, io, { timeoutMs: 10 });
    expect(result.request).toMatchObject({
      status: 'uncertain',
      attempt: {
        actualMicros: null,
        protocolMetadata: null,
        resultMetadata: null,
      },
    });
    const [reservation] = await db.query(
      'SELECT status,actual_micros FROM ai_budget_reservations WHERE request_id=$1',
      [saved.id],
    );
    expect(reservation).toMatchObject({
      status: 'uncertain',
      actual_micros: null,
    });
    await execute(saved, io);
    expect(io).toHaveBeenCalledTimes(1);
  }
});

it('rolls back accounting and text together on storage failure, then reconciles without resending', async () => {
  const saved = await request({ saveAnswer: true }),
    io = vi.fn(async () => response());
  await db.exec(
    "CREATE FUNCTION fail_protocol_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER fail_protocol_save BEFORE INSERT ON ai_saved_answers FOR EACH ROW EXECUTE FUNCTION fail_protocol_save();",
  );
  try {
    const result = await execute(saved, io);
    expect(result.request).toMatchObject({
      status: 'uncertain',
      attempt: {
        actualMicros: null,
        protocolMetadata: null,
        resultMetadata: null,
      },
    });
    expect(result.result).toBeNull();
  } finally {
    await db.exec(
      'DROP TRIGGER fail_protocol_save ON ai_saved_answers; DROP FUNCTION fail_protocol_save();',
    );
  }
  expect((await execute(saved, io)).request.status).toBe('uncertain');
  const settled = await confirmSyntheticOpenRouterAttempt(
    db,
    config,
    owner,
    saved.id,
    confirmed(),
  );
  expect(settled.attempt?.actualMicros).toBe(10001);
  expect(
    (await get(`/api/v1/ai/requests/${saved.id}/answer`)).json().answer.output,
  ).toEqual(output);
  expect(io).toHaveBeenCalledTimes(1);
});

it('makes reported reconciliation idempotent, detects changed identities/costs and never restores forgotten text', async () => {
  const saved = await request({ saveAnswer: true });
  const initial = await execute(saved);
  const repeated = await confirmSyntheticOpenRouterAttempt(
    db,
    config,
    owner,
    saved.id,
    confirmed(),
  );
  expect(repeated.version).toBe(initial.request.version);
  for (const extra of [
    { generationId: 'gen-other' },
    { usage: { inputTokens: 5, outputTokens: 3, actualMicros: 10002 } },
  ])
    await expect(
      confirmSyntheticOpenRouterAttempt(
        db,
        config,
        owner,
        saved.id,
        confirmed(extra),
      ),
    ).rejects.toMatchObject({ code: 'ATTEMPT_RESULT_CONFLICT' });
  await expect(
    confirmSyntheticAttempt(db, config, owner, saved.id, {
      outcome: 'completed',
      inputTokens: 5,
      outputTokens: 3,
    }),
  ).rejects.toMatchObject({ code: 'ATTEMPT_RESULT_CONFLICT' });
  expect(
    (await write('DELETE', `/api/v1/ai/requests/${saved.id}/answer`, change(1)))
      .statusCode,
  ).toBe(200);
  await confirmSyntheticOpenRouterAttempt(
    db,
    config,
    owner,
    saved.id,
    confirmed(),
  );
  expect(
    (await get(`/api/v1/ai/requests/${saved.id}/answer`)).json().answer,
  ).toMatchObject({ output: null, version: 2 });
});

it('keeps protocol metadata/answers owner-scoped and enforces bounded SQL metadata', async () => {
  const saved = await request({ saveAnswer: true });
  await execute(saved);
  expect(
    (await get(`/api/v1/ai/requests/${saved.id}`, otherCookie)).statusCode,
  ).toBe(404);
  expect(
    (await get(`/api/v1/ai/requests/${saved.id}/answer`, otherCookie))
      .statusCode,
  ).toBe(404);
  await expect(
    confirmSyntheticOpenRouterAttempt(
      db,
      config,
      randomUUID(),
      saved.id,
      confirmed(),
    ),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  for (const extra of [
    { generationId: 'private / text' },
    { outputState: null },
    { protocol: null },
    { prompt: 'private' },
  ])
    await expect(
      db.query(
        'UPDATE ai_attempts SET protocol_metadata=$2::jsonb WHERE request_id=$1',
        [
          saved.id,
          JSON.stringify({
            synthetic: true,
            protocol: 'openrouter',
            generationId: 'gen-test',
            outputState: 'validated',
            ...extra,
          }),
        ],
      ),
    ).rejects.toBeDefined();
});

it('rejects real credentials/non-test config and pre-aborted requests before admission or I/O', async () => {
  const saved = await request(),
    io = vi.fn(async () => response());
  for (const candidate of [
    { ...config, NODE_ENV: 'development' as const },
    {
      ...config,
      AI_PROVIDER_PROFILES: config.AI_PROVIDER_PROFILES.map((profile) => ({
        ...profile,
        credential: 'real-looking-key',
      })),
    },
  ])
    await expect(
      executeSyntheticOpenRouterRequest(
        db,
        candidate,
        owner,
        saved.id,
        1,
        text,
        io,
      ),
    ).rejects.toMatchObject({ code: 'DISPATCH_DISABLED' });
  const controller = new AbortController();
  controller.abort();
  expect(
    (await execute(saved, io, { signal: controller.signal })).request.attempt,
  ).toBeNull();
  expect(io).not.toHaveBeenCalled();
});

it('records reported overruns without clipping actual charges to the reservation or request cap', async () => {
  const saved = await request();
  const result = await execute(saved, async () =>
    response(
      packet({
        usage: {
          prompt_tokens: 5,
          completion_tokens: 3,
          total_tokens: 8,
          cost: 0.3,
        },
      }),
    ),
  );
  expect(result.request.attempt?.actualMicros).toBe(300000);
  expect((await readAIBudget(db, owner)).usage.overruns).toBeGreaterThan(0);
});

it('persists confirmed answers and uncertain attempts across restart without resending', async () => {
  const root = resolve('.artifacts', 'openrouter-settlement');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'run-'));
  const scoped = relative(root, directory);
  if (scoped.startsWith('..') || resolve(root, scoped) !== directory)
    throw Error('Unsafe cleanup path');
  const persistentConfig = { ...config, PGLITE_DATA_DIR: directory };
  let instance: typeof app | undefined;
  try {
    let store = await openDatabase(persistentConfig);
    instance = await buildApp(
      { logger: false },
      { config: persistentConfig, database: store },
    );
    const enrolled = await instance.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persist-protocol@example.test',
        password: 'synthetic-protocol-password',
      },
    });
    expect(enrolled.statusCode).toBe(201);
    const account = enrolled.json().user.id;
    const auth = {
      origin,
      cookie: String(enrolled.headers['set-cookie']).split(';')[0]!,
    };
    const route = { allowed: ['test'], preferred: 'test' };
    for (const [url, payload] of [
      [
        '/api/v1/ai/routing',
        {
          ...change(1),
          policy: { unlabeled: route, personal: route, restricted: route },
        },
      ],
      [
        '/api/v1/ai/budget',
        {
          ...change(1),
          policy: {
            monthlyLimitMicros: 50000000,
            perRequestLimitMicros: 250000,
          },
        },
      ],
      [
        '/api/v1/ai/provider-consents/test',
        { ...change(1), approved: true, expectedRegistryRevision: registry },
      ],
    ] as const)
      expect(
        (await instance.inject({ method: 'PUT', url, headers: auth, payload }))
          .statusCode,
      ).toBe(200);
    const ids: string[] = [],
      io = vi.fn(async () => response());
    for (const uncertain of [false, true]) {
      const created = await instance.inject({
        method: 'POST',
        url: '/api/v1/ai/requests',
        headers: auth,
        payload: requestBody({ saveAnswer: true }),
      });
      expect(created.statusCode).toBe(201);
      ids.push(created.json().id);
      await executeSyntheticOpenRouterRequest(
        store,
        persistentConfig,
        account,
        ids.at(-1)!,
        1,
        text,
        uncertain ? async () => response(packet({ usage: undefined })) : io,
      );
    }
    await instance.close();
    instance = undefined;
    store = await openDatabase(persistentConfig);
    instance = await buildApp(
      { logger: false },
      { config: persistentConfig, database: store },
    );
    expect(
      (
        await instance.inject({
          url: `/api/v1/ai/requests/${ids[0]}/answer`,
          headers: auth,
        })
      ).json().answer.output,
    ).toEqual(output);
    const completed = await executeSyntheticOpenRouterRequest(
      store,
      persistentConfig,
      account,
      ids[0]!,
      1,
      text,
      io,
    );
    expect(completed.request.attempt?.protocolMetadata?.generationId).toBe(
      'gen-durable-test',
    );
    expect(completed.request.attempt?.protocolObservation).toMatchObject({
      state: 'reported',
      generationId: 'gen-durable-test',
      usage: { actualMicros: 10001 },
    });
    expect(completed.result).toBeNull();
    const uncertain = await executeSyntheticOpenRouterRequest(
      store,
      persistentConfig,
      account,
      ids[1]!,
      1,
      text,
      io,
    );
    expect(uncertain.request.status).toBe('uncertain');
    expect(uncertain.request.attempt?.protocolObservation).toMatchObject({
      state: 'uncertain',
      generationId: 'gen-durable-test',
      reason: 'response',
    });
    expect(io).toHaveBeenCalledTimes(1);
  } finally {
    await instance?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
