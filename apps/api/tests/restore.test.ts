import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let otherCookie: string;
const headers = () => ({ origin, cookie });
const operation = (expectedVersion: number) => ({
  expectedVersion,
  operationId: randomUUID(),
});
async function write(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload: Record<string, unknown>,
) {
  return app.inject({ method, url, headers: headers(), payload });
}
beforeAll(async () => {
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'restore@example.test',
      password: 'synthetic-restore-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  const owner = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query(
    'INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)',
    [owner, 'other-restore@example.test', 'unused'],
  );
  await db.query(
    'INSERT INTO sessions (token_hash,owner_id,expires_at) VALUES ($1,$2,$3)',
    [
      createHash('sha256').update(token).digest('hex'),
      owner,
      new Date(Date.now() + 3600000),
    ],
  );
  otherCookie = `hub_session=${token}`;
});
afterAll(async () => {
  await app?.close();
});

it('admits only one competing restore and keeps topic labels across an archived link', async () => {
  const course = (
    await write('POST', '/api/v1/courses', {
      name: 'Archived restore class',
      operationId: randomUUID(),
    })
  ).json().course;
  const topic = (
    await write('POST', '/api/v1/topics', {
      name: 'Restore topic',
      courseId: course.id,
      operationId: randomUUID(),
    })
  ).json().topic;
  const event = (
    await write('POST', '/api/v1/calendar', {
      title: 'Topic study',
      courseId: course.id,
      topicId: topic.id,
      startsAt: '2027-04-01T09:00:00.000Z',
      endsAt: '2027-04-01T10:00:00.000Z',
      timeZone: 'UTC',
      operationId: randomUUID(),
    })
  ).json().event;
  const path = `/api/v1/calendar/${event.id}`;
  expect((await write('DELETE', path, operation(1))).statusCode).toBe(200);
  expect(
    (
      await write('PUT', `/api/v1/topics/${topic.id}`, {
        name: topic.name,
        courseId: course.id,
        sensitivity: 'personal',
        ...operation(1),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await write('DELETE', `/api/v1/courses/${course.id}`, operation(1)))
      .statusCode,
  ).toBe(200);
  const results = await Promise.all([
    write('POST', `${path}/restore`, operation(3)),
    write('POST', `${path}/restore`, operation(3)),
  ]);
  expect(results.map((response) => response.statusCode).sort()).toEqual([
    200, 409,
  ]);
  expect(
    results.find((response) => response.statusCode === 200)!.json().event,
  ).toMatchObject({
    courseId: course.id,
    topicId: topic.id,
    academicLabels: ['personal'],
    sensitivity: 'personal',
    version: 4,
  });
  expect(
    await db.query('SELECT * FROM planner_restorations WHERE item_id=$1', [
      event.id,
    ]),
  ).toHaveLength(1);
  expect(
    (await app.inject({ url: path, headers: { cookie: otherCookie } }))
      .statusCode,
  ).toBe(404);
});

it('restores tasks once, retains deletion history, and never replays a historical receipt as a new restore', async () => {
  const created = await write('POST', '/api/v1/tasks', {
    title: 'Keep task',
    notes: 'Owner notes',
    dueDate: '2027-01-01',
    completed: true,
    sensitivity: 'restricted',
    operationId: randomUUID(),
  });
  const task = created.json().task;
  const path = `/api/v1/tasks/${task.id}`;
  const deletion = operation(task.version);
  const deleted = await write('DELETE', path, deletion);
  expect(deleted.statusCode).toBe(200);
  const restore = operation(deleted.json().task.version);
  const results = await Promise.all([
    write('POST', `${path}/restore`, restore),
    write('POST', `${path}/restore`, restore),
  ]);
  expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
  expect(results[0]!.json()).toEqual(results[1]!.json());
  expect(results[0]!.json().task).toMatchObject({
    ...task,
    version: 3,
    deletedAt: null,
    updatedAt: expect.any(String),
  });
  expect(
    (await write('POST', `${path}/restore`, operation(3))).json().error.code,
  ).toBe('NOT_DELETED');
  expect(
    (
      await write('POST', `${path}/restore`, { ...restore, expectedVersion: 3 })
    ).json().error.code,
  ).toBe('OPERATION_CONFLICT');
  expect((await write('DELETE', path, deletion)).json()).toEqual(
    deleted.json(),
  );
  expect(
    (await app.inject({ url: '/api/v1/tasks', headers: headers() }))
      .json()
      .tasks.some((item: { id: string }) => item.id === task.id),
  ).toBe(true);
  const secondDeletion = await write('DELETE', path, operation(3));
  expect(secondDeletion.json().task.version).toBe(4);
  expect((await write('POST', `${path}/restore`, restore)).json()).toEqual(
    results[0]!.json(),
  );
  expect(
    (await app.inject({ url: '/api/v1/tasks', headers: headers() }))
      .json()
      .tasks.some((item: { id: string }) => item.id === task.id),
  ).toBe(false);
  expect(
    (await write('POST', `${path}/restore`, operation(2))).json().error.code,
  ).toBe('VERSION_CONFLICT');
  expect(
    (await write('POST', `${path}/restore`, operation(4))).json().task.version,
  ).toBe(5);
  const exported = await app.inject({
    url: '/api/v1/planner/export',
    headers: headers(),
  });
  expect(exported.statusCode).toBe(200);
  expect(
    exported
      .json()
      .records.plannerRestorations.filter(
        (row: { itemId: string }) => row.itemId === task.id,
      ),
  ).toEqual([
    expect.objectContaining({
      itemKind: 'task',
      itemId: task.id,
      deletedVersion: 2,
      restoredVersion: 3,
      deletedAt: deleted.json().task.deletedAt,
    }),
    expect.objectContaining({
      itemKind: 'task',
      itemId: task.id,
      deletedVersion: 4,
      restoredVersion: 5,
    }),
  ]);
});

it('protects tombstones from anonymous, foreign-owner, malformed and stale restores', async () => {
  const created = await write('POST', '/api/v1/tasks', {
    title: 'Private tombstone',
    operationId: randomUUID(),
  });
  const id = created.json().task.id;
  await write('DELETE', `/api/v1/tasks/${id}`, operation(1));
  const url = `/api/v1/tasks/${id}/restore`;
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { origin },
        payload: operation(2),
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { origin, cookie: otherCookie },
        payload: operation(2),
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await write('POST', `/api/v1/tasks/${randomUUID()}/restore`, operation(2)))
      .statusCode,
  ).toBe(404);
  expect(
    (await write('POST', url, { ...operation(2), title: 'Override' }))
      .statusCode,
  ).toBe(400);
  expect((await write('POST', url, operation(1))).statusCode).toBe(409);
  expect(
    (
      await app.inject({ url: `/api/v1/tasks/${id}`, headers: headers() })
    ).json().task,
  ).toMatchObject({ id, version: 2, deletedAt: expect.any(String) });
  expect(
    (
      await app.inject({
        url: `/api/v1/tasks/${id}`,
        headers: { cookie: otherCookie },
      })
    ).statusCode,
  ).toBe(404);
  expect((await app.inject(`/api/v1/tasks/${id}`)).statusCode).toBe(401);
  expect(
    await db.query('SELECT * FROM planner_restorations WHERE item_id=$1', [id]),
  ).toHaveLength(0);
});

