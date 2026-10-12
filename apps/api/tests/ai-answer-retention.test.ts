import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { plannerExportSchema, aiBudgetSettingsSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { executeSyntheticTextRequest } from '../src/ai/synthetic-text-execution.js';
import { confirmSyntheticAttempt } from '../src/ai/synthetic-execution.js';
import { readAIProfiles, publicAIRegistry } from '../src/ai/profiles.js';
import { buildOpenRouterTextRequest } from '../src/ai/openrouter-request.js';
import { mutate } from '../src/planner/mutations.js';
import { readAIBudget } from '../src/features/ai-budget.js';

const profile = {
  alias: 'test',
  adapter: 'anthropic',
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
const usage = {
  outcome: 'completed' as const,
  inputTokens: 1,
  outputTokens: Buffer.byteLength(JSON.stringify(output), 'utf8'),
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
async function execute(saved: { id: string }, answer: unknown = output) {
  const callback = vi.fn(async () => ({ usage, output: answer }));
  const result = await executeSyntheticTextRequest(
    db,
    config,
    owner,
    saved.id,
    1,
    text,
    { kind: 'synthetic-text', execute: callback },
  );
  return { result, callback };
}
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

it('enforces the $50 ceiling in owner writes and SQL while preserving legacy output parsing', async () => {
  expect((await get('/api/v1/ai/budget')).json()).toMatchObject({
    policy: { monthlyLimitMicros: 50000000, perRequestLimitMicros: 250000 },
    hardMonthlyLimitMicros: 50000000,
  });
  expect(
    (
      await write('PUT', '/api/v1/ai/budget', {
        ...change(2),
        policy: { monthlyLimitMicros: 50000001, perRequestLimitMicros: 250000 },
      })
    ).statusCode,
  ).toBe(400);
  await expect(
    db.query(
      'UPDATE ai_budget_policies SET monthly_limit_micros=50000001 WHERE owner_id=$1',
      [owner],
    ),
  ).rejects.toBeDefined();
  expect(
    aiBudgetSettingsSchema.safeParse({
      version: 1,
      policy: { monthlyLimitMicros: 100000000, perRequestLimitMicros: 1000000 },
      currency: 'USD',
      monthBoundary: 'UTC',
      dispatchEnabled: false,
    }).success,
  ).toBe(true);
});
it('leaves answers temporary unless this exact request opts in', async () => {
  const saved = await request();
  expect(saved.saveAnswer).toBe(false);
  const { result } = await execute(saved);
  expect(result.result!.retained).toBe(false);
  expect(result.request.attempt!.resultMetadata!.retained).toBe(false);
  expect((await get(`/api/v1/ai/requests/${saved.id}/answer`)).statusCode).toBe(
    404,
  );
  expect(
    await db.query(
      'SELECT request_id FROM ai_saved_answers WHERE request_id=$1',
      [saved.id],
    ),
  ).toEqual([]);
  const body = requestBody({ saveAnswer: true }),
    created = await write('POST', '/api/v1/ai/requests', body);
  expect(
    (await write('POST', '/api/v1/ai/requests', { ...body, saveAnswer: false }))
      .statusCode,
  ).toBe(409);
  expect(created.json().saveAnswer).toBe(true);
});
it('saves validated guidance atomically and exposes text only in owned detail/export, never metadata or receipts', async () => {
  const saved = await request({ saveAnswer: true }),
    { result, callback } = await execute(saved);
  expect(result.result!.retained).toBe(true);
  expect(result.request.attempt!.resultMetadata!.retained).toBe(true);
  const detail = await get(`/api/v1/ai/requests/${saved.id}/answer`);
  expect(detail.statusCode).toBe(200);
  expect(detail.json().answer).toMatchObject({
    version: 1,
    requestId: saved.id,
    output,
    labels: ['unlabeled'],
    synthetic: true,
  });
  expect(
    JSON.stringify((await get(`/api/v1/ai/requests/${saved.id}`)).json()),
  ).not.toContain(output.answer);
  expect(
    JSON.stringify((await get('/api/v1/ai/requests')).json()),
  ).not.toContain(output.answer);
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(
    exported.records.aiSavedAnswers.find(
      (answer) => answer.requestId === saved.id,
    )!.output,
  ).toEqual(output);
  expect(JSON.stringify(exported.records.aiRequests)).not.toContain(text);
  expect(
    JSON.stringify(await db.query('SELECT result FROM mutation_receipts')),
  ).not.toContain(output.answer);
  const retry = await executeSyntheticTextRequest(
    db,
    config,
    owner,
    saved.id,
    1,
    text,
    { kind: 'synthetic-text', execute: callback },
  );
  expect(retry.result).toBeNull();
  expect(callback).toHaveBeenCalledTimes(1);
});
it('protects saved answers from foreign and anonymous reads/writes', async () => {
  const saved = await request({ saveAnswer: true });
  await execute(saved);
  const path = `/api/v1/ai/requests/${saved.id}/answer`;
  expect((await get(path, otherCookie)).statusCode).toBe(404);
  expect((await write('DELETE', path, change(1), otherCookie)).statusCode).toBe(
    404,
  );
  expect((await get(path, '')).statusCode).toBe(401);
  expect((await write('DELETE', path, change(1), '')).statusCode).toBe(401);
  expect(
    (await get('/api/v1/planner/export', otherCookie)).json().records
      .aiSavedAnswers,
  ).toEqual([]);
});
it('forgets answer text with a tombstone and metadata-only retry receipts without resending or restoring', async () => {
  const saved = await request({ saveAnswer: true }),
    { callback } = await execute(saved),
    path = `/api/v1/ai/requests/${saved.id}/answer`,
    payload = change(1);
  const results = await Promise.all(
    [1, 2].map(() => write('DELETE', path, payload)),
  );
  expect(results[0]!.statusCode).toBe(200);
  expect(results[1]!.json()).toEqual(results[0]!.json());
  expect(JSON.stringify(results[0]!.json())).not.toContain(output.answer);
  expect((await get(path)).json().answer).toMatchObject({
    version: 2,
    output: null,
    deletedAt: expect.any(String),
  });
  await executeSyntheticTextRequest(db, config, owner, saved.id, 1, text, {
    kind: 'synthetic-text',
    execute: callback,
  });
  expect(callback).toHaveBeenCalledTimes(1);
  await confirmSyntheticAttempt(
    db,
    config,
    owner,
    saved.id,
    usage,
    {
      synthetic: true,
      retained: true,
      status: 'validated',
      answerCharacters: output.answer.length,
      suggestionCount: 0,
    },
    output,
  );
  expect((await get(path)).json().answer.output).toBeNull();
  expect((await write('DELETE', path, change(2))).statusCode).toBe(409);
  await expect(
    db.query(
      'UPDATE ai_saved_answers SET output=$2::jsonb WHERE request_id=$1',
      [saved.id, JSON.stringify(output)],
    ),
  ).rejects.toBeDefined();
});
it('rolls back result retention, accounting and metadata together when saving fails', async () => {
  const saved = await request({ saveAnswer: true });
  await db.exec(
    "CREATE FUNCTION reject_saved_answer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic retention failure'; END $$; CREATE TRIGGER reject_saved_answer BEFORE INSERT ON ai_saved_answers FOR EACH ROW EXECUTE FUNCTION reject_saved_answer();",
  );
  try {
    const { result, callback } = await execute(saved);
    expect(result.result).toBeNull();
    expect(result.request.status).toBe('uncertain');
    expect(result.request.attempt!.resultMetadata).toBeNull();
    expect(
      await db.query(
        'SELECT request_id FROM ai_saved_answers WHERE request_id=$1',
        [saved.id],
      ),
    ).toEqual([]);
    await executeSyntheticTextRequest(db, config, owner, saved.id, 1, text, {
      kind: 'synthetic-text',
      execute: callback,
    });
    expect(callback).toHaveBeenCalledTimes(1);
  } finally {
    await db.exec(
      'DROP TRIGGER reject_saved_answer ON ai_saved_answers; DROP FUNCTION reject_saved_answer();',
    );
  }
});
it('does not save invalid output despite an opted-in request and rejects direct unconsented insertion', async () => {
  const invalid = await request({ saveAnswer: true }),
    { result } = await execute(invalid, {
      ...output,
      action: { kind: 'send-email' },
    });
  expect(result.request.status).toBe('completed');
  expect(result.request.attempt!.resultMetadata!.retained).toBe(false);
  expect(
    (await get(`/api/v1/ai/requests/${invalid.id}/answer`)).statusCode,
  ).toBe(404);
  const saved = await request(),
    complete = await execute(saved);
  await expect(
    db.query(
      'INSERT INTO ai_saved_answers(owner_id,request_id,attempt_id,labels,context_manifest,output) VALUES($1,$2,$3,$4::text[],$5::jsonb,$6::jsonb)',
      [
        owner,
        saved.id,
        complete.result.request.attempt!.id,
        ['unlabeled'],
        JSON.stringify(saved.assessment.contextManifest),
        JSON.stringify(output),
      ],
    ),
  ).rejects.toBeDefined();
});
it('supports declared subscription/confidential modes and pins OpenRouter without performing a request', () => {
  for (const adapter of [
    'claude-code',
    'codex-subscription',
    'prem-confidential',
    'openrouter',
  ]) {
    const declared = {
      ...profile,
      adapter,
      ...(adapter === 'openrouter'
        ? { upstreamProvider: 'test-provider/test-region' }
        : {}),
    };
    const registry = publicAIRegistry(
      readAIProfiles({
        ...environment,
        AI_PROVIDER_PROFILES: JSON.stringify([declared]),
      }),
    );
    expect(registry.dispatchEnabled).toBe(false);
    expect(JSON.stringify(registry)).not.toContain('AI_SECRET_TEST');
    if (adapter === 'openrouter') {
      const request = buildOpenRouterTextRequest(
        registry.profiles[0]!,
        'Synthetic request envelope',
      );
      expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(request.body.provider).toEqual({
        only: ['test-provider/test-region'],
        order: ['test-provider/test-region'],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: 'deny',
        zdr: true,
      });
      expect(request.body).not.toHaveProperty('tools');
      expect(request.body).not.toHaveProperty('models');
    } else
      expect(registry.profiles[0]!.accessMode).toBe(
        adapter === 'prem-confidential'
          ? 'confidential-api'
          : 'owner-subscription',
      );
  }
  expect(() =>
    readAIProfiles({
      ...environment,
      AI_PROVIDER_PROFILES: JSON.stringify([
        { ...profile, adapter: 'openrouter' },
      ]),
    }),
  ).toThrow('Invalid environment configuration');
});
it('applies the owner-confirmed caps to populated legacy settings without changing spend, holds or historical receipts', async () => {
  await db.exec(
    'ALTER TABLE ai_budget_policies DROP CONSTRAINT ai_budget_monthly_hard_ceiling',
  );
  const oldWrite = {
    ...change(2),
    policy: { monthlyLimitMicros: 100000000, perRequestLimitMicros: 1000000 },
  };
  const historical = await mutate(
    db,
    owner,
    oldWrite.operationId,
    { kind: 'ai.budget', input: oldWrite },
    async (tx) => {
      await tx.query(
        'UPDATE ai_budget_policies SET monthly_limit_micros=$2,per_request_limit_micros=$3,version=version+1 WHERE owner_id=$1',
        [
          owner,
          oldWrite.policy.monthlyLimitMicros,
          oldWrite.policy.perRequestLimitMicros,
        ],
      );
      return readAIBudget(tx, owner);
    },
  );
  const receipts = await db.query(
    'SELECT operation_id,result FROM mutation_receipts WHERE owner_id=$1 ORDER BY operation_id',
    [owner],
  );
  const reservations = await db.query(
    'SELECT * FROM ai_budget_reservations WHERE owner_id=$1 ORDER BY id',
    [owner],
  );
  await db.query(
    'UPDATE ai_budget_policies SET monthly_limit_micros=100000000,per_request_limit_micros=1000000 WHERE owner_id=$1',
    [owner],
  );
  await db.query(
    "DELETE FROM schema_migrations WHERE name='040_ai_budget_ceiling.sql'",
  );
  await migrate(db);
  expect((await get('/api/v1/ai/budget')).json()).toMatchObject({
    version: 4,
    policy: { monthlyLimitMicros: 50000000, perRequestLimitMicros: 250000 },
  });
  expect(
    await db.query(
      'SELECT * FROM ai_budget_reservations WHERE owner_id=$1 ORDER BY id',
      [owner],
    ),
  ).toEqual(reservations);
  expect(
    await db.query(
      'SELECT operation_id,result FROM mutation_receipts WHERE owner_id=$1 ORDER BY operation_id',
      [owner],
    ),
  ).toEqual(receipts);
  const retry = await write('PUT', '/api/v1/ai/budget', oldWrite);
  expect(retry.statusCode).toBe(200);
  expect(retry.json()).toEqual(historical);
  expect(
    (await get('/api/v1/ai/budget')).json().policy.monthlyLimitMicros,
  ).toBe(50000000);
});
