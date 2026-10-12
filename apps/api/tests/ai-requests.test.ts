import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { aiRequestSchema, plannerExportSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  beginSyntheticAttempt,
  executeSyntheticRequest,
  confirmSyntheticAttempt,
} from '../src/ai/synthetic-execution.js';
import { readAIRequest } from '../src/ai/requests.js';
import type { Database } from '../src/db/database.js';
const origin = 'http://127.0.0.1:5173';
const profile = {
  alias: 'routine',
  adapter: 'anthropic',
  model: 'synthetic-only',
  credentialEnv: 'AI_SECRET_ROUTINE',
  enabled: true,
  maxInputCharacters: 48000,
  maxOutputTokens: 100,
  pricing: {
    revision: 'synthetic-v1',
    validUntil: '2050-01-01T00:00:00.000Z',
    inputTokenLimit: 10000,
    inputMicrosPerMillionTokens: 1000000,
    outputMicrosPerMillionTokens: 1000000,
  },
  retentionDisclosure: {
    revision: 'synthetic-v1',
    summary: 'Synthetic disclosure.',
  },
};
const environment = {
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  AI_PROVIDER_PROFILES: JSON.stringify([profile]),
  AI_SECRET_ROUTINE: 'synthetic-secret',
};
const config = readConfig(environment);
const text = 'Private original request text, never stored.';
const network = vi.fn(() => {
  throw new Error('Network forbidden');
});
let db: Awaited<ReturnType<typeof openDatabase>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: string;
let cookie: string;
let otherCookie: string;
let registryRevision: string;
const headers = (session = cookie) => ({ origin, cookie: session });
const change = (expectedVersion: number) => ({
  expectedVersion,
  operationId: randomUUID(),
});
async function enroll(instance: typeof app) {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'request@example.test',
      password: 'synthetic-request-password',
    },
  });
  expect(response.statusCode).toBe(201);
  return {
    owner: response.json().user.id as string,
    cookie: String(response.headers['set-cookie']).split(';')[0]!,
  };
}
async function configure(instance: typeof app, session: string) {
  const auth = headers(session);
  const registry = (
    await instance.inject({ url: '/api/v1/ai/providers', headers: auth })
  ).json();
  expect(
    (
      await instance.inject({
        method: 'PUT',
        url: '/api/v1/ai/routing',
        headers: auth,
        payload: {
          ...change(1),
          policy: {
            unlabeled: { allowed: ['routine'], preferred: 'routine' },
            personal: { allowed: ['routine'], preferred: 'routine' },
            restricted: { allowed: ['routine'], preferred: 'routine' },
          },
        },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await instance.inject({
        method: 'PUT',
        url: '/api/v1/ai/budget',
        headers: auth,
        payload: {
          ...change(1),
          policy: {
            monthlyLimitMicros: 1000000,
            perRequestLimitMicros: 100000,
          },
        },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await instance.inject({
        method: 'PUT',
        url: '/api/v1/ai/provider-consents/routine',
        headers: auth,
        payload: {
          ...change(1),
          approved: true,
          expectedRegistryRevision: registry.revision,
        },
      })
    ).statusCode,
  ).toBe(200);
  return registry.revision as string;
}
const body = (overrides: object = {}) => ({
  operationId: randomUUID(),
  expectedPolicyVersion: 2,
  expectedBudgetVersion: 2,
  expectedRegistryRevision: registryRevision,
  text,
  sensitivity: 'unlabeled',
  sources: [],
  ...overrides,
});
const create = (payload = body(), session = cookie) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/ai/requests',
    headers: headers(session),
    payload,
  });
async function newRequest(overrides: object = {}) {
  const response = await create(body(overrides));
  expect(response.statusCode).toBe(201);
  return aiRequestSchema.parse(response.json());
}
beforeAll(async () => {
  vi.stubGlobal('fetch', network);
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  ({ owner, cookie } = await enroll(app));
  registryRevision = await configure(app, cookie);
  const other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-request@example.test',
    'unused',
  ]);
  await db.query(
    'INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,$3)',
    [
      createHash('sha256').update(token).digest('hex'),
      other,
      new Date(Date.now() + 3600000),
    ],
  );
  otherCookie = `hub_session=${token}`;
});
afterAll(async () => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app?.close();
});
it('creates a durable blocked assessment once while discarding prompt text', async () => {
  const payload = body();
  const responses = await Promise.all([create(payload), create(payload)]);
  expect(responses.map((value) => value.statusCode)).toEqual([201, 201]);
  expect(responses[0]!.json()).toEqual(responses[1]!.json());
  const request = aiRequestSchema.parse(responses[0]!.json());
  expect(request).toMatchObject({
    status: 'blocked',
    dispatchEnabled: false,
    requiresTextResupply: true,
    attempt: null,
  });
  expect(
    (await create({ ...payload, text: 'Changed request text' })).json().error
      .code,
  ).toBe('OPERATION_CONFLICT');
  expect(
    await db.query('SELECT * FROM ai_requests WHERE id=$1', [request.id]),
  ).toHaveLength(1);
  const raw = await db.query(
    'SELECT r.*,p.metadata FROM ai_requests r JOIN ai_preflights p ON p.id=r.preflight_id WHERE r.id=$1',
    [request.id],
  );
  expect(JSON.stringify(raw)).not.toContain(text);
  expect(JSON.stringify(request)).not.toContain('text_hash');
  expect(JSON.stringify(request)).not.toContain('synthetic-secret');
  expect(await db.query('SELECT * FROM ai_budget_reservations')).toHaveLength(
    0,
  );
});
it('protects owner access and cancels/hides with version guards and historical receipts', async () => {
  const request = await newRequest();
  const path = `/api/v1/ai/requests/${request.id}`;
  expect((await app.inject(path)).statusCode).toBe(401);
  expect(
    (await app.inject({ url: path, headers: headers(otherCookie) })).statusCode,
  ).toBe(404);
  expect((await app.inject('/api/v1/ai/requests')).statusCode).toBe(401);
  expect(
    (await create(body({ endpoint: 'https://synthetic.invalid' }))).statusCode,
  ).toBe(400);
  const payload = change(1);
  const cancel = await app.inject({
    method: 'POST',
    url: `${path}/cancel`,
    headers: headers(),
    payload,
  });
  expect(cancel.json()).toMatchObject({ status: 'cancelled', version: 2 });
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: path,
        headers: headers(),
        payload: change(1),
      })
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
  const hidden = await app.inject({
    method: 'DELETE',
    url: path,
    headers: headers(),
    payload: change(2),
  });
  expect(hidden.statusCode).toBe(200);
  expect(hidden.json().deletedAt).not.toBeNull();
  expect((await app.inject({ url: path, headers: headers() })).statusCode).toBe(
    404,
  );
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${path}/cancel`,
        headers: headers(),
        payload,
      })
    ).json(),
  ).toEqual(cancel.json());
  await expect(
    beginSyntheticAttempt(db, config, owner, request.id, 1, text),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('runs one synthetic callback under concurrent retries and settles usage atomically', async () => {
  const request = await newRequest();
  const execute = vi.fn(
    async (input: {
      payload: string;
      attemptId: string;
      maxOutputTokens: number;
    }) => {
      expect(input.payload).toContain(text);
      expect(input.maxOutputTokens).toBe(100);
      const reservations = await db.query(
        'SELECT status FROM ai_budget_reservations WHERE request_id=$1',
        [request.id],
      );
      expect(reservations[0]!.status).toBe('uncertain');
      return {
        outcome: 'completed' as const,
        inputTokens: 100,
        outputTokens: 3,
      };
    },
  );
  await Promise.all(
    [0, 1].map(() =>
      executeSyntheticRequest(db, config, owner, request.id, 1, text, {
        kind: 'synthetic',
        execute,
      }),
    ),
  );
  expect(execute).toHaveBeenCalledTimes(1);
  const completed = await readAIRequest(db, owner, request.id);
  expect(completed).toMatchObject({
    status: 'completed',
    version: 3,
    attempt: {
      actualMicros: 103,
      inputTokens: 100,
      outputTokens: 3,
      status: 'completed',
    },
  });
  await executeSyntheticRequest(db, config, owner, request.id, 1, text, {
    kind: 'synthetic',
    execute,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(
    await confirmSyntheticAttempt(db, config, owner, request.id, {
      outcome: 'completed',
      inputTokens: 100,
      outputTokens: 3,
    }),
  ).toEqual(completed);
  await expect(
    confirmSyntheticAttempt(db, config, owner, request.id, {
      outcome: 'completed',
      inputTokens: 99,
      outputTokens: 3,
    }),
  ).rejects.toMatchObject({ code: 'ATTEMPT_RESULT_CONFLICT' });
  expect(
    (
      await db.query(
        'SELECT status,actual_micros FROM ai_budget_reservations WHERE request_id=$1',
        [request.id],
      )
    )[0],
  ).toMatchObject({ status: 'settled', actual_micros: 103 });
});
it('holds uncertainty after transport or invalid-result failures and forbids cancellation, hiding and automatic resend', async () => {
  for (const execute of [
    vi.fn(async () => {
      throw new Error('Private synthetic transport failure');
    }),
    vi.fn(async () => ({
      outcome: 'completed' as const,
      inputTokens: -1,
      outputTokens: 0,
    })),
  ]) {
    const request = await newRequest();
    const uncertain = await executeSyntheticRequest(
      db,
      config,
      owner,
      request.id,
      1,
      text,
      { kind: 'synthetic', execute },
    );
    expect(uncertain.status).toBe('uncertain');
    expect(uncertain.attempt!.actualMicros).toBeNull();
    await executeSyntheticRequest(db, config, owner, request.id, 1, text, {
      kind: 'synthetic',
      execute,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    for (const action of ['cancel', 'hide']) {
      const result = await app.inject({
        method: action === 'cancel' ? 'POST' : 'DELETE',
        url: `/api/v1/ai/requests/${request.id}${action === 'cancel' ? '/cancel' : ''}`,
        headers: headers(),
        payload: change(uncertain.version),
      });
      expect(result.json().error.code).toBe('AI_REQUEST_UNCERTAIN');
    }
    expect(
      (
        await db.query(
          'SELECT status,reserved_micros FROM ai_budget_reservations WHERE request_id=$1',
          [request.id],
        )
      )[0],
    ).toMatchObject({ status: 'uncertain', reserved_micros: 10100 });
    expect(JSON.stringify(uncertain)).not.toContain(
      'Private synthetic transport',
    );
  }
});
it('rejects stale source versions, altered text and production admission before any attempt or reservation', async () => {
  const task = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: headers(),
      payload: { title: 'Synthetic context', operationId: randomUUID() },
    })
  ).json().task;
  const request = await newRequest({
    sources: [{ kind: 'task', id: task.id, expectedVersion: 1 }],
  });
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${task.id}`,
        headers: headers(),
        payload: { title: 'Changed context', ...change(1) },
      })
    ).statusCode,
  ).toBe(200);
  await expect(
    beginSyntheticAttempt(db, config, owner, request.id, 1, text),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  const fresh = await newRequest();
  await expect(
    beginSyntheticAttempt(db, config, owner, fresh.id, 1, 'Changed text'),
  ).rejects.toMatchObject({ code: 'REQUEST_TEXT_CONFLICT' });
  await expect(
    beginSyntheticAttempt(
      db,
      { ...config, NODE_ENV: 'development' },
      owner,
      fresh.id,
      1,
      text,
    ),
  ).rejects.toMatchObject({ code: 'DISPATCH_DISABLED' });
  await expect(
    beginSyntheticAttempt(db, config, randomUUID(), fresh.id, 1, text),
  ).rejects.toThrow();
  expect(
    await db.query(
      'SELECT * FROM ai_attempts WHERE request_id=ANY($1::uuid[])',
      [[request.id, fresh.id]],
    ),
  ).toHaveLength(0);
  expect(
    await db.query(
      'SELECT * FROM ai_budget_reservations WHERE request_id=ANY($1::uuid[])',
      [[request.id, fresh.id]],
    ),
  ).toHaveLength(0);
});
it('records confirmed failed usage and overruns without understating charges', async () => {
  const request = await newRequest();
  const failed = await executeSyntheticRequest(
    db,
    config,
    owner,
    request.id,
    1,
    text,
    {
      kind: 'synthetic',
      execute: async () => ({
        outcome: 'failed',
        inputTokens: 1,
        outputTokens: 20000,
      }),
    },
  );
  expect(failed).toMatchObject({
    status: 'failed',
    attempt: { status: 'failed', actualMicros: 20001 },
  });
  expect(
    (
      await db.query(
        'SELECT status,actual_micros,reserved_micros FROM ai_budget_reservations WHERE request_id=$1',
        [request.id],
      )
    )[0],
  ).toMatchObject({
    status: 'settled',
    actual_micros: 20001,
    reserved_micros: 10100,
  });
});
it('rolls back a partial settlement and retains the hold until confirmed recovery', async () => {
  const request = await newRequest();
  await beginSyntheticAttempt(db, config, owner, request.id, 1, text);
  const failingDatabase: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          ...tx,
          query: (sql, values) => {
            if (sql.startsWith('UPDATE ai_attempts SET status='))
              throw new Error('Synthetic accounting failure');
            return tx.query(sql, values);
          },
        }),
      ),
  };
  const usage = {
    outcome: 'completed' as const,
    inputTokens: 7,
    outputTokens: 2,
  };
  await expect(
    confirmSyntheticAttempt(failingDatabase, config, owner, request.id, usage),
  ).rejects.toThrow('Synthetic accounting failure');
  expect(await readAIRequest(db, owner, request.id)).toMatchObject({
    status: 'uncertain',
    attempt: { actualMicros: null },
  });
  expect(
    (
      await db.query(
        'SELECT status,actual_micros FROM ai_budget_reservations WHERE request_id=$1',
        [request.id],
      )
    )[0],
  ).toMatchObject({ status: 'uncertain', actual_micros: null });
  const changedConfig = readConfig({
    ...environment,
    AI_PROVIDER_PROFILES: JSON.stringify([
      {
        ...profile,
        pricing: {
          ...profile.pricing,
          revision: 'changed',
          inputMicrosPerMillionTokens: 9000000,
        },
      },
    ]),
  });
  expect(
    (await confirmSyntheticAttempt(db, changedConfig, owner, request.id, usage))
      .attempt!.actualMicros,
  ).toBe(9);
});
it('pages ties with hidden cursors and exports only safe request and attempt metadata', async () => {
  const hiddenCursor = await newRequest();
  await db.query(
    "UPDATE ai_requests SET created_at='2030-01-01T00:00:00.123456Z' WHERE owner_id=$1",
    [owner],
  );
  await db.query(
    "UPDATE ai_requests SET created_at='2031-01-01T00:00:00.123456Z' WHERE id=$1",
    [hiddenCursor.id],
  );
  const first = (
    await app.inject({ url: '/api/v1/ai/requests?limit=1', headers: headers() })
  ).json();
  const cursor = first.requests[0];
  expect(cursor.id).toBe(hiddenCursor.id);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/ai/requests/${cursor.id}`,
        headers: headers(),
        payload: change(cursor.version),
      })
    ).statusCode,
  ).toBe(200);
  const second = (
    await app.inject({
      url: `/api/v1/ai/requests?limit=1&before=${first.nextBefore}`,
      headers: headers(),
    })
  ).json();
  expect(second.requests).toHaveLength(1);
  expect(second.requests[0].id).not.toBe(cursor.id);
  expect(
    (
      await app.inject({
        url: `/api/v1/ai/requests?before=${cursor.id}`,
        headers: headers(otherCookie),
      })
    ).statusCode,
  ).toBe(404);
  const exported = plannerExportSchema.parse(
    (
      await app.inject({ url: '/api/v1/planner/export', headers: headers() })
    ).json(),
  );
  expect(exported.records.aiRequests.length).toBeGreaterThan(0);
  expect(exported.records.aiRequests.some((value) => value.deletedAt)).toBe(
    true,
  );
  expect(JSON.stringify(exported)).not.toContain(text);
  expect(JSON.stringify(exported)).not.toContain('text_hash');
  expect(JSON.stringify(exported)).not.toContain('input_manifest');
});
it('retains uncertain claims after restart and confirms known usage without repeating execution', async () => {
  const root = resolve('.artifacts', 'ai-request-persistence');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'run-'));
  const persistentConfig = readConfig({
    ...environment,
    PGLITE_DATA_DIR: directory,
  });
  let instance: typeof app | undefined;
  let persistentDb: typeof db;
  try {
    persistentDb = await openDatabase(persistentConfig);
    instance = await buildApp(
      { logger: false },
      { config: persistentConfig, database: persistentDb },
    );
    const account = await enroll(instance);
    const revision = await configure(instance, account.cookie);
    const request = (
      await instance.inject({
        method: 'POST',
        url: '/api/v1/ai/requests',
        headers: headers(account.cookie),
        payload: body({ expectedRegistryRevision: revision }),
      })
    ).json();
    const claim = await beginSyntheticAttempt(
      persistentDb,
      persistentConfig,
      account.owner,
      request.id,
      1,
      text,
    );
    expect(claim.claimed).toBe(true);
    await instance.close();
    instance = undefined;
    persistentDb = await openDatabase(persistentConfig);
    instance = await buildApp(
      { logger: false },
      { config: persistentConfig, database: persistentDb },
    );
    const execute = vi.fn(async () => ({
      outcome: 'completed' as const,
      inputTokens: 0,
      outputTokens: 0,
    }));
    const uncertain = await executeSyntheticRequest(
      persistentDb,
      persistentConfig,
      account.owner,
      request.id,
      1,
      text,
      { kind: 'synthetic', execute },
    );
    expect(uncertain.status).toBe('uncertain');
    expect(execute).not.toHaveBeenCalled();
    expect(
      (
        await confirmSyntheticAttempt(
          persistentDb,
          persistentConfig,
          account.owner,
          request.id,
          { outcome: 'completed', inputTokens: 0, outputTokens: 0 },
        )
      ).attempt!.actualMicros,
    ).toBe(0);
  } finally {
    await instance?.close();
    if (dirname(resolve(directory)) === root)
      await rm(directory, { recursive: true, force: true });
  }
});