it('restores calendar series and exceptions without reviving cancelled reminders', async () => {
  const created = await write('POST', '/api/v1/calendar', {
    title: 'Series',
    startsAt: '2027-01-01T09:00:00.000Z',
    endsAt: '2027-01-01T10:00:00.000Z',
    timeZone: 'UTC',
    recurrence: { frequency: 'daily', interval: 1, count: 3, until: null },
    operationId: randomUUID(),
  });
  expect(created.statusCode).toBe(200);
  const event = created.json().event;
  const path = `/api/v1/calendar/${event.id}`;
  expect(
    (await write('DELETE', `${path}/occurrences/2027-01-02`, operation(1)))
      .statusCode,
  ).toBe(200);
  const reminder = await write('POST', '/api/v1/reminders', {
    title: 'Keep cancelled',
    scheduledAt: '2027-01-01T08:00:00.000Z',
    targetKind: 'event',
    targetId: event.id,
    operationId: randomUUID(),
  });
  expect(reminder.statusCode).toBe(200);
  await db.query("UPDATE reminders SET status='cancelled' WHERE id=$1", [
    reminder.json().reminder.id,
  ]);
  expect((await write('DELETE', path, operation(2))).statusCode).toBe(200);
  expect(
    (await write('POST', `${path}/restore`, operation(3))).json().event,
  ).toMatchObject({
    id: event.id,
    version: 4,
    deletedAt: null,
    recurrence: event.recurrence,
  });
  const occurrences = await app.inject({
    url: '/api/v1/calendar/occurrences?from=2027-01-01&to=2027-01-04&timeZone=UTC',
    headers: headers(),
  });
  expect(
    occurrences
      .json()
      .occurrences.filter((row: { id: string }) => row.id === event.id)
      .map((row: { originalDate: string }) => row.originalDate),
  ).toEqual(['2027-01-01', '2027-01-03']);
  expect(
    (
      await db.query('SELECT status FROM reminders WHERE id=$1', [
        reminder.json().reminder.id,
      ])
    )[0]!.status,
  ).toBe('cancelled');
  // Legacy event deletes share storage with Calendar and retain its advanced fields.
  expect(
    (await write('DELETE', `/api/v1/events/${event.id}`, operation(4)))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await write('POST', `/api/v1/events/${event.id}/restore`, operation(5))
    ).json().event,
  ).toMatchObject({ id: event.id, version: 6, recurrence: event.recurrence });
});

it('retains labels applied to deleted study blocks before restoring them', async () => {
  const course = (
    await write('POST', '/api/v1/courses', {
      name: 'Restore class',
      sensitivity: 'unlabeled',
      operationId: randomUUID(),
    })
  ).json().course;
  const event = (
    await write('POST', '/api/v1/calendar', {
      title: 'Study',
      startsAt: '2027-02-01T09:00:00.000Z',
      endsAt: '2027-02-01T10:00:00.000Z',
      timeZone: 'UTC',
      courseId: course.id,
      operationId: randomUUID(),
    })
  ).json().event;
  const path = `/api/v1/calendar/${event.id}`;
  await write('DELETE', path, operation(1));
  for (const [expectedVersion, sensitivity] of [
    [1, 'personal'],
    [2, 'restricted'],
    [3, 'unlabeled'],
  ] as const) {
    expect(
      (
        await write('PUT', `/api/v1/courses/${course.id}`, {
          name: course.name,
          sensitivity,
          ...operation(expectedVersion),
        })
      ).statusCode,
    ).toBe(200);
  }
  expect(
    (await write('POST', `${path}/restore`, operation(2))).json().error.code,
  ).toBe('VERSION_CONFLICT');
  expect(
    (await app.inject({ url: path, headers: headers() })).json().event,
  ).toMatchObject({ id: event.id, version: 4, deletedAt: expect.any(String) });
  const restored = await write('POST', `${path}/restore`, operation(4));
  expect(restored.statusCode).toBe(200);
  expect(restored.json().event).toMatchObject({
    sensitivity: 'restricted',
    academicLabels: ['personal', 'restricted'],
    version: 5,
  });
});
