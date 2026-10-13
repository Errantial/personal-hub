import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import {
  aiContextRefSchema,
  aiContextManifestSchema,
  plannerExportSchema,
  aiContextPreviewResponseSchema,
} from '@hub/contracts';
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
import { buildOpenRouterTextRequest } from '../src/ai/openrouter-request.js';
import { publicAIRegistry } from '../src/ai/profiles.js';
import { resolveAIContext } from '../src/features/ai-routing.js';

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
beforeEach(() => vi.stubGlobal('fetch', network));
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
const previewBody = (sources: unknown[] = []) => {
  const { operationId, ...input } = body(sources);
  void operationId;
  return input;
};
const preview = (input: object, session = cookie) =>
  write('POST', '/api/v1/ai/context/preview', input, session);
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
async function academic(sensitivity = 'unlabeled') {
  const created = await write('POST', '/api/v1/courses', {
    operationId: randomUUID(),
    name: 'Private synthetic class',
    notes: 'Excluded class notes',
    sensitivity,
  });
  expect(created.statusCode).toBe(200);
  const course = created.json().course;
  const response = await write('POST', '/api/v1/academic-work', {
    operationId: randomUUID(),
    courseId: course.id,
    title: 'Private manual exam',
    notes: 'Private manual planning notes',
    kind: 'exam',
    status: 'submitted',
    grade: { earned: 731, possible: 997 },
    dueDate: '2030-04-04',
    estimatedMinutes: 45,
    priority: 4,
    sensitivity: 'unlabeled',
  });
  expect(response.statusCode).toBe(200);
  return { course, work: response.json().work };
}
const academicRef = (value: Awaited<ReturnType<typeof academic>>) => ({
  kind: 'academic-work',
  id: value.work.id,
  expectedVersion: value.work.version,
  expectedCourseVersion: value.course.version,
});
async function academicPlanner() {
  const value = await academic('personal');
  const opened = await write('PUT', `/api/v1/academic-work/${value.work.id}`, {
    ...change(1),
    courseId: value.course.id,
    title: value.work.title,
    notes: value.work.notes,
    status: 'planned',
    grade: null,
  });
  expect(opened.statusCode).toBe(200);
  value.work = opened.json().work;
  const taskResponse = await write(
    'POST',
    `/api/v1/academic-work/${value.work.id}/planner-work`,
    {
      operationId: randomUUID(),
      kind: 'task',
      expectedWorkVersion: 2,
      expectedCourseVersion: 1,
      task: { title: 'Manual linked task', notes: 'Linked task notes' },
    },
  );
  expect(taskResponse.statusCode).toBe(200);
  const eventResponse = await write(
    'POST',
    `/api/v1/academic-work/${value.work.id}/planner-work`,
    {
      operationId: randomUUID(),
      kind: 'study',
      expectedWorkVersion: 2,
      expectedCourseVersion: 1,
      event: {
        title: 'Manual linked study',
        notes: 'Linked study notes',
        startsAt: '2030-04-04T09:00:00Z',
        endsAt: '2030-04-04T09:25:00Z',
        timeZone: 'UTC',
        courseId: value.course.id,
      },
    },
  );
  expect(eventResponse.statusCode).toBe(200);
  return {
    ...value,
    task: taskResponse.json().task,
    event: eventResponse.json().event,
  };
}
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

