import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  calendarBatchResponseSchema,
  plannerExportSchema,
} from '@hub/contracts';
import type { CalendarRecord } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { runReminderBatch } from '../src/features/reminders.js';
import { resolveAIContext } from '../src/features/ai-routing.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
async function removeSyntheticArtifact(root: string, directory: string) {
  const target = resolve(directory);
  if (dirname(target) !== root)
    throw Error('Invalid synthetic artifact directory');
  await rm(target, { recursive: true, force: true });
}
let app: Awaited<ReturnType<typeof buildApp>>,
  db: Awaited<ReturnType<typeof openDatabase>>;
let owner: string, cookie: string, otherCookie: string, courseId: string;
const headers = () => ({ origin, cookie });
const get = (url: string) => app.inject({ url, headers: headers() });
const write = (
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload: object,
) => app.inject({ method, url, payload, headers: headers() });
const change = (expectedVersion: number) => ({
  operationId: randomUUID(),
  expectedVersion,
});
const item = (event: CalendarRecord) => ({
  id: event.id,
  expectedVersion: event.version,
});
const input = (events: CalendarRecord[], action: object) => ({
  operationId: randomUUID(),
  items: events.map(item),
  action,
});
const batch = (payload: object) =>
  write('POST', '/api/v1/calendar/batch', payload);
const eventFields = (fields: object = {}) => ({
  title: 'Synthetic study block',
  notes: 'Private study notes',
  startsAt: '2030-04-04T09:00:00Z',
  endsAt: '2030-04-04T09:25:00Z',
  timeZone: 'UTC',
  courseId,
  ...fields,
});
async function create(fields: object = {}): Promise<CalendarRecord> {
  const response = await write('POST', '/api/v1/calendar', {
    operationId: randomUUID(),
    ...eventFields(fields),
  });
  expect(response.statusCode).toBe(200);
  return response.json().event;
}
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('Network forbidden');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'calendar-batch@example.test',
      password: 'synthetic-calendar-batch-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  const other = randomUUID(),
    token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-calendar-batch@example.test',
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
  const course = await write('POST', '/api/v1/courses', {
    operationId: randomUUID(),
    name: 'Synthetic Chemistry',
    sensitivity: 'personal',
  });
  expect(course.statusCode).toBe(200);
  courseId = course.json().course.id;
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app?.close();
});

it('validates bounded explicit record selection and excludes arbitrary planner/source writes', async () => {
  const event = await create();
  const valid = input([event], { kind: 'study-status', status: 'completed' });
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, items: [] },
    {
      ...valid,
      items: [item(event), { ...item(event), id: event.id.toUpperCase() }],
    },
    {
      ...valid,
      items: Array.from({ length: 101 }, () => ({
        id: randomUUID(),
        expectedVersion: 1,
      })),
    },
    { ...valid, items: [{ ...item(event), expectedVersion: 0 }] },
    { ...valid, items: [{ ...item(event), occurrenceDate: '2030-04-04' }] },
    ...[
      { kind: 'study-status', status: 'submitted' },
      { kind: 'study-status', status: 'completed', sensitivity: 'unlabeled' },
      { kind: 'study-status', status: 'completed', title: 'Overwrite' },
      { kind: 'delete', status: 'cancelled' },
      { kind: 'restore' },
      { kind: 'update', startsAt: '2030-04-04T10:00:00Z' },
      { kind: 'invitation', recipients: ['synthetic@example.test'] },
    ].map((action) => ({ ...valid, action })),
  ])
    expect((await batch(invalid)).statusCode).toBe(400);
  expect((await get(`/api/v1/calendar/${event.id}`)).json().event).toEqual(
    event,
  );
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE operation_id=$1',
      [valid.operationId],
    ),
  ).toEqual([]);
});

it('changes selected one-time study statuses only while preserving all planner fields and input order', async () => {
  const first = await create(),
    second = await create({ studyStatus: 'cancelled' }),
    untouched = await create();
  const selected = [second, first];
  const response = await batch(
    input(selected, { kind: 'study-status', status: 'completed' }),
  );
  expect(response.statusCode).toBe(200);
  const result = calendarBatchResponseSchema.parse(response.json());
  expect(result.events.map((event) => event.id)).toEqual(
    selected.map((event) => event.id),
  );
  for (const [index, previous] of selected.entries())
    expect(result.events[index]).toEqual({
      ...previous,
      studyStatus: 'completed',
      version: 2,
      updatedAt: result.events[index]!.updatedAt,
    });
  expect((await get(`/api/v1/calendar/${untouched.id}`)).json().event).toEqual(
    untouched,
  );
  const resumed = await batch(
    input(result.events, { kind: 'study-status', status: 'planned' }),
  );
  expect(resumed.statusCode).toBe(200);
  expect(
    resumed
      .json()
      .events.every(
        (event: CalendarRecord) =>
          event.studyStatus === 'planned' && event.version === 3,
      ),
  ).toBe(true);
});

