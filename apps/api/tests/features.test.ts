import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  calendarRecordSchema,
  expandEvent,
  wallTimeToInstant,
} from '@hub/contracts';
import type { CalendarInput } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { runReminderBatch } from '../src/features/reminders.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let otherCookie: string;
function headers(session = cookie) {
  return { origin, ...(session ? { cookie: session } : {}) };
}
const timed = (extra: Partial<CalendarInput> = {}) => ({
  title: 'Calendar test',
  notes: '',
  startsAt: '2027-03-07T09:00:00-07:00',
  endsAt: '2027-03-07T10:00:00-07:00',
  timeZone: 'America/Denver',
  sensitivity: 'unlabeled',
  allDay: false,
  startDate: null,
  endDate: null,
  recurrence: null,
  courseId: null,
  topicId: null,
  studyStatus: 'planned',
  ...extra,
});
async function create(
  path: string,
  payload: Record<string, unknown>,
  session = cookie,
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/${path}`,
    headers: headers(session),
    payload: { ...payload, operationId: randomUUID() },
  });
}
async function occurrences(
  from: string,
  to: string,
  timeZone = 'America/Denver',
) {
  const response = await app.inject({
    url: `/api/v1/calendar/occurrences?${new URLSearchParams({ from, to, timeZone })}`,
    headers: headers(),
  });
  expect(response.statusCode).toBe(200);
  return response.json().occurrences as {
    id: string;
    originalDate: string;
    title: string;
    startsAt: string;
    allDay: boolean;
    startDate: string;
    sensitivity: string;
    recurrence: unknown;
  }[];
}
beforeAll(async () => {
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'features@example.test',
      password: 'synthetic-feature-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query(
    'INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)',
    [id, 'other-features@example.test', 'unused'],
  );
  await db.query(
    'INSERT INTO sessions (token_hash,owner_id,expires_at) VALUES ($1,$2,$3)',
    [
      createHash('sha256').update(token).digest('hex'),
      id,
      new Date(Date.now() + 3600000),
    ],
  );
  otherCookie = `hub_session=${token}`;
});
afterAll(async () => {
  await app?.close();
});

describe('calendar time semantics', () => {
  it('rejects spring gaps and requires a choice for fall folds', () => {
    expect(() =>
      wallTimeToInstant('2027-03-14T02:30', 'America/Denver'),
    ).toThrow('does not exist');
    expect(() =>
      wallTimeToInstant('2026-11-01T01:30', 'America/Denver'),
    ).toThrow('occurs twice');
    expect(
      wallTimeToInstant('2026-11-01T01:30', 'America/Denver', 'earlier'),
    ).toBe('2026-11-01T07:30:00.000Z');
    expect(
      wallTimeToInstant('2026-11-01T01:30', 'America/Denver', 'later'),
    ).toBe('2026-11-01T08:30:00.000Z');
  });
  it('keeps weekly wall time through DST and bounds recurrence by count', async () => {
    const response = await create(
      'calendar',
      timed({
        recurrence: { frequency: 'weekly', interval: 1, count: 3, until: null },
      }),
    );
    expect(response.statusCode).toBe(200);
    const id = response.json().event.id;
    const list = (await occurrences('2027-03-01', '2027-04-01')).filter(
      (value) => value.id === id,
    );
    expect(list.map((value) => value.startsAt)).toEqual([
      '2027-03-07T16:00:00.000Z',
      '2027-03-14T15:00:00.000Z',
      '2027-03-21T15:00:00.000Z',
    ]);
  });
  it('preserves a selected later fold for a one-time event and shifts future gaps forward', () => {
    const meta = {
      id: randomUUID(),
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      deletedAt: null,
    };
    const fold = calendarRecordSchema.parse({
      ...timed(),
      ...meta,
      startsAt: '2026-11-01T08:30:00Z',
      endsAt: '2026-11-01T09:30:00Z',
    });
    expect(
      expandEvent(fold, '2026-11-01', '2026-11-02', 'America/Denver')[0]!
        .startsAt,
    ).toBe('2026-11-01T08:30:00.000Z');
    const gap = calendarRecordSchema.parse({
      ...timed(),
      ...meta,
      startsAt: '2027-03-13T09:30:00Z',
      endsAt: '2027-03-13T10:30:00Z',
      recurrence: { frequency: 'daily', interval: 1, count: 2, until: null },
    });
    expect(
      expandEvent(gap, '2027-03-14', '2027-03-15', 'America/Denver')[0]!
        .startsAt,
    ).toBe('2027-03-14T09:30:00.000Z');
  });
  it('keeps all-day dates across viewing timezones and skips absent monthly days', async () => {
    const response = await create(
      'calendar',
      timed({
        allDay: true,
        startDate: '2028-01-31',
        endDate: '2028-02-01',
        recurrence: {
          frequency: 'monthly',
          interval: 1,
          count: 3,
          until: null,
        },
      }),
    );
    expect(response.statusCode).toBe(200);
    const id = response.json().event.id;
    const list = (
      await occurrences('2028-01-01', '2028-04-02', 'Pacific/Honolulu')
    ).filter((value) => value.id === id);
    expect(list.map((value) => value.startDate)).toEqual([
      '2028-01-31',
      '2028-03-31',
    ]);
    const utc = (
      await occurrences('2028-01-31', '2028-02-01', 'Asia/Tokyo')
    ).filter((value) => value.id === id);
    expect(utc[0]!.startDate).toBe('2028-01-31');
  });
  it('supports inclusive repeat-until and efficiently expands ongoing schedules years later', () => {
    const event = calendarRecordSchema.parse({
      ...timed(),
      id: randomUUID(),
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      deletedAt: null,
      recurrence: {
        frequency: 'daily',
        interval: 1,
        count: null,
        until: '2027-03-09',
      },
    });
    expect(expandEvent(event, '2027-03-07', '2027-03-15', 'UTC')).toHaveLength(
      3,
    );
    expect(
      expandEvent(
        {
          ...event,
          recurrence: {
            frequency: 'daily',
            interval: 1,
            count: null,
            until: null,
          },
        },
        '2050-01-01',
        '2050-01-08',
        'America/Denver',
      ),
    ).toHaveLength(7);
  });
  it('moves one occurrence into another window, preserves other instances and rejects stale edits', async () => {
    const payload = timed({
      recurrence: { frequency: 'weekly', interval: 1, count: 3, until: null },
    });
    const created = await create('calendar', payload);
    const item = created.json().event;
    const body = {
      ...timed({
        title: 'Moved occurrence',
        startsAt: '2027-04-15T09:00:00-06:00',
        endsAt: '2027-04-15T10:00:00-06:00',
      }),
      expectedVersion: 1,
      operationId: randomUUID(),
    };
    const path = `/api/v1/calendar/${item.id}/occurrences/2027-03-14`;
    const saved = await app.inject({
      method: 'PUT',
      url: path,
      headers: headers(),
      payload: body,
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: path,
          headers: headers(),
          payload: body,
        })
      ).json(),
    ).toEqual(saved.json());
    expect(
      (await occurrences('2027-03-07', '2027-03-22'))
        .filter((value) => value.id === item.id)
        .map((value) => value.originalDate),
    ).toEqual(['2027-03-07', '2027-03-21']);
    const moved = (await occurrences('2027-04-15', '2027-04-16')).find(
      (value) => value.id === item.id,
    );
    expect(moved?.title).toBe('Moved occurrence');
    expect(moved?.recurrence).not.toBeNull();
    const stale = await app.inject({
      method: 'DELETE',
      url: path,
      headers: headers(),
      payload: { expectedVersion: 1, operationId: randomUUID() },
    });
    expect(stale.statusCode).toBe(409);
    const renamed = await app.inject({
      method: 'PUT',
      url: `/api/v1/calendar/${item.id}`,
      headers: headers(),
      payload: {
        ...payload,
        title: 'Renamed series',
        expectedVersion: 2,
        operationId: randomUUID(),
      },
    });
    expect(renamed.statusCode).toBe(200);
    expect(
      (await occurrences('2027-04-15', '2027-04-16')).find(
        (value) => value.id === item.id,
      )?.title,
    ).toBe('Moved occurrence');
  });
  it('cancels one occurrence and resets exceptions only for a changed schedule', async () => {
    const payload = timed({
      recurrence: { frequency: 'weekly', interval: 1, count: 3, until: null },
    });
    const created = await create('calendar', payload);
    const id = created.json().event.id;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/calendar/${id}/occurrences/2027-03-14`,
      headers: headers(),
      payload: { expectedVersion: 1, operationId: randomUUID() },
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (await occurrences('2027-03-14', '2027-03-15')).some(
        (value) => value.id === id,
      ),
    ).toBe(false);
    const changed = await app.inject({
      method: 'PUT',
      url: `/api/v1/calendar/${id}`,
      headers: headers(),
      payload: {
        ...payload,
        recurrence: { frequency: 'daily', interval: 1, count: 3, until: null },
        expectedVersion: 2,
        operationId: randomUUID(),
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(
      await db.query('SELECT * FROM event_exceptions WHERE event_id=$1', [id]),
    ).toEqual([]);
  });
  it('rejects invalid ranges and protects advanced schedules from legacy editing', async () => {
    for (const payload of [
      timed({ timeZone: 'Invalid/Zone' }),
      timed({ allDay: true, startDate: '2027-02-30', endDate: '2027-03-02' }),
    ])
      expect((await create('calendar', payload)).statusCode).toBe(400);
    const badDate = await app.inject({
      url: '/api/v1/calendar/occurrences?from=2027-02-30&to=2027-03-02&timeZone=UTC',
      headers: headers(),
    });
    expect(badDate.statusCode).toBe(400);
    expect(
      (
        await app.inject({
          url: '/api/v1/calendar/occurrences?from=2027-01-01&to=2028-01-01&timeZone=UTC',
          headers: headers(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await create(
          'calendar',
          timed({
            allDay: true,
            startDate: '2027-03-07',
            endDate: '2027-03-07',
          }),
        )
      ).statusCode,
    ).toBe(400);
    const created = await create(
      'calendar',
      timed({
        recurrence: { frequency: 'daily', interval: 1, count: 2, until: null },
      }),
    );
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/events/${created.json().event.id}`,
          headers: headers(),
          payload: {
            title: 'Would lose recurrence',
            startsAt: '2027-01-01T10:00:00Z',
            endsAt: '2027-01-01T11:00:00Z',
            timeZone: 'UTC',
            expectedVersion: 1,
            operationId: randomUUID(),
          },
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe('academic portfolios and ownership', () => {
  it('inherits later label upgrades from an occurrence-specific class', async () => {
    const course = (
      await create('courses', { name: 'Occurrence class' })
    ).json().course;
    const event = (
      await create(
        'calendar',
        timed({
          recurrence: {
            frequency: 'daily',
            interval: 1,
            count: 2,
            until: null,
          },
        }),
      )
    ).json().event;
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/v1/calendar/${event.id}/occurrences/2027-03-07`,
      headers: headers(),
      payload: {
        ...timed({ courseId: course.id }),
        expectedVersion: 1,
        operationId: randomUUID(),
      },
    });
    expect(edited.statusCode).toBe(200);
    const upgraded = await app.inject({
      method: 'PUT',
      url: `/api/v1/courses/${course.id}`,
      headers: headers(),
      payload: {
        name: course.name,
        sensitivity: 'restricted',
        expectedVersion: 1,
        operationId: randomUUID(),
      },
    });
    expect(upgraded.statusCode).toBe(200);
    expect(
      (await occurrences('2027-03-07', '2027-03-08')).find(
        (value) => value.id === event.id,
      )?.sensitivity,
    ).toBe('restricted');
  });
  it('inherits labels, keeps manual confidence independent, and rejects mismatched topic links', async () => {
    const course = (
      await create('courses', { name: 'Calculus', sensitivity: 'personal' })
    ).json().course;
    const topicResponse = await create('topics', {
      courseId: course.id,
      name: 'Integrals',
      progress: 25,
      confidence: 'low',
    });
    expect(topicResponse.statusCode).toBe(200);
    const topic = topicResponse.json().topic;
    expect(topic.sensitivity).toBe('personal');
    const session = (
      await create(
        'calendar',
        timed({
          courseId: course.id,
          topicId: topic.id,
          studyStatus: 'completed',
        }),
      )
    ).json().event;
    expect(session.sensitivity).toBe('personal');
    const list = await app.inject({
      url: '/api/v1/topics',
      headers: headers(),
    });
    expect(
      list.json().topics.find((value: { id: string }) => value.id === topic.id),
    ).toMatchObject({ progress: 25, confidence: 'low' });
    const second = (await create('courses', { name: 'Different class' })).json()
      .course;
    const movedTopic = await app.inject({
      method: 'PUT',
      url: `/api/v1/topics/${topic.id}`,
      headers: headers(),
      payload: {
        name: topic.name,
        courseId: second.id,
        expectedVersion: topic.version,
        operationId: randomUUID(),
      },
    });
    expect(movedTopic.statusCode).toBe(400);
    expect(
      (
        await create(
          'calendar',
          timed({ courseId: second.id, topicId: topic.id }),
        )
      ).statusCode,
    ).toBe(400);
    const upgrade = await app.inject({
      method: 'PUT',
      url: `/api/v1/courses/${course.id}`,
      headers: headers(),
      payload: {
        name: 'Calculus',
        sensitivity: 'restricted',
        expectedVersion: 1,
        operationId: randomUUID(),
      },
    });
    expect(upgrade.statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/v1/calendar', headers: headers() }))
        .json()
        .events.find((value: { id: string }) => value.id === session.id)
        .sensitivity,
    ).toBe('restricted');
  });
  it('scopes class/topic/calendar/reminder reads and writes to their owner', async () => {
    for (const path of [
      'courses',
      'topics',
      'calendar',
      'reminders',
      'notifications',
    ])
      expect((await app.inject(`/api/v1/${path}`)).statusCode).toBe(401);
    const course = (await create('courses', { name: 'Private course' })).json()
      .course;
    expect(
      (
        await create(
          'topics',
          { courseId: course.id, name: 'Unauthorized' },
          otherCookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await create('calendar', timed({ courseId: course.id }), otherCookie))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/courses/${course.id}`,
          headers: headers(otherCookie),
          payload: {
            name: 'Unauthorized',
            expectedVersion: 1,
            operationId: randomUUID(),
          },
        })
      ).statusCode,
    ).toBe(404);
    for (const path of ['courses', 'topics', 'calendar']) {
      const result = await app.inject({
        url: `/api/v1/${path}`,
        headers: headers(otherCookie),
      });
      expect(result.json()[path === 'calendar' ? 'events' : path]).toEqual([]);
    }
  });
  it('deduplicates class saves, checks progress bounds and tombstones portfolios', async () => {
    const body = { name: 'Biology', operationId: randomUUID() };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: headers(),
      payload: body,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/courses',
          headers: headers(),
          payload: body,
        })
      ).json(),
    ).toEqual(first.json());
    const id = first.json().course.id;
    expect(
      (await create('topics', { courseId: id, name: 'Invalid', progress: 101 }))
        .statusCode,
    ).toBe(400);
    const topic = (
      await create('topics', { courseId: id, name: 'Cells' })
    ).json().topic;
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/courses/${id}`,
      headers: headers(),
      payload: { expectedVersion: 1, operationId: randomUUID() },
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/v1/topics', headers: headers() }))
        .json()
        .topics.some((value: { id: string }) => value.id === topic.id),
    ).toBe(false);
    expect(
      (
        await db.query('SELECT deleted_at FROM topics WHERE id=$1', [topic.id])
      )[0]!.deleted_at,
    ).not.toBeNull();
  });
});

describe('durable reminder processing', () => {
  const now = new Date('2030-01-01T12:00:00Z');
  beforeEach(async () => {
    await db.exec(
      'DELETE FROM notifications; DELETE FROM reminders; DELETE FROM worker_state;',
    );
  });
  async function reminder(extra: Record<string, unknown> = {}) {
    const response = await create('reminders', {
      title: 'Durable reminder',
      scheduledAt: now.toISOString(),
      ...extra,
    });
    expect(response.statusCode).toBe(200);
    return response.json().reminder as { id: string; version: number };
  }
  it('delivers due jobs once, leaves future jobs queued, and records read state', async () => {
    const due = await reminder();
    await reminder({ scheduledAt: '2031-01-01T00:00:00Z' });
    await Promise.all([runReminderBatch(db, now), runReminderBatch(db, now)]);
    await runReminderBatch(db, now);
    const notes = (
      await app.inject({ url: '/api/v1/notifications', headers: headers() })
    ).json().notifications;
    expect(notes).toHaveLength(1);
    expect(notes[0].reminderId).toBe(due.id);
    const read = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${notes[0].id}/read`,
      headers: headers(),
      payload: { operationId: randomUUID() },
    });
    expect(read.json().notification.readAt).not.toBeNull();
    expect(
      (
        await app.inject({
          url: '/api/v1/notifications',
          headers: headers(otherCookie),
        })
      ).json().notifications,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/notifications/${notes[0].id}/read`,
          headers: headers(otherCookie),
          payload: { operationId: randomUUID() },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('pauses, resumes and cancels jobs without bypassing versions', async () => {
    const job = await reminder();
    const control = (action: string, expectedVersion: number) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/reminders/${job.id}/control`,
        headers: headers(),
        payload: { action, expectedVersion, operationId: randomUUID() },
      });
    expect((await control('pause', 1)).json().reminder.status).toBe('paused');
    await runReminderBatch(db, now);
    expect(await db.query('SELECT id FROM notifications')).toHaveLength(0);
    expect((await control('resume', 1)).statusCode).toBe(409);
    expect((await control('resume', 2)).json().reminder.status).toBe('queued');
    expect((await control('cancel', 3)).json().reminder.status).toBe(
      'cancelled',
    );
    await runReminderBatch(db, now);
    expect(await db.query('SELECT id FROM notifications')).toHaveLength(0);
  });
  it('recovers expired leases and reports exhausted retries with safe error codes', async () => {
    const job = await reminder();
    await db.query(
      "UPDATE reminders SET status='running',attempts=1,lease_token=$2,lease_until=$3 WHERE id=$1",
      [job.id, randomUUID(), new Date(now.getTime() - 1000)],
    );
    await runReminderBatch(db, now);
    expect(
      await db.query('SELECT id FROM notifications WHERE reminder_id=$1', [
        job.id,
      ]),
    ).toHaveLength(1);
    const failing = await reminder({ title: 'Failure test' });
    const fail = async () => {
      throw new Error('synthetic-private-failure');
    };
    await runReminderBatch(db, now, fail);
    await runReminderBatch(db, new Date(now.getTime() + 11000), fail);
    await runReminderBatch(db, new Date(now.getTime() + 32000), fail);
    const state = (
      await app.inject({ url: '/api/v1/reminders', headers: headers() })
    )
      .json()
      .reminders.find((value: { id: string }) => value.id === failing.id);
    expect(state).toMatchObject({
      status: 'failed',
      attempts: 3,
      lastError: 'DELIVERY_FAILED',
    });
    expect(JSON.stringify(state)).not.toContain('synthetic-private');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/reminders/${failing.id}/control`,
          headers: headers(),
          payload: {
            action: 'retry',
            expectedVersion: state.version,
            operationId: randomUUID(),
          },
        })
      ).json().reminder,
    ).toMatchObject({ status: 'queued', attempts: 0 });
    await runReminderBatch(db, new Date(now.getTime() + 40000));
    expect(
      await db.query('SELECT id FROM notifications WHERE reminder_id=$1', [
        failing.id,
      ]),
    ).toHaveLength(1);
  });
  it('cancels reminders for completed/deleted targets and invalidates occurrence reminders after edits', async () => {
    const task = (
      await create('tasks', { title: 'Finished', completed: true })
    ).json().task;
    const job = await reminder({ targetKind: 'task', targetId: task.id });
    await runReminderBatch(db, now);
    expect(
      (await db.query('SELECT status FROM reminders WHERE id=$1', [job.id]))[0]!
        .status,
    ).toBe('cancelled');
    expect(
      (
        await create(
          'reminders',
          {
            title: 'Foreign target',
            scheduledAt: now.toISOString(),
            targetKind: 'task',
            targetId: task.id,
          },
          otherCookie,
        )
      ).statusCode,
    ).toBe(404);
    const event = (
      await create(
        'calendar',
        timed({
          recurrence: {
            frequency: 'weekly',
            interval: 1,
            count: 3,
            until: null,
          },
        }),
      )
    ).json().event;
    const occurrence = await reminder({
      targetKind: 'event',
      targetId: event.id,
      occurrenceDate: '2027-03-14',
    });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/calendar/${event.id}/occurrences/2027-03-14`,
          headers: headers(),
          payload: { expectedVersion: 1, operationId: randomUUID() },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await db.query('SELECT status FROM reminders WHERE id=$1', [
          occurrence.id,
        ])
      )[0]!.status,
    ).toBe('cancelled');
  });
  it('deduplicates scheduling and rejects another owner’s controls', async () => {
    const body = {
      title: 'One scheduled reminder',
      scheduledAt: now.toISOString(),
      operationId: randomUUID(),
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/reminders',
      headers: headers(),
      payload: body,
    });
    const id = first.json().reminder.id;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/reminders',
          headers: headers(),
          payload: body,
        })
      ).json(),
    ).toEqual(first.json());
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/reminders/${id}/control`,
          headers: headers(otherCookie),
          payload: {
            action: 'cancel',
            expectedVersion: 1,
            operationId: randomUUID(),
          },
        })
      ).statusCode,
    ).toBe(404);
  });
});
