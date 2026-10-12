import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { aiContextRefSchema, plannerExportSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import {
  beginSyntheticAttempt,
  executeSyntheticRequest,
} from '../src/ai/synthetic-execution.js';
import { executeSyntheticTextRequest } from '../src/ai/synthetic-text-execution.js';
import type { Database } from '../src/db/database.js';
import { readAIBudget } from '../src/features/ai-budget.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  AI_SECRET_TEST: 'synthetic-only',
  AI_PROVIDER_PROFILES: JSON.stringify([
    {
      alias: 'test',
      adapter: 'anthropic',
      model: 'synthetic-only',
      credentialEnv: 'AI_SECRET_TEST',
      enabled: true,
      maxInputCharacters: 48000,
      maxOutputTokens: 2000,
      pricing: {
        revision: 'synthetic-v1',
        validUntil: '2050-01-01T00:00:00.000Z',
        inputTokenLimit: 48000,
        inputMicrosPerMillionTokens: 1000000,
        outputMicrosPerMillionTokens: 1000000,
      },
      retentionDisclosure: {
        revision: 'synthetic-v1',
        summary: 'Synthetic test disclosure.',
      },
    },
  ]),
});
let app: Awaited<ReturnType<typeof buildApp>>,
  db: Awaited<ReturnType<typeof openDatabase>>;
