import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  academicWorkBatchRequestSchema,
  academicWorkBatchResponseSchema,
  academicWorkBrowseResponseSchema,
  plannerExportSchema,
} from '@hub/contracts';
import type { AcademicWork } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { runReminderBatch } from '../src/features/reminders.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
async function removeSyntheticArtifact(root: string, directory: string) {
  const target = resolve(directory);
  if (dirname(target) !== root)
    throw Error('Invalid synthetic artifact directory');
  await rm(target, { recursive: true, force: true });
}
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
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
const item = (work: AcademicWork, expectedCourseVersion = 1) => ({
  id: work.id,
  expectedVersion: work.version,
  expectedCourseVersion,
});
const update = (
  work: AcademicWork[],
  changes: object,
  expectedCourseVersion = 1,
) => ({
  operationId: randomUUID(),
  items: work.map((value) => item(value, expectedCourseVersion)),
  action: { kind: 'update', changes },
});
const batch = (payload: object) =>
  write('POST', '/api/v1/academic-work/batch', payload);
const browse = (query = '') =>
  get(`/api/v1/academic-work/browse${query ? '?' + query : ''}`);
async function create(fields: object = {}): Promise<AcademicWork> {
  const response = await write('POST', '/api/v1/academic-work', {
    operationId: randomUUID(),
    courseId,
    title: 'Synthetic selected work',
    notes: 'Private manual notes',
    dueDate: '2030-04-04',
    estimatedMinutes: 45,
    ...fields,
  });
  expect(response.statusCode).toBe(200);
  return response.json().work;
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
      email: 'academic-batch@example.test',
      password: 'synthetic-academic-batch-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  const other = randomUUID(),
    token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-academic-batch@example.test',
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

it('browses empty work with exact zero totals and rejects unsupported or incomplete cursor filters', async () => {
  const empty = academicWorkBrowseResponseSchema.parse((await browse()).json());
  expect(empty).toMatchObject({
    courseId: null,
    courseState: 'active',
    status: 'all',
    kind: 'all',
    deadline: 'any',
    work: [],
    nextAfter: null,
  });
  expect(empty.summary).toEqual({
    totalCount: 0,
    openCount: 0,
    plannedCount: 0,
    inProgressCount: 0,
    submittedCount: 0,
    cancelledCount: 0,
    missingDeadlineCount: 0,
    missingEstimateCount: 0,
    estimatedOpenMinutes: 0,
  });
  for (const query of [
    'limit=0',
    'limit=201',
    'limit=1.5',
    'status=completed',
    'kind=quiz',
    'courseState=deleted',
    'deadline=today',
    'search=unknown',
    `after=${randomUUID()}`,
    'expectedCursorVersion=1',
    'expectedCourseVersion=1',
    `after=${randomUUID()}&expectedCursorVersion=1`,
    'expectedCursorVersion=1&expectedCourseVersion=1',
  ])
    expect((await browse(query)).statusCode).toBe(400);
});

it('pages open then closed work through tied/unknown deadlines with full filter counts independent of status and pages', async () => {
  await db.query(
    `INSERT INTO academic_work(id,owner_id,course_id,title,kind,notes,due_date,estimated_minutes,priority,status,sensitivity,academic_labels)
     SELECT gen_random_uuid(),$1,$2,'Synthetic browsed work ' || i,CASE WHEN i%2=0 THEN 'assignment' ELSE 'exam' END,'Private notes',
       CASE WHEN i%3=0 THEN NULL ELSE '2030-04-04'::date END,CASE WHEN i%5=0 THEN NULL ELSE 25 END,3,
       CASE i%4 WHEN 0 THEN 'planned' WHEN 1 THEN 'in_progress' WHEN 2 THEN 'submitted' ELSE 'cancelled' END,'personal',ARRAY['personal']::text[]
     FROM generate_series(1,207) i`,
    [owner, courseId],
  );
  const seen: string[] = [];
  const statuses: string[] = [];
  let cursor = '';
  let summary: unknown;
  do {
    const response = await browse(`limit=17${cursor}`);
    expect(response.statusCode).toBe(200);
    const page = academicWorkBrowseResponseSchema.parse(response.json());
    expect(page.summary).toEqual({
      totalCount: 207,
      openCount: 103,
      plannedCount: 51,
      inProgressCount: 52,
      submittedCount: 52,
      cancelledCount: 52,
      missingDeadlineCount: 34,
      missingEstimateCount: 21,
      estimatedOpenMinutes: 2050,
    });
    summary = page.summary;
    seen.push(...page.work.map((value) => value.id));
    statuses.push(...page.work.map((value) => value.status));
    expect(
      page.work.every(
        (value) =>
          value.courseName === 'Synthetic Chemistry' &&
          value.courseVersion === 1 &&
          !value.courseArchived,
      ),
    ).toBe(true);
    cursor = page.nextAfter
      ? `&after=${page.nextAfter.id}&expectedCursorVersion=${page.nextAfter.version}&expectedCourseVersion=${page.nextAfter.courseVersion}`
      : '';
  } while (cursor);
  expect(seen).toHaveLength(207);
  expect(new Set(seen).size).toBe(207);
  expect(
    statuses
      .slice(0, 103)
      .every((status) => ['planned', 'in_progress'].includes(status)),
  ).toBe(true);
  expect(
    statuses
      .slice(103)
      .every((status) => ['submitted', 'cancelled'].includes(status)),
  ).toBe(true);
  const submitted = academicWorkBrowseResponseSchema.parse(
    (await browse('status=submitted&limit=200')).json(),
  );
  expect(submitted.work).toHaveLength(52);
  expect(submitted.summary).toEqual(summary);
  expect(submitted.work.every((value) => value.status === 'submitted')).toBe(
    true,
  );
  const undated = academicWorkBrowseResponseSchema.parse(
    (await browse('deadline=undated&status=open&limit=200')).json(),
  );
  expect(undated.summary).toMatchObject({
    totalCount: 69,
    openCount: 34,
    missingDeadlineCount: 34,
  });
  expect(undated.work).toHaveLength(34);
  expect(undated.work.every((value) => value.dueDate === null)).toBe(true);
  const exams = academicWorkBrowseResponseSchema.parse(
    (await browse('kind=exam&limit=200')).json(),
  );
  expect(exams.summary.totalCount).toBe(104);
  expect(exams.work.every((value) => value.kind === 'exam')).toBe(true);
});

it('keeps archived-class browsing explicit and returns current class versions for batch selection', async () => {
  const first = await create();
  const archived = await write('POST', '/api/v1/courses', {
    operationId: randomUUID(),
    name: 'Archived synthetic class',
  });
  const historical = await create({
    courseId: archived.json().course.id,
    status: 'submitted',
    grade: { earned: 7, possible: 10 },
  });
  expect(
    (await write('DELETE', `/api/v1/courses/${historical.courseId}`, change(1)))
      .statusCode,
  ).toBe(200);
  const active = academicWorkBrowseResponseSchema.parse(
    (await browse()).json(),
  );
  expect(active.work.map((value) => value.id)).toEqual([first.id]);
  const old = academicWorkBrowseResponseSchema.parse(
    (await browse('courseState=archived')).json(),
  );
  expect(old.work[0]).toMatchObject({
    id: historical.id,
    courseVersion: 2,
    courseArchived: true,
    grade: historical.grade,
  });
  expect(old.summary).toMatchObject({
    totalCount: 1,
    openCount: 0,
    submittedCount: 1,
  });
  expect((await browse('courseState=all')).json().summary.totalCount).toBe(2);
  expect((await browse(`courseId=${historical.courseId}`)).json().work).toEqual(
    [],
  );
  const selected = active.work[0]!;
  expect(
    (
      await batch({
        operationId: randomUUID(),
        items: [
          {
            id: selected.id,
            expectedVersion: selected.version,
            expectedCourseVersion: selected.courseVersion,
          },
        ],
        action: { kind: 'update', changes: { priority: 5 } },
      })
    ).statusCode,
  ).toBe(200);
  expect((await browse(`courseId=${randomUUID()}`)).statusCode).toBe(404);
});

it('guards changed cursor work and ancestors and rejects unavailable/filtered anchors without partial pages', async () => {
  await create();
  await create();
  await create();
  const page = academicWorkBrowseResponseSchema.parse(
    (await browse('limit=1')).json(),
  );
  const cursor = page.nextAfter!;
  const query = `after=${cursor.id}&expectedCursorVersion=${cursor.version}&expectedCourseVersion=${cursor.courseVersion}`;
  expect((await browse(query)).statusCode).toBe(200);
  expect((await browse(`${query}&status=submitted`)).statusCode).toBe(404);
  expect(
    (
      await browse(
        `after=${randomUUID()}&expectedCursorVersion=1&expectedCourseVersion=1`,
      )
    ).statusCode,
  ).toBe(404);
  const changed = await batch({
    operationId: randomUUID(),
    items: [{ id: cursor.id, expectedVersion: 1, expectedCourseVersion: 1 }],
    action: { kind: 'update', changes: { dueDate: null } },
  });
  expect(changed.statusCode).toBe(200);
  expect((await browse(query)).json().error.code).toBe('VERSION_CONFLICT');
  const newQuery = `after=${cursor.id}&expectedCursorVersion=2&expectedCourseVersion=1`;
  expect(
    (
      await write('PUT', `/api/v1/courses/${courseId}`, {
        ...change(1),
        name: 'Changed class',
      })
    ).statusCode,
  ).toBe(200);
  expect((await browse(newQuery)).json().error.code).toBe('VERSION_CONFLICT');
  expect(
    (
      await batch({
        operationId: randomUUID(),
        items: [
          { id: cursor.id, expectedVersion: 2, expectedCourseVersion: 2 },
        ],
        action: { kind: 'delete' },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await browse(
        `after=${cursor.id}&expectedCursorVersion=3&expectedCourseVersion=2`,
      )
    ).statusCode,
  ).toBe(404);
});

it('does not disclose foreign classes, cursors, scores or notes through browsing', async () => {
  const work = await create({
    status: 'submitted',
    grade: { earned: 123, possible: 456 },
  });
  const noSession = await app.inject({ url: '/api/v1/academic-work/browse' });
  expect(noSession.statusCode).toBe(401);
  const session = { origin, cookie: otherCookie };
  const empty = await app.inject({
    url: '/api/v1/academic-work/browse',
    headers: session,
  });
  expect(empty.statusCode).toBe(200);
  expect(empty.json().summary.totalCount).toBe(0);
  for (const query of [
    `courseId=${courseId}`,
    `after=${work.id}&expectedCursorVersion=1&expectedCourseVersion=1`,
  ]) {
    const response = await app.inject({
      url: `/api/v1/academic-work/browse?${query}`,
      headers: session,
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(work.notes);
    expect(response.body).not.toContain('123');
  }
});

it('rejects ambiguous, unbounded and unsupported changes without mutation receipts', async () => {
  const work = await create();
  const valid = update([work], { status: 'submitted' });
  expect(academicWorkBatchRequestSchema.parse(valid)).toEqual(valid);
  const invalid = [
    { ...valid, unknown: true },
    { ...valid, items: [] },
    {
      ...valid,
      items: [item(work), { ...item(work), id: work.id.toUpperCase() }],
    },
    {
      ...valid,
      items: Array.from({ length: 101 }, () => ({
        ...item(work),
        id: randomUUID(),
      })),
    },
    { ...valid, items: [{ id: work.id, expectedVersion: 1 }] },
    { ...valid, items: [{ ...item(work), expectedCourseVersion: 0 }] },
    { ...valid, items: [{ ...item(work), expectedVersion: 0 }] },
    ...[
      {},
      { status: 'completed' },
      { priority: 0 },
      { priority: 6 },
      { dueDate: '2030-02-29' },
      { dueDate: '0000-01-01' },
      { estimatedMinutes: -1 },
      { estimatedMinutes: 60001 },
      { estimatedMinutes: 1.5 },
      { title: 'Overwrite' },
      { notes: 'Overwrite' },
      { sensitivity: 'unlabeled' },
      { courseId },
      { grade: null },
      { status: 'submitted', grade: { earned: 1, possible: 2 } },
    ].map((changes) => ({ ...valid, action: { kind: 'update', changes } })),
    { ...valid, action: { kind: 'delete', changes: { status: 'cancelled' } } },
    { ...valid, action: { kind: 'restore' } },
  ];
  for (const payload of invalid)
    expect((await batch(payload)).statusCode).toBe(400);
  expect((await get(`/api/v1/academic-work/${work.id}`)).json().work).toEqual(
    work,
  );
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE operation_id=$1',
      [valid.operationId],
    ),
  ).toEqual([]);
});

it('updates only selected fields across classes, preserving text, scores, labels and input order', async () => {
  const otherCourse = await write('POST', '/api/v1/courses', {
    operationId: randomUUID(),
    name: 'Synthetic Physics',
    sensitivity: 'restricted',
  });
  const scored = await create({
    status: 'submitted',
    grade: { earned: 8, possible: 10 },
  });
  const open = await create({
    courseId: otherCourse.json().course.id,
    status: 'in_progress',
  });
  const untouched = await create();
  const response = await batch(
    update([open, scored], {
      dueDate: null,
      estimatedMinutes: 0,
      priority: 5,
    }),
  );
  expect(response.statusCode).toBe(200);
  const result = academicWorkBatchResponseSchema.parse(response.json());
  expect(result.work.map((value) => value.id)).toEqual([open.id, scored.id]);
  for (const [index, previous] of [open, scored].entries()) {
    expect(result.work[index]).toEqual({
      ...previous,
      dueDate: null,
      estimatedMinutes: 0,
      priority: 5,
      version: 2,
      updatedAt: result.work[index]!.updatedAt,
    });
  }
  expect(result.work[0]!.academicLabels).toEqual(['restricted']);
  expect(result.work[1]!.grade).toEqual({ earned: 8, possible: 10 });
  expect(
    (await get(`/api/v1/academic-work/${untouched.id}`)).json().work,
  ).toEqual(untouched);
  const unknown = await batch(
    update(result.work, { estimatedMinutes: null, dueDate: '2030-04-05' }),
  );
  expect(unknown.statusCode).toBe(200);
  expect(
    unknown
      .json()
      .work.every(
        (value: AcademicWork) =>
          value.estimatedMinutes === null && value.priority === 5,
      ),
  ).toBe(true);
});

it('records submission and reopening independently of planned tasks, scores, estimates and mastery', async () => {
  const first = await create(),
    second = await create({ status: 'in_progress' });
  const planned = await write(
    'POST',
    `/api/v1/academic-work/${first.id}/planner-work`,
    {
      operationId: randomUUID(),
      expectedWorkVersion: 1,
      expectedCourseVersion: 1,
      kind: 'task',
      task: { title: 'Work on assignment' },
    },
  );
  expect(planned.statusCode).toBe(200);
  const result = await batch(update([first, second], { status: 'submitted' }));
  expect(result.statusCode).toBe(200);
  expect(
    result
      .json()
      .work.every(
        (value: AcademicWork) =>
          value.status === 'submitted' &&
          value.grade === null &&
          value.estimatedMinutes === 45,
      ),
  ).toBe(true);
  expect(
    (await get(`/api/v1/tasks/${planned.json().task.id}`)).json().task
      .completed,
  ).toBe(false);
  expect(
    (
      await get(`/api/v1/courses/${courseId}/work-summary?asOf=2030-04-05`)
    ).json(),
  ).toMatchObject({
    activeCount: 2,
    submittedCount: 2,
    ungradedSubmittedCount: 2,
    recordedScoreCount: 0,
  });
  const reopened = await batch(
    update(result.json().work, { status: 'planned' }),
  );
  expect(reopened.statusCode).toBe(200);
  expect(
    reopened
      .json()
      .work.every(
        (value: AcademicWork) =>
          value.status === 'planned' && value.version === 3,
      ),
  ).toBe(true);
});

it('requires deliberate score correction before reopening or cancelling graded work and rolls back the whole selection', async () => {
  const open = await create();
  const scored = await create({
    status: 'submitted',
    grade: { earned: 12, possible: 10 },
  });
  for (const status of ['planned', 'in_progress', 'cancelled']) {
    const input = update([open, scored], { status, priority: 5 });
    const rejected = await batch(input);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe('ACADEMIC_SCORE_REVIEW_REQUIRED');
    expect((await get(`/api/v1/academic-work/${open.id}`)).json().work).toEqual(
      open,
    );
    expect(
      (await get(`/api/v1/academic-work/${scored.id}`)).json().work,
    ).toEqual(scored);
    expect(
      await db.query(
        'SELECT operation_id FROM mutation_receipts WHERE operation_id=$1',
        [input.operationId],
      ),
    ).toEqual([]);
  }
  const retained = await batch(
    update([scored], { status: 'submitted', priority: 4 }),
  );
  expect(retained.statusCode).toBe(200);
  expect(retained.json().work[0].grade).toEqual(scored.grade);
});

it('rejects stale work or class versions before changing any selected record', async () => {
  const first = await create(),
    second = await create();
  const changed = await batch(update([second], { priority: 4 }));
  expect(changed.statusCode).toBe(200);
  const stale = update([first, second], { status: 'submitted' });
  expect((await batch(stale)).json().error.code).toBe('VERSION_CONFLICT');
  expect((await get(`/api/v1/academic-work/${first.id}`)).json().work).toEqual(
    first,
  );
  const course = await write('PUT', `/api/v1/courses/${courseId}`, {
    ...change(1),
    name: 'Changed Chemistry',
  });
  expect(course.statusCode).toBe(200);
  const staleClass = update([first, changed.json().work[0]], { priority: 5 });
  expect((await batch(staleClass)).json().error.code).toBe('VERSION_CONFLICT');
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE operation_id=ANY($1::uuid[])',
      [[stale.operationId, staleClass.operationId]],
    ),
  ).toEqual([]);
  const fresh = await batch(
    update([first, changed.json().work[0]], { priority: 5 }, 2),
  );
  expect(fresh.statusCode).toBe(200);
});

it('authorizes all records and rejects absent, foreign, deleted and revoked-session selections without disclosure', async () => {
  const first = await create(),
    second = await create();
  const input = update([first], { priority: 5 });
  for (const [session, expected] of [
    ['', 401],
    [otherCookie, 404],
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/academic-work/batch',
      headers: { origin, cookie: session },
      payload: input,
    });
    expect(response.statusCode).toBe(expected);
    expect(response.body).not.toContain(first.notes);
  }
  const absent = {
    ...input,
    items: [...input.items, { ...item(second), id: randomUUID() }],
  };
  expect((await batch(absent)).statusCode).toBe(404);
  expect(
    (await write('DELETE', `/api/v1/academic-work/${second.id}`, change(1)))
      .statusCode,
  ).toBe(200);
  expect(
    (await batch(update([first, second], { priority: 5 }))).statusCode,
  ).toBe(404);
  expect((await get(`/api/v1/academic-work/${first.id}`)).json().work).toEqual(
    first,
  );
  await db.query(
    'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
    [owner],
  );
  expect((await batch(input)).statusCode).toBe(401);
});

