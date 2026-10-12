import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import {
  plannerExportSchema,
  aiTextResultMetadataSchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { migrate } from '../src/db/migrate.js';

import { executeSyntheticOpenRouterRequest } from '../src/ai/synthetic-openrouter-execution.js';
import type { OpenRouterTestIO } from '../src/ai/openrouter-protocol.js';
import {
  confirmSyntheticOpenRouterAttempt,
  confirmSyntheticAttempt,
  recoverSyntheticOpenRouterAccounting,
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
const unavailable = {
  synthetic: true,
  retained: false,
  status: 'unavailable',
  answerCharacters: null,
  suggestionCount: null,
};
async function pending(extra: object = {}) {
  const saved = await request({ saveAnswer: true, ...extra });
  await beginSyntheticAttempt(db, config, owner, saved.id, 1, text);
  const observed = await recordSyntheticOpenRouterObservation(
    db,
    config,
    owner,
    saved.id,
    reported,
  );
  return { saved, observed };
}

it('upgrades populated attempts without changing historical result metadata, versions or spend', async () => {
  const saved = await request();
  await beginSyntheticAttempt(db, config, owner, saved.id, 1, text);
  const metadata = {
    synthetic: true as const,
    retained: false,
    status: 'invalid' as const,
    answerCharacters: null,
    suggestionCount: null,
  };
  const legacy = await confirmSyntheticAttempt(
    db,
    config,
    owner,
    saved.id,
    { outcome: 'completed', inputTokens: 1, outputTokens: 2 },
    metadata,
  );
  const budget = await readAIBudget(db, owner);
  const old = await readFile(
    resolve('apps/api/migrations/041_ai_saved_answers.sql'),
    'utf8',
  );
  const check = old.slice(
    old.indexOf(
      'ALTER TABLE ai_attempts ADD CONSTRAINT ai_attempts_retained_result_check',
    ),
    old.indexOf('CREATE TABLE ai_saved_answers'),
  );
  await db.exec(
    'ALTER TABLE ai_attempts DROP CONSTRAINT ai_attempts_retained_result_check;',
  );
  await db.exec(check);
  await db.exec(
    "DELETE FROM schema_migrations WHERE name='044_ai_unavailable_results.sql';",
  );
  await migrate(db);
  expect((await get(`/api/v1/ai/requests/${saved.id}`)).json()).toMatchObject({
    version: legacy.version,
    attempt: {
      version: legacy.attempt!.version,
      actualMicros: 3,
      resultMetadata: metadata,
    },
  });
  expect((await readAIBudget(db, owner)).usage).toEqual(budget.usage);
  await migrate(db);
});

it('recovers exact recorded charges after answer storage failure without retaining or resending text', async () => {
  const saved = await request({ saveAnswer: true }),
    io = vi.fn(async () => response());
  await db.exec(
    "CREATE FUNCTION fail_recovery_answer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER fail_recovery_answer BEFORE INSERT ON ai_saved_answers FOR EACH ROW EXECUTE FUNCTION fail_recovery_answer();",
  );
  let attemptVersion: number;
  try {
    const result = await execute(saved, io);
    expect(result.request.status).toBe('uncertain');
    attemptVersion = result.request.attempt!.version;
  } finally {
    await db.exec(
      'DROP TRIGGER fail_recovery_answer ON ai_saved_answers; DROP FUNCTION fail_recovery_answer();',
    );
  }
  const before = await readAIBudget(db, owner);
  const recovered = await recoverSyntheticOpenRouterAccounting(
    db,
    config,
    owner,
    saved.id,
    attemptVersion!,
  );
  expect(recovered).toMatchObject({
    status: 'completed',
    attempt: {
      actualMicros: 10001,
      inputTokens: 5,
      outputTokens: 3,
      resultMetadata: unavailable,
      protocolMetadata: { outputState: 'validated' },
      protocolObservation: reported,
    },
  });
  const after = await readAIBudget(db, owner);
  expect(
    BigInt(after.usage.spentMicros) - BigInt(before.usage.spentMicros),
  ).toBe(10001n);
  expect(BigInt(before.usage.heldMicros) - BigInt(after.usage.heldMicros)).toBe(
    50000n,
  );
  expect((await get(`/api/v1/ai/requests/${saved.id}/answer`)).statusCode).toBe(
    404,
  );
  expect((await execute(saved, io)).result).toBeNull();
  expect(io).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(recovered)).not.toContain(output.answer);
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(
    exported.records.aiRequests.find((item) => item.id === saved.id)?.attempt
      ?.resultMetadata,
  ).toEqual(unavailable);
});

it('requires complete reported usage and rejects foreign/non-test recovery without changing holds', async () => {
  const saved = await request();
  await beginSyntheticAttempt(db, config, owner, saved.id, 1, text);
  const before = await readAIBudget(db, owner);
  await expect(
    recoverSyntheticOpenRouterAccounting(db, config, owner, saved.id, 1),
  ).rejects.toMatchObject({ code: 'PROTOCOL_USAGE_UNAVAILABLE' });
  await recordSyntheticOpenRouterObservation(db, config, owner, saved.id, {
    synthetic: true,
    protocol: 'openrouter',
    state: 'uncertain',
    generationId: 'gen-durable-test',
    reason: 'billing',
  });
  await expect(
    recoverSyntheticOpenRouterAccounting(db, config, owner, saved.id, 2),
  ).rejects.toMatchObject({ code: 'PROTOCOL_USAGE_UNAVAILABLE' });
  await expect(
    recoverSyntheticOpenRouterAccounting(db, config, randomUUID(), saved.id, 2),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    recoverSyntheticOpenRouterAccounting(
      db,
      { ...config, NODE_ENV: 'development' },
      owner,
      saved.id,
      2,
    ),
  ).rejects.toMatchObject({ code: 'DISPATCH_DISABLED' });
  expect((await readAIBudget(db, owner)).usage).toEqual(before.usage);
});

it('guards new settlement by attempt version and preserves hiding restrictions until accounting settles', async () => {
  const { saved, observed } = await pending();
  expect(
    (
      await write(
        'DELETE',
        `/api/v1/ai/requests/${saved.id}`,
        change(observed.version),
      )
    ).statusCode,
  ).toBe(409);
  await expect(
    recoverSyntheticOpenRouterAccounting(
      db,
      config,
      owner,
      saved.id,
      observed.attempt!.version + 1,
    ),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  const recovered = await recoverSyntheticOpenRouterAccounting(
    db,
    config,
    owner,
    saved.id,
    observed.attempt!.version,
  );
  expect(recovered.deletedAt).toBeNull();
  expect(recovered.attempt?.resultMetadata).toEqual(unavailable);
  expect(
    (
      await write(
        'DELETE',
        `/api/v1/ai/requests/${saved.id}`,
        change(recovered.version),
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await recoverSyntheticOpenRouterAccounting(
        db,
        config,
        owner,
        saved.id,
        observed.attempt!.version,
      )
    ).deletedAt,
  ).not.toBeNull();
  expect(
    (await get(`/api/v1/ai/requests/${saved.id}`, otherCookie)).statusCode,
  ).toBe(404);
});

it('serializes concurrent recovery and makes old-version replay accounting-idempotent', async () => {
  const { saved, observed } = await pending({ saveAnswer: false });
  const before = await readAIBudget(db, owner);
  const results = await Promise.all(
    [1, 2].map(() =>
      recoverSyntheticOpenRouterAccounting(
        db,
        config,
        owner,
        saved.id,
        observed.attempt!.version,
      ),
    ),
  );
  expect(results[0]).toEqual(results[1]);
  const after = await readAIBudget(db, owner);
  expect(
    BigInt(after.usage.spentMicros) - BigInt(before.usage.spentMicros),
  ).toBe(10001n);
  expect(
    (
      await recoverSyntheticOpenRouterAccounting(
        db,
        config,
        owner,
        saved.id,
        observed.attempt!.version,
      )
    ).version,
  ).toBe(results[0]!.version);
  expect((await readAIBudget(db, owner)).usage).toEqual(after.usage);
});

it('does not overwrite successful saved answers or restore forgotten text during recovery replay', async () => {
  const saved = await request({ saveAnswer: true });
  const initial = await execute(saved);
  const recovered = await recoverSyntheticOpenRouterAccounting(
    db,
    config,
    owner,
    saved.id,
    1,
  );
  expect(recovered).toEqual(initial.request);
  expect(
    (await get(`/api/v1/ai/requests/${saved.id}/answer`)).json().answer.output,
  ).toEqual(output);
  expect(
    (await write('DELETE', `/api/v1/ai/requests/${saved.id}/answer`, change(1)))
      .statusCode,
  ).toBe(200);
  await recoverSyntheticOpenRouterAccounting(db, config, owner, saved.id, 1);
  expect(
    (await get(`/api/v1/ai/requests/${saved.id}/answer`)).json().answer,
  ).toMatchObject({ output: null, version: 2 });
});

it('forbids late answer backfill and enforces unavailable-output contract/SQL consistency', async () => {
  const { saved, observed } = await pending();
  const recovered = await recoverSyntheticOpenRouterAccounting(
    db,
    config,
    owner,
    saved.id,
    observed.attempt!.version,
  );
  await expect(
    confirmSyntheticOpenRouterAttempt(db, config, owner, saved.id, confirmed()),
  ).rejects.toMatchObject({ code: 'ATTEMPT_RESULT_CONFLICT' });
  expect(aiTextResultMetadataSchema.safeParse(unavailable).success).toBe(true);
  for (const extra of [
    { retained: true },
    { answerCharacters: 5 },
    { suggestionCount: 1 },
  ]) {
    expect(
      aiTextResultMetadataSchema.safeParse({ ...unavailable, ...extra })
        .success,
    ).toBe(false);
    await expect(
      db.query(
        'UPDATE ai_attempts SET result_metadata=$2::jsonb WHERE request_id=$1',
        [saved.id, JSON.stringify({ ...unavailable, ...extra })],
      ),
    ).rejects.toBeDefined();
  }
  await expect(
    db.query(
      'UPDATE ai_attempts SET actual_micros=actual_micros+1 WHERE request_id=$1',
      [saved.id],
    ),
  ).rejects.toBeDefined();
  await expect(
    db.query(
      'INSERT INTO ai_saved_answers(owner_id,request_id,attempt_id,labels,context_manifest,output) VALUES($1,$2,$3,$4::text[],$5::jsonb,$6::jsonb)',
      [
        owner,
        saved.id,
        recovered.attempt!.id,
        ['unlabeled'],
        JSON.stringify(recovered.attempt!.admission.contextManifest),
        JSON.stringify(output),
      ],
    ),
  ).rejects.toBeDefined();
});

it('rolls back accounting atomically on recovery failure while preserving the observation and hold', async () => {
  const { saved, observed } = await pending();
  const before = await readAIBudget(db, owner);
  await db.exec(
    "CREATE FUNCTION fail_usage_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER fail_usage_recovery BEFORE UPDATE ON ai_attempts FOR EACH ROW WHEN (NEW.actual_micros IS NOT NULL) EXECUTE FUNCTION fail_usage_recovery();",
  );
  try {
    await expect(
      recoverSyntheticOpenRouterAccounting(
        db,
        config,
        owner,
        saved.id,
        observed.attempt!.version,
      ),
    ).rejects.toBeDefined();
  } finally {
    await db.exec(
      'DROP TRIGGER fail_usage_recovery ON ai_attempts; DROP FUNCTION fail_usage_recovery();',
    );
  }
  expect((await readAIBudget(db, owner)).usage).toEqual(before.usage);
  expect((await get(`/api/v1/ai/requests/${saved.id}`)).json()).toMatchObject({
    status: 'uncertain',
    attempt: {
      actualMicros: null,
      resultMetadata: null,
      protocolObservation: reported,
    },
  });
  expect(
    (
      await recoverSyntheticOpenRouterAccounting(
        db,
        config,
        owner,
        saved.id,
        observed.attempt!.version,
      )
    ).attempt?.resultMetadata,
  ).toEqual(unavailable);
});

it('recovers rejected/error reports without classifying rejected output as lost validated text', async () => {
  for (const outputState of ['invalid', 'blocked', 'provider-error'] as const) {
    const saved = await request({ saveAnswer: true });
    await beginSyntheticAttempt(db, config, owner, saved.id, 1, text);
    const observed = await recordSyntheticOpenRouterObservation(
      db,
      config,
      owner,
      saved.id,
      { ...reported, outputState },
    );
    const recovered = await recoverSyntheticOpenRouterAccounting(
      db,
      config,
      owner,
      saved.id,
      observed.attempt!.version,
    );
    expect(recovered.status).toBe(
      outputState === 'provider-error' ? 'failed' : 'completed',
    );
    expect(recovered.attempt?.resultMetadata?.status).toBe('invalid');
    expect(recovered.attempt?.actualMicros).toBe(10001);
    expect(
      (await get(`/api/v1/ai/requests/${saved.id}/answer`)).statusCode,
    ).toBe(404);
  }
});

it('recovers persisted reports after restart and never dispatches or manufactures a saved answer', async () => {
  const root = resolve('.artifacts', 'accounting-recovery');
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
        email: 'persist-recovery@example.test',
        password: 'synthetic-recovery-password',
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
    const created = await instance.inject({
      method: 'POST',
      url: '/api/v1/ai/requests',
      headers: auth,
      payload: requestBody({ saveAnswer: true }),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    await beginSyntheticAttempt(store, persistentConfig, account, id, 1, text);
    const observed = await recordSyntheticOpenRouterObservation(
      store,
      persistentConfig,
      account,
      id,
      reported,
    );
    await instance.close();
    instance = undefined;
    store = await openDatabase(persistentConfig);
    instance = await buildApp(
      { logger: false },
      { config: persistentConfig, database: store },
    );
    const recovered = await recoverSyntheticOpenRouterAccounting(
      store,
      persistentConfig,
      account,
      id,
      observed.attempt!.version,
    );
    expect(recovered.attempt?.resultMetadata).toEqual(unavailable);
    await instance.close();
    instance = undefined;
    store = await openDatabase(persistentConfig);
    instance = await buildApp(
      { logger: false },
      { config: persistentConfig, database: store },
    );
    expect(
      (
        await recoverSyntheticOpenRouterAccounting(
          store,
          persistentConfig,
          account,
          id,
          observed.attempt!.version,
        )
      ).version,
    ).toBe(recovered.version);
    const io = vi.fn(async () => response());
    expect(
      (
        await executeSyntheticOpenRouterRequest(
          store,
          persistentConfig,
          account,
          id,
          1,
          text,
          io,
        )
      ).result,
    ).toBeNull();
    expect(io).not.toHaveBeenCalled();
    expect(
      (
        await instance.inject({
          url: `/api/v1/ai/requests/${id}/answer`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await instance?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
