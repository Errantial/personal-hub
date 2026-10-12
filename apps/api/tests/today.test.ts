import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { taskAgendaResponseSchema, todaySummarySchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { runReminderBatch } from '../src/features/reminders.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
const range = 'asOf=2030-04-04&to=2030-04-11';
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string, otherCookie: string, owner: string, otherOwner: string;
const headers = () => ({ origin, cookie });
const get = (url: string) => app.inject({ url, headers: headers() });
const agenda = (query = '') => get(`/api/v1/tasks/agenda?${range}${query}`);
const summary = () => get(`/api/v1/today/summary?${range}`);
const change = (expectedVersion: number) => ({
  expectedVersion,
  operationId: randomUUID(),
});
async function write(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload: object,
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
const task = (fields: object = {}) =>
  write('POST', '/api/v1/tasks', {
    title: 'Synthetic task',
    operationId: randomUUID(),
    ...fields,
  });
async function academic(fields: object = {}) {
  const course = (
    await write('POST', '/api/v1/courses', {
      name: 'Synthetic class',
      operationId: randomUUID(),
    })
  ).course;
  const work = (
    await write('POST', '/api/v1/academic-work', {
      courseId: course.id,
      title: 'Synthetic academic work',
      operationId: randomUUID(),
      ...fields,
    })
  ).work;
  return { course, work };
}
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'today@example.test',
      password: 'synthetic-today-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  owner = setup.json().user.id;
  otherOwner = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    otherOwner,
    'other-today@example.test',
    'unused',
  ]);
  await db.query(
    'INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,$3)',
    [
      createHash('sha256').update(token).digest('hex'),
      otherOwner,
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
it('returns explicit empty totals, validates local horizons and rejects unexpected query fields', async () => {
  const empty = todaySummarySchema.parse((await summary()).json());
  expect(empty.tasks).toEqual({
    openCount: 0,
    overdueCount: 0,
    todayCount: 0,
    upcomingCount: 0,
    laterCount: 0,
    undatedCount: 0,
  });
  expect(empty.academicWork.openCount).toBe(0);
  expect(empty.reminders).toMatchObject({
    failedCount: 0,
    unreadCount: 0,
    latestUnread: [],
    worker: { lastTick: null, errorCode: null, healthy: false },
  });
  expect(empty.warnings).toEqual([
    'MANUAL_ACADEMIC_RECORDS_ONLY',
    'SCHEDULE_NOT_INCLUDED',
    'IMPORTED_DEADLINES_NOT_INCLUDED',
  ]);
  expect(
    taskAgendaResponseSchema.parse((await agenda()).json()).entries,
  ).toEqual([]);
  for (const route of ['/api/v1/tasks/agenda', '/api/v1/today/summary']) {
    for (const query of [
      'asOf=2030-04-04&to=2030-04-04',
      'asOf=2030-04-05&to=2030-04-04',
      'asOf=2030-02-30&to=2030-03-04',
      'asOf=2030-04-04&to=2030-05-06',
      `${range}&timeZone=UTC`,
    ])
      expect((await get(`${route}?${query}`)).statusCode).toBe(400);
    expect(
      (await get(`${route}?asOf=2028-02-29&to=2028-03-31`)).statusCode,
    ).toBe(200);
  }
  for (const query of [
    '&limit=201',
    '&bucket=completed',
    `&after=${randomUUID()}`,
    '&expectedCursorVersion=1',
    `&after=${randomUUID()}&expectedCursorVersion=0`,
  ])
    expect((await agenda(query)).statusCode).toBe(400);
});
it('groups all open tasks with exclusive upcoming bounds and full totals independent of filtering', async () => {
  const dates = [
    '2020-01-01',
    '2030-04-03',
    '2030-04-04',
    '2030-04-05',
    '2030-04-10',
    '2030-04-11',
    '2031-01-01',
    null,
  ];
  for (const dueDate of dates) await task({ title: `Due ${dueDate}`, dueDate });
  await task({
    title: 'Completed excluded',
    dueDate: '2030-04-04',
    completed: true,
  });
  const removed = (
    await task({ title: 'Deleted excluded', dueDate: '2030-04-04' })
  ).task;
  await write('DELETE', `/api/v1/tasks/${removed.id}`, change(1));
  const expected = {
    openCount: 8,
    overdueCount: 2,
    todayCount: 1,
    upcomingCount: 2,
    laterCount: 2,
    undatedCount: 1,
  };
  const result = taskAgendaResponseSchema.parse(
    (await agenda('&limit=1')).json(),
  );
  expect(result.summary).toEqual(expected);
  expect(result.entries[0]!.bucket).toBe('overdue');
  expect(result.nextAfter).not.toBeNull();
  for (const bucket of ['overdue', 'today', 'upcoming', 'later', 'undated']) {
    const page = taskAgendaResponseSchema.parse(
      (await agenda(`&bucket=${bucket}`)).json(),
    );
    expect(page.summary).toEqual(expected);
    expect(page.entries.every((entry) => entry.bucket === bucket)).toBe(true);
  }
  expect((await summary()).json().tasks).toEqual(expected);
  expect((await agenda()).body).not.toContain('Completed excluded');
  expect((await agenda()).body).not.toContain('Deleted excluded');
});
it('pages deadline and UUID ties through later and undated tasks and guards changed or unavailable cursors', async () => {
  const records = [];
  for (const dueDate of ['2030-04-05', '2030-04-05', '2030-04-11', null, null])
    records.push((await task({ dueDate })).task);
  const ordered = [...records].sort(
    (a, b) =>
      (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') ||
      a.id.localeCompare(b.id),
  );
  const seen: string[] = [];
  let query = '&limit=1';
  for (let i = 0; i < 6; i++) {
    const page = taskAgendaResponseSchema.parse((await agenda(query)).json());
    seen.push(...page.entries.map((entry) => entry.task.id));
    expect(page.summary.openCount).toBe(5);
    if (!page.nextAfter) break;
    query = `&limit=1&after=${page.nextAfter.id}&expectedCursorVersion=${page.nextAfter.version}`;
  }
  expect(seen).toEqual(ordered.map((record) => record.id));
  const anchor = ordered[0]!;
  expect(
    (await agenda(`&bucket=undated&after=${anchor.id}&expectedCursorVersion=1`))
      .statusCode,
  ).toBe(404);
  await write('PUT', `/api/v1/tasks/${anchor.id}`, {
    title: 'Changed cursor',
    dueDate: '2030-04-06',
    ...change(1),
  });
  const conflict = await agenda(`&after=${anchor.id}&expectedCursorVersion=1`);
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().error.code).toBe('VERSION_CONFLICT');
  await write('PUT', `/api/v1/tasks/${anchor.id}`, {
    title: 'Completed cursor',
    completed: true,
    ...change(2),
  });
  expect(
    (await agenda(`&after=${anchor.id}&expectedCursorVersion=2`)).statusCode,
  ).toBe(404);
  const deleted = ordered[1]!;
  await write('DELETE', `/api/v1/tasks/${deleted.id}`, change(1));
  expect(
    (await agenda(`&after=${deleted.id}&expectedCursorVersion=1`)).statusCode,
  ).toBe(404);
  expect(
    (await agenda(`&after=${randomUUID()}&expectedCursorVersion=1`)).statusCode,
  ).toBe(404);
});
it('requires authorization, isolates owner totals and denies foreign task cursors without leaking text', async () => {
  const owned = (await task({ title: 'Owner task' })).task;
  const foreign = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    headers: { origin, cookie: otherCookie },
    payload: { title: 'Foreign private task', operationId: randomUUID() },
  });
  expect(foreign.statusCode).toBe(200);
  await db.query(
    "INSERT INTO reminders(id,owner_id,title,scheduled_at,status) VALUES($1,$2,'Foreign private reminder',CURRENT_TIMESTAMP,'failed')",
    [randomUUID(), otherOwner],
  );
  const foreignDelivery = randomUUID();
  await db.query(
    "INSERT INTO reminders(id,owner_id,title,scheduled_at,status) VALUES($1,$2,'Foreign private delivery',CURRENT_TIMESTAMP,'delivered')",
    [foreignDelivery, otherOwner],
  );
  await db.query(
    "INSERT INTO notifications(id,owner_id,reminder_id,title) VALUES($1,$2,$3,'Foreign private inbox')",
    [randomUUID(), otherOwner, foreignDelivery],
  );
  const foreignClass = await app.inject({
    method: 'POST',
    url: '/api/v1/courses',
    headers: { origin, cookie: otherCookie },
    payload: { name: 'Foreign private class', operationId: randomUUID() },
  });
  expect(foreignClass.statusCode).toBe(200);
  const foreignWork = await app.inject({
    method: 'POST',
    url: '/api/v1/academic-work',
    headers: { origin, cookie: otherCookie },
    payload: {
      courseId: foreignClass.json().course.id,
      title: 'Foreign private work',
      operationId: randomUUID(),
    },
  });
  expect(foreignWork.statusCode).toBe(200);
  for (const route of [
    `/api/v1/tasks/agenda?${range}`,
    `/api/v1/today/summary?${range}`,
  ]) {
    expect((await app.inject({ url: route })).statusCode).toBe(401);
    const response = await get(route);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('Foreign private');
  }
  expect((await summary()).json().reminders.failedCount).toBe(0);
  expect((await summary()).json().reminders.unreadCount).toBe(0);
  expect((await summary()).json().academicWork.openCount).toBe(0);
  expect(
    (await agenda(`&after=${foreign.json().task.id}&expectedCursorVersion=1`))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        url: `/api/v1/tasks/agenda?${range}&after=${owned.id}&expectedCursorVersion=1`,
        headers: { origin, cookie: otherCookie },
      })
    ).statusCode,
  ).toBe(404);
  await write('POST', '/api/v1/auth/logout', {});
  expect((await summary()).statusCode).toBe(401);
});
it('counts beyond task and inbox pages and returns the latest three unread notifications by precise timestamp', async () => {
  await db.query(
    "INSERT INTO tasks(id,owner_id,title,due_date) SELECT gen_random_uuid(),$1,'Synthetic bulk task ' || i,'2030-04-04'::date FROM generate_series(1,205) AS i",
    [owner],
  );
  await db.query(
    "INSERT INTO reminders(id,owner_id,title,scheduled_at,status) SELECT gen_random_uuid(),$1,'Synthetic inbox ' || i,'2030-04-04'::timestamptz,'delivered' FROM generate_series(1,205) AS i",
    [owner],
  );
  await db.query(
    "INSERT INTO notifications(id,owner_id,reminder_id,title,created_at) SELECT gen_random_uuid(),owner_id,id,title,'2030-04-04T10:00:00.123Z'::timestamptz + (substring(title from '[0-9]+$')::int * interval '1 microsecond') FROM reminders WHERE owner_id=$1",
    [owner],
  );
  const result = todaySummarySchema.parse((await summary()).json());
  expect(result.tasks.todayCount).toBe(205);
  expect(result.reminders.unreadCount).toBe(205);
  expect(result.reminders.latestUnread.map((item) => item.title)).toEqual([
    'Synthetic inbox 205',
    'Synthetic inbox 204',
    'Synthetic inbox 203',
  ]);
  expect((await agenda('&limit=200')).json()).toMatchObject({
    summary: { openCount: 205 },
    entries: expect.any(Array),
    nextAfter: expect.any(Object),
  });
  expect((await agenda('&limit=200')).json().entries).toHaveLength(200);
  await write(
    'POST',
    `/api/v1/notifications/${result.reminders.latestUnread[0]!.id}/read`,
    { operationId: randomUUID() },
  );
  const changed = (await summary()).json();
  expect(changed.reminders.unreadCount).toBe(204);
  expect(
    changed.reminders.latestUnread.map((item: { title: string }) => item.title),
  ).toEqual([
    'Synthetic inbox 204',
    'Synthetic inbox 203',
    'Synthetic inbox 202',
  ]);
});
it('keeps manual work and linked planner facts separate through submission, labels, deletion and restoration', async () => {
  const { course, work } = await academic({
    dueDate: '2030-04-03',
    estimatedMinutes: 0,
  });
  const linked = await write(
    'POST',
    `/api/v1/academic-work/${work.id}/planner-work`,
    {
      kind: 'task',
      expectedWorkVersion: 1,
      expectedCourseVersion: 1,
      operationId: randomUUID(),
      task: { title: 'Linked agenda task', dueDate: '2030-04-04' },
    },
  );
  await academic({ dueDate: null, estimatedMinutes: null });
  await academic({ dueDate: '2030-04-05', estimatedMinutes: 30 });
  await academic({ dueDate: '2030-04-11', estimatedMinutes: 60 });
  const archived = await academic({
    dueDate: '2030-04-04',
    estimatedMinutes: 99,
  });
  await write('DELETE', `/api/v1/courses/${archived.course.id}`, change(1));
  const initial = todaySummarySchema.parse((await summary()).json());
  expect(initial.tasks).toMatchObject({ openCount: 1, todayCount: 1 });
  expect(initial.academicWork).toEqual({
    openCount: 3,
    overdueCount: 1,
    todayCount: 0,
    upcomingCount: 1,
    missingDeadlineCount: 1,
    missingEstimateCount: 1,
    estimatedOpenMinutes: 30,
  });
  const initialPage = (await agenda()).json().entries[0];
  expect(initialPage.task.academicSource.workId).toBe(work.id);
  await write('PUT', `/api/v1/academic-work/${work.id}`, {
    courseId: course.id,
    title: work.title,
    dueDate: work.dueDate,
    estimatedMinutes: 0,
    sensitivity: 'restricted',
    status: 'submitted',
    grade: { earned: 0, possible: 10 },
    ...change(1),
  });
  expect(
    (await agenda(`&after=${linked.task.id}&expectedCursorVersion=1`))
      .statusCode,
  ).toBe(409);
  const page = (await agenda()).json().entries[0].task;
  expect(page).toMatchObject({
    dueDate: '2030-04-04',
    completed: false,
    version: 2,
    sensitivity: 'restricted',
    academicSource: { currentStatus: 'submitted', labels: ['restricted'] },
  });
  expect((await summary()).json().academicWork.openCount).toBe(2);
  await write('DELETE', `/api/v1/tasks/${linked.task.id}`, change(2));
  expect((await summary()).json().tasks.openCount).toBe(0);
  await write('POST', `/api/v1/tasks/${linked.task.id}/restore`, change(3));
  expect((await agenda()).json().entries[0].task).toMatchObject({
    version: 4,
    academicSource: { workId: work.id, labels: ['restricted'] },
  });
});
it('reports reminder states and availability without delivering, reading, or mutating operational history', async () => {
  const delivered = (
    await write('POST', '/api/v1/reminders', {
      title: 'Delivered summary reminder',
      scheduledAt: '2000-01-01T00:00:00Z',
      operationId: randomUUID(),
    })
  ).reminder;
  await runReminderBatch(db);
  for (const status of ['queued', 'running', 'paused', 'failed', 'cancelled'])
    await db.query(
      'INSERT INTO reminders(id,owner_id,title,scheduled_at,status) VALUES($1,$2,$3,$4,$5)',
      [
        randomUUID(),
        owner,
        `Synthetic ${status}`,
        '2000-01-01T00:00:00Z',
        status,
      ],
    );
  await write('POST', '/api/v1/reminders', {
    title: 'Future queued reminder',
    scheduledAt: '2100-01-01T00:00:00Z',
    operationId: randomUUID(),
  });
  const readState = () =>
    db.query(
      'SELECT id,status,version FROM reminders WHERE owner_id=$1 ORDER BY id',
      [owner],
    );
  const before = await readState();
  const [receipts] = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM mutation_receipts WHERE owner_id=$1',
    [owner],
  );
  const result = todaySummarySchema.parse((await summary()).json());
  expect(result.reminders).toMatchObject({
    queuedCount: 2,
    runningCount: 1,
    pausedCount: 1,
    failedCount: 1,
    dueCount: 2,
    unreadCount: 1,
    worker: { healthy: true, errorCode: null },
  });
  expect(result.reminders.latestUnread[0]!.reminderId).toBe(delivered.id);
  expect(await readState()).toEqual(before);
  expect(
    (
      await db.query(
        'SELECT COUNT(*)::int AS count FROM mutation_receipts WHERE owner_id=$1',
        [owner],
      )
    )[0],
  ).toEqual(receipts);
  expect(
    (
      await db.query('SELECT read_at FROM notifications WHERE owner_id=$1', [
        owner,
      ])
    )[0]!.read_at,
  ).toBeNull();
  await db.query(
    "UPDATE worker_state SET error_code='WORKER_FAILED' WHERE name='reminders'",
  );
  expect((await summary()).json().reminders.worker).toMatchObject({
    healthy: false,
    errorCode: 'WORKER_FAILED',
  });
  await db.query(
    "UPDATE worker_state SET error_code=NULL,last_tick=CURRENT_TIMESTAMP - interval '1 minute' WHERE name='reminders'",
  );
  expect((await summary()).json().reminders.worker.healthy).toBe(false);
  await db.query(
    "UPDATE worker_state SET last_tick=CURRENT_TIMESTAMP + interval '1 minute' WHERE name='reminders'",
  );
  expect((await summary()).json().reminders.worker.healthy).toBe(false);
});
it('blocks oversized academic summaries rather than returning partial attention totals', async () => {
  const { course } = await academic();
  await db.query(
    "INSERT INTO academic_work(id,owner_id,course_id,title,kind,priority,status,sensitivity) SELECT gen_random_uuid(),$1,$2,'Synthetic bulk work','assignment',3,'planned','unlabeled' FROM generate_series(1,5000)",
    [owner, course.id],
  );
  const response = await summary();
  expect(response.statusCode).toBe(413);
  expect(response.json().error.code).toBe('ACADEMIC_WORK_TOO_LARGE');
  expect(response.json()).not.toHaveProperty('tasks');
  expect((await agenda()).statusCode).toBe(200);
});
it('reopens persisted task counts without materializing summary state', async () => {
  const root = resolve('.artifacts', 'today-persistence');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'run-'));
  const persistent = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: path });
  let reopened: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    reopened = await buildApp({ logger: false }, { config: persistent });
    const setup = await reopened.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persistent-today@example.test',
        password: 'synthetic-persistent-password',
      },
    });
    expect(setup.statusCode).toBe(201);
    const persistentHeaders = {
      origin,
      cookie: String(setup.headers['set-cookie']).split(';')[0]!,
    };
    const created = await reopened.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: persistentHeaders,
      payload: {
        title: 'Persisted summary task',
        dueDate: '2030-04-04',
        operationId: randomUUID(),
      },
    });
    expect(created.statusCode).toBe(200);
    const first = todaySummarySchema.parse(
      (
        await reopened.inject({
          url: `/api/v1/today/summary?${range}`,
          headers: persistentHeaders,
        })
      ).json(),
    );
    await reopened.close();
    reopened = undefined;
    reopened = await buildApp({ logger: false }, { config: persistent });
    const next = todaySummarySchema.parse(
      (
        await reopened.inject({
          url: `/api/v1/today/summary?${range}`,
          headers: persistentHeaders,
        })
      ).json(),
    );
    expect(next.tasks).toEqual(first.tasks);
    expect(next.reminders).toEqual(first.reminders);
    const page = taskAgendaResponseSchema.parse(
      (
        await reopened.inject({
          url: `/api/v1/tasks/agenda?${range}`,
          headers: persistentHeaders,
        })
      ).json(),
    );
    expect(page.entries[0]!.task.id).toBe(created.json().task.id);
  } finally {
    await reopened?.close();
    expect(dirname(path)).toBe(root);
    await rm(path, { recursive: true, force: true });
  }
});