it('permits historical deletion from archived classes with current class versions and preserves restore semantics', async () => {
  const work = await create({
    status: 'submitted',
    grade: { earned: 9, possible: 10 },
  });
  expect(
    (await write('DELETE', `/api/v1/courses/${courseId}`, change(1)))
      .statusCode,
  ).toBe(200);
  expect(
    (await batch(update([work], { priority: 5 }, 2))).json().error.code,
  ).toBe('ACADEMIC_CLASS_ARCHIVED');
  const deleted = await batch({
    operationId: randomUUID(),
    items: [item(work, 2)],
    action: { kind: 'delete' },
  });
  expect(deleted.statusCode).toBe(200);
  const tombstone = deleted.json().work[0];
  expect(tombstone).toMatchObject({
    id: work.id,
    version: 2,
    grade: work.grade,
    academicLabels: ['personal'],
  });
  expect(tombstone.deletedAt).not.toBeNull();
  const restore = await write(
    'POST',
    `/api/v1/academic-work/${work.id}/restore`,
    change(2),
  );
  expect(restore.json().error.code).toBe('ACADEMIC_CLASS_ARCHIVED');
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(exported.records.academicWork).toContainEqual(tombstone);
});

it('deduplicates competing lost-response retries and preserves historical receipts after later writes', async () => {
  const first = await create(),
    second = await create();
  const input = update([second, first], { priority: 5 });
  const results = await Promise.all([batch(input), batch(input), batch(input)]);
  expect(results.every((result) => result.statusCode === 200)).toBe(true);
  expect(results[1]!.json()).toEqual(results[0]!.json());
  const updated = results[0]!.json().work;
  expect(updated.every((value: AcademicWork) => value.version === 2)).toBe(
    true,
  );
  const deletion = {
    operationId: randomUUID(),
    items: updated.map((value: AcademicWork) => item(value)),
    action: { kind: 'delete' },
  };
  const deleted = await batch(deletion);
  expect(deleted.statusCode).toBe(200);
  expect((await batch(input)).json()).toEqual(results[0]!.json());
  expect((await batch(deletion)).json()).toEqual(deleted.json());
  expect(
    (await get(`/api/v1/academic-work/${first.id}`)).json().work.version,
  ).toBe(3);
  const conflict = await batch({
    ...input,
    action: { kind: 'update', changes: { priority: 4 } },
  });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().error.code).toBe('OPERATION_CONFLICT');
});