it('requires class versions only for academic refs and binds parent identity in academic manifests', async () => {
  const value = await academic();
  const selected = academicRef(value);
  expect(aiContextRefSchema.safeParse(selected).success).toBe(true);
  expect(
    aiContextRefSchema.safeParse({
      ...selected,
      expectedCourseVersion: undefined,
    }).success,
  ).toBe(false);
  expect(
    aiContextRefSchema.safeParse({
      ...ref(value.work),
      expectedCourseVersion: 1,
    }).success,
  ).toBe(false);
  expect(
    aiContextRefSchema.safeParse({
      ...selected,
      expectedMemorySettingsVersion: 1,
    }).success,
  ).toBe(false);
  const saved = await request([selected]);
  const manifest = saved.assessment.contextManifest;
  expect(manifest.sources[0].academicCourse).toEqual({
    id: value.course.id,
    version: 1,
  });
  expect(
    aiContextManifestSchema.safeParse({
      ...manifest,
      sources: [{ ...manifest.sources[0], academicCourse: undefined }],
    }).success,
  ).toBe(false);
  expect(
    (
      await write(
        'POST',
        '/api/v1/ai/requests',
        body([selected, { ...selected, id: selected.id.toUpperCase() }]),
      )
    ).statusCode,
  ).toBe(400);
  const prepared = buildOpenRouterTextRequest(
    {
      ...publicAIRegistry(config.AI_PROVIDER_PROFILES).profiles[0]!,
      adapter: 'openrouter',
      upstreamProvider: 'synthetic-upstream',
    },
    'synthetic',
  );
  expect(
    prepared.body.response_format.json_schema.schema.properties.suggestions
      .items.properties.source.properties.kind.enum,
  ).toContain('academic-work');
});

it('assembles manual planning fields without grades, class text or public text retention', async () => {
  const value = await academic('personal');
  const saved = await request([academicRef(value)]);
  expect(saved.assessment.route.labels).toEqual(['unlabeled', 'personal']);
  expect(JSON.stringify(saved)).not.toContain(value.work.notes);
  const claim = await beginSyntheticAttempt(
    db,
    config,
    owner,
    saved.id,
    1,
    text,
  );
  expect(claim.claimed).toBe(true);
  if (!claim.claimed) throw Error('Expected synthetic claim');
  const fragment = JSON.parse(claim.payload).sources[0];
  expect(fragment.content).toEqual({
    title: value.work.title,
    kind: 'exam',
    notes: value.work.notes,
    dueDate: '2030-04-04',
    estimatedMinutes: 45,
    priority: 4,
    status: 'submitted',
  });
  expect(claim.payload).not.toContain('grade');
  expect(claim.payload).not.toContain('731');
  expect(claim.payload).not.toContain('Excluded class notes');
  expect(claim.contextManifest.sources[0]!.characters).toBe(
    JSON.stringify(fragment.content).length,
  );
  expect(
    JSON.stringify(
      (await get('/api/v1/planner/export')).json().records.aiRequests,
    ),
  ).not.toContain(value.work.notes);
});

it('inherits historical work and current class labels without inferred sensitivity', async () => {
  const value = await academic('personal');
  const response = await write('PUT', `/api/v1/courses/${value.course.id}`, {
    ...change(1),
    name: value.course.name,
    sensitivity: 'restricted',
  });
  expect(response.statusCode).toBe(200);
  value.course = response.json().course;
  value.work = (
    await get(`/api/v1/academic-work/${value.work.id}`)
  ).json().work;
  const saved = await request([academicRef(value)]);
  expect(saved.assessment.route.labels).toEqual([
    'unlabeled',
    'personal',
    'restricted',
  ]);
  const relabeled = await write('PUT', `/api/v1/courses/${value.course.id}`, {
    ...change(value.course.version),
    name: value.course.name,
    sensitivity: 'unlabeled',
  });
  expect(relabeled.statusCode).toBe(200);
  value.course = relabeled.json().course;
  value.work = (
    await get(`/api/v1/academic-work/${value.work.id}`)
  ).json().work;
  expect((await request([academicRef(value)])).assessment.route.labels).toEqual(
    ['unlabeled', 'personal', 'restricted'],
  );
});

it('blocks stale work or class versions and unavailable academic ancestors before admission or holds', async () => {
  for (const mutation of [
    'work',
    'course',
    'delete-work',
    'archive-course',
  ] as const) {
    const value = await academic();
    const saved = await request([academicRef(value)]);
    if (mutation === 'work')
      await db.query('UPDATE academic_work SET version=version+1 WHERE id=$1', [
        value.work.id,
      ]);
    else if (mutation === 'course')
      await db.query('UPDATE courses SET version=version+1 WHERE id=$1', [
        value.course.id,
      ]);
    else if (mutation === 'delete-work')
      expect(
        (
          await write(
            'DELETE',
            `/api/v1/academic-work/${value.work.id}`,
            change(1),
          )
        ).statusCode,
      ).toBe(200);
    else
      expect(
        (await write('DELETE', `/api/v1/courses/${value.course.id}`, change(1)))
          .statusCode,
      ).toBe(200);
    await expect(
      beginSyntheticAttempt(db, config, owner, saved.id, 1, text),
    ).rejects.toMatchObject({
      code: mutation.includes('-') ? 'NOT_FOUND' : 'VERSION_CONFLICT',
    });
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
  }
});