let owner: string, cookie: string, otherCookie: string, registry: string;
const text = 'Synthetic request: help plan my day.';
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
const body = (sources: unknown[] = []) => ({
  operationId: randomUUID(),
  expectedPolicyVersion: 2,
  expectedBudgetVersion: 2,
  expectedRegistryRevision: registry,
  text,
  sensitivity: 'unlabeled',
  sources,
});
async function request(sources: unknown[] = []) {
  const response = await write('POST', '/api/v1/ai/requests', body(sources));
  expect(response.statusCode).toBe(201);
  return response.json();
}
async function task() {
  const response = await write('POST', '/api/v1/tasks', {
    operationId: randomUUID(),
    title: 'Private synthetic task',
    notes: 'Private context notes',
    dueDate: null,
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
  });
  expect(response.statusCode).toBe(200);
  return response.json().task;
}
const ref = (value: { id: string; version: number }) => ({
  kind: 'task',
  id: value.id,
  expectedVersion: value.version,
});
async function memory() {
  const response = await write('POST', '/api/v1/memory', {
    operationId: randomUUID(),
    kind: 'preference',
    title: 'Private memory title',
    content: 'Private owner memory content',
    sensitivity: 'restricted',
  });
  expect(response.statusCode).toBe(200);
  return response.json().memory;
}
beforeAll(async () => {
  vi.stubGlobal('fetch', network);
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const enrollment = await write(
    'POST',
    '/api/v1/auth/setup',
    { email: 'context@example.test', password: 'synthetic-context-password' },
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
        policy: { monthlyLimitMicros: 10000000, perRequestLimitMicros: 100000 },
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
  const other = randomUUID(),
    token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-context@example.test',
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
  await app?.close();
  vi.unstubAllGlobals();
});

it('binds allowlisted text to safe owned manifest metadata without retaining text or digest in public records', async () => {
  const value = await task(),
    saved = await request([ref(value)]);
  expect(saved.assessment.contextManifest).toMatchObject({
    boundary: 'text-only',
    projection: 'owned-text-v1',
    request: { provenance: 'owner-entered' },
    sources: [
      {
        kind: 'task',
        id: value.id,
        version: 1,
        labels: ['unlabeled'],
        attachmentDerived: false,
      },
    ],
  });
  expect(JSON.stringify(saved)).not.toContain(value.title);
  const [stored] = await db.query(
    'SELECT context_hash FROM ai_requests WHERE id=$1',
    [saved.id],
  );
  expect(stored!.context_hash).toMatch(/^[a-f0-9]{64}$/);
  const claim = await beginSyntheticAttempt(
    db,
    config,
    owner,
    saved.id,
    1,
    text,
  );
  expect(claim.claimed).toBe(true);
  if (claim.claimed) {
    expect(claim.payload).toContain(value.notes);
    expect(claim.contextManifest).toEqual(saved.assessment.contextManifest);
  }
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(JSON.stringify(exported.records.aiRequests)).not.toContain(
    stored!.context_hash,
  );
  expect(JSON.stringify(exported.records.aiRequests)).not.toContain(
    value.notes,
  );
  expect(
    JSON.stringify(await db.query('SELECT result FROM mutation_receipts')),
  ).not.toContain(text);
});
it('blocks changed projected text even when a damaged source does not advance its version', async () => {
  const value = await task(),
    saved = await request([ref(value)]);
  await db.query('UPDATE tasks SET notes=$2 WHERE id=$1', [
    value.id,
    'Changed synthetic context',
  ]);
  const execute = vi.fn(async () => ({
    outcome: 'completed' as const,
    inputTokens: 1,
    outputTokens: 0,
  }));
  await expect(
    executeSyntheticRequest(db, config, owner, saved.id, 1, text, {
      kind: 'synthetic',
      execute,
    }),
  ).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
  expect(execute).not.toHaveBeenCalled();
  expect(
    await db.query('SELECT id FROM ai_attempts WHERE request_id=$1', [
      saved.id,
    ]),
  ).toEqual([]);
  expect(
    await db.query(
      'SELECT id FROM ai_budget_reservations WHERE request_id=$1',
      [saved.id],
    ),
  ).toEqual([]);
});
it('requires new assessment for legacy unbound requests while preserving legacy metadata parsing', async () => {
  const saved = await request();
  await db.query('UPDATE ai_requests SET context_hash=NULL WHERE id=$1', [
    saved.id,
  ]);
  await db.query(
    "UPDATE ai_preflights SET metadata=metadata-'contextManifest' WHERE id=$1",
    [saved.assessment.id],
  );
  expect(
    (await get(`/api/v1/ai/requests/${saved.id}`)).json().assessment
      .contextManifest,
  ).toBeNull();
  await expect(
    beginSyntheticAttempt(db, config, owner, saved.id, 1, text),
  ).rejects.toMatchObject({ code: 'CONTEXT_BINDING_REQUIRED' });
});
it('requires explicit memory settings/version and respects global disable, re-enable and forget before admission', async () => {
  const value = await memory();
  const selected = {
    kind: 'memory',
    id: value.id,
    expectedVersion: 1,
    expectedMemorySettingsVersion: 1,
  };
  expect(
    (await write('POST', '/api/v1/ai/requests', body([selected]))).json().error
      .code,
  ).toBe('MEMORY_DISABLED');
  expect(
    (
      await write('PUT', '/api/v1/memory/settings', {
        ...change(1),
        enabled: true,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await write('POST', '/api/v1/ai/requests', body([selected]))).json().error
      .code,
  ).toBe('VERSION_CONFLICT');
  const enabled = { ...selected, expectedMemorySettingsVersion: 2 },
    saved = await request([enabled]);
  expect(saved.assessment.contextManifest.sources[0]).toMatchObject({
    kind: 'memory',
    labels: ['restricted'],
    memorySettingsVersion: 2,
  });
  expect(JSON.stringify(saved)).not.toContain('Private owner memory content');
  await write('PUT', '/api/v1/memory/settings', {
    ...change(2),
    enabled: false,
  });
  await expect(
    beginSyntheticAttempt(db, config, owner, saved.id, 1, text),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  await write('PUT', '/api/v1/memory/settings', {
    ...change(3),
    enabled: true,
  });
  await expect(
    beginSyntheticAttempt(db, config, owner, saved.id, 1, text),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  const fresh = await request([
    { ...enabled, expectedMemorySettingsVersion: 4 },
  ]);
  await write('DELETE', `/api/v1/memory/${value.id}`, change(1));
  await expect(
    beginSyntheticAttempt(db, config, owner, fresh.id, 1, text),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(
    await db.query('SELECT id FROM ai_attempts WHERE request_id=$1', [
      fresh.id,
    ]),
  ).toEqual([]);
});
it('rejects foreign memory, disabled records, missing settings and case-variant duplicate refs', async () => {
  const value = await memory(),
    settings = (await get('/api/v1/memory/settings')).json();
  const selected = {
    kind: 'memory',
    id: value.id,
    expectedVersion: 1,
    expectedMemorySettingsVersion: settings.version,
  };
  expect(
    aiContextRefSchema.safeParse({
      kind: 'memory',
      id: value.id,
      expectedVersion: 1,
    }).success,
  ).toBe(false);
  expect(
    aiContextRefSchema.safeParse({
      ...ref(value),
      expectedMemorySettingsVersion: 1,
    }).success,
  ).toBe(false);
  expect(
    (
      await write(
        'POST',
        '/api/v1/ai/routing/preview',
        {
          expectedPolicyVersion: 1,
          text,
          sensitivity: 'unlabeled',
          sources: [{ ...selected, expectedMemorySettingsVersion: 1 }],
          simulatedAvailableProviders: ['test'],
        },
        otherCookie,
      )
    ).json().error.code,
  ).toBe('MEMORY_DISABLED');
  // Enable the foreign owner's setting, but never grant access to this owner's record.
  expect(
    (
      await write(
        'PUT',
        '/api/v1/memory/settings',
        { ...change(1), enabled: true },
        otherCookie,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await write(
        'POST',
        '/api/v1/ai/routing/preview',
        {
          expectedPolicyVersion: 1,
          text,
          sensitivity: 'unlabeled',
          sources: [{ ...selected, expectedMemorySettingsVersion: 2 }],
          simulatedAvailableProviders: ['test'],
        },
        otherCookie,
      )
    ).statusCode,
  ).toBe(404);
  const duplicate = await write(
    'POST',
    '/api/v1/ai/requests',
    body([selected, { ...selected, id: selected.id.toUpperCase() }]),
  );
  expect(duplicate.statusCode).toBe(400);
  await db.query('UPDATE memories SET enabled=FALSE WHERE id=$1', [value.id]);
  expect(
    (await write('POST', '/api/v1/ai/requests', body([selected]))).json().error
      .code,
  ).toBe('MEMORY_DISABLED');
});
it('returns typed source-linked guidance once, settles immutable usage and retains only result counts', async () => {
  const value = await task(),
    saved = await request([ref(value)]);
  const output = {
    answer: 'Synthetic plan: review the selected task.',
    suggestions: [
      {
        source: { kind: 'task', id: value.id, version: 1 },
        note: 'Review its deadline.',
      },
    ],
  };
  const execute = vi.fn(async () => ({
    usage: {
      outcome: 'completed',
      inputTokens: 100,
      outputTokens: Buffer.byteLength(JSON.stringify(output), 'utf8'),
    },
    output,
  }));
  const adapter = { kind: 'synthetic-text' as const, execute };
  const results = await Promise.all(
    [1, 2].map(() =>
      executeSyntheticTextRequest(
        db,
        config,
        owner,
        saved.id,
        1,
        text,
        adapter,
      ),
    ),
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect(results.filter((value) => value.result !== null)).toHaveLength(1);
  expect(results.find((value) => value.result !== null)!.result).toMatchObject({
    synthetic: true,
    retained: false,
    labels: ['unlabeled'],
    output,
  });
  const detail = (await get(`/api/v1/ai/requests/${saved.id}`)).json();
  expect(detail.attempt.resultMetadata).toMatchObject({
    status: 'validated',
    retained: false,
    answerCharacters: output.answer.length,
    suggestionCount: 1,
  });
  expect(JSON.stringify(detail)).not.toContain(output.answer);
  expect(
    JSON.stringify(
      await db.query('SELECT * FROM ai_attempts WHERE request_id=$1', [
        saved.id,
      ]),
    ),
  ).not.toContain(output.answer);
  expect(
    (
      await executeSyntheticTextRequest(
        db,
        config,
        owner,
        saved.id,
        1,
        text,
        adapter,
      )
    ).result,
  ).toBeNull();
  expect(execute).toHaveBeenCalledTimes(1);
});
it('settles confirmed usage but discards ungrounded, executable, oversized or mismatched fake results', async () => {
  for (const output of [
    {
      answer: 'Ungrounded',
      suggestions: [
        {
          source: { kind: 'task', id: randomUUID(), version: 1 },
          note: 'Unavailable source',
        },
      ],
    },
    { answer: 'Unsafe shape', suggestions: [], action: { kind: 'send-email' } },
    { answer: 'x'.repeat(3000), suggestions: [] },
    { answer: 'Mismatched token count', suggestions: [] },
  ]) {
    const saved = await request();
    const result = await executeSyntheticTextRequest(
      db,
      config,
      owner,
      saved.id,
      1,
      text,
      {
        kind: 'synthetic-text',
        execute: async () => ({
          usage: {
            outcome: 'completed',
            inputTokens: 1,
            outputTokens: output.answer.startsWith('Mismatched')
              ? 0
              : Buffer.byteLength(JSON.stringify(output), 'utf8'),
          },
          output,
        }),
      },
    );
    expect(result.result).toBeNull();
    expect(result.request.status).toBe('completed');
    expect(result.request.attempt!.resultMetadata!.status).toBe('invalid');
    expect(
      (
        await db.query(
          'SELECT status FROM ai_budget_reservations WHERE request_id=$1',
          [saved.id],
        )
      )[0]!.status,
    ).toBe('settled');
  }
});
it('preserves uncertainty and never exposes text on malformed usage or accounting rollback', async () => {
  for (const failAccounting of [false, true]) {
    const saved = await request();
    if (failAccounting)
      await db.exec(
        "CREATE FUNCTION fail_text_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER fail_text_result BEFORE UPDATE ON ai_attempts FOR EACH ROW EXECUTE FUNCTION fail_text_result();",
      );
    const output = { answer: 'Temporary synthetic output', suggestions: [] };
    const execute = vi.fn(async () => ({
      usage: {
        outcome: 'completed',
        inputTokens: failAccounting ? 1 : -1,
        outputTokens: Buffer.byteLength(JSON.stringify(output), 'utf8'),
      },
      output,
    }));
    try {
      const result = await executeSyntheticTextRequest(
        db,
        config,
        owner,
        saved.id,
        1,
        text,
        { kind: 'synthetic-text', execute },
      );
      expect(result.result).toBeNull();
      expect(result.request.status).toBe('uncertain');
      expect(result.request.attempt!.resultMetadata).toBeNull();
      await executeSyntheticTextRequest(db, config, owner, saved.id, 1, text, {
        kind: 'synthetic-text',
        execute,
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(
        (
          await db.query(
            'SELECT status FROM ai_budget_reservations WHERE request_id=$1',
            [saved.id],
          )
        )[0]!.status,
      ).toBe('uncertain');
    } finally {
      if (failAccounting)
        await db.exec(
          'DROP TRIGGER fail_text_result ON ai_attempts; DROP FUNCTION fail_text_result();',
        );
    }
  }
});
it('upgrades populated legacy requests without inventing a binding or altering versions and receipts', async () => {
  const saved = await request(),
    [before] = await db.query(
      'SELECT id,version,status,text_hash FROM ai_requests WHERE id=$1',
      [saved.id],
    );
  await db.exec('ALTER TABLE ai_requests DROP COLUMN context_hash');
  await db.query(
    "DELETE FROM schema_migrations WHERE name='038_ai_context_binding.sql'",
  );
  await migrate(db);
  const [after] = await db.query(
    'SELECT id,version,status,text_hash,context_hash FROM ai_requests WHERE id=$1',
    [saved.id],
  );
  expect(after).toEqual({ ...before, context_hash: null });
  await expect(
    beginSyntheticAttempt(db, config, owner, saved.id, 1, text),
  ).rejects.toMatchObject({ code: 'CONTEXT_BINDING_REQUIRED' });
});
it('rejects non-test text execution and SQL metadata that tries to retain arbitrary result fields', async () => {
  const saved = await request();
  const execute = vi.fn(async () => ({}));
  await expect(
    executeSyntheticTextRequest(
      db,
      { ...config, NODE_ENV: 'development' },
      owner,
      saved.id,
      1,
      text,
      { kind: 'synthetic-text', execute },
    ),
  ).rejects.toMatchObject({ code: 'DISPATCH_DISABLED' });
  expect(execute).not.toHaveBeenCalled();
  await beginSyntheticAttempt(db, config, owner, saved.id, 1, text);
  await expect(
    db.query(
      'UPDATE ai_attempts SET result_metadata=$2::jsonb WHERE request_id=$1',
      [
        saved.id,
        JSON.stringify({
          synthetic: true,
          retained: false,
          status: 'validated',
          answerCharacters: 1,
          suggestionCount: 0,
          answer: 'Never stored',
        }),
      ],
    ),
  ).rejects.toBeDefined();
});

it('times out once, aborts the callback signal and discards late results without resending', async () => {
  const saved = await request();
  let finish: ((value: unknown) => void) | undefined;
  let signal: AbortSignal | undefined;
  const execute = vi.fn(async (input: { signal: AbortSignal }) => {
    signal = input.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const adapter = { kind: 'synthetic-text' as const, execute };
  const result = await executeSyntheticTextRequest(
    db,
    config,
    owner,
    saved.id,
    1,
    text,
    adapter,
    10,
  );
  expect(signal!.aborted).toBe(true);
  expect(result.request.status).toBe('uncertain');
  const output = { answer: 'Late synthetic result', suggestions: [] };
  finish!({
    usage: {
      outcome: 'completed',
      inputTokens: 1,
      outputTokens: Buffer.byteLength(JSON.stringify(output), 'utf8'),
    },
    output,
  });
  await Promise.resolve();
  const retry = await executeSyntheticTextRequest(
    db,
    config,
    owner,
    saved.id,
    1,
    text,
    adapter,
    10,
  );
  expect(retry.request.status).toBe('uncertain');
  expect(retry.result).toBeNull();
  expect(execute).toHaveBeenCalledTimes(1);
});

it('does not let adapter mutation invent admitted sources for result guidance', async () => {
  const saved = await request();
  const invented = randomUUID();
  const result = await executeSyntheticTextRequest(
    db,
    config,
    owner,
    saved.id,
    1,
    text,
    {
      kind: 'synthetic-text',
      execute: async (input) => {
        input.contextManifest.sources.push({
          kind: 'task',
          id: invented,
          version: 1,
          labels: ['unlabeled'],
          attachmentDerived: false,
          memorySettingsVersion: null,
          characters: 1,
        });
        const output = {
          answer: 'Synthetic invented guidance',
          suggestions: [
            {
              source: { kind: 'task', id: invented, version: 1 },
              note: 'Invented source',
            },
          ],
        };
        return {
          usage: {
            outcome: 'completed',
            inputTokens: 1,
            outputTokens: Buffer.byteLength(JSON.stringify(output), 'utf8'),
          },
          output,
        };
      },
    },
  );
  expect(result.result).toBeNull();
  expect(result.request.attempt!.admission.contextManifest!.sources).toEqual(
    [],
  );
  expect(result.request.attempt!.resultMetadata!.status).toBe('invalid');
});

it('retains validated result metadata across restart without retaining or replaying the output', async () => {
  const root = resolve('.artifacts', 'verified-ai-context');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'run-'));
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
        email: 'persist-context@example.test',
        password: 'synthetic-context-password',
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
            monthlyLimitMicros: 10000000,
            perRequestLimitMicros: 100000,
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
    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/ai/requests',
      headers: auth,
      payload: body(),
    });
    expect(response.statusCode).toBe(201);
    const saved = response.json();
    const output = {
      answer: 'Ephemeral persisted-test result',
      suggestions: [],
    };
    const execute = vi.fn(async () => ({
      usage: {
        outcome: 'completed',
        inputTokens: 1,
        outputTokens: Buffer.byteLength(JSON.stringify(output), 'utf8'),
      },
      output,
    }));
    const adapter = { kind: 'synthetic-text' as const, execute };
    const completed = await executeSyntheticTextRequest(
      store,
      persistentConfig,
      account,
      saved.id,
      1,
      text,
      adapter,
    );
    expect(completed.result!.output).toEqual(output);
    const retainedResponse = await instance.inject({
      method: 'POST',
      url: '/api/v1/ai/requests',
      headers: auth,
      payload: { ...body(), saveAnswer: true },
    });
    expect(retainedResponse.statusCode).toBe(201);
    const retainedId = retainedResponse.json().id;
    const retainedExecute = vi.fn(async () => ({
      usage: {
        outcome: 'completed' as const,
        inputTokens: 1,
        outputTokens: Buffer.byteLength(JSON.stringify(output), 'utf8'),
      },
      output,
    }));
    const retainedAdapter = {
      kind: 'synthetic-text' as const,
      execute: retainedExecute,
    };
    expect(
      (
        await executeSyntheticTextRequest(
          store,
          persistentConfig,
          account,
          retainedId,
          1,
          text,
          retainedAdapter,
        )
      ).result!.retained,
    ).toBe(true);
    await instance.close();
    instance = undefined;
    store = await openDatabase(persistentConfig);
    instance = await buildApp(
      { logger: false },
      { config: persistentConfig, database: store },
    );
    const retry = await executeSyntheticTextRequest(
      store,
      persistentConfig,
      account,
      saved.id,
      1,
      text,
      adapter,
    );
    expect(retry.request).toEqual(completed.request);
    expect(retry.result).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (
        await instance.inject({
          url: `/api/v1/ai/requests/${retainedId}/answer`,
          headers: auth,
        })
      ).json().answer.output,
    ).toEqual(output);
    expect(
      (
        await executeSyntheticTextRequest(
          store,
          persistentConfig,
          account,
          retainedId,
          1,
          text,
          retainedAdapter,
        )
      ).result,
    ).toBeNull();
    expect(retainedExecute).toHaveBeenCalledTimes(1);
    const exportResponse = await instance.inject({
      url: '/api/v1/planner/export',
      headers: auth,
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(
      JSON.stringify(exportResponse.json().records.aiRequests),
    ).not.toContain(output.answer);
  } finally {
    await instance?.close();
    expect(dirname(resolve(directory))).toBe(root);
    await rm(directory, { recursive: true, force: true });
  }
});

it('blocks post-admission source changes and consent revocation before any callback', async () => {
  for (const revokeConsent of [false, true]) {
    const value = await task(),
      saved = await request([ref(value)]);
    const proxy: Database = {
      ...db,
      async transaction(work) {
        const result = await db.transaction(work);
        if (
          result &&
          typeof result === 'object' &&
          'claimed' in result &&
          result.claimed === true
        ) {
          if (revokeConsent) {
            const current = (await get('/api/v1/ai/provider-readiness')).json()
              .profiles[0].consent.version;
            expect(
              (
                await write('PUT', '/api/v1/ai/provider-consents/test', {
                  ...change(current),
                  approved: false,
                  expectedRegistryRevision: registry,
                })
              ).statusCode,
            ).toBe(200);
          } else
            await db.query('UPDATE tasks SET notes=$2 WHERE id=$1', [
              value.id,
              'Changed after committed admission',
            ]);
        }
        return result;
      },
    };
    const execute = vi.fn(async () => ({
      usage: { outcome: 'completed', inputTokens: 0, outputTokens: 0 },
      output: { answer: 'Never delivered', suggestions: [] },
    }));
    try {
      const result = await executeSyntheticTextRequest(
        proxy,
        config,
        owner,
        saved.id,
        1,
        text,
        { kind: 'synthetic-text', execute },
      );
      expect(result.request.status).toBe('uncertain');
      expect(result.result).toBeNull();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      if (revokeConsent) {
        const current = (await get('/api/v1/ai/provider-readiness')).json()
          .profiles[0].consent.version;
        expect(
          (
            await write('PUT', '/api/v1/ai/provider-consents/test', {
              ...change(current),
              approved: true,
              expectedRegistryRevision: registry,
            })
          ).statusCode,
        ).toBe(200);
      }
    }
  }
});

it('counts the existing hold once at final revalidation when the monthly limit fits exactly', async () => {
  const budget = await readAIBudget(db, owner);
  const monthly =
    Number(budget.usage.spentMicros) + Number(budget.usage.heldMicros) + 50000;
  await db.query(
    'UPDATE ai_budget_policies SET monthly_limit_micros=$2 WHERE owner_id=$1',
    [owner, monthly],
  );
  try {
    const saved = await request(),
      output = { answer: 'Exact-budget synthetic result', suggestions: [] };
    const execute = vi.fn(async () => ({
      usage: {
        outcome: 'completed',
        inputTokens: 1,
        outputTokens: Buffer.byteLength(JSON.stringify(output), 'utf8'),
      },
      output,
    }));
    const result = await executeSyntheticTextRequest(
      db,
      config,
      owner,
      saved.id,
      1,
      text,
      { kind: 'synthetic-text', execute },
    );
    expect(result.result!.output).toEqual(output);
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    await db.query(
      'UPDATE ai_budget_policies SET monthly_limit_micros=10000000 WHERE owner_id=$1',
      [owner],
    );
  }
});

it('excludes archived classes and topics from new context even when their tombstone versions are supplied', async () => {
  const created = await write('POST', '/api/v1/courses', {
    operationId: randomUUID(),
    name: 'Synthetic archived context class',
  });
  expect(created.statusCode).toBe(200);
  const course = created.json().course;
  const topicResponse = await write('POST', '/api/v1/topics', {
    operationId: randomUUID(),
    name: 'Synthetic archived topic',
    courseId: course.id,
  });
  expect(topicResponse.statusCode).toBe(200);
  const topic = topicResponse.json().topic;
  expect(
    (await write('DELETE', `/api/v1/courses/${course.id}`, change(1)))
      .statusCode,
  ).toBe(200);
  for (const source of [
    { kind: 'course', id: course.id, expectedVersion: 2 },
    { kind: 'topic', id: topic.id, expectedVersion: 2 },
  ])
    expect(
      (await write('POST', '/api/v1/ai/requests', body([source]))).statusCode,
    ).toBe(404);
});