it('rolls back partial SQL updates, schedule revisions and receipts, allowing the same operation to retry', async () => {
  const first = await create(),
    second = await create();
  const input = update([first, second], { priority: 5 });
  const before = await db.query(
    'SELECT * FROM planner_schedule_locks WHERE owner_id=$1',
    [owner],
  );
  await db.exec(`CREATE FUNCTION reject_selected_work() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id='${second.id}'::uuid AND NEW.priority=5 THEN RAISE EXCEPTION 'Synthetic failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_selected_work BEFORE UPDATE ON academic_work FOR EACH ROW EXECUTE FUNCTION reject_selected_work()`);
  expect((await batch(input)).statusCode).toBe(500);
  expect((await get(`/api/v1/academic-work/${first.id}`)).json().work).toEqual(
    first,
  );
  expect((await get(`/api/v1/academic-work/${second.id}`)).json().work).toEqual(
    second,
  );
  expect(
    await db.query('SELECT * FROM planner_schedule_locks WHERE owner_id=$1', [
      owner,
    ]),
  ).toEqual(before);
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE operation_id=$1',
      [input.operationId],
    ),
  ).toEqual([]);
  await db.exec(
    'DROP TRIGGER reject_selected_work ON academic_work; DROP FUNCTION reject_selected_work()',
  );
  expect((await batch(input)).statusCode).toBe(200);
});