it('requires owner authorization and rejects foreign academic sources without disclosure', async () => {
  const value = await academic();
  const payload = {
    expectedPolicyVersion: 1,
    text,
    sensitivity: 'unlabeled',
    sources: [academicRef(value)],
    simulatedAvailableProviders: ['test'],
  };
  const foreign = await write(
    'POST',
    '/api/v1/ai/routing/preview',
    payload,
    otherCookie,
  );
  expect(foreign.statusCode).toBe(404);
  expect(foreign.body).not.toContain(value.work.title);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/ai/routing/preview',
        headers: { origin },
        payload,
      })
    ).statusCode,
  ).toBe(401);
});

it('detects academic text damage without a version advance while excluding recorded grade data from binding', async () => {
  const value = await academic();
  const saved = await request([academicRef(value)]);
  await db.query('UPDATE academic_work SET notes=$2 WHERE id=$1', [
    value.work.id,
    'Changed private planning notes',
  ]);
  await expect(
    beginSyntheticAttempt(db, config, owner, saved.id, 1, text),
  ).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
  await db.query(
    'UPDATE academic_work SET notes=$2,grade=$3::jsonb WHERE id=$1',
    [
      value.work.id,
      value.work.notes,
      JSON.stringify({ earned: 3, possible: 5 }),
    ],
  );
  expect(
    (await beginSyntheticAttempt(db, config, owner, saved.id, 1, text)).claimed,
  ).toBe(true);
});

it('preserves uncertainty and blocks the callback when academic parent state changes after committed admission', async () => {
  const value = await academic();
  const saved = await request([academicRef(value)]);
  const proxy: Database = {
    ...db,
    async transaction(work) {
      const result = await db.transaction(work);
      if (
        result &&
        typeof result === 'object' &&
        'claimed' in result &&
        result.claimed === true
      )
        await db.query('UPDATE courses SET version=version+1 WHERE id=$1', [
          value.course.id,
        ]);
      return result;
    },
  };
  const execute = vi.fn(async () => ({
    usage: { outcome: 'completed', inputTokens: 1, outputTokens: 0 },
    output: { answer: 'Never delivered', suggestions: [] },
  }));
  const result = await executeSyntheticTextRequest(
    proxy,
    config,
    owner,
    saved.id,
    1,
    text,
    { kind: 'synthetic-text', execute },
  );
  expect(execute).not.toHaveBeenCalled();
  expect(result.request.status).toBe('uncertain');
  expect(result.result).toBeNull();
  const [hold] = await db.query(
    'SELECT status FROM ai_budget_reservations WHERE request_id=$1',
    [saved.id],
  );
  expect(hold!.status).toBe('uncertain');
});

