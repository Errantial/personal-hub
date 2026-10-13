import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  academicWorkSchema,
  plannerExportSchema,
  academicAgendaResponseSchema,
  academicPlanningResponseSchema,
  academicPlannerSourceResponseSchema,
  academicPlannerWorkResponseSchema,
  plannerSensitivity,
  academicPlannerSummarySchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { resolveAIContext } from '../src/features/ai-routing.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string, otherCookie: string, courseId: string, otherOwner: string;
const change = (expectedVersion: number) => ({
  operationId: randomUUID(),
  expectedVersion,
});
const headers = () => ({ origin, cookie });
const get = (url: string) => app.inject({ url, headers: headers() });
const write = (
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload: object,
) => app.inject({ method, url, headers: headers(), payload });
const create = (fields: object = {}) =>
  write('POST', '/api/v1/academic-work', {
    courseId,
    title: 'Synthetic assignment',
    operationId: randomUUID(),
    ...fields,
  });
const summary = () =>
  get(`/api/v1/courses/${courseId}/work-summary?asOf=2030-04-04`);
const agenda = (query = '') =>
  get(`/api/v1/academic-work/agenda?asOf=2030-04-04&to=2030-04-11${query}`);
const taskPlanning = (fields: object = {}) => ({
  kind: 'task',
  expectedWorkVersion: 1,
  expectedCourseVersion: 1,
  operationId: randomUUID(),
  task: { title: 'Plan assignment work', dueDate: '2030-04-05' },
  ...fields,
});
const studyPlanning = (fields: object = {}) => ({
  kind: 'study',
  expectedWorkVersion: 1,
  expectedCourseVersion: 1,
  operationId: randomUUID(),
  event: {
    title: 'Study assignment',
    startsAt: '2030-04-04T09:00:00Z',
    endsAt: '2030-04-04T09:25:00Z',
    timeZone: 'UTC',
    courseId,
  },
  ...fields,
});
const planWork = (id: string, input: object) =>
  write('POST', `/api/v1/academic-work/${id}/planner-work`, input);
const plannerWork = (id: string, query = '') =>
  get(`/api/v1/academic-work/${id}/planner-work${query}`);
