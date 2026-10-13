import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  taskBrowseResponseSchema,
  taskBatchResponseSchema,
} from '@hub/contracts';
import type { Task } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { runReminderBatch } from '../src/features/reminders.js';
import { resolveAIContext } from '../src/features/ai-routing.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let owner: string, cookie: string, other: string, otherCookie: string;
const headers = () => ({ origin, cookie });
const get = (url: string) => app.inject({ url, headers: headers() });
const browse = (query = '') =>
  get(`/api/v1/tasks/browse${query ? '?' + query : ''}`);
const batch = (payload: object) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/tasks/batch',
    headers: headers(),
    payload,
  });
const item = (task: Task) => ({ id: task.id, expectedVersion: task.version });
const update = (tasks: Task[], changes: object) => ({
  operationId: randomUUID(),
  items: tasks.map(item),
  action: { kind: 'update', changes },
});
async function write(
  url: string,
  payload: object,
  method: 'POST' | 'PUT' = 'POST',
) {
  const response = await app.inject({
    method,
    url,
    headers: headers(),
    payload,
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
async function task(fields: object = {}): Promise<Task> {
  return (
    await write('/api/v1/tasks', {
      title: 'Synthetic task',
      operationId: randomUUID(),
      ...fields,
    })
  ).task;
}
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in synthetic task tests.');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'tasks@example.test',
      password: 'synthetic-tasks-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-tasks@example.test',
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
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app?.close();
});
it('validates bounded strict filters and changes without recording failed operations', async () => {
  expect(taskBrowseResponseSchema.parse((await browse()).json())).toEqual({
    status: 'all',
    priority: 'all',
    due: 'any',
    tasks: [],
    nextAfter: null,
    summary: { totalCount: 0, openCount: 0, completedCount: 0 },
  });
  for (const query of [
    'limit=0',
    'limit=201',
    'limit=1.5',
    'status=deleted',
    'priority=urgent',
    'due=today',
    'search=anything',
    `after=${randomUUID()}`,
    'expectedCursorVersion=1',
  ])
    expect((await browse(query)).statusCode).toBe(400);
  const saved = await task();
  const valid = update([saved], { completed: true });
  const invalid = [
    { ...valid, extra: true },
    { ...valid, items: [] },
    {
      ...valid,
      items: [...valid.items, { ...item(saved), id: saved.id.toUpperCase() }],
    },
    {
      ...valid,
      items: Array.from({ length: 101 }, () => ({
        id: randomUUID(),
        expectedVersion: 1,
      })),
    },
    { ...valid, items: [{ ...item(saved), expectedVersion: 0 }] },
    ...[
      {},
      { completed: 'true' },
      { priority: 'urgent' },
      { dueDate: '2030-02-29' },
      { dueDate: '0000-01-01' },
      { title: 'Overwrite' },
      { sensitivity: 'unlabeled' },
      { canvasSourceRef: {} },
    ].map((changes) => ({ ...valid, action: { kind: 'update', changes } })),
    { ...valid, action: { kind: 'delete', changes: { completed: true } } },
    { ...valid, action: { kind: 'restore' } },
  ];
  for (const payload of invalid)
    expect((await batch(payload)).statusCode).toBe(400);
  expect((await get(`/api/v1/tasks/${saved.id}`)).json().task.version).toBe(1);
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE owner_id=$1 AND operation_id=$2',
      [owner, valid.operationId],
    ),
  ).toHaveLength(0);
});
it('pages open then completed tasks with tied dates and undated anchors while totals ignore status/pages', async () => {
  await db.query(
    `INSERT INTO tasks(id,owner_id,title,due_date,priority,completed)
    SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(i),12,'0'))::uuid,$1,'Synthetic page ' || i,CASE WHEN i%3=0 THEN NULL ELSE '2030-04-04'::date END,
      CASE WHEN i%2=0 THEN 'high' ELSE 'normal' END,i%4=0 FROM generate_series(1,207) i`,
    [owner],
  );
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM tasks WHERE owner_id=$1 ORDER BY completed,due_date NULLS LAST,id',
    [owner],
  );
  const visited: string[] = [];
  let cursor = '';
  do {
    const response = await browse(`limit=17${cursor}`);
    expect(response.statusCode).toBe(200);
    const page = taskBrowseResponseSchema.parse(response.json());
    expect(page.summary).toEqual({
      totalCount: 207,
      openCount: 156,
      completedCount: 51,
    });
    visited.push(...page.tasks.map((t) => t.id));
    cursor = page.nextAfter
      ? `&after=${page.nextAfter.id}&expectedCursorVersion=${page.nextAfter.version}`
      : '';
  } while (cursor);
  expect(visited).toEqual(rows.map((row) => row.id));
  expect(new Set(visited).size).toBe(207);
  const completed = taskBrowseResponseSchema.parse(
    (await browse('status=completed&priority=high&due=undated')).json(),
  );
  expect(completed.summary).toEqual({
    totalCount: 34,
    openCount: 17,
    completedCount: 17,
  });
  expect(completed.tasks).toHaveLength(17);
  expect(
    completed.tasks.every(
      (t) => t.completed && t.priority === 'high' && t.dueDate === null,
    ),
  ).toBe(true);
  const dated = (await browse('status=open&priority=normal&due=dated')).json();
  expect(
    dated.tasks.every(
      (t: Task) =>
        !t.completed && t.priority === 'normal' && t.dueDate !== null,
    ),
  ).toBe(true);
  const receiptsBefore = await db.query(
    'SELECT operation_id FROM mutation_receipts',
  );
  await browse();
  expect(await db.query('SELECT operation_id FROM mutation_receipts')).toEqual(
    receiptsBefore,
  );
});
it('rejects changed and no-longer-eligible cursors and isolates sessions, records and receipts', async () => {
  const first = await task({ priority: 'high' });
  const second = await task();
  expect(
    (await batch(update([first], { dueDate: '2030-04-04' }))).statusCode,
  ).toBe(200);
  expect(
    (await browse(`after=${first.id}&expectedCursorVersion=1`)).statusCode,
  ).toBe(409);
  expect(
    (await browse(`after=${first.id}&expectedCursorVersion=2&priority=normal`))
      .statusCode,
  ).toBe(404);
  const foreignId = randomUUID();
  await db.query(
    "INSERT INTO tasks(id,owner_id,title) VALUES($1,$2,'Foreign task')",
    [foreignId, other],
  );
  expect(
    (await browse(`after=${foreignId}&expectedCursorVersion=1`)).statusCode,
  ).toBe(404);
  const selection = update([second, { ...first, id: foreignId, version: 1 }], {
    completed: true,
  });
  expect((await batch(selection)).statusCode).toBe(404);
  expect((await get(`/api/v1/tasks/${second.id}`)).json().task.version).toBe(1);
  const payload = update([second], { completed: true });
  expect((await batch(payload)).statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/tasks/batch',
        headers: { origin, cookie: otherCookie },
        payload,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        url: '/api/v1/tasks/browse',
        headers: { cookie: otherCookie },
      })
    ).json().summary.totalCount,
  ).toBe(1);
  for (const route of ['/api/v1/tasks/browse', '/api/v1/tasks/batch']) {
    const options = route.endsWith('batch')
      ? { method: 'POST' as const, headers: { origin }, payload }
      : {};
    expect((await app.inject({ url: route, ...options })).statusCode).toBe(401);
  }
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/tasks/batch',
        headers: { origin: 'https://foreign.example.test', cookie },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  await db.query(
    'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
    [owner],
  );
  expect((await browse()).statusCode).toBe(401);
  expect((await batch(payload)).statusCode).toBe(401);
});
it('atomically patches only selected fields, clears deadlines and returns input order with exact historical retries', async () => {
  const one = await task({
    notes: 'Owner notes',
    dueDate: '2030-04-04',
    sensitivity: 'restricted',
  });
  const two = await task({ notes: 'Second notes', priority: 'low' });
  const payload = update([two, one], {
    completed: true,
    priority: 'high',
    dueDate: '2032-02-29',
  });
  const [first, duplicate] = await Promise.all([
    batch(payload),
    batch(payload),
  ]);
  expect(first.statusCode).toBe(200);
  expect(duplicate.json()).toEqual(first.json());
  const saved = taskBatchResponseSchema.parse(first.json()).tasks;
  expect(saved.map((t) => t.id)).toEqual([two.id, one.id]);
  expect(
    saved.every(
      (t) =>
        t.version === 2 &&
        t.completed &&
        t.priority === 'high' &&
        t.dueDate === '2032-02-29',
    ),
  ).toBe(true);
  expect(saved[1]).toMatchObject({
    title: one.title,
    notes: one.notes,
    sensitivity: 'restricted',
    createdAt: one.createdAt,
  });
  const cleared = taskBatchResponseSchema.parse(
    (await batch(update(saved, { completed: false, dueDate: null }))).json(),
  ).tasks;
  expect(
    cleared.every(
      (t) =>
        t.version === 3 &&
        !t.completed &&
        t.dueDate === null &&
        t.priority === 'high',
    ),
  ).toBe(true);
  // Successful no-op field assignments still advance optimistic versions like PUT.
  expect(
    (await batch(update(cleared, { priority: 'high' }))).json().tasks[0]
      .version,
  ).toBe(4);
  expect((await batch(payload)).json()).toEqual(first.json());
  expect(
    (await batch({ ...payload, action: { kind: 'delete' } })).statusCode,
  ).toBe(409);
  expect(
    (await batch({ ...payload, items: [...payload.items].reverse() }))
      .statusCode,
  ).toBe(409);
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE owner_id=$1 AND operation_id=$2',
      [owner, payload.operationId],
    ),
  ).toHaveLength(1);
});
it('rolls back stale or missing selections without consuming an operation ID', async () => {
  const one = await task();
  const two = await task();
  const payload = update([one, two], { completed: true });
  expect((await batch(update([two], { priority: 'high' }))).statusCode).toBe(
    200,
  );
  expect((await batch(payload)).json().error.code).toBe('VERSION_CONFLICT');
  expect((await get(`/api/v1/tasks/${one.id}`)).json().task).toEqual(one);
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE owner_id=$1 AND operation_id=$2',
      [owner, payload.operationId],
    ),
  ).toHaveLength(0);
  const repaired = {
    ...payload,
    items: [item(one), { id: two.id, expectedVersion: 2 }],
  };
  expect((await batch(repaired)).statusCode).toBe(200);
  const missing = update(
    [
      { ...one, version: 2 },
      { ...two, id: randomUUID(), version: 1 },
    ],
    { dueDate: null },
  );
  expect((await batch(missing)).statusCode).toBe(404);
  expect((await get(`/api/v1/tasks/${one.id}`)).json().task.version).toBe(2);
});
it('rolls back task writes and receipts when a database failure interrupts an update', async () => {
  const one = await task();
  const two = await task();
  await db.exec(`CREATE FUNCTION reject_synthetic_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.priority='high' THEN RAISE EXCEPTION 'Synthetic rollback'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_synthetic_batch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION reject_synthetic_batch();`);
  const payload = update([one, two], { priority: 'high' });
  expect((await batch(payload)).statusCode).toBe(500);
  expect((await get(`/api/v1/tasks/${one.id}`)).json().task).toEqual(one);
  expect((await get(`/api/v1/tasks/${two.id}`)).json().task).toEqual(two);
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE owner_id=$1 AND operation_id=$2',
      [owner, payload.operationId],
    ),
  ).toHaveLength(0);
  await db.exec(
    'DROP TRIGGER reject_synthetic_batch ON tasks; DROP FUNCTION reject_synthetic_batch();',
  );
  expect((await batch(payload)).statusCode).toBe(200);
});
it('permits one competing batch and preserves the whole losing selection', async () => {
  const one = await task();
  const two = await task();
  const three = await task();
  const results = await Promise.all([
    batch(update([one, two], { priority: 'high' })),
    batch(update([two, three], { completed: true })),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const loserOnly = results[0]!.statusCode === 200 ? three : one;
  expect((await get(`/api/v1/tasks/${loserOnly.id}`)).json().task).toEqual(
    loserOnly,
  );
  expect((await get(`/api/v1/tasks/${two.id}`)).json().task.version).toBe(2);
});
it('retains linked source snapshots and inherited labels through batch deletion, restoration and export', async () => {
  const course = (
    await write('/api/v1/courses', {
      name: 'Synthetic class',
      operationId: randomUUID(),
      sensitivity: 'restricted',
    })
  ).course;
  const work = (
    await write('/api/v1/academic-work', {
      courseId: course.id,
      title: 'Synthetic assignment',
      operationId: randomUUID(),
    })
  ).work;
  const linked: Task = (
    await write(`/api/v1/academic-work/${work.id}/planner-work`, {
      kind: 'task',
      expectedWorkVersion: 1,
      expectedCourseVersion: 1,
      operationId: randomUUID(),
      task: {
        title: 'Owner planner title',
        notes: 'Owner planner notes',
        dueDate: '2030-04-04',
      },
    })
  ).task;
  const sourceBefore = (
    await get(`/api/v1/tasks/${linked.id}/academic-source`)
  ).json();
  const patched = (await batch(update([linked], { completed: true }))).json()
    .tasks[0];
  expect(patched).toMatchObject({
    title: linked.title,
    notes: linked.notes,
    sensitivity: 'restricted',
    academicSource: linked.academicSource,
  });
  expect(
    (await get(`/api/v1/academic-work/${work.id}`)).json().work.status,
  ).toBe('planned');
  const deletedResponse = await batch({
    operationId: randomUUID(),
    items: [item(patched)],
    action: { kind: 'delete' },
  });
  expect(deletedResponse.statusCode).toBe(200);
  const deleted = deletedResponse.json().tasks[0];
  expect(deleted.deletedAt).not.toBeNull();
  expect(deleted.version).toBe(3);
  expect((await browse()).json().summary.totalCount).toBe(0);
  expect(
    (await browse(`after=${linked.id}&expectedCursorVersion=3`)).statusCode,
  ).toBe(404);
  expect(
    (await batch(update([deleted], { completed: false }))).statusCode,
  ).toBe(404);
  const exported = (await get('/api/v1/planner/export')).json();
  expect(exported.records.tasks[0]).toMatchObject({
    id: linked.id,
    version: 3,
    deletedAt: deleted.deletedAt,
  });
  expect(exported.records.academicPlannerSources).toHaveLength(1);
  const restored = (
    await write(`/api/v1/tasks/${linked.id}/restore`, {
      operationId: randomUUID(),
      expectedVersion: 3,
    })
  ).task;
  expect(restored).toMatchObject({
    version: 4,
    deletedAt: null,
    completed: true,
    sensitivity: 'restricted',
    academicSource: linked.academicSource,
  });
  const sourceAfter = (
    await get(`/api/v1/tasks/${linked.id}/academic-source`)
  ).json();
  expect(sourceAfter.source).toEqual(sourceBefore.source);
  const context = await resolveAIContext(db, owner, {
    kind: 'task',
    id: linked.id,
    expectedVersion: 4,
  });
  expect(context).toMatchObject({
    attachmentDerived: false,
    labels: ['restricted'],
    academicPlanning: { workId: work.id, courseId: course.id },
  });
  expect((await get('/api/v1/tasks')).json().tasks[0]).toEqual(restored);
});
it('preserves Canvas file provenance and captured facts when batching linked and ordinary tasks', async () => {
  const base = '/api/v1/connections/canvas';
  await write(`${base}/import`, {
    operationId: randomUUID(),
    feed: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic Hub//EN\r\nBEGIN:VEVENT\r\nUID:batch-source\r\nDTSTART:20300404T170000Z\r\nDTEND:20300404T170000Z\r\nSUMMARY:Synthetic source\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
  });
  const source = (await get(base)).json().items[0];
  const linked = await task({
    canvasSourceRef: { itemId: source.id, expectedVersion: source.version },
    notes: 'Owner linked notes',
  });
  const ordinary = await task({ sensitivity: 'personal' });
  const changed = taskBatchResponseSchema.parse(
    (
      await batch(
        update([linked, ordinary], { dueDate: '2030-04-06', completed: true }),
      )
    ).json(),
  ).tasks;
  expect(changed[0]!.canvasSource).toEqual(linked.canvasSource);
  expect(changed[0]!.canvasSource!.inputKind).toBe('calendar-file');
  expect(changed[0]!.notes).toBe('Owner linked notes');
  expect(changed[1]!.sensitivity).toBe('personal');
  expect((await get(base)).json().items[0]).toEqual(source);
  const context = await resolveAIContext(db, owner, {
    kind: 'task',
    id: linked.id,
    expectedVersion: 2,
  });
  expect(context.attachmentDerived).toBe(true);
});
it('suppresses task-target reminder delivery after batch completion/deletion without reviving cancelled jobs', async () => {
  const done = await task();
  const removed = await task();
  for (const t of [done, removed])
    await write('/api/v1/reminders', {
      title: 'Synthetic task reminder',
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      targetKind: 'task',
      targetId: t.id,
      operationId: randomUUID(),
    });
  expect((await batch(update([done], { completed: true }))).statusCode).toBe(
    200,
  );
  expect(
    (
      await batch({
        operationId: randomUUID(),
        items: [item(removed)],
        action: { kind: 'delete' },
      })
    ).statusCode,
  ).toBe(200);
  await runReminderBatch(db);
  expect(
    (await get('/api/v1/reminders'))
      .json()
      .reminders.every((r: { status: string }) => r.status === 'cancelled'),
  ).toBe(true);
  expect(
    await db.query('SELECT id FROM notifications WHERE owner_id=$1', [owner]),
  ).toHaveLength(0);
  expect(
    (await batch(update([{ ...done, version: 2 }], { completed: false })))
      .statusCode,
  ).toBe(200);
  await write(`/api/v1/tasks/${removed.id}/restore`, {
    expectedVersion: 2,
    operationId: randomUUID(),
  });
  await runReminderBatch(db);
  expect(
    await db.query('SELECT id FROM notifications WHERE owner_id=$1', [owner]),
  ).toHaveLength(0);
});
it('persists batch receipts and tombstones across restart while historical retries leave newer records intact', async () => {
  const root = resolve('.artifacts');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'task-batch-'));
  const persistent = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: path });
  let reopened: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    reopened = await buildApp({ logger: false }, { config: persistent });
    const setup = await reopened.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persisted-tasks@example.test',
        password: 'synthetic-persisted-tasks',
      },
    });
    expect(setup.statusCode).toBe(201);
    const h = {
      origin,
      cookie: String(setup.headers['set-cookie']).split(';')[0]!,
    };
    const created = await reopened.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: h,
      payload: { title: 'Persisted task', operationId: randomUUID() },
    });
    const saved = created.json().task;
    const payload = update([saved], { completed: true });
    const result = await reopened.inject({
      method: 'POST',
      url: '/api/v1/tasks/batch',
      headers: h,
      payload,
    });
    expect(result.statusCode).toBe(200);
    const deletion = {
      operationId: randomUUID(),
      items: [item(result.json().tasks[0])],
      action: { kind: 'delete' },
    };
    expect(
      (
        await reopened.inject({
          method: 'POST',
          url: '/api/v1/tasks/batch',
          headers: h,
          payload: deletion,
        })
      ).statusCode,
    ).toBe(200);
    await reopened.close();
    reopened = undefined;
    reopened = await buildApp({ logger: false }, { config: persistent });
    expect(
      (
        await reopened.inject({
          method: 'POST',
          url: '/api/v1/tasks/batch',
          headers: h,
          payload,
        })
      ).json(),
    ).toEqual(result.json());
    expect(
      (
        await reopened.inject({ url: `/api/v1/tasks/${saved.id}`, headers: h })
      ).json().task,
    ).toMatchObject({ version: 3, completed: true });
    expect(
      (
        await reopened.inject({ url: '/api/v1/tasks/browse', headers: h })
      ).json().summary.totalCount,
    ).toBe(0);
    expect(
      (
        await reopened.inject({
          method: 'POST',
          url: '/api/v1/tasks/batch',
          headers: h,
          payload: deletion,
        })
      ).json().tasks[0].version,
    ).toBe(3);
  } finally {
    await reopened?.close();
    expect(dirname(path)).toBe(root);
    await rm(path, { recursive: true, force: true });
  }
});