it('retains academic guidance only with per-request consent and keeps request history metadata-only', async () => {
  const value = await academic('personal');
  const output = {
    answer: 'Synthetic academic guidance',
    suggestions: [
      {
        source: { kind: 'academic-work', id: value.work.id, version: 1 },
        note: 'Review this manual plan.',
      },
    ],
  };
  for (const saveAnswer of [false, true]) {
    const response = await write('POST', '/api/v1/ai/requests', {
      ...body([academicRef(value)]),
      saveAnswer,
    });
    expect(response.statusCode).toBe(201);
    const saved = response.json();
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
    expect(result.result!.retained).toBe(saveAnswer);
    expect(result.result!.labels).toEqual(['unlabeled', 'personal']);
    const answer = await get(`/api/v1/ai/requests/${saved.id}/answer`);
    expect(answer.statusCode).toBe(saveAnswer ? 200 : 404);
    expect(
      JSON.stringify((await get(`/api/v1/ai/requests/${saved.id}`)).json()),
    ).not.toContain(output.answer);
    if (saveAnswer) {
      expect(
        answer.json().answer.contextManifest.sources[0].academicCourse,
      ).toEqual({ id: value.course.id, version: 1 });
      expect(
        (
          await write(
            'DELETE',
            `/api/v1/ai/requests/${saved.id}/answer`,
            change(1),
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await get(`/api/v1/ai/requests/${saved.id}/answer`)).json().answer
          .output,
      ).toBeNull();
    }
  }
});

it('binds direct manual task and study origins while projecting only their own planning text', async () => {
  const value = await academicPlanner();
  for (const [kind, item] of [
    ['task', value.task],
    ['event', value.event],
  ] as const) {
    const selected = { kind, id: item.id, expectedVersion: 1 };
    const saved = await request([selected]);
    expect(
      saved.assessment.contextManifest.sources[0].academicPlanning,
    ).toMatchObject({
      workId: value.work.id,
      courseId: value.course.id,
      capturedWorkVersion: 2,
      currentWorkVersion: 2,
      capturedCourseVersion: 1,
      currentCourseVersion: 1,
      provenance: 'owner-entered-planning-fields',
    });
    const claim = await beginSyntheticAttempt(
      db,
      config,
      owner,
      saved.id,
      1,
      text,
    );
    if (!claim.claimed) throw Error('Expected claim');
    expect(JSON.parse(claim.payload).sources[0].content.notes).toBe(item.notes);
    expect(claim.payload).not.toContain(value.work.notes);
    expect(claim.payload).not.toContain('Excluded class notes');
  }
});

it('invalidates a bound planner request when source or parent versions change without planner edits', async () => {
  for (const target of ['work', 'course']) {
    const value = await academicPlanner();
    const saved = await request([
      { kind: 'task', id: value.task.id, expectedVersion: 1 },
    ]);
    await db.query(
      `UPDATE ${target === 'work' ? 'academic_work' : 'courses'} SET version=version+1 WHERE id=$1`,
      [target === 'work' ? value.work.id : value.course.id],
    );
    expect(
      (await get(`/api/v1/tasks/${value.task.id}`)).json().task.version,
    ).toBe(1);
    await expect(
      beginSyntheticAttempt(db, config, owner, saved.id, 1, text),
    ).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
    expect(
      await db.query(
        'SELECT id FROM ai_budget_reservations WHERE request_id=$1',
        [saved.id],
      ),
    ).toEqual([]);
  }
});

it('blocks direct planner context when its manual source is deleted or its original class archived', async () => {
  for (const target of ['work', 'course']) {
    const value = await academicPlanner();
    const selected = { kind: 'task', id: value.task.id, expectedVersion: 1 };
    expect(
      (
        await write(
          'DELETE',
          `/api/v1/${target === 'work' ? 'academic-work' : 'courses'}/${target === 'work' ? value.work.id : value.course.id}`,
          change(target === 'work' ? 2 : 1),
        )
      ).statusCode,
    ).toBe(200);
    const latest = (await get(`/api/v1/tasks/${value.task.id}`)).json().task;
    expect(
      (
        await write(
          'POST',
          '/api/v1/ai/requests',
          body([{ ...selected, expectedVersion: latest.version }]),
        )
      ).statusCode,
    ).toBe(404);
  }
});

it('preserves linked labels and origin binding after a study block detaches from its class', async () => {
  const value = await academicPlanner();
  const updated = await write('PUT', `/api/v1/calendar/${value.event.id}`, {
    ...change(1),
    title: value.event.title,
    notes: value.event.notes,
    startsAt: value.event.startsAt,
    endsAt: value.event.endsAt,
    timeZone: 'UTC',
    courseId: null,
    topicId: null,
    sensitivity: 'unlabeled',
  });
  expect(updated.statusCode).toBe(200);
  const event = updated.json().event;
  const saved = await request([
    { kind: 'event', id: event.id, expectedVersion: event.version },
  ]);
  expect(saved.assessment.contextManifest.sources[0]).toMatchObject({
    labels: ['personal'],
    academicPlanning: { workId: value.work.id, courseId: value.course.id },
  });
});

it('fails closed for legacy incomplete study history and mismatched captured academic origins', async () => {
  const value = await academicPlanner();
  await db.query('UPDATE events SET academic_labels=NULL WHERE id=$1', [
    value.event.id,
  ]);
  const old = await write(
    'POST',
    '/api/v1/ai/requests',
    body([{ kind: 'event', id: value.event.id, expectedVersion: 1 }]),
  );
  expect(old.statusCode).toBe(409);
  expect(old.json().error.code).toBe('PROVENANCE_UNAVAILABLE');
  const damaged = {
    async query(sql: string, params?: unknown[]) {
      const rows = await db.query(sql, params);
      if (sql.includes('SELECT s.snapshot'))
        return rows.map((row) => ({
          ...row,
          snapshot: { ...(row.snapshot as object), courseId: randomUUID() },
        }));
      return rows;
    },
  };
  await expect(
    resolveAIContext(damaged as typeof db, owner, {
      kind: 'task',
      id: value.task.id,
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ code: 'PROVENANCE_UNAVAILABLE' });
});

it('omits new academic metadata from ordinary manifests to preserve preexisting integrity bindings', async () => {
  const value = await task();
  const saved = await request([ref(value)]);
  expect(saved.assessment.contextManifest.sources[0]).not.toHaveProperty(
    'academicCourse',
  );
  expect(saved.assessment.contextManifest.sources[0]).not.toHaveProperty(
    'academicPlanning',
  );
  expect(
    aiContextManifestSchema.parse(saved.assessment.contextManifest),
  ).toEqual(saved.assessment.contextManifest);
  expect(
    (await beginSyntheticAttempt(db, config, owner, saved.id, 1, text)).claimed,
  ).toBe(true);
});

it('enforces immutable academic captures and monotonic labels in SQL', async () => {
  const value = await academicPlanner();
  const [before] = await db.query(
    'SELECT * FROM academic_planner_sources WHERE task_id=$1',
    [value.task.id],
  );
  for (const assignment of [
    "snapshot=jsonb_set(snapshot,'{version}','99'::jsonb)",
    "created_at=created_at+interval '1 second'",
    'id=gen_random_uuid()',
    'task_id=NULL',
    'labels=ARRAY[]::text[]',
  ])
    await expect(
      db.query(
        `UPDATE academic_planner_sources SET ${assignment} WHERE id=$1`,
        [before!.id],
      ),
    ).rejects.toThrow();
  await expect(
    db.query('DELETE FROM academic_planner_sources WHERE id=$1', [before!.id]),
  ).rejects.toThrow('cannot be removed');
  await db.query(
    "UPDATE academic_planner_sources SET labels=ARRAY['personal','restricted']::text[] WHERE id=$1",
    [before!.id],
  );
  const [after] = await db.query(
    'SELECT * FROM academic_planner_sources WHERE id=$1',
    [before!.id],
  );
  expect(after).toEqual({ ...before, labels: ['personal', 'restricted'] });
});

it('upgrades populated academic origins without changing captures, labels or mutation receipts', async () => {
  await academicPlanner();
  const before = await db.query(
    'SELECT * FROM academic_planner_sources ORDER BY id',
  );
  const receipts = await db.query(
    'SELECT operation_id,payload_hash,result FROM mutation_receipts ORDER BY operation_id',
  );
  await db.exec(
    'DROP TRIGGER academic_origin_guard ON academic_planner_sources',
  );
  await db.query(
    "DELETE FROM schema_migrations WHERE name='045_academic_origin_guard.sql'",
  );
  await migrate(db);
  expect(
    await db.query('SELECT * FROM academic_planner_sources ORDER BY id'),
  ).toEqual(before);
  expect(
    await db.query(
      'SELECT operation_id,payload_hash,result FROM mutation_receipts ORDER BY operation_id',
    ),
  ).toEqual(receipts);
  await expect(
    db.query('DELETE FROM academic_planner_sources WHERE id=$1', [
      before[0]!.id,
    ]),
  ).rejects.toThrow('cannot be removed');
});

it('blocks unavailable approved academic destinations without assembling text or falling back', async () => {
  const value = await academic('restricted');
  const [previous] = await db.query(
    'SELECT policy FROM ai_routing_policies WHERE owner_id=$1',
    [owner],
  );
  const allowed = { allowed: ['test'], preferred: 'test' };
  await db.query(
    'UPDATE ai_routing_policies SET policy=$2::jsonb WHERE owner_id=$1',
    [
      owner,
      JSON.stringify({
        unlabeled: allowed,
        personal: allowed,
        restricted: { allowed: [], preferred: null },
      }),
    ],
  );
  try {
    const saved = await request([academicRef(value)]);
    expect(saved.assessment.route.status).toBe('blocked');
    expect(saved.assessment.route.provider).toBeNull();
    expect(saved.assessment.contextAssembled).toBe(false);
    expect(saved.assessment.contextManifest).toBeNull();
    expect(JSON.stringify(saved)).not.toContain(value.work.notes);
    await expect(
      beginSyntheticAttempt(db, config, owner, saved.id, 1, text),
    ).rejects.toMatchObject({ code: 'CONTEXT_BINDING_REQUIRED' });
  } finally {
    await db.query(
      'UPDATE ai_routing_policies SET policy=$2::jsonb WHERE owner_id=$1',
      [owner, JSON.stringify(previous!.policy)],
    );
  }
});

it('rejects an oversized academic envelope without partial text assembly or a budget hold', async () => {
  const refs = [];
  for (let index = 0; index < 5; index++) {
    const value = await academic();
    await db.query('UPDATE academic_work SET notes=$2 WHERE id=$1', [
      value.work.id,
      'x'.repeat(10000),
    ]);
    refs.push(academicRef(value));
  }
  const saved = await request(refs);
  expect(saved.assessment.reason).toBe('INPUT_LIMIT');
  expect(saved.assessment.contextAssembled).toBe(false);
  expect(saved.assessment.contextManifest).toBeNull();
  expect(
    saved.assessment.sources.every(
      (source: { characters: number | null }) => source.characters === null,
    ),
  ).toBe(true);
  expect(
    await db.query(
      'SELECT id FROM ai_budget_reservations WHERE request_id=$1',
      [saved.id],
    ),
  ).toEqual([]);
});

it('returns a no-store owner context review without creating durable records or receipts', async () => {
  const value = await academic('personal');
  const unique = `Transient review ${randomUUID()}`;
  const before = await db.query(
    'SELECT (SELECT count(*) FROM ai_preflights) AS preflights,(SELECT count(*) FROM ai_requests) AS requests,(SELECT count(*) FROM ai_attempts) AS attempts,(SELECT count(*) FROM mutation_receipts) AS receipts,(SELECT count(*) FROM ai_budget_reservations) AS holds',
  );
  const response = await preview({
    ...previewBody([academicRef(value)]),
    text: unique,
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  const review = aiContextPreviewResponseSchema.parse(response.json());
  expect(review).toMatchObject({
    preview: true,
    retained: false,
    dispatchEnabled: false,
  });
  expect(JSON.parse(review.payload!).request).toBe(unique);
  expect(JSON.parse(review.payload!).sources[0].content.notes).toBe(
    value.work.notes,
  );
  expect(review.assessment.contextManifest!.sources[0]!.academicCourse).toEqual(
    { id: value.course.id, version: 1 },
  );
  expect(review.payload!.length).toBe(
    review.assessment.contextManifest!.payloadCharacters,
  );
  expect(review).not.toHaveProperty('contextHash');
  expect(
    await db.query(
      'SELECT (SELECT count(*) FROM ai_preflights) AS preflights,(SELECT count(*) FROM ai_requests) AS requests,(SELECT count(*) FROM ai_attempts) AS attempts,(SELECT count(*) FROM mutation_receipts) AS receipts,(SELECT count(*) FROM ai_budget_reservations) AS holds',
    ),
  ).toEqual(before);
  expect(
    JSON.stringify(await db.query('SELECT metadata FROM ai_preflights')),
  ).not.toContain(unique);
});

it('discloses no payload for denied routes and preserves provider blockers on selected previews', async () => {
  const value = await academic('restricted');
  const selected = await preview(previewBody([academicRef(value)]));
  expect(selected.statusCode).toBe(200);
  expect(selected.json().assessment.executionReadiness.blockers).toContain(
    'PROVIDER_VERIFICATION_REQUIRED',
  );
  expect(selected.json().dispatchEnabled).toBe(false);
  const [previous] = await db.query(
    'SELECT policy FROM ai_routing_policies WHERE owner_id=$1',
    [owner],
  );
  const allowed = { allowed: ['test'], preferred: 'test' };
  await db.query(
    'UPDATE ai_routing_policies SET policy=$2::jsonb WHERE owner_id=$1',
    [
      owner,
      JSON.stringify({
        unlabeled: allowed,
        personal: allowed,
        restricted: { allowed: [], preferred: null },
      }),
    ],
  );
  try {
    const denied = await preview(previewBody([academicRef(value)]));
    expect(denied.statusCode).toBe(200);
    expect(denied.json().payload).toBeNull();
    expect(denied.json().assessment.contextAssembled).toBe(false);
    expect(denied.body).not.toContain(value.work.notes);
  } finally {
    await db.query(
      'UPDATE ai_routing_policies SET policy=$2::jsonb WHERE owner_id=$1',
      [owner, JSON.stringify(previous!.policy)],
    );
  }
});

it('rejects stale sources, classes, settings and registry versions on context review', async () => {
  const value = await academic();
  const input = previewBody([academicRef(value)]);
  for (const invalid of [
    { ...input, expectedPolicyVersion: 1 },
    { ...input, expectedBudgetVersion: 1 },
    { ...input, expectedRegistryRevision: 'a'.repeat(64) },
    { ...input, sources: [{ ...academicRef(value), expectedVersion: 2 }] },
    {
      ...input,
      sources: [{ ...academicRef(value), expectedCourseVersion: 2 }],
    },
  ]) {
    const response = await preview(invalid);
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain(value.work.notes);
  }
});

it('requires authorization and allowed origin for transient private context', async () => {
  const value = await academic();
  const payload = previewBody([academicRef(value)]);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/ai/context/preview',
        headers: { origin },
        payload,
      })
    ).statusCode,
  ).toBe(401);
  const foreign = await preview(
    { ...payload, expectedPolicyVersion: 1, expectedBudgetVersion: 1 },
    otherCookie,
  );
  expect(foreign.statusCode).toBe(404);
  expect(foreign.body).not.toContain(value.work.title);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/ai/context/preview',
        headers: { origin: 'https://example.test', cookie },
        payload,
      })
    ).statusCode,
  ).toBe(403);
});

