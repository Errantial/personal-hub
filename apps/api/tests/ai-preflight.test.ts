import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import {
  aiProviderRegistrySchema,
  aiPreflightSchema,
  aiPreflightsResponseSchema,
  plannerExportSchema,
  aiBudgetSettingsSchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { publicAIRegistry } from '../src/ai/profiles.js';
import { assembleAITextContext } from '../src/ai/context.js';
import { resolveAIContext } from '../src/features/ai-routing.js';
import { applyCanvasSnapshot } from '../src/connections/canvas.js';
import { parseCanvasFeed } from '../src/connections/canvas-feed.js';
import { applyCanvasLmsSnapshot } from '../src/connections/canvas-lms.js';
import { mutate } from '../src/planner/mutations.js';
import type { Database } from '../src/db/database.js';
const profiles = [
  {
    alias: 'routine',
    adapter: 'anthropic',
    model: 'synthetic-model',
    credentialEnv: 'AI_SECRET_ROUTINE',
    enabled: true,
    maxInputCharacters: 48000,
    maxOutputTokens: 1000,
  },
  {
    alias: 'private',
    adapter: 'openai-compatible',
    model: 'synthetic-private',
    credentialEnv: 'AI_SECRET_PRIVATE',
    enabled: true,
    maxInputCharacters: 1000,
    maxOutputTokens: 500,
  },
  {
    alias: 'vault',
    adapter: 'openai',
    model: 'synthetic-vault',
    credentialEnv: 'AI_SECRET_VAULT',
    enabled: true,
    maxInputCharacters: 48000,
    maxOutputTokens: 500,
  },
  {
    alias: 'paused',
    adapter: 'anthropic',
    model: 'synthetic-paused',
    credentialEnv: 'AI_SECRET_PAUSED',
    enabled: false,
    maxInputCharacters: 48000,
    maxOutputTokens: 500,
  },
];
const environment = {
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  AI_PROVIDER_PROFILES: JSON.stringify(profiles),
  AI_SECRET_ROUTINE: 'synthetic-secret-never-disclose',
  AI_SECRET_PRIVATE: 'synthetic-private-secret',
  AI_SECRET_PAUSED: 'synthetic-paused-secret',
};
const origin = 'http://127.0.0.1:5173';
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let otherCookie: string;
let owner: string;
let registry: ReturnType<typeof aiProviderRegistrySchema.parse>;
let budgetVersion = 1;
const network = vi.fn(() => {
  throw new Error('Provider/network calls forbidden');
});
const headers = (session = cookie) => ({ origin, cookie: session });
const input = (overrides: object = {}) => ({
  operationId: randomUUID(),
  expectedPolicyVersion: 1,
  expectedRegistryRevision: registry.revision,
  expectedBudgetVersion: budgetVersion,
  text: 'Synthetic request body must not persist.',
  sensitivity: 'unlabeled',
  sources: [],
  ...overrides,
});
const preflight = (body: object, session = cookie) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/ai/preflights',
    headers: headers(session),
    payload: body,
  });
