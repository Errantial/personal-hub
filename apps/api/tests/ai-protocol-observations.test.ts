import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { plannerExportSchema, aiAttemptSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';

import { migrate } from '../src/db/migrate.js';

import { executeSyntheticOpenRouterRequest } from '../src/ai/synthetic-openrouter-execution.js';
import type { OpenRouterTestIO } from '../src/ai/openrouter-protocol.js';
import {
  confirmSyntheticOpenRouterAttempt,
  confirmSyntheticAttempt,
  beginSyntheticAttempt,
} from '../src/ai/synthetic-execution.js';

import { recordSyntheticOpenRouterObservation } from '../src/ai/protocol-observations.js';
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

const reported = {
  synthetic: true as const,
  protocol: 'openrouter' as const,
  state: 'reported' as const,
  generationId: 'gen-durable-test',
  usage: { inputTokens: 5, outputTokens: 3, actualMicros: 10001 },
  outputState: 'validated' as const,
};
const uncertain = {
  synthetic: true as const,
  protocol: 'openrouter' as const,
  state: 'uncertain' as const,
  generationId: 'gen-durable-test',
  reason: 'response' as const,
};

it('upgrades populated older attempts with null observations and unchanged versions/spend', async () => {
  const saved = await request();
  await beginSyntheticAttempt(db, config, owner, saved.id, 1, text);
  const legacy = await confirmSyntheticAttempt(db, config, owner, saved.id, {
    outcome: 'completed',
    inputTokens: 1,
    outputTokens: 2,
  });
  const budget = await readAIBudget(db, owner);
  await db.exec(
    "DROP TRIGGER ai_protocol_observation_guard ON ai_attempts; DROP FUNCTION hub_guard_protocol_observation(); ALTER TABLE ai_attempts DROP COLUMN protocol_observation; DELETE FROM schema_migrations WHERE name='043_ai_protocol_observations.sql';",
  );
  await migrate(db);
  const upgraded = (await get(`/api/v1/ai/requests/${saved.id}`)).json();
  expect(upgraded).toMatchObject({
    version: legacy.version,
    attempt: {
      version: legacy.attempt!.version,
      protocolObservation: null,
      actualMicros: 3,
    },
  });
  const old = { ...upgraded.attempt };
  delete old.protocolObservation;
  expect(aiAttemptSchema.parse(old).protocolObservation).toBeNull();
  expect((await readAIBudget(db, owner)).usage).toEqual(budget.usage);
  await migrate(db);
});

it('persists bounded generation identity without usage for an uncertain response and never resends', async () => {
  const saved = await request({ saveAnswer: true });
  const io = vi.fn(async () =>
    response(
      packet({
        usage: undefined,
        error: { message: 'Private provider failure' },
      }),
    ),
  );
  const result = await execute(saved, io);
  expect(result.request).toMatchObject({
    status: 'uncertain',
    attempt: {
      protocolObservation: uncertain,
      actualMicros: null,
      protocolMetadata: null,
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
  expect(JSON.stringify(result)).not.toContain('Private provider failure');
  expect((await execute(saved, io)).result).toBeNull();
  expect(io).toHaveBeenCalledTimes(1);
});

it('records null generation identities for timeouts without inventing provider evidence', async () => {
  const saved = await request();
  const io = vi.fn(async () => new Promise<Response>(() => {}));
  const result = await execute(saved, io, { timeoutMs: 10 });
  expect(result.request.attempt?.protocolObservation).toEqual({
    ...uncertain,
    generationId: null,
    reason: 'timeout',
  });
  expect(result.request.status).toBe('uncertain');
  await execute(saved, io);
  expect(io).toHaveBeenCalledTimes(1);
});

it('retains reported billing through answer storage rollback and rejects conflicting reconciliation', async () => {
  const saved = await request({ saveAnswer: true }),
    io = vi.fn(async () => response());
  await db.exec(
    "CREATE FUNCTION fail_observed_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER fail_observed_save BEFORE INSERT ON ai_saved_answers FOR EACH ROW EXECUTE FUNCTION fail_observed_save();",
  );
  try {
    const result = await execute(saved, io);
    expect(result.request).toMatchObject({
      status: 'uncertain',
      attempt: {
        protocolObservation: reported,
        actualMicros: null,
        protocolMetadata: null,
        resultMetadata: null,
      },
    });
    expect(result.result).toBeNull();
  } finally {
    await db.exec(
      'DROP TRIGGER fail_observed_save ON ai_saved_answers; DROP FUNCTION fail_observed_save();',
    );
  }
  for (const change of [
    { generationId: 'gen-other' },
    { usage: { ...reported.usage, actualMicros: 10002 } },
    { usage: { ...reported.usage, outputTokens: 4 } },
  ])
    await expect(
      confirmSyntheticOpenRouterAttempt(
        db,
        config,
        owner,
        saved.id,
        confirmed(change),
      ),
    ).rejects.toMatchObject({ code: 'ATTEMPT_RESULT_CONFLICT' });
  const settled = await confirmSyntheticOpenRouterAttempt(
    db,
    config,
    owner,
    saved.id,
    confirmed(),
  );
  expect(settled.attempt?.protocolObservation).toEqual(reported);
  expect(settled.attempt?.actualMicros).toBe(10001);
  expect(io).toHaveBeenCalledTimes(1);
});

it('makes observations idempotent and immutable in helpers and SQL even after settlement', async () => {
  const saved = await request();
  await beginSyntheticAttempt(db, config, owner, saved.id, 1, text);
  const first = await recordSyntheticOpenRouterObservation(
    db,
    config,
    owner,
    saved.id,
    reported,
  );
  const replay = await recordSyntheticOpenRouterObservation(
    db,
    config,
    owner,
    saved.id,
    reported,
  );
  expect(replay.attempt?.version).toBe(first.attempt?.version);
  expect(replay.version).toBe(first.version);
  await expect(
    recordSyntheticOpenRouterObservation(db, config, owner, saved.id, {
      ...reported,
      generationId: 'gen-other',
    }),
  ).rejects.toMatchObject({ code: 'ATTEMPT_RESULT_CONFLICT' });
  for (const replacement of [null, { ...reported, generationId: 'gen-other' }])
    await expect(
      db.query(
        'UPDATE ai_attempts SET protocol_observation=$2::jsonb,version=version+1 WHERE request_id=$1',
        [saved.id, JSON.stringify(replacement)],
      ),
    ).rejects.toBeDefined();
  await confirmSyntheticOpenRouterAttempt(
    db,
    config,
    owner,
    saved.id,
    confirmed(),
  );
  expect(
    (
      await recordSyntheticOpenRouterObservation(
        db,
        config,
        owner,
        saved.id,
        reported,
      )
    ).attempt?.protocolObservation,
  ).toEqual(reported);
});

it('rejects malformed/private observation fields and preserves the unobserved attempt', async () => {
  const saved = await request();
  await beginSyntheticAttempt(db, config, owner, saved.id, 1, text);
  for (const value of [
    { ...reported, output: output.answer },
    { ...reported, protocol: null },
    { ...reported, state: null },
    { ...reported, generationId: 'Private / identifier' },
    { ...reported, usage: { ...reported.usage, actualMicros: -1 } },
    { ...reported, usage: { ...reported.usage, inputTokens: null } },
    { ...reported, usage: { ...reported.usage, inputTokens: 0.5 } },
    { ...uncertain, reason: null },
  ])
    await expect(
      db.query(
        'UPDATE ai_attempts SET protocol_observation=$2::jsonb,version=version+1 WHERE request_id=$1',
        [saved.id, JSON.stringify(value)],
      ),
    ).rejects.toBeDefined();
  await expect(
    recordSyntheticOpenRouterObservation(db, config, owner, saved.id, {
      ...reported,
      output: output.answer,
    } as typeof reported),
  ).rejects.toBeDefined();
  expect(
    (await get(`/api/v1/ai/requests/${saved.id}`)).json().attempt
      .protocolObservation,
  ).toBeNull();
});

it('keeps observations owner-scoped and rejects non-test or non-uncertain records', async () => {
  const saved = await request();
  await execute(saved);
  expect(
    (await get(`/api/v1/ai/requests/${saved.id}`, otherCookie)).statusCode,
  ).toBe(404);
  await expect(
    recordSyntheticOpenRouterObservation(
      db,
      config,
      randomUUID(),
      saved.id,
      reported,
    ),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    recordSyntheticOpenRouterObservation(
      db,
      { ...config, NODE_ENV: 'development' },
      owner,
      saved.id,
      reported,
    ),
  ).rejects.toMatchObject({ code: 'DISPATCH_DISABLED' });
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(
    exported.records.aiRequests.find((request) => request.id === saved.id)
      ?.attempt?.protocolObservation,
  ).toEqual(reported);
  expect(JSON.stringify(exported.records.aiRequests)).not.toContain(
    output.answer,
  );
  const legacy = await request();
  await beginSyntheticAttempt(db, config, owner, legacy.id, 1, text);
  await confirmSyntheticAttempt(db, config, owner, legacy.id, {
    outcome: 'completed',
    inputTokens: 1,
    outputTokens: 2,
  });
  await expect(
    recordSyntheticOpenRouterObservation(
      db,
      config,
      owner,
      legacy.id,
      reported,
    ),
  ).rejects.toMatchObject({ code: 'AI_REQUEST_STATE' });
});

it('keeps the uncertain hold when observation persistence itself fails and never resends', async () => {
  const saved = await request({ saveAnswer: true }),
    io = vi.fn(async () => response());
  await db.exec(
    "CREATE FUNCTION fail_protocol_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER fail_protocol_observation BEFORE UPDATE ON ai_attempts FOR EACH ROW WHEN (NEW.protocol_observation IS NOT NULL) EXECUTE FUNCTION fail_protocol_observation();",
  );
  try {
    const result = await execute(saved, io);
    expect(result.request).toMatchObject({
      status: 'uncertain',
      attempt: {
        protocolObservation: null,
        actualMicros: null,
        resultMetadata: null,
      },
    });
    expect(result.result).toBeNull();
  } finally {
    await db.exec(
      'DROP TRIGGER fail_protocol_observation ON ai_attempts; DROP FUNCTION fail_protocol_observation();',
    );
  }
  await execute(saved, io);
  expect(io).toHaveBeenCalledTimes(1);
  expect((await get(`/api/v1/ai/requests/${saved.id}/answer`)).statusCode).toBe(
    404,
  );
});