it('blocks disabled memory and file-derived context instead of returning preview text', async () => {
  const value = await memory();
  const disabled = await preview(
    previewBody([
      {
        kind: 'memory',
        id: value.id,
        expectedVersion: 1,
        expectedMemorySettingsVersion: 1,
      },
    ]),
  );
  expect(disabled.statusCode).toBe(409);
  expect(disabled.json().error.code).toBe('MEMORY_DISABLED');
  const imported = await write('POST', '/api/v1/connections/canvas/import', {
    operationId: randomUUID(),
    feed: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:preview-file\r\nDTSTART:20300404T170000Z\r\nDTEND:20300404T173000Z\r\nSUMMARY:Private attachment-derived text\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
  });
  expect(imported.statusCode).toBe(200);
  const source = (await get('/api/v1/connections/canvas')).json().items[0];
  const file = await preview(
    previewBody([
      { kind: 'canvas-item', id: source.id, expectedVersion: source.version },
    ]),
  );
  expect(file.statusCode).toBe(200);
  expect(file.json().assessment.reason).toBe('ATTACHMENT_DERIVED');
  expect(file.json().payload).toBeNull();
  expect(file.body).not.toContain('Private attachment-derived text');
});

it('requires fresh submission after review and never accepts uploaded context or retention authority', async () => {
  const value = await academic();
  const input = previewBody([academicRef(value)]);
  expect((await preview(input)).statusCode).toBe(200);
  await db.query('UPDATE academic_work SET version=version+1 WHERE id=$1', [
    value.work.id,
  ]);
  expect(
    (
      await write('POST', '/api/v1/ai/requests', {
        ...input,
        operationId: randomUUID(),
      })
    ).statusCode,
  ).toBe(409);
  for (const extra of [
    { payload: 'private-upload' },
    { contextManifest: {} },
    { attachments: [] },
    { saveAnswer: true },
    { operationId: randomUUID() },
    { dispatchEnabled: true },
  ])
    expect((await preview({ ...input, ...extra })).statusCode).toBe(400);
});

