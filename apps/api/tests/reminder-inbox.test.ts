import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  plannerExportSchema,
  reminderSnoozeResponseSchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { runReminderBatch } from '../src/features/reminders.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string, otherCookie: string, owner: string, otherOwner: string;
const headers = () => ({ origin, cookie });
const post = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: headers(), payload });
const get = (url: string) => app.inject({ url, headers: headers() });
const future = () => new Date(Date.now() + 3600000).toISOString();
const change = (expectedVersion: number) => ({
  operationId: randomUUID(),
  expectedVersion,
});
async function academicTarget(fields: object = {}) {
  const course = (
    await post('/api/v1/courses', {
      name: 'Synthetic academic class',
      operationId: randomUUID(),
    })
  ).json().course;
  const work = (
    await post('/api/v1/academic-work', {
      courseId: course.id,
      title: 'Synthetic academic assignment',
      operationId: randomUUID(),
      ...fields,
    })
  ).json().work;
  return { course, work };
}
async function reminder(target: object = {}) {
  const response = await post('/api/v1/reminders', {
    title: 'Synthetic reminder',
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    operationId: randomUUID(),
    ...target,
  });
  expect(response.statusCode).toBe(200);
  return response.json().reminder;
}
async function delivered(target: object = {}) {
  const r = await reminder(target);
  await runReminderBatch(db);
  return (await get('/api/v1/reminders'))
    .json()
    .reminders.find((value: { id: string }) => value.id === r.id);
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
      email: 'reminders@example.test',
      password: 'synthetic-reminder-password',
    },
  });
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  owner = setup.json().user.id;
  otherOwner = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    otherOwner,
    'other-reminders@example.test',
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
it('delivers and snoozes an academic target at explicit times and suppresses a closed child without rescheduling deadlines', async () => {
  const { work } = await academicTarget({
    dueDate: '2030-04-04',
    estimatedMinutes: 100,
  });
  const first = await delivered({
    targetKind: 'academic-work',
    targetId: work.id,
  });
  expect(first).toMatchObject({
    status: 'delivered',
    targetKind: 'academic-work',
    targetId: work.id,
    occurrenceDate: null,
  });
  const input = { ...change(first.version), scheduledAt: future() };
  const snoozed = await post(`/api/v1/reminders/${first.id}/snooze`, input);
  expect(snoozed.statusCode).toBe(200);
  const child = reminderSnoozeResponseSchema.parse(snoozed.json()).reminder;
  expect(child).toMatchObject({
    targetKind: 'academic-work',
    targetId: work.id,
    snoozedFromId: first.id,
    scheduledAt: input.scheduledAt,
  });
  expect(
    (await post(`/api/v1/reminders/${first.id}/snooze`, input)).json(),
  ).toEqual(snoozed.json());
  const closed = await app.inject({
    method: 'PUT',
    url: `/api/v1/academic-work/${work.id}`,
    headers: headers(),
    payload: {
      courseId: work.courseId,
      title: work.title,
      dueDate: '2030-04-09',
      estimatedMinutes: 100,
      status: 'submitted',
      grade: null,
      ...change(1),
    },
  });
  expect(closed.statusCode).toBe(200);
  expect(
    (await get(`/api/v1/reminders/${child.id}`)).json().reminder.scheduledAt,
  ).toBe(input.scheduledAt);
  await runReminderBatch(db, new Date(Date.parse(input.scheduledAt) + 1));
  expect(
    (await get(`/api/v1/reminders/${child.id}`)).json().reminder.status,
  ).toBe('cancelled');
  expect(
    (await get('/api/v1/notifications/history')).json().notifications,
  ).toHaveLength(1);
  expect(
    (await get(`/api/v1/academic-work/${work.id}`)).json().work.dueDate,
  ).toBe('2030-04-09');
});
it('guards owned academic targets and forbids occurrence dates and cross-owner database links', async () => {
  const { course, work } = await academicTarget();
  const payload = {
    title: 'Academic reminder',
    scheduledAt: future(),
    targetKind: 'academic-work',
    targetId: work.id,
    operationId: randomUUID(),
  };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/reminders',
        headers: { origin, cookie: otherCookie },
        payload,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/reminders',
        headers: { origin },
        payload,
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await post('/api/v1/reminders', { ...payload, targetId: randomUUID() }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await post('/api/v1/reminders', {
        ...payload,
        occurrenceDate: '2030-04-04',
      })
    ).statusCode,
  ).toBe(400);
  await expect(
    db.query(
      "INSERT INTO reminders(id,owner_id,title,scheduled_at,target_kind,target_id) VALUES($1,$2,'Foreign academic target',CURRENT_TIMESTAMP,'academic-work',$3)",
      [randomUUID(), otherOwner, work.id],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await app.inject({
    method: 'PUT',
    url: `/api/v1/academic-work/${work.id}`,
    headers: headers(),
    payload: {
      courseId: course.id,
      title: work.title,
      status: 'cancelled',
      grade: null,
      ...change(1),
    },
  });
  expect((await post('/api/v1/reminders', payload)).json().error.code).toBe(
    'TARGET_UNAVAILABLE',
  );
});
it('rechecks academic closure between claim and delivery and never resurrects a cancelled reminder', async () => {
  const { course, work } = await academicTarget();
  const queued = await reminder({
    targetKind: 'academic-work',
    targetId: work.id,
  });
  await runReminderBatch(db, new Date(), async () => {
    const closed = await app.inject({
      method: 'PUT',
      url: `/api/v1/academic-work/${work.id}`,
      headers: headers(),
      payload: {
        courseId: course.id,
        title: work.title,
        status: 'submitted',
        grade: null,
        ...change(1),
      },
    });
    expect(closed.statusCode).toBe(200);
  });
  expect(
    (await get(`/api/v1/reminders/${queued.id}`)).json().reminder,
  ).toMatchObject({ status: 'cancelled', attempts: 1 });
  expect((await get('/api/v1/notifications/summary')).json().unreadCount).toBe(
    0,
  );
  await app.inject({
    method: 'PUT',
    url: `/api/v1/academic-work/${work.id}`,
    headers: headers(),
    payload: {
      courseId: course.id,
      title: work.title,
      status: 'planned',
      grade: null,
      ...change(2),
    },
  });
  await runReminderBatch(db);
  expect(
    (await get(`/api/v1/reminders/${queued.id}`)).json().reminder.status,
  ).toBe('cancelled');
  expect((await get('/api/v1/notifications/summary')).json().unreadCount).toBe(
    0,
  );
});
it('blocks unavailable academic resume/snooze and suppresses deleted and archived targets', async () => {
  const { course, work } = await academicTarget();
  const first = await delivered({
    targetKind: 'academic-work',
    targetId: work.id,
  });
  const paused = await reminder({
    targetKind: 'academic-work',
    targetId: work.id,
  });
  expect(
    (
      await post(`/api/v1/reminders/${paused.id}/control`, {
        action: 'pause',
        ...change(paused.version),
      })
    ).statusCode,
  ).toBe(200);
  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/v1/academic-work/${work.id}`,
    headers: headers(),
    payload: change(1),
  });
  expect(deleted.statusCode).toBe(200);
  expect(
    (
      await post(`/api/v1/reminders/${paused.id}/control`, {
        action: 'resume',
        ...change(2),
      })
    ).json().error.code,
  ).toBe('TARGET_UNAVAILABLE');
  expect(
    (
      await post(`/api/v1/reminders/${first.id}/snooze`, {
        scheduledAt: future(),
        ...change(first.version),
      })
    ).json().error.code,
  ).toBe('REMINDER_TARGET_UNAVAILABLE');
  expect(
    (
      await post('/api/v1/reminders', {
        title: 'Deleted work reminder',
        targetKind: 'academic-work',
        targetId: work.id,
        scheduledAt: future(),
        operationId: randomUUID(),
      })
    ).statusCode,
  ).toBe(409);
  await app.inject({
    method: 'POST',
    url: `/api/v1/academic-work/${work.id}/restore`,
    headers: headers(),
    payload: change(2),
  });
  const queued = await reminder({
    targetKind: 'academic-work',
    targetId: work.id,
  });
  await app.inject({
    method: 'DELETE',
    url: `/api/v1/courses/${course.id}`,
    headers: headers(),
    payload: change(1),
  });
  await runReminderBatch(db);
  expect(
    (await get(`/api/v1/reminders/${queued.id}`)).json().reminder.status,
  ).toBe('cancelled');
  expect(
    (await get(`/api/v1/reminders/${paused.id}`)).json().reminder.status,
  ).toBe('paused');
});
it('upgrades populated legacy reminder targets without changing deliveries or receipts', async () => {
  const task = (
    await post('/api/v1/tasks', {
      title: 'Legacy target',
      operationId: randomUUID(),
    })
  ).json().task;
  const original = await delivered({ targetKind: 'task', targetId: task.id });
  const receipts = await db.query(
    'SELECT operation_id,payload_hash,result FROM mutation_receipts ORDER BY operation_id',
  );
  await db.exec(
    "ALTER TABLE reminders DROP CONSTRAINT reminders_owned_academic_work; ALTER TABLE reminders DROP COLUMN academic_work_id; ALTER TABLE reminders DROP CONSTRAINT reminders_target_kind_check; ALTER TABLE reminders ADD CONSTRAINT reminders_target_kind_check CHECK(target_kind IN ('task','event'))",
  );
  await db.query(
    "DELETE FROM schema_migrations WHERE name='029_academic_work_reminders.sql'",
  );
  await migrate(db);
  expect(
    (await get(`/api/v1/reminders/${original.id}`)).json().reminder,
  ).toEqual(original);
  expect(
    await db.query(
      'SELECT operation_id,payload_hash,result FROM mutation_receipts ORDER BY operation_id',
    ),
  ).toEqual(receipts);
  await runReminderBatch(db);
  expect(
    (await get('/api/v1/notifications/history')).json().notifications,
  ).toHaveLength(1);
  const { work } = await academicTarget();
  expect(
    (await reminder({ targetKind: 'academic-work', targetId: work.id }))
      .targetKind,
  ).toBe('academic-work');
});
it('snoozes atomically, preserves delivery, inherits the target and returns exact retry receipts', async () => {
  const task = (
    await post('/api/v1/tasks', { title: 'Study', operationId: randomUUID() })
  ).json().task;
  const r = await delivered({ targetKind: 'task', targetId: task.id });
  const input = { ...change(r.version), scheduledAt: future() };
  const response = await post(`/api/v1/reminders/${r.id}/snooze`, input);
  expect(response.statusCode).toBe(200);
  const saved = reminderSnoozeResponseSchema.parse(response.json());
  expect(saved.sourceReminder).toMatchObject({
    id: r.id,
    status: 'delivered',
    version: r.version + 1,
  });
  expect(saved.reminder).toMatchObject({
    snoozedFromId: r.id,
    status: 'queued',
    version: 1,
    targetId: task.id,
    targetKind: 'task',
    scheduledAt: input.scheduledAt,
  });
  expect(saved.notification.readAt).not.toBeNull();
  expect((await get(`/api/v1/reminders/${r.id}`)).json().reminder).toEqual(
    saved.sourceReminder,
  );
  expect(
    (await post(`/api/v1/reminders/${r.id}/snooze`, input)).json(),
  ).toEqual(saved);
  expect(
    (
      await post(`/api/v1/reminders/${r.id}/snooze`, {
        ...input,
        scheduledAt: new Date(Date.now() + 7200000).toISOString(),
      })
    ).json().error.code,
  ).toBe('OPERATION_CONFLICT');
  expect(
    (
      await post(`/api/v1/reminders/${r.id}/snooze`, {
        ...change(saved.sourceReminder.version),
        scheduledAt: future(),
      })
    ).json().error.code,
  ).toBe('REMINDER_ALREADY_SNOOZED');
  await runReminderBatch(db);
  expect((await get('/api/v1/notifications/summary')).json().unreadCount).toBe(
    0,
  );
  await runReminderBatch(db, new Date(Date.parse(input.scheduledAt) + 1));
  await runReminderBatch(db, new Date(Date.parse(input.scheduledAt) + 2));
  expect((await get('/api/v1/notifications/history')).json()).toMatchObject({
    unreadCount: 1,
  });
  expect(
    (await get('/api/v1/notifications')).json().notifications,
  ).toHaveLength(2);
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(
    exported.records.reminders.find((v) => v.id === saved.reminder.id)
      ?.snoozedFromId,
  ).toBe(r.id);
  expect(JSON.stringify(exported)).not.toContain('leaseToken');
});
it('rejects competing snoozes and allows a later snooze of the new delivery', async () => {
  const r = await delivered();
  const scheduledAt = future();
  const responses = await Promise.all(
    [1, 2].map(() =>
      post(`/api/v1/reminders/${r.id}/snooze`, {
        ...change(r.version),
        scheduledAt,
      }),
    ),
  );
  expect(responses.map((v) => v.statusCode).sort()).toEqual([200, 409]);
  const child = responses.find((v) => v.statusCode === 200)!.json().reminder;
  await runReminderBatch(db, new Date(Date.parse(scheduledAt) + 1));
  const current = (await get('/api/v1/reminders'))
    .json()
    .reminders.find((v: { id: string }) => v.id === child.id);
  const again = await post(`/api/v1/reminders/${child.id}/snooze`, {
    ...change(current.version),
    scheduledAt: new Date(Date.parse(scheduledAt) + 3600000).toISOString(),
  });
  expect(again.statusCode).toBe(200);
  expect(again.json().reminder.snoozedFromId).toBe(child.id);
  expect(await db.query('SELECT id FROM reminders')).toHaveLength(3);
});
it('rejects queued, running, stale, past and unbounded snoozes without reading notifications', async () => {
  const r = await reminder();
  expect(
    (
      await post(`/api/v1/reminders/${r.id}/snooze`, {
        ...change(1),
        scheduledAt: future(),
      })
    ).json().error.code,
  ).toBe('REMINDER_STATE');
  await runReminderBatch(db, new Date(), async () => {
    const [running] = await db.query(
      'SELECT version FROM reminders WHERE id=$1',
      [r.id],
    );
    expect(
      (
        await post(`/api/v1/reminders/${r.id}/snooze`, {
          ...change(Number(running!.version)),
          scheduledAt: future(),
        })
      ).json().error.code,
    ).toBe('REMINDER_STATE');
  });
  expect(
    (
      await post(`/api/v1/reminders/${r.id}/snooze`, {
        ...change(1),
        scheduledAt: future(),
      })
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
  const current = (await get('/api/v1/reminders')).json().reminders[0];
  for (const scheduledAt of [
    new Date(Date.now() - 1).toISOString(),
    new Date(Date.now() + 366 * 86400000).toISOString(),
    'invalid',
  ])
    expect(
      (
        await post(`/api/v1/reminders/${r.id}/snooze`, {
          ...change(current.version),
          scheduledAt,
        })
      ).statusCode,
    ).toBe(400);
  expect((await get('/api/v1/notifications/summary')).json().unreadCount).toBe(
    1,
  );
  expect(await db.query('SELECT id FROM reminders')).toHaveLength(1);
});
it('blocks snooze after task completion or deletion and leaves the delivery unread', async () => {
  for (const deleted of [false, true]) {
    const task = (
      await post('/api/v1/tasks', {
        title: 'Target',
        operationId: randomUUID(),
      })
    ).json().task;
    const r = await delivered({ targetKind: 'task', targetId: task.id });
    await db.query(
      deleted
        ? 'UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1'
        : 'UPDATE tasks SET completed=true WHERE id=$1',
      [task.id],
    );
    const response = await post(`/api/v1/reminders/${r.id}/snooze`, {
      ...change(r.version),
      scheduledAt: future(),
    });
    expect(response.json().error.code).toBe('REMINDER_TARGET_UNAVAILABLE');
  }
  expect((await get('/api/v1/notifications/summary')).json().unreadCount).toBe(
    2,
  );
  expect(
    await db.query(
      'SELECT id FROM reminders WHERE snoozed_from_id IS NOT NULL',
    ),
  ).toHaveLength(0);
});
it('cancels a snoozed child when its target is completed before delivery', async () => {
  const task = (
    await post('/api/v1/tasks', { title: 'Target', operationId: randomUUID() })
  ).json().task;
  const r = await delivered({ targetKind: 'task', targetId: task.id });
  const scheduledAt = future();
  const child = (
    await post(`/api/v1/reminders/${r.id}/snooze`, {
      ...change(r.version),
      scheduledAt,
    })
  ).json().reminder;
  await db.query('UPDATE tasks SET completed=true WHERE id=$1', [task.id]);
  await runReminderBatch(db, new Date(Date.parse(scheduledAt) + 1));
  expect(
    await db.query('SELECT status FROM reminders WHERE id=$1', [child.id]),
  ).toEqual([{ status: 'cancelled' }]);
  expect(
    (await get('/api/v1/notifications')).json().notifications,
  ).toHaveLength(1);
});
it('preserves recurring occurrence identity and rejects snooze after occurrence cancellation', async () => {
  const event = (
    await post('/api/v1/calendar', {
      operationId: randomUUID(),
      title: 'Recurring class',
      timeZone: 'UTC',
      startsAt: '2030-04-01T09:00:00.000Z',
      endsAt: '2030-04-01T10:00:00.000Z',
      recurrence: { frequency: 'weekly', interval: 1, count: 3, until: null },
    })
  ).json().event;
  const r = await delivered({
    targetKind: 'event',
    targetId: event.id,
    occurrenceDate: '2030-04-08',
  });
  const scheduledAt = future();
  const snoozed = await post(`/api/v1/reminders/${r.id}/snooze`, {
    ...change(r.version),
    scheduledAt,
  });
  expect(snoozed.statusCode).toBe(200);
  expect(snoozed.json().reminder.occurrenceDate).toBe('2030-04-08');
  const second = await delivered({
    targetKind: 'event',
    targetId: event.id,
    occurrenceDate: '2030-04-08',
  });
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/calendar/${event.id}/occurrences/2030-04-08`,
        headers: headers(),
        payload: change(1),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await post(`/api/v1/reminders/${second.id}/snooze`, {
        ...change(second.version),
        scheduledAt,
      })
    ).json().error.code,
  ).toBe('REMINDER_TARGET_UNAVAILABLE');
  await runReminderBatch(db, new Date(Date.parse(scheduledAt) + 1));
  expect(
    await db.query('SELECT status FROM reminders WHERE id=$1', [
      snoozed.json().reminder.id,
    ]),
  ).toEqual([{ status: 'cancelled' }]);
  expect((await get('/api/v1/notifications/summary')).json().unreadCount).toBe(
    1,
  );
});
it('honors cancellation racing with a snoozed child lease and preserves read timestamps', async () => {
  const r = await delivered();
  const n = (await get('/api/v1/notifications')).json().notifications[0];
  const marked = await post(`/api/v1/notifications/${n.id}/read`, {
    operationId: randomUUID(),
  });
  const scheduledAt = future();
  const snoozed = await post(`/api/v1/reminders/${r.id}/snooze`, {
    ...change(r.version),
    scheduledAt,
  });
  expect(snoozed.json().notification.readAt).toBe(
    marked.json().notification.readAt,
  );
  const child = snoozed.json().reminder;
  await runReminderBatch(
    db,
    new Date(Date.parse(scheduledAt) + 1),
    async () => {
      const current = (await get(`/api/v1/reminders/${child.id}`)).json()
        .reminder;
      expect(current.status).toBe('running');
      expect(
        (
          await post(`/api/v1/reminders/${child.id}/control`, {
            ...change(current.version),
            action: 'cancel',
          })
        ).statusCode,
      ).toBe(200);
    },
  );
  expect(
    (await get(`/api/v1/reminders/${child.id}`)).json().reminder.status,
  ).toBe('cancelled');
  expect(
    (await get('/api/v1/notifications')).json().notifications,
  ).toHaveLength(1);
});
it('rolls back a missing delivered notification and enforces same-owner snooze links in SQL', async () => {
  const r = await delivered();
  await db.query('DELETE FROM notifications WHERE reminder_id=$1', [r.id]);
  expect(
    (
      await post(`/api/v1/reminders/${r.id}/snooze`, {
        ...change(r.version),
        scheduledAt: future(),
      })
    ).statusCode,
  ).toBe(409);
  expect(
    await db.query('SELECT version FROM reminders WHERE id=$1', [r.id]),
  ).toEqual([{ version: r.version }]);
  await expect(
    db.query(
      'INSERT INTO reminders(id,owner_id,title,scheduled_at,snoozed_from_id) VALUES($1,$2,$3,CURRENT_TIMESTAMP,$4)',
      [randomUUID(), otherOwner, 'Wrong owner', r.id],
    ),
  ).rejects.toMatchObject({ code: '23503' });
});
it('marks only selected notifications read atomically and never captures later arrivals on replay', async () => {
  await delivered();
  await delivered();
  const before = (await get('/api/v1/notifications')).json().notifications;
  const payload = {
    operationId: randomUUID(),
    notificationIds: before.map((v: { id: string }) => v.id),
  };
  const marked = await post('/api/v1/notifications/read', payload);
  expect(marked.statusCode).toBe(200);
  expect(
    marked
      .json()
      .notifications.every((v: { readAt: string | null }) => v.readAt),
  ).toBe(true);
  await delivered();
  expect((await post('/api/v1/notifications/read', payload)).json()).toEqual(
    marked.json(),
  );
  expect((await get('/api/v1/notifications/summary')).json().unreadCount).toBe(
    1,
  );
  const unread = (
    await get('/api/v1/notifications/history?unreadOnly=true')
  ).json().notifications[0];
  expect(
    (
      await post('/api/v1/notifications/read', {
        operationId: randomUUID(),
        notificationIds: [unread.id, randomUUID()],
      })
    ).statusCode,
  ).toBe(404);
  expect((await get('/api/v1/notifications/summary')).json().unreadCount).toBe(
    1,
  );
  expect(
    (
      await post('/api/v1/notifications/read', {
        operationId: randomUUID(),
        notificationIds: [unread.id, unread.id],
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await post('/api/v1/notifications/read', {
        operationId: randomUUID(),
        notificationIds: [],
      })
    ).statusCode,
  ).toBe(400);
});
it('pages microsecond ties without omissions and keeps cursors usable after marking them read', async () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (let i = 0; i < ids.length; i++) {
    const r = await delivered();
    await db.query(
      'UPDATE reminders SET created_at=$2::timestamptz WHERE id=$1',
      [r.id, `2030-01-01T00:00:00.00000${i + 1}Z`],
    );
    await db.query(
      'UPDATE notifications SET id=$2,created_at=$3::timestamptz WHERE reminder_id=$1',
      [r.id, ids[i], `2030-01-01T00:00:00.00000${i + 1}Z`],
    );
  }
  const first = (
    await get('/api/v1/notifications/history?limit=1&unreadOnly=true')
  ).json();
  expect(first).toMatchObject({ unreadCount: 3, nextBefore: ids[2] });
  await post('/api/v1/notifications/read', {
    operationId: randomUUID(),
    notificationIds: [first.nextBefore],
  });
  const second = (
    await get(
      `/api/v1/notifications/history?limit=1&unreadOnly=true&before=${first.nextBefore}`,
    )
  ).json();
  expect(second).toMatchObject({ unreadCount: 2, nextBefore: ids[1] });
  const third = (
    await get(
      `/api/v1/notifications/history?limit=1&before=${second.nextBefore}`,
    )
  ).json();
  expect(third.notifications[0].id).toBe(ids[0]);
  expect(third.nextBefore).toBeNull();
  const r1 = (
    await get('/api/v1/reminders/history?limit=1&status=delivered')
  ).json();
  const r2 = (
    await get(
      `/api/v1/reminders/history?limit=2&status=delivered&before=${r1.nextBefore}`,
    )
  ).json();
  expect(
    new Set([...r1.reminders, ...r2.reminders].map((v: { id: string }) => v.id))
      .size,
  ).toBe(3);
  expect(r2.nextBefore).toBeNull();
});
it('counts unread notifications beyond the legacy 200-item inbox and validates bounded history queries', async () => {
  await db.query(
    "INSERT INTO reminders(id,owner_id,title,scheduled_at,status) SELECT gen_random_uuid(),$1,'Synthetic old delivery',CURRENT_TIMESTAMP,'delivered' FROM generate_series(1,205)",
    [owner],
  );
  await db.query(
    'INSERT INTO notifications(id,owner_id,reminder_id,title) SELECT gen_random_uuid(),owner_id,id,title FROM reminders WHERE owner_id=$1',
    [owner],
  );
  expect(
    (await get('/api/v1/notifications')).json().notifications,
  ).toHaveLength(200);
  expect((await get('/api/v1/notifications/summary')).json().unreadCount).toBe(
    205,
  );
  expect(
    (await get('/api/v1/notifications/history?limit=200')).json(),
  ).toMatchObject({ unreadCount: 205 });
  for (const url of [
    '/api/v1/notifications/history?limit=201',
    '/api/v1/notifications/history?unreadOnly=1',
    '/api/v1/reminders/history?status=unknown',
    '/api/v1/reminders/history?extra=true',
  ])
    expect((await get(url)).statusCode).toBe(400);
});
it('requires owner authorization and rejects foreign records, cursors and bulk selections', async () => {
  const r = await delivered();
  const n = (await get('/api/v1/notifications')).json().notifications[0];
  for (const url of [
    '/api/v1/reminders/history',
    '/api/v1/notifications/history',
    '/api/v1/notifications/summary',
  ]) {
    expect((await app.inject({ url })).statusCode).toBe(401);
    const response = await app.inject({
      url,
      headers: { cookie: otherCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json().unreadCount ?? response.json().reminders.length,
    ).toBe(0);
  }
  for (const url of [
    `/api/v1/reminders/history?before=${r.id}`,
    `/api/v1/notifications/history?before=${n.id}`,
  ])
    expect(
      (await app.inject({ url, headers: { cookie: otherCookie } })).statusCode,
    ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/reminders/${r.id}/snooze`,
        headers: { origin, cookie: otherCookie },
        payload: { ...change(r.version), scheduledAt: future() },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        url: `/api/v1/reminders/${r.id}`,
        headers: { cookie: otherCookie },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/read',
        headers: { origin, cookie: otherCookie },
        payload: { operationId: randomUUID(), notificationIds: [n.id] },
      })
    ).statusCode,
  ).toBe(404);
  expect((await get('/api/v1/notifications/summary')).json().unreadCount).toBe(
    1,
  );
});
it('rolls back the inbox read and receipt if creating the child fails', async () => {
  const r = await delivered();
  await db.exec(`CREATE FUNCTION reject_snooze_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.snoozed_from_id IS NOT NULL THEN RAISE EXCEPTION 'Synthetic insertion failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_snooze_fixture BEFORE INSERT ON reminders FOR EACH ROW EXECUTE FUNCTION reject_snooze_fixture()`);
  const input = { ...change(r.version), scheduledAt: future() };
  expect(
    (await post(`/api/v1/reminders/${r.id}/snooze`, input)).statusCode,
  ).toBe(500);
  expect((await get('/api/v1/notifications/summary')).json().unreadCount).toBe(
    1,
  );
  expect(
    await db.query('SELECT version FROM reminders WHERE id=$1', [r.id]),
  ).toEqual([{ version: r.version }]);
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE operation_id=$1',
      [input.operationId],
    ),
  ).toHaveLength(0);
  await db.exec(
    'DROP TRIGGER reject_snooze_fixture ON reminders; DROP FUNCTION reject_snooze_fixture()',
  );
  expect(
    (await post(`/api/v1/reminders/${r.id}/snooze`, input)).statusCode,
  ).toBe(200);
});
it('upgrades populated reminder history without changing records or receipts', async () => {
  const r = await delivered();
  const previous = (await get('/api/v1/reminders')).json();
  const inbox = (await get('/api/v1/notifications')).json();
  const receipts = await db.query(
    'SELECT * FROM mutation_receipts ORDER BY operation_id',
  );
  await db.exec(
    'ALTER TABLE reminders DROP COLUMN snoozed_from_id; ALTER TABLE reminders DROP CONSTRAINT reminders_id_owner_unique; DROP INDEX reminders_owner_history; DROP INDEX notifications_owner_history; DROP INDEX notifications_owner_unread',
  );
  await db.query(
    "DELETE FROM schema_migrations WHERE name='025_reminder_snooze.sql'",
  );
  await migrate(db);
  expect((await get('/api/v1/reminders')).json()).toEqual(previous);
  expect((await get('/api/v1/notifications')).json()).toEqual(inbox);
  expect(
    await db.query('SELECT * FROM mutation_receipts ORDER BY operation_id'),
  ).toEqual(receipts);
  expect(
    (
      await post(`/api/v1/reminders/${r.id}/snooze`, {
        ...change(r.version),
        scheduledAt: future(),
      })
    ).statusCode,
  ).toBe(200);
});
it('persists snoozed delivery and retry receipts across an isolated server restart', async () => {
  const root = resolve('.artifacts', 'reminder-persistence');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'run-'));
  let persistent: typeof app | undefined;
  try {
    const cfg = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: path });
    let database = await openDatabase(cfg);
    persistent = await buildApp({ logger: false }, { config: cfg, database });
    const setup = await persistent.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'restart-reminder@example.test',
        password: 'synthetic-reminder-password',
      },
    });
    const session = String(setup.headers['set-cookie']).split(';')[0]!;
    const send = (url: string, payload: object) =>
      persistent!.inject({
        method: 'POST',
        url,
        headers: { origin, cookie: session },
        payload,
      });
    const course = (
      await send('/api/v1/courses', {
        name: 'Restart academic class',
        operationId: randomUUID(),
      })
    ).json().course;
    const work = (
      await send('/api/v1/academic-work', {
        courseId: course.id,
        title: 'Restart academic target',
        operationId: randomUUID(),
      })
    ).json().work;
    const r = (
      await send('/api/v1/reminders', {
        title: 'Restart snooze',
        operationId: randomUUID(),
        scheduledAt: new Date(Date.now() - 1000).toISOString(),
        targetKind: 'academic-work',
        targetId: work.id,
      })
    ).json().reminder;
    await runReminderBatch(database);
    const input = { ...change(3), scheduledAt: future() };
    const snoozed = await send(`/api/v1/reminders/${r.id}/snooze`, input);
    expect(snoozed.statusCode).toBe(200);
    await persistent.close();
    persistent = undefined;
    database = await openDatabase(cfg);
    persistent = await buildApp({ logger: false }, { config: cfg, database });
    expect(
      (await send(`/api/v1/reminders/${r.id}/snooze`, input)).json(),
    ).toEqual(snoozed.json());
    await runReminderBatch(
      database,
      new Date(Date.parse(input.scheduledAt) + 1),
    );
    await runReminderBatch(
      database,
      new Date(Date.parse(input.scheduledAt) + 2),
    );
    expect(await database.query('SELECT id FROM reminders')).toHaveLength(2);
    expect(await database.query('SELECT id FROM notifications')).toHaveLength(
      2,
    );
  } finally {
    await persistent?.close();
    if (dirname(resolve(path)) === root)
      await rm(path, { recursive: true, force: true });
  }
});