it('rejects mixed regular, all-day and recurring selections atomically for study-status changes', async () => {
  const study = await create();
  const invalid = [
    await create({ courseId: null }),
    await create({
      allDay: true,
      startDate: '2030-04-04',
      endDate: '2030-04-05',
    }),
    await create({
      recurrence: { frequency: 'daily', interval: 1, count: 3, until: null },
    }),
  ];
  for (const event of invalid) {
    const request = input([study, event], {
      kind: 'study-status',
      status: 'completed',
    });
    const response = await batch(request);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(
      'CALENDAR_STUDY_SELECTION_REQUIRED',
    );
    expect((await get(`/api/v1/calendar/${study.id}`)).json().event).toEqual(
      study,
    );
    expect((await get(`/api/v1/calendar/${event.id}`)).json().event).toEqual(
      event,
    );
  }
  const deleted = await batch(input([study, ...invalid], { kind: 'delete' }));
  expect(deleted.statusCode).toBe(200);
  expect(
    deleted
      .json()
      .events.every(
        (event: CalendarRecord) =>
          event.deletedAt !== null && event.version === 2,
      ),
  ).toBe(true);
});

it('checks ownership, absent/deleted records, origins and revoked sessions without private disclosure', async () => {
  const first = await create(),
    second = await create();
  const payload = input([first], { kind: 'delete' });
  for (const [session, status] of [
    ['', 401],
    [otherCookie, 404],
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/calendar/batch',
      headers: { origin, cookie: session },
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain(first.notes);
  }
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/calendar/batch',
        headers: { origin: 'https://example.test', cookie },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await batch({
        ...payload,
        items: [...payload.items, { id: randomUUID(), expectedVersion: 1 }],
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await write('DELETE', `/api/v1/calendar/${second.id}`, change(1)))
      .statusCode,
  ).toBe(200);
  expect(
    (await batch(input([first, second], { kind: 'delete' }))).statusCode,
  ).toBe(404);
  expect((await get(`/api/v1/calendar/${first.id}`)).json().event).toEqual(
    first,
  );
  await db.query(
    'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
    [owner],
  );
  expect((await batch(payload)).statusCode).toBe(401);
});

it('requires current versions for the whole selection and permits historical deletion after class archival', async () => {
  const first = await create(),
    second = await create();
  const changed = await batch(
    input([second], { kind: 'study-status', status: 'completed' }),
  );
  expect(changed.statusCode).toBe(200);
  const rejected = await batch(input([first, second], { kind: 'delete' }));
  expect(rejected.statusCode).toBe(409);
  expect(rejected.json().error.code).toBe('VERSION_CONFLICT');
  expect((await get(`/api/v1/calendar/${first.id}`)).json().event).toEqual(
    first,
  );
  expect(
    (await write('DELETE', `/api/v1/courses/${courseId}`, change(1)))
      .statusCode,
  ).toBe(200);
  const archived = await batch(
    input([first], { kind: 'study-status', status: 'cancelled' }),
  );
  expect(archived.statusCode).toBe(404);
  const deletion = await batch(
    input([first, changed.json().events[0]], { kind: 'delete' }),
  );
  expect(deletion.statusCode).toBe(200);
  expect(
    deletion
      .json()
      .events.every((event: CalendarRecord) => event.deletedAt !== null),
  ).toBe(true);
});

it('deduplicates competing requests and returns historical results after later changes without reapplying them', async () => {
  const first = await create(),
    second = await create();
  const payload = input([second, first], {
    kind: 'study-status',
    status: 'completed',
  });
  payload.items[0]!.id = payload.items[0]!.id.toUpperCase();
  const results = await Promise.all([batch(payload), batch(payload)]);
  expect(results[0]!.statusCode).toBe(200);
  expect(results[1]!.json()).toEqual(results[0]!.json());
  expect(
    results[0]!
      .json()
      .events.every((event: CalendarRecord) => event.version === 2),
  ).toBe(true);
  const deletion = input(results[0]!.json().events, { kind: 'delete' });
  const deleted = await batch(deletion);
  expect(deleted.statusCode).toBe(200);
  expect((await batch(payload)).json()).toEqual(results[0]!.json());
  expect((await batch(deletion)).json()).toEqual(deleted.json());
  expect((await get(`/api/v1/calendar/${first.id}`)).json().event.version).toBe(
    3,
  );
  const reused = await batch({ ...payload, action: { kind: 'delete' } });
  expect(reused.json().error.code).toBe('OPERATION_CONFLICT');
});

it('rolls back partial SQL changes, schedule revisions and receipts on failure', async () => {
  const first = await create(),
    second = await create();
  const payload = input([first, second], {
    kind: 'study-status',
    status: 'completed',
  });
  const revision = await db.query(
    'SELECT * FROM planner_schedule_locks WHERE owner_id=$1',
    [owner],
  );
  await db.exec(`CREATE FUNCTION reject_calendar_batch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id='${second.id}'::uuid AND NEW.study_status='completed' THEN RAISE EXCEPTION 'Synthetic rollback'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_calendar_batch BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION reject_calendar_batch()`);
  const failed = await batch(payload);
  expect(failed.statusCode).toBe(500);
  expect(failed.body).not.toContain('Synthetic rollback');
  expect((await get(`/api/v1/calendar/${first.id}`)).json().event).toEqual(
    first,
  );
  expect((await get(`/api/v1/calendar/${second.id}`)).json().event).toEqual(
    second,
  );
  expect(
    await db.query('SELECT * FROM planner_schedule_locks WHERE owner_id=$1', [
      owner,
    ]),
  ).toEqual(revision);
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE operation_id=$1',
      [payload.operationId],
    ),
  ).toEqual([]);
  await db.exec(
    'DROP TRIGGER reject_calendar_batch ON events; DROP FUNCTION reject_calendar_batch()',
  );
  expect((await batch(payload)).statusCode).toBe(200);
});