it('serializes different overlapping selections so the stale batch never partially updates its other records', async () => {
  const first = await create(),
    shared = await create(),
    last = await create();
  const inputs = [
    update([first, shared], { priority: 4 }),
    update([shared, last], { priority: 5 }),
  ];
  const results = await Promise.all(inputs.map(batch));
  expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
  const winner = results[0]!.statusCode === 200 ? 0 : 1;
  const unselected = winner === 0 ? last : first;
  expect(
    (await get(`/api/v1/academic-work/${unselected.id}`)).json().work,
  ).toEqual(unselected);
  expect(
    (await get(`/api/v1/academic-work/${shared.id}`)).json().work.version,
  ).toBe(2);
});

it('suppresses academic reminders after selected submission/deletion without editing linked planner work', async () => {
  const first = await create(),
    second = await create(),
    remaining = await create();
  for (const value of [first, second, remaining]) {
    const reminder = await write('POST', '/api/v1/reminders', {
      operationId: randomUUID(),
      targetKind: 'academic-work',
      targetId: value.id,
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      title: 'Synthetic academic reminder',
    });
    expect(reminder.statusCode).toBe(200);
  }
  expect(
    (await batch(update([first], { status: 'submitted' }))).statusCode,
  ).toBe(200);
  expect(
    (
      await batch({
        operationId: randomUUID(),
        items: [item(second)],
        action: { kind: 'delete' },
      })
    ).statusCode,
  ).toBe(200);
  await runReminderBatch(db);
  const notifications = await db.query<{ target_id: string }>(
    'SELECT r.target_id FROM notifications n JOIN reminders r ON r.id=n.reminder_id WHERE n.owner_id=$1',
    [owner],
  );
  expect(notifications).toEqual([{ target_id: remaining.id }]);
  expect(
    (
      await get('/api/v1/academic-work/agenda?asOf=2030-04-04&to=2030-04-11')
    ).json().summary.openCount,
  ).toBe(1);
});