it('rechecks session authorization inside the preview snapshot before releasing private text', async () => {
  const value = await academic();
  const hash = createHash('sha256').update(cookie.split('=')[1]!).digest('hex');
  const [session] = await db.query(
    'SELECT expires_at FROM sessions WHERE token_hash=$1',
    [hash],
  );
  let armed = false;
  const proxy: Database = {
    ...db,
    close: async () => {},
    async transaction(work) {
      if (armed) {
        armed = false;
        await db.query(
          "UPDATE sessions SET expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE token_hash=$1",
          [hash],
        );
      }
      return db.transaction(work);
    },
  };
  const instance = await buildApp(
    { logger: false },
    { config, database: proxy },
  );
  try {
    armed = true;
    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/ai/context/preview',
      headers: headers(),
      payload: previewBody([academicRef(value)]),
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(value.work.notes);
  } finally {
    await db.query('UPDATE sessions SET expires_at=$2 WHERE token_hash=$1', [
      hash,
      session!.expires_at,
    ]);
    await instance.close();
  }
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
    const courseResponse = await instance.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: auth,
      payload: { operationId: randomUUID(), name: 'Persisted context class' },
    });
    expect(courseResponse.statusCode).toBe(200);
    const course = courseResponse.json().course;
    const workResponse = await instance.inject({
      method: 'POST',
      url: '/api/v1/academic-work',
      headers: auth,
      payload: {
        operationId: randomUUID(),
        courseId: course.id,
        title: 'Persisted manual context',
        notes: 'Private persisted planning notes',
      },
    });
    expect(workResponse.statusCode).toBe(200);
    const work = workResponse.json().work;
    const sources = [
      {
        kind: 'academic-work',
        id: work.id,
        expectedVersion: 1,
        expectedCourseVersion: 1,
      },
    ];
    const response = await instance.inject({
      method: 'POST',
      url: '/api/v1/ai/requests',
      headers: auth,
      payload: body(sources),
    });
    expect(response.statusCode).toBe(201);
    const saved = response.json();
    const output = {
      answer: 'Ephemeral persisted-test result',
      suggestions: [
        {
          source: { kind: 'academic-work', id: work.id, version: 1 },
          note: 'Persisted source-linked guidance',
        },
      ],
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
      payload: { ...body(sources), saveAnswer: true },
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
    const pending = await instance.inject({
      method: 'POST',
      url: '/api/v1/ai/requests',
      headers: auth,
      payload: body(sources),
    });
    expect(pending.statusCode).toBe(201);
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
    const parentChange = await instance.inject({
      method: 'PUT',
      url: `/api/v1/courses/${course.id}`,
      headers: auth,
      payload: {
        ...change(1),
        name: course.name,
        notes: 'Changed after restart',
      },
    });
    expect(parentChange.statusCode).toBe(200);
    await expect(
      beginSyntheticAttempt(
        store,
        persistentConfig,
        account,
        pending.json().id,
        1,
        text,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      await store.query('SELECT id FROM ai_attempts WHERE request_id=$1', [
        pending.json().id,
      ]),
    ).toEqual([]);
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