it('preserves the losing selection in overlapping concurrent status/deletion batches', async () => {
  const first = await create(),
    shared = await create(),
    last = await create();
  const results = await Promise.all([
    batch(
      input([first, shared], { kind: 'study-status', status: 'completed' }),
    ),
    batch(input([shared, last], { kind: 'delete' })),
  ]);
  expect(
    results.filter((response) => response.statusCode === 200),
  ).toHaveLength(1);
  expect(
    results.filter((response) => [404, 409].includes(response.statusCode)),
  ).toHaveLength(1);
  const loserOnly = results[0]!.statusCode === 200 ? last : first;
  expect((await get(`/api/v1/calendar/${loserOnly.id}`)).json().event).toEqual(
    loserOnly,
  );
  expect(
    (await get(`/api/v1/calendar/${shared.id}`)).json().event.version,
  ).toBe(2);
});

it('suppresses claimed reminder delivery after a selected study-status change and leaves unrelated reminders active', async () => {
  const first = await create(),
    second = await create();
  for (const event of [first, second]) {
    const reminder = await write('POST', '/api/v1/reminders', {
      operationId: randomUUID(),
      title: 'Synthetic study reminder',
      targetKind: 'event',
      targetId: event.id,
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(reminder.statusCode).toBe(200);
  }
  const payload = input([first], { kind: 'study-status', status: 'completed' });
  await runReminderBatch(db, new Date(), async () => {
    expect((await batch(payload)).statusCode).toBe(200);
  });
  const notifications = await db.query<{ target_id: string }>(
    'SELECT r.target_id FROM notifications n JOIN reminders r ON r.id=n.reminder_id WHERE n.owner_id=$1',
    [owner],
  );
  expect(notifications).toEqual([{ target_id: second.id }]);
  expect(
    (await get(`/api/v1/calendar/${first.id}`)).json().event.studyStatus,
  ).toBe('completed');
});

it('retains recurrence exceptions and tombstones through batch deletion/export and individual restore without restarting cancelled jobs', async () => {
  const recurring = await create({
    recurrence: { frequency: 'daily', interval: 1, count: 3, until: null },
  });
  expect(
    (
      await write(
        'DELETE',
        `/api/v1/calendar/${recurring.id}/occurrences/2030-04-05`,
        change(1),
      )
    ).statusCode,
  ).toBe(200);
  const current = (await get(`/api/v1/calendar/${recurring.id}`)).json().event;
  const reminder = await write('POST', '/api/v1/reminders', {
    operationId: randomUUID(),
    title: 'Synthetic recurring reminder',
    targetKind: 'event',
    targetId: recurring.id,
    occurrenceDate: '2030-04-04',
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  expect(reminder.statusCode).toBe(200);
  const exceptions = await db.query(
    'SELECT * FROM event_exceptions WHERE event_id=$1',
    [recurring.id],
  );
  const deleted = await batch(input([current], { kind: 'delete' }));
  expect(deleted.statusCode).toBe(200);
  await runReminderBatch(db);
  expect(
    (await get(`/api/v1/reminders/${reminder.json().reminder.id}`)).json()
      .reminder.status,
  ).toBe('cancelled');
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(exported.records.events[0]).toEqual(deleted.json().events[0]);
  expect(exported.records.exceptions[0]).toMatchObject({
    eventId: recurring.id,
    originalDate: '2030-04-05',
    cancelled: true,
  });
  const restored = await write(
    'POST',
    `/api/v1/calendar/${recurring.id}/restore`,
    change(3),
  );
  expect(restored.statusCode).toBe(200);
  expect(
    await db.query('SELECT * FROM event_exceptions WHERE event_id=$1', [
      recurring.id,
    ]),
  ).toEqual(exceptions);
  await runReminderBatch(db);
  expect((await get('/api/v1/notifications')).json().notifications).toEqual([]);
});

it('keeps academic source facts and incomplete provenance intact when recording study completion', async () => {
  const saved = await write('POST', '/api/v1/academic-work', {
    operationId: randomUUID(),
    courseId,
    title: 'Synthetic exam',
    estimatedMinutes: 100,
  });
  const work = saved.json().work;
  const planned = await write(
    'POST',
    `/api/v1/academic-work/${work.id}/planner-work`,
    {
      operationId: randomUUID(),
      kind: 'study',
      expectedWorkVersion: 1,
      expectedCourseVersion: 1,
      event: eventFields(),
    },
  );
  expect(planned.statusCode).toBe(200);
  const event = planned.json().event;
  const source = await db.query(
    'SELECT * FROM academic_planner_sources WHERE event_id=$1',
    [event.id],
  );
  await db.query('UPDATE events SET academic_labels=NULL WHERE id=$1', [
    event.id,
  ]);
  const result = await batch(
    input([event], { kind: 'study-status', status: 'completed' }),
  );
  expect(result.statusCode).toBe(200);
  expect(result.json().events[0].academicLabels).toBeNull();
  expect(result.json().events[0].academicSource).toEqual(event.academicSource);
  expect((await get(`/api/v1/academic-work/${work.id}`)).json().work).toEqual(
    work,
  );
  expect(
    await db.query('SELECT * FROM academic_planner_sources WHERE event_id=$1', [
      event.id,
    ]),
  ).toEqual(source);
  await expect(
    resolveAIContext(db, owner, {
      kind: 'event',
      id: event.id,
      expectedVersion: 2,
    }),
  ).rejects.toMatchObject({ code: 'PROVENANCE_UNAVAILABLE' });
});

it('persists calendar batch receipts and tombstones across isolated restarts', async () => {
  const root = resolve('.artifacts', 'calendar-batch');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'restart-'));
  const isolated = readConfig({
    NODE_ENV: 'test',
    PGLITE_DATA_DIR: resolve(directory, 'db'),
  });
  let durable: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    durable = await buildApp({ logger: false }, { config: isolated });
    const setup = await durable.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persist-calendar-batch@example.test',
        password: 'synthetic-calendar-batch-password',
      },
    });
    const session = {
      origin,
      cookie: String(setup.headers['set-cookie']).split(';')[0]!,
    };
    const created = await durable.inject({
      method: 'POST',
      url: '/api/v1/calendar',
      headers: session,
      payload: {
        operationId: randomUUID(),
        ...eventFields({ courseId: null }),
      },
    });
    expect(created.statusCode).toBe(200);
    const payload = input([created.json().event], { kind: 'delete' });
    const deleted = await durable.inject({
      method: 'POST',
      url: '/api/v1/calendar/batch',
      headers: session,
      payload,
    });
    expect(deleted.statusCode).toBe(200);
    await durable.close();
    durable = await buildApp({ logger: false }, { config: isolated });
    expect(
      (
        await durable.inject({
          method: 'POST',
          url: '/api/v1/calendar/batch',
          headers: session,
          payload,
        })
      ).json(),
    ).toEqual(deleted.json());
    const restored = await durable.inject({
      method: 'POST',
      url: `/api/v1/calendar/${created.json().event.id}/restore`,
      headers: session,
      payload: change(2),
    });
    expect(restored.statusCode).toBe(200);
    expect(
      (
        await durable.inject({
          method: 'POST',
          url: '/api/v1/calendar/batch',
          headers: session,
          payload,
        })
      ).json(),
    ).toEqual(deleted.json());
    expect(
      (
        await durable.inject({
          url: `/api/v1/calendar/${created.json().event.id}`,
          headers: session,
        })
      ).json().event,
    ).toEqual(restored.json().event);
  } finally {
    await durable?.close();
    await removeSyntheticArtifact(root, directory);
  }
});
