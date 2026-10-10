import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { accountResponseSchema, plannerExportSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { authService } from '../src/auth/routes.js';

const origin = 'http://127.0.0.1:5173';
const credentials = {
  email: 'account@example.test',
  password: 'synthetic-account-password',
};
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let owner: string;
let other: string;
let otherCookie: string;
const headers = (session = cookie) => ({ origin, cookie: session });
const post = (
  url: string,
  payload: Record<string, unknown>,
  session = cookie,
) => app.inject({ method: 'POST', url, headers: headers(session), payload });
const get = (url: string, session = cookie) =>
  app.inject({ url, headers: headers(session) });
const cookieFrom = (reply: { headers: Record<string, unknown> }) =>
  String(reply.headers['set-cookie']).split(';')[0]!;

beforeAll(async () => {
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await post('/api/v1/auth/setup', credentials, '');
  expect(setup.statusCode).toBe(201);
  cookie = cookieFrom(setup);
  owner = setup.json().user.id;
  other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-account@example.test',
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
  await app?.close();
});

it('protects account/export routes and revokes only other owner sessions with versioned receipts', async () => {
  expect((await get('/api/v1/auth/account', '')).statusCode).toBe(401);
  expect((await get('/api/v1/planner/export', '')).statusCode).toBe(401);
  const extra = cookieFrom(await post('/api/v1/auth/login', credentials));
  const account = accountResponseSchema.parse(
    (await get('/api/v1/auth/account')).json(),
  );
  expect(account.sessions).toHaveLength(2);
  expect(JSON.stringify(account)).not.toContain('token_hash');
  expect(JSON.stringify(account)).not.toContain(cookie.split('=')[1]);
  const target = account.sessions.find((value) => !value.current)!;
  const current = account.sessions.find((value) => value.current)!;
  const payload = {
    operationId: randomUUID(),
    expectedVersion: target.version,
  };
  expect(
    (await post(`/api/v1/auth/sessions/${current.id}/revoke`, payload))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await post(`/api/v1/auth/sessions/${target.id}/revoke`, {
        ...payload,
        expectedVersion: 99,
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await post(
        `/api/v1/auth/sessions/${target.id}/revoke`,
        payload,
        otherCookie,
      )
    ).statusCode,
  ).toBe(404);
  expect(
    (await post(`/api/v1/auth/sessions/${target.id}/revoke`, payload))
      .statusCode,
  ).toBe(200);
  expect(
    (await post(`/api/v1/auth/sessions/${target.id}/revoke`, payload))
      .statusCode,
  ).toBe(200);
  expect((await get('/api/v1/tasks', extra)).statusCode).toBe(401);
  expect(
    (
      await post(
        '/api/v1/tasks',
        { title: 'Blocked replay', operationId: randomUUID() },
        extra,
      )
    ).statusCode,
  ).toBe(401);
  expect((await get('/api/v1/auth/account', otherCookie)).statusCode).toBe(200);
});

it('reauthenticates password changes, rotates sessions and prevents stale verified logins', async () => {
  const [initial] = await db.query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id=$1',
    [owner],
  );
  const second = cookieFrom(await post('/api/v1/auth/login', credentials));
  const originalCookie = cookie;
  const payload = {
    currentPassword: credentials.password,
    newPassword: 'synthetic-new-account-password',
    expectedVersion: 1,
  };
  expect(
    (
      await post('/api/v1/auth/password', {
        ...payload,
        currentPassword: 'wrong-password',
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await post('/api/v1/auth/password', { ...payload, expectedVersion: 99 }))
      .statusCode,
  ).toBe(409);
  const changed = await post('/api/v1/auth/password', payload);
  expect(changed.statusCode).toBe(200);
  cookie = cookieFrom(changed);
  expect(cookie).not.toBe(originalCookie);
  expect((await get('/api/v1/tasks', originalCookie)).statusCode).toBe(401);
  expect((await get('/api/v1/tasks', second)).statusCode).toBe(401);
  expect((await get('/api/v1/auth/account')).json()).toMatchObject({
    version: 2,
    sessions: [{ current: true }],
  });
  expect((await post('/api/v1/auth/login', credentials)).statusCode).toBe(401);
  expect(
    (
      await post('/api/v1/auth/login', {
        ...credentials,
        password: payload.newPassword,
      })
    ).statusCode,
  ).toBe(200);
  await expect(
    authService(db, config).createSession(
      owner,
      {} as FastifyReply,
      initial!.password_hash,
    ),
  ).rejects.toMatchObject({ statusCode: 401 });
  const receipts = JSON.stringify(
    await db.query('SELECT * FROM mutation_receipts'),
  );
  expect(receipts).not.toContain(credentials.password);
  expect(receipts).not.toContain(payload.newPassword);
});

it('exports owner records and tombstones with a versioned format and excludes operational secrets', async () => {
  const taskReply = await post('/api/v1/tasks', {
    title: 'Exported task',
    notes: 'Private synthetic note',
    sensitivity: 'restricted',
    operationId: randomUUID(),
  });
  const task = taskReply.json().task;
  expect(taskReply.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/tasks/${task.id}`,
        headers: headers(),
        payload: { expectedVersion: 1, operationId: randomUUID() },
      })
    ).statusCode,
  ).toBe(200);
  await post(
    '/api/v1/tasks',
    { title: 'Other owner only', operationId: randomUUID() },
    otherCookie,
  );
  const course = (
    await post('/api/v1/courses', {
      name: 'Export course',
      sensitivity: 'personal',
      operationId: randomUUID(),
    })
  ).json().course;
  const topic = (
    await post('/api/v1/topics', {
      courseId: course.id,
      name: 'Export topic',
      progress: 60,
      confidence: 'medium',
      operationId: randomUUID(),
    })
  ).json().topic;
  const eventReply = await post('/api/v1/calendar', {
    title: 'Export study',
    startsAt: '2027-03-01T10:00:00Z',
    endsAt: '2027-03-01T11:00:00Z',
    timeZone: 'UTC',
    courseId: course.id,
    topicId: topic.id,
    recurrence: { frequency: 'daily', interval: 1, count: 2, until: null },
    operationId: randomUUID(),
  });
  expect(eventReply.statusCode).toBe(200);
  const event = eventReply.json().event;
  await db.query(
    'INSERT INTO event_exceptions(event_id,original_date,cancelled,replacement) VALUES($1,$2,true,NULL)',
    [event.id, '2027-03-02'],
  );
  const reminderReply = await post('/api/v1/reminders', {
    title: 'Export reminder',
    scheduledAt: '2028-01-01T00:00:00Z',
    operationId: randomUUID(),
  });
  expect(reminderReply.statusCode).toBe(200);
  const reminder = reminderReply.json().reminder;
  await db.query(
    'INSERT INTO notifications(id,reminder_id,owner_id,title) VALUES($1,$2,$3,$4)',
    [randomUUID(), reminder.id, owner, 'Export inbox'],
  );
  const response = await get('/api/v1/planner/export');
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-disposition']).toContain('attachment;');
  const output = plannerExportSchema.parse(response.json());
  expect(output.owner.id).toBe(owner);
  expect(output.records.tasks).toMatchObject([
    { id: task.id, version: 2, sensitivity: 'restricted' },
  ]);
  expect(output.records.tasks[0]!.deletedAt).not.toBeNull();
  expect(output.records.courses[0]!.id).toBe(course.id);
  expect(output.records.topics[0]!.progress).toBe(60);
  expect(output.records.events[0]).toMatchObject({
    courseId: course.id,
    topicId: topic.id,
    sensitivity: 'personal',
  });
  expect(output.records.exceptions[0]).toMatchObject({
    eventId: event.id,
    cancelled: true,
  });
  expect(output.records.reminders[0]!.id).toBe(reminder.id);
  expect(output.records.notifications[0]!.title).toBe('Export inbox');
  for (const forbidden of [
    'Other owner only',
    'password_hash',
    'token_hash',
    'lease_token',
    'mutation_receipts',
    'setupToken',
  ])
    expect(response.body).not.toContain(forbidden);
  expect(
    (await get('/api/v1/planner/export', otherCookie)).json().records.courses,
  ).toHaveLength(0);
});

it('rejects oversized exports instead of silently truncating records', async () => {
  await db.query(
    "INSERT INTO tasks(id,owner_id,title) SELECT gen_random_uuid(),$1,'Bulk synthetic task' FROM generate_series(1,10001)",
    [other],
  );
  const result = await get('/api/v1/planner/export', otherCookie);
  expect(result.statusCode).toBe(413);
  expect(result.json().error.code).toBe('EXPORT_TOO_LARGE');
});