it('persists selected changes and tombstone receipts across an isolated restart without overwriting newer state', async () => {
  const root = resolve('.artifacts', 'academic-batch');
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
        email: 'persist-academic-batch@example.test',
        password: 'synthetic-academic-batch-password',
      },
    });
    const session = {
      origin,
      cookie: String(setup.headers['set-cookie']).split(';')[0]!,
    };
    const course = await durable.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: session,
      payload: { operationId: randomUUID(), name: 'Persisted synthetic class' },
    });
    const saved = await durable.inject({
      method: 'POST',
      url: '/api/v1/academic-work',
      headers: session,
      payload: {
        operationId: randomUUID(),
        courseId: course.json().course.id,
        title: 'Persisted selected work',
      },
    });
    expect(saved.statusCode).toBe(200);
    const input = update([saved.json().work], {
      status: 'submitted',
      estimatedMinutes: 0,
    });
    const changed = await durable.inject({
      method: 'POST',
      url: '/api/v1/academic-work/batch',
      headers: session,
      payload: input,
    });
    expect(changed.statusCode).toBe(200);
    await durable.close();
    durable = await buildApp({ logger: false }, { config: isolated });
    expect(
      (
        await durable.inject({
          method: 'POST',
          url: '/api/v1/academic-work/batch',
          headers: session,
          payload: input,
        })
      ).json(),
    ).toEqual(changed.json());
    const deletion = {
      operationId: randomUUID(),
      items: changed.json().work.map((value: AcademicWork) => item(value)),
      action: { kind: 'delete' },
    };
    const deleted = await durable.inject({
      method: 'POST',
      url: '/api/v1/academic-work/batch',
      headers: session,
      payload: deletion,
    });
    expect(deleted.statusCode).toBe(200);
    await durable.close();
    durable = await buildApp({ logger: false }, { config: isolated });
    expect(
      (
        await durable.inject({
          method: 'POST',
          url: '/api/v1/academic-work/batch',
          headers: session,
          payload: deletion,
        })
      ).json(),
    ).toEqual(deleted.json());
    expect(
      (
        await durable.inject({
          method: 'POST',
          url: '/api/v1/academic-work/batch',
          headers: session,
          payload: input,
        })
      ).json(),
    ).toEqual(changed.json());
    expect(
      (
        await durable.inject({
          url: `/api/v1/academic-work/${saved.json().work.id}`,
          headers: session,
        })
      ).json().work,
    ).toEqual(deleted.json().work[0]);
  } finally {
    await durable?.close();
    await removeSyntheticArtifact(root, directory);
  }
});
