import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  reminderSchema,
  taskResponseSchema,
  tasksResponseSchema,
  Temporal,
} from '@hub/contracts';
import type { Task } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  runReminderBatch,
  saveReminderProposal,
} from '../src/features/reminders.js';
import { syncRecurringEventReminders } from '../src/features/recurrence.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
const headers = () => ({ origin, cookie });
const post = (path: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/${path}`,
    headers: headers(),
    payload: { operationId: randomUUID(), ...payload },
  });
const put = (path: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PUT',
    url: `/api/v1/${path}`,
    headers: headers(),
    payload: { operationId: randomUUID(), ...payload },
  });
const del = (path: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'DELETE',
    url: `/api/v1/${path}`,
    headers: headers(),
    payload: { operationId: randomUUID(), ...payload },
  });
const get = (path: string) =>
  app.inject({ url: `/api/v1/${path}`, headers: headers() });
async function tasks() {
  const response = await get('tasks');
  expect(response.statusCode).toBe(200);
  return tasksResponseSchema.parse(response.json()).tasks;
}
async function makeTask(title: string, dueDate = '2027-03-01') {
  const response = await post('tasks', {
    title,
    notes: '',
    dueDate,
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
  });
  expect(response.statusCode).toBe(200);
  return taskResponseSchema.parse(response.json()).task;
}
beforeAll(async () => {
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'recurring@example.test',
      password: 'synthetic-recurring-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => {
  await app?.close();
});

it('completes one repeating task occurrence and creates exactly one next one', async () => {
  const created = await post('tasks', {
    title: 'Plan the week',
    notes: '',
    dueDate: '2027-03-01',
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      count: 4,
      until: null,
      byDay: ['MO', 'WE'],
      timeZone: 'America/Denver',
    },
  });
  expect(created.statusCode).toBe(200);
  const first = taskResponseSchema.parse(created.json()).task;
  expect(first.seriesId).not.toBeNull();
  expect(first.occurrenceKey).toBe('2027-03-01');
  expect(first.recurrence?.byDay).toEqual(['MO', 'WE']);

  const completed = await put(`tasks/${first.id}`, {
    title: first.title,
    notes: first.notes,
    dueDate: first.dueDate,
    priority: first.priority,
    completed: true,
    sensitivity: first.sensitivity,
    expectedVersion: first.version,
  });
  expect(completed.statusCode).toBe(200);
  const after = await tasks();
  const series = after.filter((task) => task.seriesId === first.seriesId);
  expect(series.map((task) => task.dueDate).sort()).toEqual([
    '2027-03-01',
    '2027-03-03',
  ]);
  expect(series.find((task) => task.dueDate === '2027-03-03')?.completed).toBe(
    false,
  );

  // Repeating the same completion (or a retried worker) must not duplicate it.
  await put(`tasks/${first.id}`, {
    title: first.title,
    notes: first.notes,
    dueDate: first.dueDate,
    priority: first.priority,
    completed: true,
    sensitivity: first.sensitivity,
    expectedVersion: completed.json().task.version,
  });
  expect(
    (await tasks()).filter((task) => task.seriesId === first.seriesId),
  ).toHaveLength(2);
});

it('edits and deletes this occurrence versus all future occurrences', async () => {
  const created = await post('tasks', {
    title: 'Daily review',
    notes: '',
    dueDate: '2027-04-01',
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
    recurrence: {
      frequency: 'daily',
      interval: 1,
      count: 5,
      until: null,
      timeZone: 'America/Denver',
    },
  });
  const first = taskResponseSchema.parse(created.json()).task;
  await put(`tasks/${first.id}`, {
    title: first.title,
    notes: first.notes,
    dueDate: first.dueDate,
    priority: first.priority,
    completed: true,
    sensitivity: first.sensitivity,
    expectedVersion: first.version,
  });
  const second = (await tasks()).find(
    (task) => task.seriesId === first.seriesId && task.dueDate === '2027-04-02',
  )!;
  expect(second).toBeTruthy();

  const edited = await put(`tasks/${second.id}`, {
    title: 'Daily review (renamed)',
    notes: second.notes,
    dueDate: second.dueDate,
    priority: second.priority,
    completed: false,
    sensitivity: second.sensitivity,
    scope: 'future',
    expectedVersion: second.version,
  });
  expect(edited.statusCode).toBe(200);
  expect((await tasks()).find((task) => task.id === second.id)?.title).toBe(
    'Daily review (renamed)',
  );

  const skipped = await del(`tasks/${second.id}`, {
    expectedVersion: edited.json().task.version,
    scope: 'this',
  });
  expect(skipped.statusCode).toBe(200);
  const afterSkip = await tasks();
  expect(afterSkip.find((task) => task.id === second.id)).toBeUndefined();
  const third = afterSkip.find(
    (task) => task.seriesId === first.seriesId && task.dueDate === '2027-04-03',
  )!;
  expect(third).toBeTruthy();

  const stopped = await del(`tasks/${third.id}`, {
    expectedVersion: third.version,
    scope: 'future',
  });
  expect(stopped.statusCode).toBe(200);
  expect(
    (await tasks()).filter((task) => task.seriesId === first.seriesId),
  ).toHaveLength(1);
});

it('shifts materialized future tasks when this-and-future dates move', async () => {
  const created = await post('tasks', {
    title: 'Shifted series',
    notes: '',
    dueDate: '2027-08-01',
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
    recurrence: {
      frequency: 'daily',
      interval: 1,
      count: 5,
      until: null,
      timeZone: 'America/Denver',
    },
  });
  const first = taskResponseSchema.parse(created.json()).task;
  const complete = async (task: {
    id: string;
    version: number;
    title: string;
    notes: string;
    dueDate: string | null;
    priority: 'low' | 'normal' | 'high';
    sensitivity: 'unlabeled' | 'personal' | 'restricted';
  }) => {
    const response = await put(`tasks/${task.id}`, {
      title: task.title,
      notes: task.notes,
      dueDate: task.dueDate,
      priority: task.priority,
      completed: true,
      sensitivity: task.sensitivity,
      expectedVersion: task.version,
    });
    return taskResponseSchema.parse(response.json()).task as Task;
  };
  await complete(first);
  const second = (await tasks()).find(
    (task) => task.seriesId === first.seriesId && task.dueDate === '2027-08-02',
  )!;
  const secondDone = await complete(second);
  const third = (await tasks()).find(
    (task) => task.seriesId === first.seriesId && task.dueDate === '2027-08-03',
  )!;
  expect(third).toBeTruthy();
  // A manually edited future occurrence is no longer an untouched generated
  // row, so reopening the current occurrence must keep it for the shift test.
  const editedFuture = await put(`tasks/${third.id}`, {
    title: 'Shifted future',
    notes: third.notes,
    dueDate: third.dueDate,
    priority: third.priority,
    completed: false,
    sensitivity: third.sensitivity,
    expectedVersion: third.version,
  });
  expect(editedFuture.statusCode).toBe(200);
  const reopened = await put(`tasks/${second.id}`, {
    title: second.title,
    notes: second.notes,
    dueDate: second.dueDate,
    priority: second.priority,
    completed: false,
    sensitivity: second.sensitivity,
    expectedVersion: secondDone.version,
  });
  expect(reopened.statusCode).toBe(200);
  const edited = await put(`tasks/${second.id}`, {
    title: 'Shifted series',
    notes: second.notes,
    dueDate: '2027-08-04',
    priority: second.priority,
    completed: false,
    sensitivity: second.sensitivity,
    scope: 'future',
    expectedVersion: reopened.json().task.version,
  });
  expect(edited.statusCode).toBe(200);
  const moved = (await tasks())
    .filter((task) => task.seriesId === first.seriesId)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  expect(moved.map((task) => task.dueDate)).toEqual([
    '2027-08-01',
    '2027-08-04',
    '2027-08-05',
  ]);
});

it('splits an event occurrence into this and all future', async () => {
  const created = await post('calendar', {
    title: 'Split series',
    notes: '',
    startsAt: '2027-09-01T09:00:00-06:00',
    endsAt: '2027-09-01T10:00:00-06:00',
    timeZone: 'America/Denver',
    sensitivity: 'unlabeled',
    allDay: false,
    startDate: null,
    endDate: null,
    courseId: null,
    topicId: null,
    studyStatus: 'planned',
    recurrence: {
      frequency: 'daily',
      interval: 1,
      count: 4,
      until: null,
      timeZone: 'America/Denver',
    },
  });
  const first = (created.json() as { event: { id: string; version: number } })
    .event;
  const edited = await put(`calendar/${first.id}/occurrences/2027-09-02`, {
    title: 'Split series (future)',
    notes: '',
    startsAt: '2027-09-02T09:00:00-06:00',
    endsAt: '2027-09-02T10:00:00-06:00',
    timeZone: 'America/Denver',
    sensitivity: 'unlabeled',
    allDay: false,
    startDate: null,
    endDate: null,
    courseId: null,
    topicId: null,
    studyStatus: 'planned',
    recurrence: {
      frequency: 'daily',
      interval: 1,
      count: 4,
      until: null,
      timeZone: 'America/Denver',
    },
    expectedVersion: first.version,
    scope: 'future',
  });
  expect(edited.statusCode).toBe(200);
  const query = new URLSearchParams({
    from: '2027-09-01',
    to: '2027-09-06',
    timeZone: 'America/Denver',
  });
  const occurrenceList = async () =>
    (await get(`calendar/occurrences?${query}`)).json().occurrences as {
      title: string;
      originalDate: string;
    }[];
  let occurrences = await occurrenceList();
  expect(occurrences.map((item) => [item.originalDate, item.title])).toEqual([
    ['2027-09-01', 'Split series'],
    ['2027-09-02', 'Split series (future)'],
    ['2027-09-03', 'Split series (future)'],
    ['2027-09-04', 'Split series (future)'],
  ]);
  const future = (await get('calendar'))
    .json()
    .events.filter(
      (item: { title: string }) => item.title === 'Split series (future)',
    )[0];
  const stopped = await del(`calendar/${future.id}/occurrences/2027-09-03`, {
    expectedVersion: future.version,
    scope: 'future',
  });
  expect(stopped.statusCode).toBe(200);
  occurrences = await occurrenceList();
  expect(occurrences.map((item) => item.originalDate)).toEqual([
    '2027-09-01',
    '2027-09-02',
  ]);
});

it('removes an untouched generated occurrence when a repeat is reopened', async () => {
  const created = await post('tasks', {
    title: 'Reopen repeat',
    notes: '',
    dueDate: '2027-10-01',
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
    recurrence: {
      frequency: 'daily',
      interval: 1,
      count: 3,
      until: null,
      timeZone: 'America/Denver',
    },
  });
  const first = taskResponseSchema.parse(created.json()).task;
  const done = await put(`tasks/${first.id}`, {
    title: first.title,
    notes: first.notes,
    dueDate: first.dueDate,
    priority: first.priority,
    completed: true,
    sensitivity: first.sensitivity,
    expectedVersion: first.version,
  });
  expect(done.statusCode).toBe(200);
  expect(
    (await tasks()).find(
      (task) =>
        task.seriesId === first.seriesId && task.dueDate === '2027-10-02',
    ),
  ).toBeTruthy();
  const reopened = await put(`tasks/${first.id}`, {
    title: first.title,
    notes: first.notes,
    dueDate: first.dueDate,
    priority: first.priority,
    completed: false,
    sensitivity: first.sensitivity,
    expectedVersion: taskResponseSchema.parse(done.json()).task.version,
  });
  expect(reopened.statusCode).toBe(200);
  expect(
    (await tasks()).filter((task) => task.seriesId === first.seriesId),
  ).toHaveLength(1);
});

it('revives cancelled offset reminders when a task returns to active', async () => {
  const task = await makeTask('Revive offsets', '2027-11-01');
  const savedResponse = await put(`tasks/${task.id}`, {
    title: task.title,
    notes: task.notes,
    dueDate: task.dueDate,
    dueAt: '2027-11-01T09:00:00-07:00',
    dueTimeZone: 'America/Denver',
    reminderOffsets: [60],
    priority: task.priority,
    completed: false,
    sensitivity: task.sensitivity,
    expectedVersion: task.version,
  });
  const saved = taskResponseSchema.parse(savedResponse.json()).task;
  const offsetRows = async () =>
    (await get('reminders'))
      .json()
      .reminders.filter(
        (row: { targetId: string | null; offsetMinutes: number | null }) =>
          row.targetId === saved.id && row.offsetMinutes === 60,
      ) as { id: string; status: string }[];
  expect((await offsetRows())[0]!.status).toBe('queued');

  const completed = await put(`tasks/${saved.id}`, {
    title: saved.title,
    notes: saved.notes,
    dueDate: saved.dueDate,
    dueAt: saved.dueAt,
    dueTimeZone: saved.dueTimeZone,
    priority: saved.priority,
    completed: true,
    sensitivity: saved.sensitivity,
    expectedVersion: saved.version,
  });
  expect((await offsetRows())[0]!.status).toBe('cancelled');
  const reopened = await put(`tasks/${saved.id}`, {
    title: saved.title,
    notes: saved.notes,
    dueDate: saved.dueDate,
    dueAt: saved.dueAt,
    dueTimeZone: saved.dueTimeZone,
    priority: saved.priority,
    completed: false,
    sensitivity: saved.sensitivity,
    expectedVersion: taskResponseSchema.parse(completed.json()).task.version,
  });
  expect((await offsetRows())[0]!.status).toBe('queued');

  const removed = await del(`tasks/${saved.id}`, {
    expectedVersion: taskResponseSchema.parse(reopened.json()).task.version,
  });
  expect(removed.statusCode).toBe(200);
  expect((await offsetRows())[0]!.status).toBe('cancelled');
  const restored = await post(`tasks/${saved.id}/restore`, {
    expectedVersion: taskResponseSchema.parse(removed.json()).task.version,
  });
  expect(restored.statusCode).toBe(200);
  expect((await offsetRows())[0]!.status).toBe('queued');
});

it('restores a deleted series from one Recently deleted occurrence', async () => {
  const created = await post('tasks', {
    title: 'Restore series',
    notes: '',
    dueDate: '2027-12-20',
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
    recurrence: {
      frequency: 'daily',
      interval: 1,
      count: 3,
      until: null,
      timeZone: 'America/Denver',
    },
  });
  const first = taskResponseSchema.parse(created.json()).task;
  await put(`tasks/${first.id}`, {
    title: first.title,
    notes: first.notes,
    dueDate: first.dueDate,
    priority: first.priority,
    completed: true,
    sensitivity: first.sensitivity,
    expectedVersion: first.version,
  });
  const second = (await tasks()).find(
    (task) => task.seriesId === first.seriesId && task.dueDate === '2027-12-21',
  )!;
  const deleted = await del(`tasks/${second.id}`, {
    expectedVersion: second.version,
    scope: 'series',
  });
  expect(deleted.statusCode).toBe(200);
  expect(
    (await tasks()).filter((task) => task.seriesId === first.seriesId),
  ).toHaveLength(0);
  const restored = await post(`tasks/${second.id}/restore`, {
    expectedVersion: taskResponseSchema.parse(deleted.json()).task.version,
  });
  expect(restored.statusCode).toBe(200);
  expect(
    (await tasks()).filter((task) => task.seriesId === first.seriesId),
  ).toHaveLength(2);
  const [series] = await db.query(
    `SELECT deleted_at AS "deletedAt",cancelled_from AS "cancelledFrom"
     FROM recurrence_series WHERE id=$1`,
    [first.seriesId],
  );
  expect(series).toMatchObject({ deletedAt: null, cancelledFrom: null });
  // The completed first occurrence stays completed; the open occurrence returns.
  expect(taskResponseSchema.parse(restored.json()).task.completed).toBe(false);
  expect((await tasks()).find((task) => task.id === first.id)?.completed).toBe(
    true,
  );
});

it('restores a this-and-future deletion batch and clears its cut', async () => {
  const created = await post('tasks', {
    title: 'Future restore',
    notes: '',
    dueDate: '2028-01-01',
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
    recurrence: {
      frequency: 'daily',
      interval: 1,
      count: 4,
      until: null,
      timeZone: 'America/Denver',
    },
  });
  const first = taskResponseSchema.parse(created.json()).task;
  await put(`tasks/${first.id}`, {
    title: first.title,
    notes: first.notes,
    dueDate: first.dueDate,
    priority: first.priority,
    completed: true,
    sensitivity: first.sensitivity,
    expectedVersion: first.version,
  });
  const second = (await tasks()).find(
    (task) => task.seriesId === first.seriesId && task.dueDate === '2028-01-02',
  )!;
  const stopped = await del(`tasks/${second.id}`, {
    expectedVersion: second.version,
    scope: 'future',
  });
  expect(stopped.statusCode).toBe(200);
  expect(
    (await tasks()).filter((task) => task.seriesId === first.seriesId),
  ).toHaveLength(1);
  const restored = await post(`tasks/${second.id}/restore`, {
    expectedVersion: taskResponseSchema.parse(stopped.json()).task.version,
  });
  expect(restored.statusCode).toBe(200);
  expect(
    (await tasks()).filter((task) => task.seriesId === first.seriesId),
  ).toHaveLength(2);
  const [series] = await db.query(
    `SELECT cancelled_from AS "cancelledFrom",deleted_at AS "deletedAt"
     FROM recurrence_series WHERE id=$1`,
    [first.seriesId],
  );
  expect(series).toMatchObject({ cancelledFrom: null, deletedAt: null });
});

it('keeps a later generated occurrence when its parent was completed', async () => {
  const created = await post('tasks', {
    title: 'Nested reopen',
    notes: '',
    dueDate: '2028-03-01',
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
    recurrence: {
      frequency: 'daily',
      interval: 1,
      count: 5,
      until: null,
      timeZone: 'America/Denver',
    },
  });
  const first = taskResponseSchema.parse(created.json()).task;
  const complete = async (task: Task) => {
    const response = await put(`tasks/${task.id}`, {
      title: task.title,
      notes: task.notes,
      dueDate: task.dueDate,
      priority: task.priority,
      completed: true,
      sensitivity: task.sensitivity,
      expectedVersion: task.version,
    });
    return taskResponseSchema.parse(response.json()).task;
  };
  await complete(first);
  const second = (await tasks()).find(
    (task) => task.seriesId === first.seriesId && task.dueDate === '2028-03-02',
  )!;
  const secondDone = await complete(second);
  const third = (await tasks()).find(
    (task) => task.seriesId === first.seriesId && task.dueDate === '2028-03-03',
  )!;
  expect(third).toBeTruthy();
  const reopened = await put(`tasks/${first.id}`, {
    title: first.title,
    notes: first.notes,
    dueDate: first.dueDate,
    priority: first.priority,
    completed: false,
    sensitivity: first.sensitivity,
    expectedVersion: taskResponseSchema.parse(
      (await get(`tasks/${first.id}`)).json(),
    ).task.version,
  });
  expect(reopened.statusCode).toBe(200);
  expect(
    (await tasks()).filter((task) => task.seriesId === first.seriesId),
  ).toHaveLength(3);
  expect(secondDone.completed).toBe(true);
});

it('keeps offset reminders when a series stops repeating', async () => {
  const created = await post('tasks', {
    title: 'Stop repeating offsets',
    notes: '',
    dueDate: '2029-01-01',
    dueAt: '2029-01-01T09:00:00-07:00',
    dueTimeZone: 'America/Denver',
    reminderOffsets: [60],
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
    recurrence: {
      frequency: 'daily',
      interval: 1,
      count: 4,
      until: null,
      timeZone: 'America/Denver',
    },
  });
  const first = taskResponseSchema.parse(created.json()).task;
  const firstDone = await put(`tasks/${first.id}`, {
    title: first.title,
    notes: first.notes,
    dueDate: first.dueDate,
    priority: first.priority,
    completed: true,
    sensitivity: first.sensitivity,
    expectedVersion: first.version,
  });
  const second = (await tasks()).find(
    (task) => task.seriesId === first.seriesId && task.dueDate === '2029-01-02',
  )!;
  await put(`tasks/${second.id}`, {
    title: 'Future edited',
    notes: second.notes,
    dueDate: second.dueDate,
    dueAt: second.dueAt,
    dueTimeZone: second.dueTimeZone,
    priority: second.priority,
    completed: false,
    sensitivity: second.sensitivity,
    expectedVersion: second.version,
  });
  const reopened = await put(`tasks/${first.id}`, {
    title: first.title,
    notes: first.notes,
    dueDate: first.dueDate,
    dueAt: first.dueAt,
    dueTimeZone: first.dueTimeZone,
    priority: first.priority,
    completed: false,
    sensitivity: first.sensitivity,
    expectedVersion: taskResponseSchema.parse(firstDone.json()).task.version,
  });
  expect(reopened.statusCode).toBe(200);
  const stopped = await put(`tasks/${first.id}`, {
    title: first.title,
    notes: first.notes,
    dueDate: first.dueDate,
    dueAt: first.dueAt,
    dueTimeZone: first.dueTimeZone,
    priority: first.priority,
    completed: false,
    sensitivity: first.sensitivity,
    recurrence: null,
    scope: 'future',
    expectedVersion: taskResponseSchema.parse(reopened.json()).task.version,
  });
  expect(stopped.statusCode).toBe(200);
  const reminderFor = async (targetId: string) =>
    (await get('reminders'))
      .json()
      .reminders.find(
        (row: { targetId: string | null; offsetMinutes: number | null }) =>
          row.targetId === targetId && row.offsetMinutes === 60,
      ) as { status: string } | undefined;
  expect((await reminderFor(first.id))?.status).toBe('queued');
  const deletedSecond = taskResponseSchema.parse(
    (await get(`tasks/${second.id}`)).json(),
  ).task;
  const restored = await post(`tasks/${second.id}/restore`, {
    expectedVersion: deletedSecond.version,
  });
  expect(restored.statusCode).toBe(200);
  expect((await reminderFor(second.id))?.status).toBe('queued');
});

it('delivers a repeating reminder, schedules the next, and cancels the series', async () => {
  const target = await makeTask('Water plants', '2027-05-01');
  const created = await post('reminders', {
    title: 'Water plants',
    scheduledAt: '2027-05-01T09:00:00-06:00',
    targetKind: 'task',
    targetId: target.id,
    occurrenceDate: null,
    recurrence: {
      frequency: 'daily',
      interval: 1,
      count: 3,
      until: null,
      timeZone: 'America/Denver',
    },
  });
  expect(created.statusCode).toBe(200);
  const first = reminderSchema.parse(created.json().reminder);
  expect(first.seriesId).not.toBeNull();
  const delivered = await runReminderBatch(
    db,
    new Date('2027-05-01T15:05:00.000Z'),
  );
  expect(delivered).toBe(1);
  const rows = (await get('reminders')).json().reminders as {
    id: string;
    status: string;
    scheduledAt: string;
    seriesId: string | null;
  }[];
  const series = rows.filter((row) => row.seriesId === first.seriesId);
  expect(series.map((row) => row.status).sort()).toEqual([
    'delivered',
    'queued',
  ]);
  const next = series.find((row) => row.status === 'queued')!;
  expect(next.scheduledAt).toBe('2027-05-02T15:00:00.000Z');

  // Dismiss is idempotent: the next occurrence already exists.
  const current = (await get(`reminders/${first.id}`)).json().reminder as {
    version: number;
  };
  const dismissed = await post(`reminders/${first.id}/dismiss`, {
    expectedVersion: current.version,
  });
  expect(dismissed.statusCode).toBe(200);
  const afterDismiss = (await get('reminders')).json().reminders as {
    seriesId: string | null;
  }[];
  expect(
    afterDismiss.filter((row) => row.seriesId === first.seriesId),
  ).toHaveLength(2);

  const cancelled = await post(`reminders/${next.id}/control`, {
    action: 'cancel',
    scope: 'series',
    expectedVersion: 1,
  });
  expect(cancelled.statusCode).toBe(200);
  const afterCancel = (await get('reminders')).json().reminders as {
    status: string;
    seriesId: string | null;
  }[];
  expect(
    afterCancel
      .filter((row) => row.seriesId === first.seriesId)
      .every((row) => row.status !== 'queued' && row.status !== 'paused'),
  ).toBe(true);
});

it('accepts a recurring reminder proposal through the agent write path', async () => {
  const target = await makeTask('Agent recurrence target', '2027-07-01');
  const [ownerRow] = await db.query('SELECT id FROM users LIMIT 1');
  const owner = String(ownerRow!.id);
  const saved = await saveReminderProposal(db, owner, 'POST', null, {
    title: 'Agent weekly reminder',
    scheduledAt: '2027-07-04T19:00:00-06:00',
    targetKind: 'task',
    targetId: target.id,
    occurrenceDate: null,
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      count: 4,
      until: null,
      byDay: ['SU'],
      timeZone: 'America/Denver',
    },
    operationId: randomUUID(),
  });
  expect(saved.reminder.seriesId).not.toBeNull();
  expect(saved.reminder.recurrence).toMatchObject({ byDay: ['SU'] });
  const [row] = await db.query(
    'SELECT occurrence_key FROM reminders WHERE owner_id=$1 AND id=$2',
    [owner, saved.reminder.id],
  );
  expect(
    row!.occurrence_key instanceof Date
      ? row!.occurrence_key.toISOString().slice(0, 10)
      : String(row!.occurrence_key).slice(0, 10),
  ).toBe('2027-07-04');

  const moved = await saveReminderProposal(
    db,
    owner,
    'PUT',
    saved.reminder.id,
    {
      title: saved.reminder.title,
      scheduledAt: '2027-07-11T19:00:00-06:00',
      operationId: randomUUID(),
      expectedVersion: saved.reminder.version,
    },
  );
  expect(moved.reminder.recurrence).toMatchObject({ byDay: ['SU'] });
});

it('creates one reminder per event occurrence offset', async () => {
  const firstDate = Temporal.Now.plainDateISO().add({ days: 10 });
  const secondDate = firstDate.add({ days: 7 });
  const firstStart = firstDate
    .toPlainDateTime({ hour: 19 })
    .toZonedDateTime('America/Denver', { disambiguation: 'compatible' })
    .toInstant();
  const firstEnd = firstDate
    .toPlainDateTime({ hour: 20 })
    .toZonedDateTime('America/Denver', { disambiguation: 'compatible' })
    .toInstant();
  const created = await post('calendar', {
    title: 'Weekly planning',
    notes: '',
    startsAt: firstStart.toString({ smallestUnit: 'millisecond' }),
    endsAt: firstEnd.toString({ smallestUnit: 'millisecond' }),
    timeZone: 'America/Denver',
    sensitivity: 'unlabeled',
    allDay: false,
    startDate: null,
    endDate: null,
    courseId: null,
    topicId: null,
    studyStatus: 'planned',
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      count: 2,
      until: null,
      timeZone: 'America/Denver',
    },
    reminderOffsets: [60],
  });
  expect(created.statusCode).toBe(200);
  const eventId = created.json().event.id;
  const raw = await db.query<{
    occurrence_date: string;
    offset_minutes: number;
  }>(
    'SELECT occurrence_date,offset_minutes,status FROM reminders WHERE target_id=$1 ORDER BY occurrence_date',
    [eventId],
  );
  expect(raw).toHaveLength(2);
  const rows = (await get('reminders')).json().reminders as {
    targetId: string | null;
    occurrenceDate: string | null;
    offsetMinutes: number | null;
    scheduledAt: string;
    title: string;
  }[];
  const generated = rows.filter(
    (row) => row.targetId === eventId && row.offsetMinutes === 60,
  );
  const expectedDates = [firstDate.toString(), secondDate.toString()].sort();
  expect(generated.map((row) => row.occurrenceDate).sort()).toEqual(
    expectedDates,
  );
  expect(
    generated.find((row) => row.occurrenceDate === firstDate.toString())!
      .scheduledAt,
  ).toBe(
    firstStart
      .subtract({ minutes: 60 })
      .toString({ smallestUnit: 'millisecond' }),
  );

  const event = created.json().event as { id: string; version: number };
  const deleted = await del(`calendar/${event.id}`, {
    expectedVersion: event.version,
  });
  expect(deleted.statusCode).toBe(200);
  const statuses = async () =>
    (await get('reminders'))
      .json()
      .reminders.filter(
        (row: { targetId: string | null; offsetMinutes: number | null }) =>
          row.targetId === event.id && row.offsetMinutes === 60,
      )
      .map((row: { status: string }) => row.status);
  expect(await statuses()).toEqual(['cancelled', 'cancelled']);
  const restored = await post(`calendar/${event.id}/restore`, {
    expectedVersion: (deleted.json() as { event: { version: number } }).event
      .version,
  });
  expect(restored.statusCode).toBe(200);
  expect(await statuses()).toEqual(['queued', 'queued']);
});

it('keeps a user-cancelled offset reminder cancelled through a sweep', async () => {
  const offsetDate = Temporal.Now.plainDateISO().add({ days: 12 });
  const offsetStart = offsetDate
    .toPlainDateTime({ hour: 9 })
    .toZonedDateTime('America/Denver', { disambiguation: 'compatible' })
    .toInstant();
  const offsetEnd = offsetDate
    .toPlainDateTime({ hour: 10 })
    .toZonedDateTime('America/Denver', { disambiguation: 'compatible' })
    .toInstant();
  const created = await post('calendar', {
    title: 'User cancelled offset',
    notes: '',
    startsAt: offsetStart.toString({ smallestUnit: 'millisecond' }),
    endsAt: offsetEnd.toString({ smallestUnit: 'millisecond' }),
    timeZone: 'America/Denver',
    sensitivity: 'unlabeled',
    allDay: false,
    startDate: null,
    endDate: null,
    courseId: null,
    topicId: null,
    studyStatus: 'planned',
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      count: 2,
      until: null,
      timeZone: 'America/Denver',
    },
    reminderOffsets: [60],
  });
  expect(created.statusCode).toBe(200);
  const event = created.json().event as { id: string };
  const [offset] = (await get('reminders'))
    .json()
    .reminders.filter(
      (row: {
        targetId: string | null;
        offsetMinutes: number | null;
        occurrenceDate: string | null;
      }) =>
        row.targetId === event.id &&
        row.offsetMinutes === 60 &&
        row.occurrenceDate === offsetDate.toString(),
    ) as { id: string; version: number; status: string }[];
  expect(offset!.status).toBe('queued');
  const cancelled = await post(`reminders/${offset!.id}/control`, {
    action: 'cancel',
    expectedVersion: offset!.version,
  });
  expect(cancelled.statusCode).toBe(200);
  await syncRecurringEventReminders(db);
  const [after] = (await get('reminders'))
    .json()
    .reminders.filter((row: { id: string }) => row.id === offset!.id) as {
    status: string;
  }[];
  expect(after!.status).toBe('cancelled');
});

it('leaves a due queued offset reminder alone during sync', async () => {
  const created = await makeTask('Past due offset', '2020-01-01');
  const withOffset = await put(`tasks/${created.id}`, {
    title: created.title,
    notes: created.notes,
    dueDate: created.dueDate,
    dueAt: created.dueAt,
    dueTimeZone: created.dueTimeZone,
    reminderOffsets: [60],
    priority: created.priority,
    completed: false,
    sensitivity: created.sensitivity,
    expectedVersion: created.version,
  });
  const task = taskResponseSchema.parse(withOffset.json()).task;
  const [ownerRow] = await db.query('SELECT id FROM users LIMIT 1');
  const owner = String(ownerRow!.id);
  const reminderId = randomUUID();
  await db.query(
    `INSERT INTO reminders(id,owner_id,title,scheduled_at,target_kind,target_id,
       occurrence_date,offset_minutes,status)
     VALUES($1,$2,$3,$4,'task',$5,$6,60,'queued')`,
    [
      reminderId,
      owner,
      'Past due offset',
      '2020-01-01T08:00:00.000Z',
      task.id,
      '2020-01-01',
    ],
  );
  const saved = await put(`tasks/${task.id}`, {
    title: 'Past due offset renamed',
    notes: task.notes,
    dueDate: task.dueDate,
    priority: task.priority,
    completed: false,
    sensitivity: task.sensitivity,
    expectedVersion: task.version,
  });
  expect(saved.statusCode).toBe(200);
  const [reminder] = await db.query(
    'SELECT status FROM reminders WHERE id=$1',
    [reminderId],
  );
  expect(reminder!.status).toBe('queued');
});

it('keeps offsets on a task and refreshes them when the due time changes', async () => {
  const task = await makeTask('Prepare slides', '2027-06-01');
  const created = await put(`tasks/${task.id}`, {
    title: task.title,
    notes: task.notes,
    dueDate: task.dueDate,
    dueAt: '2027-06-01T09:00:00-06:00',
    dueTimeZone: 'America/Denver',
    reminderOffsets: [1440, 60],
    priority: task.priority,
    completed: false,
    sensitivity: task.sensitivity,
    expectedVersion: task.version,
  });
  expect(created.statusCode).toBe(200);
  const saved = taskResponseSchema.parse(created.json()).task as Task;
  expect(saved.reminderOffsets).toEqual([1440, 60]);
  const rows = (await get('reminders')).json().reminders as {
    targetId: string | null;
    offsetMinutes: number | null;
    scheduledAt: string;
  }[];
  const offsets = rows
    .filter((row) => row.targetId === task.id && row.offsetMinutes !== null)
    .sort((a, b) => a.offsetMinutes! - b.offsetMinutes!);
  expect(offsets.map((row) => row.offsetMinutes)).toEqual([60, 1440]);
  expect(offsets[0]!.scheduledAt).toBe('2027-06-01T14:00:00.000Z');
  expect(offsets[1]!.scheduledAt).toBe('2027-05-31T15:00:00.000Z');
  await db.query(
    `UPDATE reminders SET status='failed'
     WHERE target_id=$1 AND offset_minutes=60`,
    [task.id],
  );

  const renamed = await put(`tasks/${task.id}`, {
    title: 'Prepare slides (renamed)',
    notes: saved.notes,
    dueDate: saved.dueDate,
    dueAt: saved.dueAt,
    dueTimeZone: saved.dueTimeZone,
    priority: saved.priority,
    completed: false,
    sensitivity: saved.sensitivity,
    expectedVersion: saved.version,
  });
  expect(renamed.statusCode).toBe(200);
  expect(taskResponseSchema.parse(renamed.json()).task.reminderOffsets).toEqual(
    [1440, 60],
  );
  const [rescheduled] = await db.query(
    `SELECT status FROM reminders
     WHERE target_id=$1 AND offset_minutes=60`,
    [task.id],
  );
  expect(rescheduled!.status).toBe('queued');
});