const planningSummary = (
  id: string,
  query = 'from=2030-04-04&to=2030-04-11&timeZone=UTC',
) => get(`/api/v1/academic-work/${id}/planner-work-summary?${query}`);
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
      email: 'academic@example.test',
      password: 'synthetic-academic-password',
    },
  });
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  otherOwner = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    otherOwner,
    'other-academic@example.test',
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
  courseId = (
    await write('POST', '/api/v1/courses', {
      name: 'Chemistry',
      sensitivity: 'personal',
      operationId: randomUUID(),
    })
  ).json().course.id;
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app?.close();
});
it('groups deadline planning fields with complete totals and explicit missing/zero estimates', async () => {
  await create({
    dueDate: '2030-04-03',
    estimatedMinutes: 60,
    notes: 'Private notes',
  });
  await create({ dueDate: '2030-04-04', estimatedMinutes: 0 });
  await create({
    dueDate: '2030-04-10',
    estimatedMinutes: null,
    status: 'in_progress',
  });
  await create({ dueDate: null, estimatedMinutes: 30 });
  await create({ dueDate: '2030-04-11', estimatedMinutes: 900 });
  await create({
    dueDate: '2030-04-03',
    status: 'submitted',
    grade: { earned: 8, possible: 10 },
  });
  await create({ dueDate: '2030-04-03', status: 'cancelled' });
  const response = await agenda('&limit=2');
  expect(response.statusCode).toBe(200);
  const result = academicAgendaResponseSchema.parse(response.json());
  expect(result.summary).toEqual({
    openCount: 4,
    overdueCount: 1,
    todayCount: 1,
    upcomingCount: 1,
    missingDeadlineCount: 1,
    missingEstimateCount: 1,
    estimatedOpenMinutes: 90,
  });
  expect(result.entries.map((entry) => entry.bucket)).toEqual([
    'overdue',
    'today',
  ]);
  expect(result.entries[1]!.estimatedMinutes).toBe(0);
  expect(result.nextAfter).toMatchObject({ version: 1 });
  expect(response.body).not.toContain('Private notes');
  expect(
    result.entries.every((entry) => !('notes' in entry) && !('grade' in entry)),
  ).toBe(true);
  const undated = academicAgendaResponseSchema.parse(
    (await agenda('&bucket=undated')).json(),
  );
  expect(undated.summary).toEqual(result.summary);
  expect(undated.entries).toHaveLength(1);
  expect(undated.entries[0]).toMatchObject({
    dueDate: null,
    bucket: 'undated',
    courseName: 'Chemistry',
    academicLabels: ['personal'],
  });
});
it('pages tied dates and unknown deadlines exactly once with a versioned owned cursor', async () => {
  const records = [];
  for (const dueDate of ['2030-04-03', '2030-04-04', '2030-04-04', null, null])
    records.push((await create({ dueDate })).json().work);
  const expected = records
    .sort(
      (a, b) =>
        (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
        a.id.localeCompare(b.id),
    )
    .map((record) => record.id);
  const seen: string[] = [];
  let query = '&limit=1';
  for (let page = 0; page < 6; page++) {
    const result = academicAgendaResponseSchema.parse(
      (await agenda(query)).json(),
    );
    expect(result.summary.openCount).toBe(5);
    seen.push(...result.entries.map((entry) => entry.id));
    if (!result.nextAfter) break;
    query = `&limit=1&after=${result.nextAfter.id}&expectedCursorVersion=${result.nextAfter.version}`;
  }
  expect(seen).toEqual(expected);
  const cursor = records[0];
  const invalidBucket = await agenda(
    `&bucket=undated&after=${cursor.id}&expectedCursorVersion=1`,
  );
  expect(invalidBucket.statusCode).toBe(404);
  await write('PUT', `/api/v1/academic-work/${cursor.id}`, {
    courseId,
    title: 'Changed deadline',
    dueDate: '2030-04-06',
    status: 'planned',
    grade: null,
    ...change(1),
  });
  const stale = await agenda(`&after=${cursor.id}&expectedCursorVersion=1`);
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error.code).toBe('VERSION_CONFLICT');
  expect(
    (await agenda(`&after=${randomUUID()}&expectedCursorVersion=1`)).statusCode,
  ).toBe(404);
});
it('excludes archived, deleted and foreign work and re-evaluates owner-reported lifecycle changes', async () => {
  const record = (await create({ dueDate: '2030-04-03' })).json().work;
  const otherCourse = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: { origin, cookie: otherCookie },
      payload: { name: 'Foreign class', operationId: randomUUID() },
    })
  ).json().course.id;
  const foreign = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/academic-work',
      headers: { origin, cookie: otherCookie },
      payload: {
        courseId: otherCourse,
        title: 'Foreign private title',
        dueDate: '2030-04-03',
        operationId: randomUUID(),
      },
    })
  ).json().work;
  expect((await agenda(`&courseId=${otherCourse}`)).statusCode).toBe(404);
  expect(
    (await agenda(`&after=${foreign.id}&expectedCursorVersion=1`)).statusCode,
  ).toBe(404);
  expect((await agenda()).body).not.toContain('Foreign private title');
  await write('DELETE', `/api/v1/academic-work/${record.id}`, change(1));
  expect((await agenda()).json().summary.openCount).toBe(0);
  expect(
    (await agenda(`&after=${record.id}&expectedCursorVersion=1`)).statusCode,
  ).toBe(404);
  await write('POST', `/api/v1/academic-work/${record.id}/restore`, change(2));
  expect((await agenda()).json().entries[0].version).toBe(3);
  await write('PUT', `/api/v1/academic-work/${record.id}`, {
    courseId,
    title: record.title,
    dueDate: record.dueDate,
    status: 'submitted',
    grade: null,
    ...change(3),
  });
  expect((await agenda()).json().summary.openCount).toBe(0);
  await create({ dueDate: '2030-04-04' });
  expect(
    (await write('DELETE', `/api/v1/courses/${courseId}`, change(1)))
      .statusCode,
  ).toBe(200);
  expect((await agenda()).json().summary.openCount).toBe(0);
  expect((await agenda(`&courseId=${courseId}`)).statusCode).toBe(404);
  expect((await get(`/api/v1/academic-work/${record.id}`)).statusCode).toBe(
    200,
  );
});
it('validates agenda ranges, filters and cursor pairs and requires authorization', async () => {
  expect(
    (
      await app.inject({
        url: '/api/v1/academic-work/agenda?asOf=2030-04-04&to=2030-04-11',
      })
    ).statusCode,
  ).toBe(401);
  for (const query of [
    'asOf=2030-04-04&to=2030-04-04',
    'asOf=2030-04-04&to=2030-05-06',
    'asOf=2030-02-30&to=2030-03-04',
    'asOf=2030-04-04',
    'asOf=2030-04-04&to=2030-04-11&bucket=submitted',
    'asOf=2030-04-04&to=2030-04-11&limit=201',
    `asOf=2030-04-04&to=2030-04-11&after=${randomUUID()}`,
    'asOf=2030-04-04&to=2030-04-11&expectedCursorVersion=1',
    'asOf=2030-04-04&to=2030-04-11&timeZone=UTC',
  ])
    expect(
      (await get(`/api/v1/academic-work/agenda?${query}`)).statusCode,
    ).toBe(400);
  expect(
    (await get('/api/v1/academic-work/agenda?asOf=2030-12-31&to=2031-01-31'))
      .statusCode,
  ).toBe(200);
  const empty = academicAgendaResponseSchema.parse((await agenda()).json());
  expect(empty).toMatchObject({
    entries: [],
    nextAfter: null,
    summary: { openCount: 0, estimatedOpenMinutes: 0, missingEstimateCount: 0 },
    warnings: ['MANUAL_RECORDS_ONLY'],
  });
});
it('keeps agenda totals complete beyond a page and blocks oversized relevant workloads', async () => {
  const owner = (
    await db.query('SELECT owner_id FROM owner_setup WHERE singleton=1')
  )[0]!.owner_id;
  await db.query(
    `INSERT INTO academic_work(id,owner_id,course_id,title,kind,priority,status,sensitivity,due_date,estimated_minutes,academic_labels)
    SELECT gen_random_uuid(),$1,$2,'Synthetic bulk work','assignment',3,'planned','personal',DATE '2030-04-04',0,ARRAY['personal']::text[] FROM generate_series(1,201)`,
    [owner, courseId],
  );
  const result = academicAgendaResponseSchema.parse(
    (await agenda('&limit=200')).json(),
  );
  expect(result.entries).toHaveLength(200);
  expect(result.summary).toMatchObject({
    openCount: 201,
    todayCount: 201,
    missingEstimateCount: 0,
    estimatedOpenMinutes: 0,
  });
  expect(result.nextAfter).not.toBeNull();
  await db.query(
    `INSERT INTO academic_work(id,owner_id,course_id,title,kind,priority,status,sensitivity,due_date,academic_labels)
    SELECT gen_random_uuid(),$1,$2,'Synthetic bulk work','assignment',3,'planned','personal',DATE '2030-04-04',ARRAY['personal']::text[] FROM generate_series(1,4800)`,
    [owner, courseId],
  );
  const blocked = await agenda('&bucket=undated');
  expect(blocked.statusCode).toBe(413);
  expect(blocked.json().error.code).toBe('ACADEMIC_WORK_TOO_LARGE');
});
it('filters active classes and preserves local date boundaries across leap day', async () => {
  const secondCourse = (
    await write('POST', '/api/v1/courses', {
      name: 'Physics',
      operationId: randomUUID(),
    })
  ).json().course.id;
  await create({ dueDate: '2032-02-28', estimatedMinutes: null });
  await create({ dueDate: '2032-02-29', estimatedMinutes: 0 });
  await create({ dueDate: '2032-03-01', estimatedMinutes: 25 });
  await create({ dueDate: '2032-03-02', estimatedMinutes: 500 });
  await create({
    courseId: secondCourse,
    dueDate: '2032-02-29',
    estimatedMinutes: 30,
  });
  const filtered = await get(
    `/api/v1/academic-work/agenda?asOf=2032-02-29&to=2032-03-02&courseId=${courseId}&bucket=today`,
  );
  expect(filtered.statusCode).toBe(200);
  const result = academicAgendaResponseSchema.parse(filtered.json());
  expect(result.summary).toMatchObject({
    openCount: 3,
    overdueCount: 1,
    todayCount: 1,
    upcomingCount: 1,
    estimatedOpenMinutes: 25,
    missingEstimateCount: 1,
  });
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({
    courseId,
    dueDate: '2032-02-29',
    estimatedMinutes: 0,
  });
  expect(result.courseId).toBe(courseId);
  const allClasses = await get(
    '/api/v1/academic-work/agenda?asOf=2032-02-29&to=2032-03-02',
  );
  expect(allClasses.json().summary).toMatchObject({
    openCount: 4,
    todayCount: 2,
    estimatedOpenMinutes: 55,
  });
});
it('creates explicit task/study work with immutable planning snapshots and exact receipts', async () => {
  const source = (
    await create({
      dueDate: '2030-04-04',
      estimatedMinutes: 0,
      notes: 'Source notes never copied',
    })
  ).json().work;
  const input = taskPlanning();
  const first = await planWork(source.id, input);
  expect(first.statusCode).toBe(200);
  const result = academicPlanningResponseSchema.parse(first.json());
  expect(result.kind).toBe('task');
  if (result.kind !== 'task') throw new Error('Expected task');
  expect(result.task).toMatchObject({
    title: 'Plan assignment work',
    notes: '',
    dueDate: '2030-04-05',
    sensitivity: 'personal',
    academicSource: {
      workId: source.id,
      capturedWorkVersion: 1,
      currentWorkVersion: 1,
      labels: ['personal'],
    },
  });
  expect(result.source.snapshot).toMatchObject({
    id: source.id,
    dueDate: '2030-04-04',
    estimatedMinutes: 0,
    courseVersion: 1,
    provenance: 'owner-entered-planning-fields',
  });
  expect(first.body).not.toContain('Source notes never copied');
  expect('title' in result.source.snapshot).toBe(false);
  expect((await planWork(source.id, input)).json()).toEqual(first.json());
  expect(
    (
      await planWork(source.id, {
        ...input,
        task: { title: 'Different input' },
      })
    ).statusCode,
  ).toBe(409);
  const study = await planWork(source.id, studyPlanning());
  expect(study.statusCode).toBe(200);
  expect(study.json().event).toMatchObject({
    courseId,
    studyStatus: 'planned',
    academicLabels: ['personal'],
    academicSource: { workId: source.id },
  });
  const separate = await planWork(source.id, taskPlanning());
  expect(separate.statusCode).toBe(200);
  expect(separate.json().task.id).not.toBe(result.task.id);
  const list = academicPlannerWorkResponseSchema.parse(
    (await plannerWork(source.id)).json(),
  );
  expect(list.entries).toHaveLength(3);
  expect(
    (await get(`/api/v1/academic-work/${source.id}`)).json().work.version,
  ).toBe(1);
});
it('retains captured/current source differences without rewriting personal planning fields', async () => {
  const source = (
    await create({ dueDate: '2030-04-04', estimatedMinutes: 50 })
  ).json().work;
  const created = (await planWork(source.id, taskPlanning())).json();
  await write('PUT', `/api/v1/academic-work/${source.id}`, {
    courseId,
    title: 'Source changed',
    dueDate: '2030-04-09',
    estimatedMinutes: 100,
    notes: 'Private current notes',
    status: 'in_progress',
    grade: null,
    ...change(1),
  });
  const details = await get(
    `/api/v1/tasks/${created.task.id}/academic-source?expectedVersion=1`,
  );
  expect(details.statusCode).toBe(200);
  const inspected = academicPlannerSourceResponseSchema.parse(details.json());
  expect(inspected.source).toMatchObject({
    changed: true,
    snapshot: { version: 1, dueDate: '2030-04-04', estimatedMinutes: 50 },
    current: {
      version: 2,
      dueDate: '2030-04-09',
      estimatedMinutes: 100,
      status: 'in_progress',
    },
  });
  expect(details.body).not.toContain('Private current notes');
  expect(
    (await get(`/api/v1/tasks/${created.task.id}`)).json().task,
  ).toMatchObject({
    version: 1,
    title: 'Plan assignment work',
    dueDate: '2030-04-05',
  });
  await write('DELETE', `/api/v1/academic-work/${source.id}`, change(2));
  expect(
    (await get(`/api/v1/tasks/${created.task.id}/academic-source`)).json()
      .source.current.deletedAt,
  ).not.toBeNull();
  expect((await plannerWork(source.id)).json()).toMatchObject({
    workVersion: 3,
    entries: [{ kind: 'task' }],
  });
  await write('POST', `/api/v1/academic-work/${source.id}/restore`, change(3));
  expect(
    (await get(`/api/v1/tasks/${created.task.id}/academic-source`)).json()
      .source.current,
  ).toMatchObject({ version: 4, deletedAt: null });
  await expect(
    resolveAIContext(
      db,
      (await db.query('SELECT owner_id FROM owner_setup WHERE singleton=1'))[0]!
        .owner_id as string,
      { kind: 'task', id: created.task.id, expectedVersion: 1 },
    ),
  ).resolves.toMatchObject({
    academicPlanning: { workId: source.id, currentWorkVersion: 4 },
    labels: ['personal'],
  });
});
it('keeps task completion and planner tombstones separate from assignment submission', async () => {
  const source = (await create()).json().work;
  const linked = (await planWork(source.id, taskPlanning())).json().task;
  const edited = await write('PUT', `/api/v1/tasks/${linked.id}`, {
    title: 'Completed personal plan',
    completed: true,
    sensitivity: 'unlabeled',
    ...change(1),
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().task).toMatchObject({
    completed: true,
    sensitivity: 'personal',
    academicSource: { workId: source.id },
  });
  expect(
    (await get(`/api/v1/academic-work/${source.id}`)).json().work,
  ).toMatchObject({ version: 1, status: 'planned', estimatedMinutes: null });
  await write('DELETE', `/api/v1/tasks/${linked.id}`, change(2));
  expect((await plannerWork(source.id)).json().entries).toHaveLength(0);
  expect(
    (await plannerWork(source.id, '?deleted=true')).json().entries,
  ).toHaveLength(1);
  expect(
    (await get(`/api/v1/tasks/${linked.id}/academic-source`)).json()
      .itemDeletedAt,
  ).not.toBeNull();
  await write('POST', `/api/v1/tasks/${linked.id}/restore`, change(3));
  expect((await plannerWork(source.id)).json().entries[0].task).toMatchObject({
    version: 4,
    completed: true,
    title: 'Completed personal plan',
  });
  const stale = await get(
    `/api/v1/tasks/${linked.id}/academic-source?expectedVersion=1`,
  );
  expect(stale.statusCode).toBe(409);
});
it('propagates source/class labels once through detached and deleted planner work', async () => {
  const source = (await create({ sensitivity: 'restricted' })).json().work;
  const task = (await planWork(source.id, taskPlanning())).json().task;
  const event = (await planWork(source.id, studyPlanning())).json().event;
  await write('PUT', `/api/v1/calendar/${event.id}`, {
    title: 'Detached plan',
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timeZone: 'UTC',
    courseId: null,
    topicId: null,
    sensitivity: 'unlabeled',
    studyStatus: 'completed',
    ...change(1),
  });
  expect(
    (await get(`/api/v1/calendar/${event.id}`)).json().event,
  ).toMatchObject({
    sensitivity: 'restricted',
    academicLabels: ['personal', 'restricted'],
    courseId: null,
  });
  await write('DELETE', `/api/v1/tasks/${task.id}`, change(1));
  await write('DELETE', `/api/v1/calendar/${event.id}`, change(2));
  // Personal is already captured by the parent; repeated labels are no-ops for linked versions.
  await write('PUT', `/api/v1/courses/${courseId}`, {
    name: 'Renamed Chemistry',
    sensitivity: 'personal',
    ...change(1),
  });
  expect((await get(`/api/v1/tasks/${task.id}`)).json().task.version).toBe(2);
  expect((await get(`/api/v1/calendar/${event.id}`)).json().event.version).toBe(
    3,
  );
  expect(
    (await get(`/api/v1/tasks/${task.id}/academic-source`)).json().source
      .labels,
  ).toEqual(['personal', 'restricted']);
  await write('PUT', `/api/v1/courses/${courseId}`, {
    name: 'Restricted Chemistry',
    sensitivity: 'restricted',
    ...change(2),
  });
  expect((await get(`/api/v1/tasks/${task.id}`)).json().task.version).toBe(2);
  expect((await get(`/api/v1/calendar/${event.id}`)).json().event.version).toBe(
    3,
  );
  const secondSource = (await create()).json().work;
  const secondTask = (
    await planWork(secondSource.id, taskPlanning({ expectedCourseVersion: 3 }))
  ).json().task;
  const secondEvent = (
    await planWork(secondSource.id, studyPlanning({ expectedCourseVersion: 3 }))
  ).json().event;
  // Reapply personal after restricted: masked independent label advances each item exactly once.
  await write('PUT', `/api/v1/courses/${courseId}`, {
    name: 'Personal Chemistry',
    sensitivity: 'personal',
    ...change(3),
  });
  expect(
    (await get(`/api/v1/tasks/${secondTask.id}`)).json().task,
  ).toMatchObject({ version: 2, sensitivity: 'restricted' });
  expect(
    (await get(`/api/v1/calendar/${secondEvent.id}`)).json().event,
  ).toMatchObject({
    version: 2,
    academicLabels: ['personal', 'restricted'],
    sensitivity: 'restricted',
  });
  await write('DELETE', `/api/v1/courses/${courseId}`, change(4));
  expect(
    (await get(`/api/v1/tasks/${secondTask.id}/academic-source`)).json().source
      .current.courseArchived,
  ).toBe(true);
});
it('captures masked work labels and keeps deleted planner item versions conflict-safe', async () => {
  const parent = (
    await write('POST', '/api/v1/courses', {
      name: 'Unlabeled source class',
      operationId: randomUUID(),
    })
  ).json().course;
  const source = (
    await create({ courseId: parent.id, sensitivity: 'restricted' })
  ).json().work;
  const task = (await planWork(source.id, taskPlanning())).json().task;
  const block = (
    await planWork(
      source.id,
      studyPlanning({
        event: { ...studyPlanning().event, courseId: parent.id },
      }),
    )
  ).json().event;
  await write('DELETE', `/api/v1/tasks/${task.id}`, change(1));
  await write('DELETE', `/api/v1/calendar/${block.id}`, change(1));
  const updated = await write('PUT', `/api/v1/academic-work/${source.id}`, {
    courseId: parent.id,
    title: source.title,
    status: 'planned',
    grade: null,
    sensitivity: 'personal',
    ...change(1),
  });
  expect(updated.statusCode).toBe(200);
  const currentTask = (await get(`/api/v1/tasks/${task.id}`)).json().task;
  expect(currentTask).toMatchObject({
    version: 3,
    sensitivity: 'restricted',
    academicSource: { labels: ['personal', 'restricted'] },
  });
  expect(plannerSensitivity({ ...currentTask, sensitivity: 'unlabeled' })).toBe(
    'restricted',
  );
  expect(
    (await get(`/api/v1/calendar/${block.id}`)).json().event,
  ).toMatchObject({
    version: 3,
    academicLabels: ['restricted'],
    sensitivity: 'restricted',
  });
  expect(
    (await write('POST', `/api/v1/tasks/${task.id}/restore`, change(2)))
      .statusCode,
  ).toBe(409);
  expect(
    (await write('POST', `/api/v1/tasks/${task.id}/restore`, change(3)))
      .statusCode,
  ).toBe(200);
  const repeated = await write('PUT', `/api/v1/academic-work/${source.id}`, {
    courseId: parent.id,
    title: source.title,
    status: 'planned',
    grade: null,
    sensitivity: 'personal',
    ...change(2),
  });
  expect(repeated.statusCode).toBe(200);
  expect((await get(`/api/v1/tasks/${task.id}`)).json().task.version).toBe(4);
  expect((await get(`/api/v1/calendar/${block.id}`)).json().event.version).toBe(
    3,
  );
});
it('retains topic and changed-class labels through later study detachment and legacy edits', async () => {
  const topic = (
    await write('POST', '/api/v1/topics', {
      courseId,
      name: 'Source topic',
      confidence: 'unknown',
      sensitivity: 'restricted',
      operationId: randomUUID(),
    })
  ).json().topic;
  const source = (await create()).json().work;
  const created = (
    await planWork(
      source.id,
      studyPlanning({ event: { ...studyPlanning().event, topicId: topic.id } }),
    )
  ).json();
  expect(created.source.labels.sort()).toEqual(['personal', 'restricted']);
  const first = await write('PUT', `/api/v1/calendar/${created.event.id}`, {
    title: 'Detached topic',
    startsAt: created.event.startsAt,
    endsAt: created.event.endsAt,
    timeZone: 'UTC',
    courseId: null,
    topicId: null,
    sensitivity: 'unlabeled',
    ...change(1),
  });
  expect(first.json().event.sensitivity).toBe('restricted');
  const legacy = await write('PUT', `/api/v1/events/${created.event.id}`, {
    title: 'Legacy edit',
    startsAt: created.event.startsAt,
    endsAt: created.event.endsAt,
    timeZone: 'UTC',
    sensitivity: 'unlabeled',
    ...change(2),
  });
  expect(legacy.statusCode).toBe(200);
  expect(legacy.json().event).toMatchObject({
    sensitivity: 'restricted',
    academicSource: { workId: source.id, labels: ['personal', 'restricted'] },
  });
  // A different class applied after creation also remains captured after removal.
  const plainParent = (
    await write('POST', '/api/v1/courses', {
      name: 'Plain parent',
      operationId: randomUUID(),
    })
  ).json().course;
  const plainSource = (await create({ courseId: plainParent.id })).json().work;
  const plain = (
    await planWork(
      plainSource.id,
      studyPlanning({
        event: { ...studyPlanning().event, courseId: plainParent.id },
      }),
    )
  ).json().event;
  const moved = await write('PUT', `/api/v1/calendar/${plain.id}`, {
    title: plain.title,
    startsAt: plain.startsAt,
    endsAt: plain.endsAt,
    timeZone: 'UTC',
    courseId,
    topicId: null,
    ...change(1),
  });
  expect(moved.statusCode).toBe(200);
  await write('PUT', `/api/v1/courses/${courseId}`, {
    name: 'Newly restricted class',
    sensitivity: 'restricted',
    ...change(1),
  });
  expect(
    (await get(`/api/v1/calendar/${plain.id}`)).json().event,
  ).toMatchObject({
    version: 3,
    sensitivity: 'restricted',
    academicSource: { labels: ['personal', 'restricted'] },
  });
  const detached = await write('PUT', `/api/v1/calendar/${plain.id}`, {
    title: plain.title,
    startsAt: plain.startsAt,
    endsAt: plain.endsAt,
    timeZone: 'UTC',
    courseId: null,
    topicId: null,
    sensitivity: 'unlabeled',
    ...change(3),
  });
  expect(detached.json().event.sensitivity).toBe('restricted');
});
it('advances a masked topic label once and retains source label history after detachment', async () => {
  const parent = (
    await write('POST', '/api/v1/courses', {
      name: 'Plain parent',
      operationId: randomUUID(),
    })
  ).json().course;
  const topic = (
    await write('POST', '/api/v1/topics', {
      courseId: parent.id,
      name: 'Restricted topic',
      sensitivity: 'restricted',
      operationId: randomUUID(),
    })
  ).json().topic;
  const source = (await create({ courseId: parent.id })).json().work;
  const event = (
    await planWork(
      source.id,
      studyPlanning({
        event: {
          ...studyPlanning().event,
          courseId: parent.id,
          topicId: topic.id,
        },
      }),
    )
  ).json().event;
  const revised = await write('PUT', `/api/v1/topics/${topic.id}`, {
    courseId: parent.id,
    name: 'Personal topic',
    sensitivity: 'personal',
    ...change(1),
  });
  expect(revised.statusCode).toBe(200);
  expect(
    (await get(`/api/v1/calendar/${event.id}`)).json().event,
  ).toMatchObject({
    version: 2,
    sensitivity: 'restricted',
    academicSource: { labels: ['personal', 'restricted'] },
  });
  await write('PUT', `/api/v1/topics/${topic.id}`, {
    courseId: parent.id,
    name: 'Same applied label',
    sensitivity: 'personal',
    ...change(2),
  });
  expect((await get(`/api/v1/calendar/${event.id}`)).json().event.version).toBe(
    2,
  );
  await write('PUT', `/api/v1/calendar/${event.id}`, {
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timeZone: 'UTC',
    courseId: null,
    topicId: null,
    sensitivity: 'unlabeled',
    ...change(2),
  });
  const owner = (
    await db.query('SELECT owner_id FROM owner_setup WHERE singleton=1')
  )[0]!.owner_id as string;
  await expect(
    resolveAIContext(db, owner, {
      kind: 'event',
      id: event.id,
      expectedVersion: 3,
    }),
  ).resolves.toMatchObject({
    labels: ['personal', 'restricted'],
    academicPlanning: { workId: source.id },
  });
});
it('serializes source planning with closing work rather than creating against a stale source', async () => {
  const source = (await create()).json().work;
  const input = taskPlanning();
  const [planned, closed] = await Promise.all([
    planWork(source.id, input),
    write('PUT', `/api/v1/academic-work/${source.id}`, {
      courseId,
      title: source.title,
      status: 'submitted',
      grade: { earned: 0, possible: 10 },
      ...change(1),
    }),
  ]);
  expect(closed.statusCode).toBe(200);
  expect([200, 409]).toContain(planned.statusCode);
  const current = academicPlannerWorkResponseSchema.parse(
    (await plannerWork(source.id)).json(),
  );
  expect(current.workVersion).toBe(2);
  expect(current.entries).toHaveLength(planned.statusCode === 200 ? 1 : 0);
  if (planned.statusCode === 200) {
    expect(current.entries[0]!.source.snapshot.status).toBe('planned');
    expect((await planWork(source.id, input)).json()).toEqual(planned.json());
    const detail = await get(
      `/api/v1/tasks/${planned.json().task.id}/academic-source`,
    );
    expect(detail.json().source.current.status).toBe('submitted');
    expect(detail.body).not.toContain('earned');
  }
});
it('enforces normalized same-owner links, one planner target and one source per item', async () => {
  const source = (await create()).json().work;
  const created = (await planWork(source.id, taskPlanning())).json();
  const owner = (
    await db.query('SELECT owner_id FROM owner_setup WHERE singleton=1')
  )[0]!.owner_id;
  const foreignTask = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { origin, cookie: otherCookie },
      payload: { title: 'Foreign task', operationId: randomUUID() },
    })
  ).json().task;
  const event = (
    await write('POST', '/api/v1/calendar', {
      ...studyPlanning().event,
      operationId: randomUUID(),
    })
  ).json().event;
  const insert = (
    taskId: string | null,
    eventId: string | null,
    workId = source.id,
    snapshot = created.source.snapshot,
  ) =>
    db.query(
      'INSERT INTO academic_planner_sources(id,owner_id,work_id,task_id,event_id,snapshot,labels) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::text[])',
      [
        randomUUID(),
        owner,
        workId,
        taskId,
        eventId,
        JSON.stringify(snapshot),
        [],
      ],
    );
  await expect(insert(foreignTask.id, null)).rejects.toMatchObject({
    code: '23503',
  });
  await expect(insert(created.task.id, null)).rejects.toMatchObject({
    code: '23505',
  });
  await expect(insert(null, null)).rejects.toMatchObject({ code: '23514' });
  await expect(insert(foreignTask.id, event.id)).rejects.toMatchObject({
    code: '23514',
  });
  await expect(
    insert(null, event.id, randomUUID(), {
      ...created.source.snapshot,
      id: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: '23514' });
  const unavailableWork = randomUUID();
  await expect(
    insert(null, event.id, unavailableWork, {
      ...created.source.snapshot,
      id: unavailableWork,
    }),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    insert(null, event.id, randomUUID(), {
      ...created.source.snapshot,
      id: source.id,
    }),
  ).rejects.toMatchObject({ code: '23514' });
});
it('requires owned open sources and guarded class/work versions before creating planner work', async () => {
  const source = (await create()).json().work;
  expect(
    (await planWork(source.id, taskPlanning({ expectedWorkVersion: 2 })))
      .statusCode,
  ).toBe(409);
  expect(
    (await planWork(source.id, taskPlanning({ expectedCourseVersion: 2 })))
      .statusCode,
  ).toBe(409);
  expect((await planWork(randomUUID(), taskPlanning())).statusCode).toBe(404);
  const foreign = await app.inject({
    method: 'POST',
    url: `/api/v1/academic-work/${source.id}/planner-work`,
    headers: { origin, cookie: otherCookie },
    payload: taskPlanning(),
  });
  expect(foreign.statusCode).toBe(404);
  const noAuth = await app.inject({
    method: 'POST',
    url: `/api/v1/academic-work/${source.id}/planner-work`,
    headers: { origin },
    payload: taskPlanning(),
  });
  expect(noAuth.statusCode).toBe(401);
  await write('PUT', `/api/v1/academic-work/${source.id}`, {
    courseId,
    title: source.title,
    status: 'submitted',
    grade: null,
    ...change(1),
  });
  expect(
    (await planWork(source.id, taskPlanning({ expectedWorkVersion: 2 }))).json()
      .error.code,
  ).toBe('ACADEMIC_WORK_CLOSED');
  await write('DELETE', `/api/v1/academic-work/${source.id}`, change(2));
  expect(
    (await planWork(source.id, taskPlanning({ expectedWorkVersion: 3 }))).json()
      .error.code,
  ).toBe('ACADEMIC_WORK_DELETED');
  const open = (await create()).json().work;
  await write('DELETE', `/api/v1/courses/${courseId}`, change(1));
  expect(
    (await planWork(open.id, taskPlanning({ expectedCourseVersion: 2 }))).json()
      .error.code,
  ).toBe('ACADEMIC_CLASS_ARCHIVED');
});
it('rejects unvalidated study/source payloads and makes unknown links explicit without leaking ownership', async () => {
  const source = (await create()).json().work;
  const normal = (
    await write('POST', '/api/v1/tasks', {
      title: 'Ordinary task',
      operationId: randomUUID(),
    })
  ).json().task;
  expect(
    (await get(`/api/v1/tasks/${normal.id}/academic-source`)).json().source,
  ).toBeNull();
  const linked = (await planWork(source.id, taskPlanning())).json().task;
  for (const url of [
    `/api/v1/academic-work/${source.id}/planner-work`,
    `/api/v1/tasks/${linked.id}/academic-source`,
  ]) {
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (await app.inject({ url, headers: { origin, cookie: otherCookie } }))
        .statusCode,
    ).toBe(404);
  }
  for (const input of [
    taskPlanning({
      task: {
        title: 'Bad source',
        canvasSourceRef: { itemId: randomUUID(), expectedVersion: 1 },
      },
    }),
    taskPlanning({ task: { title: 'Bad source', academicSource: {} } }),
    studyPlanning({
      event: { ...studyPlanning().event, courseId: randomUUID() },
    }),
    studyPlanning({
      event: { ...studyPlanning().event, endsAt: '2030-04-04T12:01:00Z' },
    }),
    studyPlanning({
      event: {
        ...studyPlanning().event,
        recurrence: { frequency: 'daily', interval: 1, count: 2, until: null },
      },
    }),
    studyPlanning({
      event: { ...studyPlanning().event, studyStatus: 'completed' },
    }),
  ])
    expect((await planWork(source.id, input)).statusCode).toBe(400);
  expect((await plannerWork(source.id, '?deleted=maybe')).statusCode).toBe(400);
  expect(
    (await get(`/api/v1/tasks/${linked.id}/academic-source?limit=1`))
      .statusCode,
  ).toBe(400);
});
it('rolls back planner creation and receipt on a link failure, then deduplicates competing retries', async () => {
  const source = (await create()).json().work;
  const input = taskPlanning();
  await db.exec(`CREATE FUNCTION reject_academic_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic failure'; END $$;
    CREATE TRIGGER reject_academic_link BEFORE INSERT ON academic_planner_sources FOR EACH ROW EXECUTE FUNCTION reject_academic_link()`);
  expect((await planWork(source.id, input)).statusCode).toBe(500);
  const failedStudy = studyPlanning();
  expect((await planWork(source.id, failedStudy)).statusCode).toBe(500);
  expect((await db.query('SELECT id FROM tasks')).length).toBe(0);
  expect((await db.query('SELECT id FROM events')).length).toBe(0);
  expect(
    (await db.query('SELECT id FROM academic_planner_sources')).length,
  ).toBe(0);
  expect(
    (
      await db.query(
        'SELECT operation_id FROM mutation_receipts WHERE operation_id=$1',
        [input.operationId],
      )
    ).length,
  ).toBe(0);
  await db.exec(
    'DROP TRIGGER reject_academic_link ON academic_planner_sources; DROP FUNCTION reject_academic_link()',
  );
  const results = await Promise.all([
    planWork(source.id, input),
    planWork(source.id, input),
  ]);
  expect(results[0]!.statusCode).toBe(200);
  expect(results[1]!.json()).toEqual(results[0]!.json());
  expect((await db.query('SELECT id FROM tasks')).length).toBe(1);
  expect(
    (await db.query('SELECT id FROM academic_planner_sources')).length,
  ).toBe(1);
});
it('pages owned linked tasks and blocks with stable cursors and explicit deleted filters', async () => {
  const source = (await create()).json().work;
  const linked = [];
  for (let i = 0; i < 4; i++)
    linked.push(
      (
        await planWork(source.id, i % 2 ? studyPlanning() : taskPlanning())
      ).json(),
    );
  const ids: string[] = [];
  let query = '?limit=1&deleted=all';
  for (let i = 0; i < 5; i++) {
    const response = await plannerWork(source.id, query);
    expect(response.statusCode).toBe(200);
    const result = academicPlannerWorkResponseSchema.parse(response.json());
    ids.push(...result.entries.map((entry) => entry.source.id));
    if (!result.nextAfter) break;
    query = `?limit=1&deleted=all&after=${result.nextAfter}`;
  }
  expect(ids).toEqual(linked.map((result) => result.source.id).sort());
  expect(
    (await plannerWork(source.id, `?after=${randomUUID()}`)).statusCode,
  ).toBe(404);
  await write('DELETE', `/api/v1/tasks/${linked[0].task.id}`, change(1));
  expect(
    (await plannerWork(source.id, '?deleted=false')).json().entries,
  ).toHaveLength(3);
  expect(
    (await plannerWork(source.id, '?deleted=true')).json().entries,
  ).toHaveLength(1);
  expect(
    (
      await plannerWork(
        source.id,
        `?deleted=false&after=${linked[0].source.id}`,
      )
    ).statusCode,
  ).toBe(200);
});
it('preserves legacy planner rows and receipts without inventing academic links on migration upgrade', async () => {
  const source = (await create()).json().work;
  const input = { title: 'Legacy planner task', operationId: randomUUID() };
  const original = await write('POST', '/api/v1/tasks', input);
  await db.exec(
    'DROP TABLE academic_planner_sources; ALTER TABLE tasks DROP CONSTRAINT tasks_owned_id',
  );
  await db.query(
    "DELETE FROM schema_migrations WHERE name IN ('028_academic_planner_sources.sql','045_academic_origin_guard.sql')",
  );
  await migrate(db);
  expect((await write('POST', '/api/v1/tasks', input)).json()).toEqual(
    original.json(),
  );
  expect(
    (await get(`/api/v1/tasks/${original.json().task.id}`)).json(),
  ).toEqual(original.json());
  expect((await plannerWork(source.id)).json().entries).toEqual([]);
  expect(
    (
      await get(`/api/v1/tasks/${original.json().task.id}/academic-source`)
    ).json().source,
  ).toBeNull();
});
it('exports retained academic planner snapshots without treating completion as a source update', async () => {
  const source = (await create({ estimatedMinutes: null })).json().work;
  const result = (await planWork(source.id, taskPlanning())).json();
  await write('DELETE', `/api/v1/tasks/${result.task.id}`, change(1));
  await write('DELETE', `/api/v1/academic-work/${source.id}`, change(1));
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(exported.records.academicPlannerSources).toHaveLength(1);
  expect(exported.records.academicPlannerSources[0]).toEqual(result.source);
  expect(exported.records.tasks[0]!.academicSource).toMatchObject({
    sourceDeleted: true,
    workId: source.id,
  });
  expect(exported.records.tasks[0]!.deletedAt).not.toBeNull();
});
it('reports linked planning statuses without changing submission, scores or full estimates', async () => {
  const source = (await create({ estimatedMinutes: 100 })).json().work;
  const task = (await planWork(source.id, taskPlanning())).json().task;
  const block = (await planWork(source.id, studyPlanning())).json().event;
  await write('PUT', `/api/v1/tasks/${task.id}`, {
    title: task.title,
    completed: true,
    ...change(1),
  });
  await write('PUT', `/api/v1/calendar/${block.id}`, {
    ...studyPlanning().event,
    studyStatus: 'completed',
    ...change(1),
  });
  const cancelled = (await planWork(source.id, studyPlanning())).json().event;
  await write('PUT', `/api/v1/calendar/${cancelled.id}`, {
    ...studyPlanning().event,
    studyStatus: 'cancelled',
    ...change(1),
  });
  const deleted = (await planWork(source.id, taskPlanning())).json().task;
  await write('DELETE', `/api/v1/tasks/${deleted.id}`, change(1));
  const result = academicPlannerSummarySchema.parse(
    (await planningSummary(source.id)).json(),
  );
  expect(result.currentWork).toMatchObject({
    version: 1,
    status: 'planned',
    estimatedMinutes: 100,
  });
  expect(result.tasks).toEqual({
    openCount: 0,
    completedCount: 1,
    deletedCount: 1,
  });
  expect(result.calendar).toEqual({
    recordCount: 2,
    deletedRecordCount: 0,
    plannedCount: 0,
    completedCount: 1,
    cancelledCount: 1,
    allDayCount: 0,
    plannedMinutes: 0,
    completedMinutes: 25,
    cancelledMinutes: 25,
  });
  expect(result.warnings).toContain('PLANNER_COMPLETION_IS_NOT_SUBMISSION');
  expect(result.warnings).toContain('STUDY_TIME_IS_NOT_MASTERY');
  const empty = await planningSummary(
    source.id,
    'from=2030-04-20&to=2030-04-21&timeZone=UTC',
  );
  expect(empty.json().calendar).toMatchObject({
    recordCount: 2,
    completedCount: 0,
    completedMinutes: 0,
  });
  expect(empty.json().tasks.completedCount).toBe(1);
});
it('reports recurrence and occurrence edits and excludes all-day/deleted minutes explicitly', async () => {
  const source = (await create()).json().work;
  const block = (await planWork(source.id, studyPlanning())).json().event;
  const recurring = await write('PUT', `/api/v1/calendar/${block.id}`, {
    ...studyPlanning().event,
    recurrence: { frequency: 'daily', interval: 1, count: 3, until: null },
    ...change(1),
  });
  expect(recurring.statusCode).toBe(200);
  const cancelled = await write(
    'DELETE',
    `/api/v1/calendar/${block.id}/occurrences/2030-04-05`,
    change(2),
  );
  expect(cancelled.statusCode).toBe(200);
  const completed = await write(
    'PUT',
    `/api/v1/calendar/${block.id}/occurrences/2030-04-06`,
    {
      ...studyPlanning().event,
      startsAt: '2030-04-06T09:00:00Z',
      endsAt: '2030-04-06T09:40:00Z',
      studyStatus: 'completed',
      ...change(3),
    },
  );
  expect(completed.statusCode).toBe(200);
  const result = academicPlannerSummarySchema.parse(
    (await planningSummary(source.id)).json(),
  );
  expect(result.calendar).toMatchObject({
    recordCount: 1,
    plannedCount: 1,
    completedCount: 1,
    cancelledCount: 0,
    plannedMinutes: 25,
    completedMinutes: 40,
  });
  const allDay = await write('PUT', `/api/v1/calendar/${block.id}`, {
    ...studyPlanning().event,
    allDay: true,
    startDate: '2030-04-04',
    endDate: '2030-04-05',
    ...change(4),
  });
  expect(allDay.statusCode).toBe(200);
  expect((await planningSummary(source.id)).json().calendar).toMatchObject({
    recordCount: 1,
    allDayCount: 1,
    plannedCount: 0,
    completedCount: 0,
    plannedMinutes: 0,
    completedMinutes: 0,
  });
  await write('DELETE', `/api/v1/calendar/${block.id}`, change(5));
  expect((await planningSummary(source.id)).json().calendar).toMatchObject({
    recordCount: 0,
    deletedRecordCount: 1,
    allDayCount: 0,
  });
});
it('clips linked Calendar time to local report boundaries and uses elapsed minutes across DST', async () => {
  const source = (await create({ estimatedMinutes: 60 })).json().work;
  for (const [startsAt, endsAt] of [
    ['2030-03-10T06:50:00Z', '2030-03-10T07:15:00Z'],
    ['2030-03-10T08:50:00Z', '2030-03-10T09:15:00Z'],
  ])
    expect(
      (
        await planWork(
          source.id,
          studyPlanning({
            event: {
              ...studyPlanning().event,
              startsAt,
              endsAt,
              timeZone: 'America/Denver',
            },
          }),
        )
      ).statusCode,
    ).toBe(200);
  const result = academicPlannerSummarySchema.parse(
    (
      await planningSummary(
        source.id,
        'from=2030-03-10&to=2030-03-11&timeZone=America%2FDenver',
      )
    ).json(),
  );
  expect(result.calendar).toMatchObject({
    plannedCount: 2,
    plannedMinutes: 40,
  });
  expect(result.currentWork.estimatedMinutes).toBe(60);
  expect(
    (
      await planningSummary(
        source.id,
        'from=2030-03-09&to=2030-03-10&timeZone=America%2FDenver',
      )
    ).json().calendar.plannedMinutes,
  ).toBe(10);
});
it('keeps report counts complete beyond one page, retains archived source history and validates ownership/ranges', async () => {
  const source = (await create()).json().work;
  const linked = (await planWork(source.id, taskPlanning())).json();
  const owner = (
    await db.query('SELECT owner_id FROM owner_setup WHERE singleton=1')
  )[0]!.owner_id;
  await db.query(
    `WITH inserted AS (INSERT INTO tasks(id,owner_id,title) SELECT gen_random_uuid(),$1,'Synthetic linked task' FROM generate_series(1,200) RETURNING id)
    INSERT INTO academic_planner_sources(id,owner_id,work_id,task_id,snapshot,labels) SELECT gen_random_uuid(),$1,$2,id,$3::jsonb,ARRAY['personal']::text[] FROM inserted`,
    [owner, source.id, JSON.stringify(linked.source.snapshot)],
  );
  expect(
    (await plannerWork(source.id, '?limit=200')).json().entries,
  ).toHaveLength(200);
  expect((await planningSummary(source.id)).json().tasks.openCount).toBe(201);
  const url = `/api/v1/academic-work/${source.id}/planner-work-summary?from=2030-04-04&to=2030-04-11&timeZone=UTC`;
  expect((await app.inject({ url })).statusCode).toBe(401);
  expect(
    (await app.inject({ url, headers: { cookie: otherCookie } })).statusCode,
  ).toBe(404);
  expect(
    (
      await planningSummary(
        source.id,
        'from=2030-04-04&to=2030-05-06&timeZone=UTC',
      )
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await planningSummary(
        source.id,
        'from=2030-02-30&to=2030-03-04&timeZone=UTC',
      )
    ).statusCode,
  ).toBe(400);
  await write('DELETE', `/api/v1/courses/${courseId}`, change(1));
  expect((await planningSummary(source.id)).json()).toMatchObject({
    currentWork: { courseArchived: true },
    tasks: { openCount: 201 },
  });
  await db.query(
    `WITH inserted AS (INSERT INTO tasks(id,owner_id,title) SELECT gen_random_uuid(),$1,'Synthetic linked task' FROM generate_series(1,4800) RETURNING id)
    INSERT INTO academic_planner_sources(id,owner_id,work_id,task_id,snapshot,labels) SELECT gen_random_uuid(),$1,$2,id,$3::jsonb,ARRAY['personal']::text[] FROM inserted`,
    [owner, source.id, JSON.stringify(linked.source.snapshot)],
  );
  const blocked = await planningSummary(source.id);
  expect(blocked.statusCode).toBe(413);
  expect(blocked.json().error.code).toBe('ACADEMIC_WORK_TOO_LARGE');
});
it('keeps manual records versioned with exact retry receipts and competing write conflicts', async () => {
  const input = {
    courseId,
    title: 'Exam',
    kind: 'exam',
    dueDate: '2030-04-07',
    estimatedMinutes: 120,
    operationId: randomUUID(),
  };
  const first = await write('POST', '/api/v1/academic-work', input);
  expect(first.statusCode).toBe(200);
  const record = academicWorkSchema.parse(first.json().work);
  expect(record).toMatchObject({
    provenance: 'owner-entered',
    sensitivity: 'personal',
    academicLabels: ['personal'],
    grade: null,
    version: 1,
  });
  expect((await write('POST', '/api/v1/academic-work', input)).json()).toEqual(
    first.json(),
  );
  expect(
    (
      await write('POST', '/api/v1/academic-work', {
        ...input,
        title: 'Changed',
      })
    ).json().error.code,
  ).toBe('OPERATION_CONFLICT');
  const edits = await Promise.all(
    ['First', 'Second'].map((title) =>
      write('PUT', `/api/v1/academic-work/${record.id}`, {
        courseId,
        kind: record.kind,
        dueDate: record.dueDate,
        estimatedMinutes: record.estimatedMinutes,
        title,
        status: 'in_progress',
        grade: null,
        ...change(1),
      }),
    ),
  );
  expect(edits.map((v) => v.statusCode).sort()).toEqual([200, 409]);
  expect(
    (await get(`/api/v1/academic-work/${record.id}`)).json().work.version,
  ).toBe(2);
});
it('requires explicit score/status on updates and validates score bounds and incompatible states', async () => {
  const record = (
    await create({ status: 'submitted', grade: { earned: 0, possible: 10 } })
  ).json().work;
  const missing = await write('PUT', `/api/v1/academic-work/${record.id}`, {
    courseId,
    title: 'Notes edit',
    ...change(1),
  });
  expect(missing.statusCode).toBe(400);
  for (const fields of [
    { status: 'planned', grade: { earned: 1, possible: 10 } },
    { status: 'submitted', grade: { earned: -1, possible: 10 } },
    { status: 'submitted', grade: { earned: 1, possible: 0 } },
    { status: 'submitted', grade: { earned: 1, possible: 0.00001 } },
    { status: 'submitted', grade: { earned: 0.12345, possible: 10 } },
    { status: 'submitted', grade: { earned: 1, possible: 1000001 } },
    { dueDate: '2030-02-30' },
    { estimatedMinutes: 60001 },
    { provenance: 'canvas' },
  ])
    expect((await create(fields)).statusCode).toBe(400);
  expect(
    (await get(`/api/v1/academic-work/${record.id}`)).json().work.grade,
  ).toEqual({ earned: 0, possible: 10 });
  expect(
    (
      await create({
        status: 'submitted',
        grade: { earned: 12.125, possible: 10.5 },
      })
    ).statusCode,
  ).toBe(200);
});
it('keeps missing academic data unknown and separates submission, scores and manual topic confidence', async () => {
  await write('POST', '/api/v1/topics', {
    courseId,
    name: 'Atoms',
    confidence: 'low',
    progress: 20,
    operationId: randomUUID(),
  });
  await create({
    title: 'Overdue',
    dueDate: '2030-04-01',
    estimatedMinutes: 60,
  });
  await create({
    title: 'Due today',
    dueDate: '2030-04-04',
    estimatedMinutes: 0,
    status: 'in_progress',
  });
  await create({ title: 'Missing data' });
  await create({ title: 'Submitted unknown score', status: 'submitted' });
  await create({
    title: 'Recorded zero',
    status: 'submitted',
    grade: { earned: 0, possible: 20 },
  });
  await create({
    title: 'Recorded extra credit',
    status: 'submitted',
    grade: { earned: 11, possible: 10 },
  });
  await create({
    title: 'Cancelled',
    status: 'cancelled',
    dueDate: '2030-01-01',
    estimatedMinutes: 100,
  });
  const removed = (
    await create({ status: 'submitted', grade: { earned: 100, possible: 100 } })
  ).json().work;
  await write('DELETE', `/api/v1/academic-work/${removed.id}`, change(1));
  const response = await summary();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    activeCount: 6,
    submittedCount: 3,
    overdueCount: 1,
    missingDeadlineCount: 1,
    missingEstimateCount: 1,
    estimatedOpenMinutes: 60,
    recordedScoreCount: 2,
    ungradedSubmittedCount: 1,
    recordedEarnedPoints: 11,
    recordedPossiblePoints: 30,
    recordedPointsPercent: (11 / 30) * 100,
    warnings: [
      'MANUAL_RECORDS_ONLY',
      'NOT_FINAL_CLASS_GRADE',
      'EXTRA_CREDIT_PRESENT',
    ],
  });
  expect((await get('/api/v1/topics')).json().topics[0]).toMatchObject({
    confidence: 'low',
    progress: 20,
    version: 1,
  });
  expect((await get('/api/v1/tasks')).json().tasks).toEqual([]);
  expect((await get('/api/v1/calendar')).json().events).toEqual([]);
});
it('reports an empty class with an unknown score rather than zero percent', async () => {
  expect((await summary()).json()).toMatchObject({
    activeCount: 0,
    recordedScoreCount: 0,
    recordedPointsPercent: null,
    courseArchived: false,
  });
  expect(
    (await get(`/api/v1/courses/${courseId}/work-summary`)).statusCode,
  ).toBe(400);
});
it('retains tombstones and labels applied while deleted and requires deliberate restore', async () => {
  const r = (
    await create({
      sensitivity: 'restricted',
      status: 'submitted',
      grade: { earned: 8, possible: 10 },
    })
  ).json().work;
  const del = change(1);
  const deleted = await write('DELETE', `/api/v1/academic-work/${r.id}`, del);
  expect(deleted.statusCode).toBe(200);
  expect(
    (await write('DELETE', `/api/v1/academic-work/${r.id}`, del)).json(),
  ).toEqual(deleted.json());
  expect((await get('/api/v1/academic-work')).json().work).toEqual([]);
  expect(
    (await get('/api/v1/academic-work?deleted=true')).json().work[0].id,
  ).toBe(r.id);
  // Initial restricted item masks the newly inherited personal label only visually.
  await write('PUT', `/api/v1/courses/${courseId}`, {
    name: 'Chemistry',
    sensitivity: 'restricted',
    ...change(1),
  });
  const current = (await get(`/api/v1/academic-work/${r.id}`)).json().work;
  expect(current.academicLabels).toEqual(['personal', 'restricted']);
  const restored = await write(
    'POST',
    `/api/v1/academic-work/${r.id}/restore`,
    change(current.version),
  );
  expect(restored.statusCode).toBe(200);
  expect(restored.json().work).toMatchObject({
    deletedAt: null,
    grade: { earned: 8, possible: 10 },
    academicLabels: ['personal', 'restricted'],
  });
  expect(
    (await write('DELETE', `/api/v1/academic-work/${r.id}`, del)).json(),
  ).toEqual(deleted.json());
});
it('advances masked label versions on tombstones and blocks stale restoration', async () => {
  const unlabelled = (
    await write('POST', '/api/v1/courses', {
      name: 'Other',
      operationId: randomUUID(),
    })
  ).json().course;
  const r = (
    await create({ courseId: unlabelled.id, sensitivity: 'restricted' })
  ).json().work;
  await write('DELETE', `/api/v1/academic-work/${r.id}`, change(1));
  await write('PUT', `/api/v1/courses/${unlabelled.id}`, {
    name: 'Other',
    sensitivity: 'personal',
    ...change(1),
  });
  expect(
    (
      await write('POST', `/api/v1/academic-work/${r.id}/restore`, change(2))
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
  const current = (await get(`/api/v1/academic-work/${r.id}`)).json().work;
  expect(current).toMatchObject({
    version: 3,
    sensitivity: 'restricted',
    academicLabels: ['personal', 'restricted'],
  });
  expect(
    (await write('POST', `/api/v1/academic-work/${r.id}/restore`, change(3)))
      .statusCode,
  ).toBe(200);
});
it('preserves labels through owner relabeling and prohibits moving records between classes', async () => {
  const r = (await create({ sensitivity: 'restricted' })).json().work;
  const second = (
    await write('POST', '/api/v1/courses', {
      name: 'Different',
      operationId: randomUUID(),
    })
  ).json().course;
  const body = {
    courseId,
    title: 'Relabeled',
    status: 'planned',
    grade: null,
    sensitivity: 'unlabeled',
    ...change(1),
  };
  expect(
    (
      await write('PUT', `/api/v1/academic-work/${r.id}`, {
        ...body,
        courseId: second.id,
      })
    ).statusCode,
  ).toBe(400);
  const saved = await write('PUT', `/api/v1/academic-work/${r.id}`, body);
  expect(saved.statusCode).toBe(200);
  expect(saved.json().work.academicLabels).toEqual(['personal', 'restricted']);
  expect(
    (await write('PUT', `/api/v1/academic-work/${r.id}`, body)).json(),
  ).toEqual(saved.json());
});
it('retains academic history when a class is archived and permits historical deletion but not restore', async () => {
  const r = (
    await create({ status: 'submitted', grade: { earned: 75, possible: 100 } })
  ).json().work;
  await write('DELETE', `/api/v1/courses/${courseId}`, change(1));
  expect((await summary()).json()).toMatchObject({
    courseArchived: true,
    recordedPointsPercent: 75,
  });
  expect((await create()).statusCode).toBe(404);
  expect(
    (
      await write('PUT', `/api/v1/academic-work/${r.id}`, {
        courseId,
        title: 'Archive edit',
        status: 'submitted',
        grade: { earned: 80, possible: 100 },
        ...change(1),
      })
    ).statusCode,
  ).toBe(404);
  const deleted = await write(
    'DELETE',
    `/api/v1/academic-work/${r.id}`,
    change(1),
  );
  expect(deleted.statusCode).toBe(200);
  expect(
    (
      await write('POST', `/api/v1/academic-work/${r.id}/restore`, change(2))
    ).json().error.code,
  ).toBe('ACADEMIC_CLASS_ARCHIVED');
});
it('requires ownership on every read/write and enforces class ownership in SQL', async () => {
  const r = (await create()).json().work;
  for (const url of [
    '/api/v1/academic-work',
    `/api/v1/academic-work/${r.id}`,
    `/api/v1/courses/${courseId}/work-summary?asOf=2030-04-04`,
  ])
    expect((await app.inject({ url })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        url: '/api/v1/academic-work',
        headers: { cookie: otherCookie },
      })
    ).json().work,
  ).toEqual([]);
  for (const url of [
    `/api/v1/academic-work/${r.id}`,
    `/api/v1/academic-work?before=${r.id}`,
    `/api/v1/academic-work?courseId=${courseId}`,
    `/api/v1/courses/${courseId}/work-summary?asOf=2030-04-04`,
  ])
    expect(
      (await app.inject({ url, headers: { cookie: otherCookie } })).statusCode,
    ).toBe(404);
  for (const action of ['delete', 'restore', 'create'] as const) {
    const response = await app.inject({
      method: action === 'delete' ? 'DELETE' : 'POST',
      url:
        action === 'create'
          ? '/api/v1/academic-work'
          : `/api/v1/academic-work/${r.id}${action === 'restore' ? '/restore' : ''}`,
      headers: { origin, cookie: otherCookie },
      payload:
        action === 'create'
          ? { courseId, title: 'Foreign class', operationId: randomUUID() }
          : change(1),
    });
    expect(response.statusCode).toBe(404);
  }
  await expect(
    db.query(
      "INSERT INTO academic_work(id,owner_id,course_id,title,kind,priority,status,sensitivity) VALUES($1,$2,$3,'Foreign','assignment',3,'planned','unlabeled')",
      [randomUUID(), otherOwner, courseId],
    ),
  ).rejects.toMatchObject({ code: '23503' });
});
it('pages by precise creation time even when cursors are deleted or status filters change', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = (await create()).json().work;
    ids.push(r.id);
    await db.query(
      'UPDATE academic_work SET created_at=$2::timestamptz WHERE id=$1',
      [r.id, `2030-01-01T00:00:00.00000${i + 1}Z`],
    );
  }
  const first = (
    await get('/api/v1/academic-work?limit=1&status=planned')
  ).json();
  expect(first.nextBefore).toBe(ids[2]);
  await write('DELETE', `/api/v1/academic-work/${ids[2]}`, change(1));
  const second = (
    await get(
      `/api/v1/academic-work?limit=1&status=planned&before=${first.nextBefore}`,
    )
  ).json();
  expect(second.nextBefore).toBe(ids[1]);
  const last = (
    await get(`/api/v1/academic-work?limit=1&before=${second.nextBefore}`)
  ).json();
  expect(last.work[0].id).toBe(ids[0]);
  expect(last.nextBefore).toBeNull();
  for (const url of [
    '/api/v1/academic-work?limit=201',
    '/api/v1/academic-work?status=graded',
    '/api/v1/academic-work?deleted=1',
  ])
    expect((await get(url)).statusCode).toBe(400);
});
it('exports records, scores and tombstones while accepting older exports without academic work', async () => {
  const r = (
    await create({ status: 'submitted', grade: { earned: 90, possible: 100 } })
  ).json().work;
  await write('DELETE', `/api/v1/academic-work/${r.id}`, change(1));
  const response = (await get('/api/v1/planner/export')).json();
  const exported = plannerExportSchema.parse(response);
  expect(exported.records.academicWork[0]).toMatchObject({
    id: r.id,
    version: 2,
    provenance: 'owner-entered',
    grade: { earned: 90, possible: 100 },
  });
  expect(exported.records.academicWork[0]!.deletedAt).not.toBeNull();
  delete response.records.academicWork;
  expect(plannerExportSchema.parse(response).records.academicWork).toEqual([]);
});
it('upgrades a populated planner without changing existing records or receipts', async () => {
  const input = {
    title: 'Existing planner task',
    notes: 'Retained owner note',
    operationId: randomUUID(),
  };
  const task = await write('POST', '/api/v1/tasks', input);
  const course = (await get('/api/v1/courses')).json();
  const receipts = await db.query(
    'SELECT operation_id,payload_hash,result FROM mutation_receipts ORDER BY operation_id',
  );
  await db.exec(`ALTER TABLE reminders DROP CONSTRAINT reminders_owned_academic_work;
    ALTER TABLE reminders DROP COLUMN academic_work_id;
    DROP TABLE academic_planner_sources;
    ALTER TABLE tasks DROP CONSTRAINT tasks_owned_id;
    DROP TABLE study_event_contexts;
    DROP TABLE study_workload_sources;
    DROP TABLE study_workload_contexts;
    ALTER TABLE study_plans DROP CONSTRAINT study_plans_owned_id;
    ALTER TABLE events DROP CONSTRAINT events_owned_id;
    DROP TABLE academic_work`);
  await db.query(
    "DELETE FROM schema_migrations WHERE name IN ('026_academic_work.sql','027_study_workload_sources.sql','028_academic_planner_sources.sql','029_academic_work_reminders.sql','045_academic_origin_guard.sql')",
  );
  await migrate(db);
  expect((await get('/api/v1/courses')).json()).toEqual(course);
  expect((await write('POST', '/api/v1/tasks', input)).json()).toEqual(
    task.json(),
  );
  expect(
    await db.query(
      'SELECT operation_id,payload_hash,result FROM mutation_receipts ORDER BY operation_id',
    ),
  ).toEqual(receipts);
  expect((await create()).statusCode).toBe(200);
});
it('refuses oversized summaries instead of reporting a truncated class total', async () => {
  await db.query(
    "INSERT INTO academic_work(id,owner_id,course_id,title,kind,priority,status,sensitivity) SELECT gen_random_uuid(),c.owner_id,c.id,'Synthetic bulk record','assignment',3,'planned','unlabeled' FROM courses c CROSS JOIN generate_series(1,5001) WHERE c.id=$1",
    [courseId],
  );
  expect((await summary()).json().error.code).toBe('ACADEMIC_WORK_TOO_LARGE');
  expect(
    (await get('/api/v1/academic-work?limit=200')).json().work,
  ).toHaveLength(200);
});
it('persists scores and mutation receipts across an isolated database restart', async () => {
  const root = resolve('.artifacts', 'academic-work-persistence');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'run-'));
  let persistent: typeof app | undefined;
  try {
    const cfg = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: path });
    persistent = await buildApp({ logger: false }, { config: cfg });
    const setup = await persistent.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'academic-restart@example.test',
        password: 'synthetic-academic-password',
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
        name: 'Restart course',
        operationId: randomUUID(),
      })
    ).json().course;
    const input = {
      courseId: course.id,
      title: 'Retained score',
      status: 'submitted',
      grade: { earned: 9.5, possible: 10 },
      operationId: randomUUID(),
    };
    const record = await send('/api/v1/academic-work', input);
    expect(record.statusCode).toBe(200);
    const open = await send('/api/v1/academic-work', {
      courseId: course.id,
      title: 'Restart planning source',
      estimatedMinutes: 0,
      operationId: randomUUID(),
    });
    expect(open.statusCode).toBe(200);
    const planningInput = taskPlanning();
    const plannedTask = await send(
      `/api/v1/academic-work/${open.json().work.id}/planner-work`,
      planningInput,
    );
    expect(plannedTask.statusCode).toBe(200);
    const plannedBlock = await send(
      `/api/v1/academic-work/${open.json().work.id}/planner-work`,
      studyPlanning({
        event: { ...studyPlanning().event, courseId: course.id },
      }),
    );
    expect(plannedBlock.statusCode).toBe(200);
    const closed = await persistent.inject({
      method: 'PUT',
      url: `/api/v1/academic-work/${open.json().work.id}`,
      headers: { origin, cookie: session },
      payload: {
        courseId: course.id,
        title: 'Source closed',
        status: 'submitted',
        grade: null,
        ...change(1),
      },
    });
    expect(closed.statusCode).toBe(200);
    await persistent.close();
    persistent = undefined;
    persistent = await buildApp({ logger: false }, { config: cfg });
    expect((await send('/api/v1/academic-work', input)).json()).toEqual(
      record.json(),
    );
    const list = await persistent.inject({
      url: '/api/v1/academic-work',
      headers: { cookie: session },
    });
    expect(list.json().work).toHaveLength(2);
    expect(
      list
        .json()
        .work.find((work: { id: string }) => work.id === record.json().work.id)
        .grade,
    ).toEqual(input.grade);
    expect(
      (
        await send(
          `/api/v1/academic-work/${open.json().work.id}/planner-work`,
          planningInput,
        )
      ).json(),
    ).toEqual(plannedTask.json());
    const retained = await persistent.inject({
      url: `/api/v1/academic-work/${open.json().work.id}/planner-work?deleted=all`,
      headers: { cookie: session },
    });
    expect(retained.statusCode).toBe(200);
    expect(retained.json().entries).toHaveLength(2);
    const provenance = await persistent.inject({
      url: `/api/v1/tasks/${plannedTask.json().task.id}/academic-source`,
      headers: { cookie: session },
    });
    expect(provenance.statusCode).toBe(200);
    expect(provenance.json().source).toMatchObject({
      changed: true,
      snapshot: { version: 1, estimatedMinutes: 0 },
      current: { version: 2, status: 'submitted' },
    });
  } finally {
    await persistent?.close();
    if (dirname(resolve(path)) === root)
      await rm(path, { recursive: true, force: true });
  }
});