async function policy(alias = 'private') {
  const current = (
    await app.inject({ url: '/api/v1/ai/routing', headers: headers() })
  ).json();
  const result = await app.inject({
    method: 'PUT',
    url: '/api/v1/ai/routing',
    headers: headers(),
    payload: {
      expectedVersion: current.version,
      operationId: randomUUID(),
      policy: {
        unlabeled: {
          allowed: ['routine', 'private', 'vault', 'paused'],
          preferred: 'routine',
        },
        personal: { allowed: [alias, 'routine'], preferred: alias },
        restricted: { allowed: ['vault'], preferred: 'vault' },
      },
    },
  });
  expect(result.statusCode).toBe(200);
  return result.json().version as number;
}
beforeAll(async () => {
  vi.stubGlobal('fetch', network);
  const config = readConfig(environment);
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'preflight@example.test',
      password: 'synthetic-preflight-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  owner = setup.json().user.id;
  const other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-preflight@example.test',
    'unused',
  ]);
  await db.query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '1 day')",
    [createHash('sha256').update(token).digest('hex'), other],
  );
  otherCookie = `hub_session=${token}`;
  registry = aiProviderRegistrySchema.parse(
    (
      await app.inject({ url: '/api/v1/ai/providers', headers: headers() })
    ).json(),
  );
});
afterAll(async () => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app?.close();
});
beforeEach(() => {
  vi.stubGlobal('fetch', network);
});
it('validates server-only profiles without leaking malformed configuration or credentials', () => {
  expect(registry).toMatchObject({
    dispatchEnabled: false,
    health: 'not_checked',
  });
  expect(
    registry.profiles.map((row) => [row.alias, row.configuration]),
  ).toEqual([
    ['paused', 'disabled'],
    ['private', 'configured'],
    ['routine', 'configured'],
    ['vault', 'credential_missing'],
  ]);
  expect(JSON.stringify(registry)).not.toContain('AI_SECRET');
  expect(JSON.stringify(registry)).not.toContain('synthetic-secret');
  for (const rows of [
    [profiles[0], profiles[0]],
    [{ ...profiles[0], endpoint: 'https://untrusted.example.test' }],
    [{ ...profiles[0], credential: 'private-value' }],
    [{ ...profiles[0], credentialEnv: 'CANVAS_API_TOKEN' }],
    [{ ...profiles[0], maxInputCharacters: 48001 }],
  ]) {
    expect(() =>
      readConfig({
        ...environment,
        AI_PROVIDER_PROFILES: JSON.stringify(rows),
      }),
    ).toThrow(/^Invalid environment configuration: AI_PROVIDER_PROFILES$/);
  }
  expect(() =>
    readConfig({
      ...environment,
      AI_PROVIDER_PROFILES: 'private malformed data',
    }),
  ).toThrow(/^Invalid environment configuration: AI_PROVIDER_PROFILES$/);
  expect(() =>
    readConfig({ ...environment, AI_SECRET_ROUTINE: 'secret\nheader' }),
  ).toThrow(/^Invalid environment configuration: AI_PROVIDER_PROFILES$/);
  expect(
    publicAIRegistry(
      readConfig({ ...environment, AI_SECRET_ROUTINE: 'rotated-synthetic' })
        .AI_PROVIDER_PROFILES,
    ).revision,
  ).toBe(registry.revision);
  expect(
    publicAIRegistry(
      readConfig({ ...environment, AI_SECRET_ROUTINE: undefined })
        .AI_PROVIDER_PROFILES,
    ).revision,
  ).not.toBe(registry.revision);
  expect(readConfig({}).AI_PROVIDER_PROFILES).toEqual([]);
});
it('requires owner/origin authorization and rejects simulated availability, attachments and arbitrary destinations', async () => {
  expect((await app.inject({ url: '/api/v1/ai/providers' })).statusCode).toBe(
    401,
  );
  expect((await preflight(input(), '')).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/ai/preflights',
        headers: { cookie },
        payload: input(),
      })
    ).statusCode,
  ).toBe(403);
  for (const fields of [
    { simulatedAvailableProviders: ['vault'] },
    { endpoint: 'https://untrusted.example.test' },
    { attachments: ['file text'] },
    { screenshot: 'pixels' },
    { provider: 'routine' },
    { model: 'different' },
  ])
    expect((await preflight(input(fields))).statusCode).toBe(400);
  expect(
    (
      await preflight(input({ expectedRegistryRevision: '0'.repeat(64) }))
    ).json().error.code,
  ).toBe('REGISTRY_CONFLICT');
  expect(
    (await preflight(input({ expectedPolicyVersion: 999 }))).json().error.code,
  ).toBe('VERSION_CONFLICT');
  expect(await db.query('SELECT id FROM ai_preflights')).toHaveLength(0);
});
it('persists deny-by-default metadata, deduplicates lost responses and never stores text', async () => {
  const body = input();
  const [first, second] = await Promise.all([preflight(body), preflight(body)]);
  expect(first.statusCode).toBe(201);
  expect(second.statusCode).toBe(201);
  expect(second.json()).toEqual(first.json());
  const result = aiPreflightSchema.parse(first.json());
  expect(result).toMatchObject({
    status: 'blocked',
    reason: 'NO_APPROVED_PROVIDER',
    contextAssembled: false,
    contextCharacters: null,
  });
  expect(
    (await preflight({ ...body, text: 'changed' })).json().error.code,
  ).toBe('OPERATION_CONFLICT');
  expect(await db.query('SELECT id FROM ai_preflights')).toHaveLength(1);
  const stored =
    JSON.stringify(await db.query('SELECT metadata FROM ai_preflights')) +
    JSON.stringify(await db.query('SELECT result FROM mutation_receipts'));
  expect(stored).not.toContain(body.text);
  expect(stored).not.toContain('synthetic-secret');
});
it('stores precise owner spending limits with versioned retry receipts and fail-closed unset/zero states', async () => {
  const base = '/api/v1/ai/budget';
  const get = (session = cookie) =>
    app.inject({ url: base, headers: headers(session) });
  expect((await get('')).statusCode).toBe(401);
  const initial = aiBudgetSettingsSchema.parse((await get()).json());
  expect(initial).toMatchObject({
    version: 1,
    policy: { monthlyLimitMicros: null, perRequestLimitMicros: null },
    currency: 'USD',
    monthBoundary: 'UTC',
    dispatchEnabled: false,
  });
  const expectedPolicyVersion = await policy();
  expect(
    (await preflight(input({ expectedPolicyVersion }))).json(),
  ).toMatchObject({
    reason: 'BUDGET_UNSET',
    budgetVersion: 1,
    contextAssembled: true,
  });
  const save = (body: object) =>
    app.inject({ method: 'PUT', url: base, headers: headers(), payload: body });
  for (const invalid of [
    { monthlyLimitMicros: 5, perRequestLimitMicros: 6 },
    { monthlyLimitMicros: null, perRequestLimitMicros: 1 },
    { monthlyLimitMicros: 1.5, perRequestLimitMicros: 1 },
    { monthlyLimitMicros: -1, perRequestLimitMicros: 0 },
    { monthlyLimitMicros: 1_000_000_000_001, perRequestLimitMicros: 1 },
  ])
    expect(
      (
        await save({
          operationId: randomUUID(),
          expectedVersion: 1,
          policy: invalid,
        })
      ).statusCode,
    ).toBe(400);
  const zero = {
    operationId: randomUUID(),
    expectedVersion: 1,
    policy: { monthlyLimitMicros: 0, perRequestLimitMicros: 0 },
  };
  const savedZero = await save(zero);
  expect(savedZero.statusCode).toBe(200);
  expect((await save(zero)).json()).toEqual(savedZero.json());
  budgetVersion = savedZero.json().version;
  expect(
    (await preflight(input({ expectedPolicyVersion }))).json().reason,
  ).toBe('BUDGET_ZERO_LIMIT');
  expect((await save({ ...zero, operationId: randomUUID() })).statusCode).toBe(
    409,
  );
  const body = {
    operationId: randomUUID(),
    expectedVersion: budgetVersion,
    policy: { monthlyLimitMicros: 10_000_001, perRequestLimitMicros: 123_456 },
  };
  const [first, second] = await Promise.all([save(body), save(body)]);
  expect(first.statusCode).toBe(200);
  expect(second.json()).toEqual(first.json());
  budgetVersion = first.json().version;
  expect((await get()).json().policy).toEqual(body.policy);
  expect((await get(otherCookie)).json().policy).toEqual(initial.policy);
  expect(
    (
      await preflight(
        input({ expectedPolicyVersion, expectedBudgetVersion: 1 }),
      )
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
});
it('uses configuration status, full labels and provider-specific bounds while dispatch stays disabled', async () => {
  const expectedPolicyVersion = await policy();
  const ready = await preflight(input({ expectedPolicyVersion }));
  expect(ready.statusCode).toBe(201);
  expect(ready.json()).toMatchObject({
    reason: 'DISPATCH_DISABLED',
    model: 'synthetic-model',
    route: { provider: 'routine', status: 'selected' },
    contextAssembled: true,
    contextCharacters: 0,
  });
  const unavailable = await preflight(
    input({ expectedPolicyVersion, sensitivity: 'restricted' }),
  );
  expect(unavailable.json()).toMatchObject({
    reason: 'PROVIDER_UNAVAILABLE',
    route: { provider: 'vault' },
    contextAssembled: false,
  });
  const bounded = await preflight(
    input({
      expectedPolicyVersion,
      sensitivity: 'personal',
      text: '\\'.repeat(900),
    }),
  );
  expect(bounded.json()).toMatchObject({
    reason: 'INPUT_LIMIT',
    model: 'synthetic-private',
    contextAssembled: false,
    contextCharacters: null,
  });
  const pausedVersion = await policy('paused');
  expect(
    (
      await preflight(
        input({
          expectedPolicyVersion: pausedVersion,
          sensitivity: 'personal',
        }),
      )
    ).json(),
  ).toMatchObject({
    reason: 'PROVIDER_UNAVAILABLE',
    route: { provider: 'paused' },
  });
});
it('resolves owned current context, checks versions and persists only a provenance/count manifest', async () => {
  const expectedPolicyVersion = await policy();
  const task = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: headers(),
      payload: {
        title: 'Private synthetic title',
        notes: 'Context notes never persist in AI receipts.',
        sensitivity: 'personal',
        operationId: randomUUID(),
      },
    })
  ).json().task;
  const ref = { kind: 'task', id: task.id, expectedVersion: task.version };
  const result = await preflight(
    input({ expectedPolicyVersion, sources: [ref] }),
  );
  expect(result.statusCode).toBe(201);
  expect(result.json()).toMatchObject({
    reason: 'DISPATCH_DISABLED',
    route: { provider: 'private', labels: ['unlabeled', 'personal'] },
    sources: [
      {
        kind: 'task',
        id: task.id,
        version: task.version,
        labels: ['personal'],
      },
    ],
  });
  expect(result.json().sources[0].characters).toBeGreaterThan(0);
  expect(JSON.stringify(result.json())).not.toContain(task.title);
  expect(
    JSON.stringify(await db.query('SELECT metadata FROM ai_preflights')),
  ).not.toContain(task.notes);
  expect(
    (
      await preflight(
        input({ expectedPolicyVersion, sources: [ref] }),
        otherCookie,
      )
    ).statusCode,
  ).toBe(409); // other owner's default policy version differs
  expect(
    (
      await preflight(
        input({ sources: [ref], expectedBudgetVersion: 1 }),
        otherCookie,
      )
    ).statusCode,
  ).toBe(404);
  const stale = await preflight(
    input({
      expectedPolicyVersion,
      sources: [{ ...ref, expectedVersion: 999 }],
    }),
  );
  expect(stale.json().error.code).toBe('VERSION_CONFLICT');
  const ownerLabelOnly = await preflight(
    input({
      expectedPolicyVersion,
      text: 'My password and medical data are words, not an automatic label.',
    }),
  );
  expect(ownerLabelOnly.json().route.labels).toEqual(['unlabeled']);
});
it('blocks file-derived and unknown historical sources before assembling text', async () => {
  const expectedPolicyVersion = await policy();
  await db.query(
    'INSERT INTO canvas_sources(owner_id,enabled) VALUES($1,TRUE)',
    [owner],
  );
  await applyCanvasSnapshot(
    db,
    owner,
    parseCanvasFeed(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic-preflight-file\r\nDTSTAMP:20261010T120000Z\r\nDTSTART:20261101T120000Z\r\nSUMMARY:File title must stay local\r\nEND:VEVENT\r\nEND:VCALENDAR',
    ),
    'calendar-file',
  );
  const [item] = await db.query(
    'SELECT id,version FROM canvas_items WHERE owner_id=$1',
    [owner],
  );
  const blocked = await preflight(
    input({
      expectedPolicyVersion,
      sources: [
        { kind: 'canvas-item', id: item!.id, expectedVersion: item!.version },
      ],
    }),
  );
  expect(blocked.json()).toMatchObject({
    reason: 'ATTACHMENT_DERIVED',
    contextAssembled: false,
    contextCharacters: null,
    sources: [{ attachmentDerived: true, characters: null }],
  });
  const legacy = randomUUID();
  await db.query('INSERT INTO courses(id,owner_id,name) VALUES($1,$2,$3)', [
    legacy,
    owner,
    'Synthetic legacy class',
  ]);
  const topic = randomUUID();
  await db.query(
    'INSERT INTO topics(id,owner_id,course_id,name,academic_labels) VALUES($1,$2,$3,$4,NULL)',
    [topic, owner, legacy, 'Legacy topic'],
  );
  expect(
    (
      await preflight(
        input({
          expectedPolicyVersion,
          sources: [{ kind: 'topic', id: topic, expectedVersion: 1 }],
        }),
      )
    ).json().error.code,
  ).toBe('PROVENANCE_UNAVAILABLE');
});
it('allowlists text fields, omits private source URLs and counts the complete serialized envelope', async () => {
  const [task] = await db.query(
    'SELECT id,version FROM tasks WHERE owner_id=$1',
    [owner],
  );
  const assembled = await db.transaction(async (tx) => {
    const resolved = await resolveAIContext(tx, owner, {
      kind: 'task',
      id: String(task!.id),
      expectedVersion: Number(task!.version),
    });
    return assembleAITextContext(
      tx,
      owner,
      'Synthetic prompt',
      [resolved],
      48000,
    );
  });
  const payload = JSON.parse(assembled!.payload);
  expect(payload.sources[0].content).toEqual({
    title: 'Private synthetic title',
    notes: 'Context notes never persist in AI receipts.',
    dueDate: null,
    priority: 'normal',
    completed: false,
  });
  expect(payload.sources[0].content).not.toHaveProperty('canvasSource');
  expect(payload.sources[0].content).not.toHaveProperty('owner_id');
  const empty = await assembleAITextContext(
    db,
    owner,
    'quote " and newline\n',
    [],
    48000,
  );
  expect(
    await assembleAITextContext(
      db,
      owner,
      'quote " and newline\n',
      [],
      empty!.payload.length,
    ),
  ).not.toBeNull();
  expect(
    await assembleAITextContext(
      db,
      owner,
      'quote " and newline\n',
      [],
      empty!.payload.length - 1,
    ),
  ).toBeNull();
  const [item] = await db.query(
    'SELECT id,version FROM canvas_items WHERE owner_id=$1',
    [owner],
  );
  await db.query(
    "UPDATE canvas_items SET input_kind='calendar-feed',provider_data=jsonb_set(provider_data,'{sourceUrl}',to_jsonb('https://example.test/private-feed-marker'::text)) WHERE id=$1",
    [item!.id],
  );
  const safe = await db.transaction(async (tx) => {
    const resolved = await resolveAIContext(tx, owner, {
      kind: 'canvas-item',
      id: String(item!.id),
      expectedVersion: Number(item!.version),
    });
    return assembleAITextContext(tx, owner, 'Feed context', [resolved], 48000);
  });
  expect(safe!.payload).not.toContain('private-feed-marker');
  expect(safe!.payload).not.toContain('sourceUrl');
});
it('assembles academic, base calendar and API assignment projections with all inherited permissions and no rich payload extras', async () => {
  const create = async (path: string, fields: object) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/${path}`,
      headers: headers(),
      payload: { ...fields, operationId: randomUUID() },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const course = (
    await create('courses', {
      name: 'Synthetic gateway class',
      notes: 'Class context',
      instructor: 'Synthetic instructor',
      term: 'Synthetic term',
      sensitivity: 'personal',
    })
  ).course;
  const topic = (
    await create('topics', {
      courseId: course.id,
      name: 'Synthetic gateway topic',
      notes: 'Topic context',
      progress: 25,
      confidence: 'low',
      sensitivity: 'restricted',
    })
  ).topic;
  const event = (
    await create('calendar', {
      title: 'Synthetic gateway study',
      startsAt: '2027-05-01T17:00:00.000Z',
      endsAt: '2027-05-01T18:00:00.000Z',
      timeZone: 'UTC',
      courseId: course.id,
      topicId: topic.id,
    })
  ).event;
  await db.query(
    'INSERT INTO canvas_lms_sources(owner_id,enabled) VALUES($1,TRUE)',
    [owner],
  );
  await db.transaction((tx) =>
    applyCanvasLmsSnapshot(tx, owner, {
      accountProviderId: '30',
      courses: [
        {
          providerId: '10',
          data: {
            name: 'Synthetic API class',
            code: 'TEST',
            term: 'Synthetic',
            timeZone: 'UTC',
          },
        },
      ],
      assignments: [
        {
          providerId: '20',
          courseProviderId: '10',
          data: {
            title: 'Synthetic gateway assignment',
            dueAt: '2027-05-01T17:00:00.000Z',
            pointsPossible: 10,
            locked: false,
            published: true,
          },
        },
      ],
    }),
  );
  const [assignment] = await db.query(
    'SELECT id,version FROM canvas_lms_assignments WHERE owner_id=$1',
    [owner],
  );
  await db.query(
    'UPDATE canvas_lms_assignments SET provider_data=provider_data || \'{"attachment_text":"rich content must not be projected","secret_extra":"hidden payload marker"}\'::jsonb WHERE id=$1',
    [assignment!.id],
  );
  const refs = [
    { kind: 'course' as const, id: course.id, expectedVersion: course.version },
    { kind: 'topic' as const, id: topic.id, expectedVersion: topic.version },
    { kind: 'event' as const, id: event.id, expectedVersion: event.version },
    {
      kind: 'canvas-assignment' as const,
      id: String(assignment!.id),
      expectedVersion: Number(assignment!.version),
    },
  ];
  const assembled = await db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const sources = [];
    for (const ref of refs)
      sources.push(await resolveAIContext(tx, owner, ref));
    expect(sources[1]!.labels).toEqual(['personal', 'restricted']);
    expect(sources[2]!.labels).toEqual(['personal', 'restricted']);
    return assembleAITextContext(
      tx,
      owner,
      'Synthetic multi-source request',
      sources,
      48000,
    );
  });
  const content = JSON.parse(assembled!.payload).sources;
  expect(content[0].content).toMatchObject({
    name: course.name,
    instructor: 'Synthetic instructor',
    notes: 'Class context',
  });
  expect(content[1].content).toMatchObject({
    progress: 25,
    confidence: 'low',
    notes: 'Topic context',
  });
  expect(content[2].content).toMatchObject({
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timeZone: 'UTC',
    studyStatus: 'planned',
  });
  expect(content[3].content).toMatchObject({
    title: 'Synthetic gateway assignment',
    pointsPossible: 10,
  });
  expect(assembled!.payload).not.toContain(
    'rich content must not be projected',
  );
  expect(assembled!.payload).not.toContain('hidden payload marker');
  const current = (
    await app.inject({ url: '/api/v1/ai/routing', headers: headers() })
  ).json();
  const rule = { allowed: ['routine'], preferred: 'routine' };
  const update = await app.inject({
    method: 'PUT',
    url: '/api/v1/ai/routing',
    headers: headers(),
    payload: {
      expectedVersion: current.version,
      operationId: randomUUID(),
      policy: { unlabeled: rule, personal: rule, restricted: rule },
    },
  });
  const response = await preflight(
    input({ expectedPolicyVersion: update.json().version, sources: refs }),
  );
  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({
    reason: 'DISPATCH_DISABLED',
    contextAssembled: true,
    route: {
      provider: 'routine',
      labels: ['unlabeled', 'personal', 'restricted'],
    },
  });
  expect(
    response
      .json()
      .sources.map((source: { characters: number }) => source.characters),
  ).toEqual(assembled!.counts);
  expect(JSON.stringify(response.json())).not.toContain(course.name);
});
it('rejects a changed or deleted context rather than assembling a stale source projection', async () => {
  const [task] = await db.query(
    'SELECT id,version FROM tasks WHERE owner_id=$1',
    [owner],
  );
  const source = await resolveAIContext(db, owner, {
    kind: 'task',
    id: String(task!.id),
    expectedVersion: Number(task!.version),
  });
  await db.query(
    'UPDATE tasks SET version=version+1,deleted_at=CURRENT_TIMESTAMP WHERE id=$1',
    [task!.id],
  );
  await expect(
    assembleAITextContext(db, owner, 'Synthetic stale source', [source], 48000),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  await expect(
    resolveAIContext(db, owner, {
      kind: 'task',
      id: source.id,
      expectedVersion: source.version + 1,
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('pages deterministic owner history, protects IDs and preserves delete tombstones/retry receipts in export', async () => {
  // pg converts timestamptz to JS Date at millisecond precision. Cursor comparison
  // must retain SQL microseconds, including when many records share one timestamp.
  await db.query(
    "UPDATE ai_preflights SET created_at='2026-10-10T21:00:00.123456Z' WHERE owner_id=$1",
    [owner],
  );
  const page = aiPreflightsResponseSchema.parse(
    (
      await app.inject({
        url: '/api/v1/ai/preflights?limit=2',
        headers: headers(),
      })
    ).json(),
  );
  expect(page.preflights).toHaveLength(2);
  expect(page.nextBefore).not.toBeNull();
  const next = aiPreflightsResponseSchema.parse(
    (
      await app.inject({
        url: `/api/v1/ai/preflights?limit=2&before=${page.nextBefore}`,
        headers: headers(),
      })
    ).json(),
  );
  expect(
    next.preflights.some((row) =>
      page.preflights.some((first) => first.id === row.id),
    ),
  ).toBe(false);
  const target = page.preflights[0]!;
  expect(
    (
      await app.inject({
        url: `/api/v1/ai/preflights/${target.id}`,
        headers: headers(otherCookie),
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        url: `/api/v1/ai/preflights?before=${target.id}`,
        headers: headers(otherCookie),
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        url: '/api/v1/ai/preflights?limit=51',
        headers: headers(),
      })
    ).statusCode,
  ).toBe(400);
  const body = { operationId: randomUUID(), expectedVersion: target.version };
  const remove = (payload = body, session = cookie) =>
    app.inject({
      method: 'DELETE',
      url: `/api/v1/ai/preflights/${target.id}`,
      headers: headers(session),
      payload,
    });
  expect((await remove(body, otherCookie)).statusCode).toBe(404);
  expect(
    (await remove({ ...body, operationId: randomUUID(), expectedVersion: 999 }))
      .statusCode,
  ).toBe(409);
  const deleted = await remove();
  expect(deleted.statusCode).toBe(200);
  expect(deleted.json()).toMatchObject({
    version: 2,
    deletedAt: expect.any(String),
  });
  expect((await remove()).json()).toEqual(deleted.json());
  expect(
    (
      await app.inject({
        url: `/api/v1/ai/preflights/${target.id}`,
        headers: headers(),
      })
    ).statusCode,
  ).toBe(404);
  const exported = plannerExportSchema.parse(
    (
      await app.inject({ url: '/api/v1/planner/export', headers: headers() })
    ).json(),
  );
  expect(
    exported.records.aiPreflights.find((row) => row.id === target.id)
      ?.deletedAt,
  ).not.toBeNull();
  expect(JSON.stringify(exported.records.aiPreflights)).not.toContain(
    'synthetic-secret',
  );
  expect(
    (
      await app.inject({
        url: '/api/v1/ai/preflights',
        headers: headers(otherCookie),
      })
    ).json().preflights,
  ).toEqual([]);
});
it('retries only rolled-back snapshot transactions and reports retryable exhaustion', async () => {
  const transaction = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error('synthetic serialization'), { code: '40001' }),
    )
    .mockResolvedValueOnce('receipt');
  const fake = { transaction } as unknown as Database;
  expect(
    await mutate(fake, owner, randomUUID(), {}, async () => 'unused', {
      isolation: 'repeatable read',
    }),
  ).toBe('receipt');
  expect(transaction).toHaveBeenCalledTimes(2);
  transaction
    .mockReset()
    .mockRejectedValue(
      Object.assign(new Error('synthetic serialization'), { code: '40001' }),
    );
  await expect(
    mutate(fake, owner, randomUUID(), {}, async () => 'unused', {
      isolation: 'repeatable read',
    }),
  ).rejects.toMatchObject({ statusCode: 409, code: 'RETRY_REQUIRED' });
  expect(transaction).toHaveBeenCalledTimes(4);
  transaction
    .mockReset()
    .mockRejectedValue(
      Object.assign(new Error('synthetic input'), { code: '23514' }),
    );
  await expect(
    mutate(fake, owner, randomUUID(), {}, async () => 'unused', {
      isolation: 'repeatable read',
    }),
  ).rejects.toMatchObject({ code: '23514' });
  expect(transaction).toHaveBeenCalledTimes(1);
});
