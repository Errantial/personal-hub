import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import {
  studyPlanSchema,
  studyPreviewSchema,
  plannerExportSchema,
  studyWorkloadResponseSchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { resolveAIContext } from '../src/features/ai-routing.js';
const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
const range = { from: '2030-04-01', to: '2030-04-08' };
const prefs = {
  timeZone: 'UTC',
  sessionMinutes: 25,
  breakMinutes: 5,
  dailyMaximumMinutes: 100,
  windows: Array.from({ length: 7 }, (_, i) => ({
    day: i + 1,
    startMinute: 540,
    endMinute: 720,
  })),
};
const change = (expectedVersion: number) => ({
  operationId: randomUUID(),
  expectedVersion,
});
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string,
  otherCookie: string,
  owner: string,
  courseId: string,
  topicId: string;
const headers = () => ({ origin, cookie });
async function write(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload: object,
) {
  return app.inject({ method, url, headers: headers(), payload });
}
async function get(url: string) {
  return app.inject({ url, headers: headers() });
}
async function preview() {
  const r = await write('POST', '/api/v1/study/preview', range);
  expect(r.statusCode).toBe(200);
  return studyPreviewSchema.parse(r.json());
}
async function draft() {
  const p = await preview();
  const r = await write('POST', '/api/v1/study/plans', {
    ...range,
    expectedContextRevision: p.contextRevision,
    operationId: randomUUID(),
  });
  expect(r.statusCode).toBe(201);
  return studyPlanSchema.parse(r.json());
}
async function work(fields: object = {}) {
  const response = await write('POST', '/api/v1/academic-work', {
    courseId,
    title: 'Private synthetic work title',
    notes: 'Private synthetic notes',
    operationId: randomUUID(),
    ...fields,
  });
  expect(response.statusCode).toBe(200);
  return response.json().work;
}
async function workload(id: string, query = '') {
  const response = await get(`/api/v1/study/plans/${id}/workload${query}`);
  expect(response.statusCode).toBe(200);
  return studyWorkloadResponseSchema.parse(response.json());
}
async function removeWorkloadMigration() {
  await db.exec(`ALTER TABLE reminders DROP CONSTRAINT reminders_owned_academic_work;
    ALTER TABLE reminders DROP COLUMN academic_work_id;
    DROP TABLE academic_planner_sources;
    ALTER TABLE tasks DROP CONSTRAINT tasks_owned_id;
    DROP TABLE study_event_contexts;
    DROP TABLE study_workload_sources;
    DROP TABLE study_workload_contexts;
    ALTER TABLE study_plans DROP CONSTRAINT study_plans_owned_id;
    ALTER TABLE events DROP CONSTRAINT events_owned_id;
    ALTER TABLE academic_work DROP CONSTRAINT academic_work_owned_id`);
  await db.query(
    "DELETE FROM schema_migrations WHERE name IN ('027_study_workload_sources.sql','028_academic_planner_sources.sql','029_academic_work_reminders.sql')",
  );
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
  const enrolled = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'study@example.test',
      password: 'synthetic-study-password',
    },
  });
  cookie = String(enrolled.headers['set-cookie']).split(';')[0]!;
  owner = enrolled.json().user.id;
  const other = randomUUID(),
    token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-study@example.test',
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
  courseId = (
    await write('POST', '/api/v1/courses', {
      name: 'Physics',
      sensitivity: 'restricted',
      operationId: randomUUID(),
    })
  ).json().course.id;
  topicId = (
    await write('POST', '/api/v1/topics', {
      courseId,
      name: 'Vectors',
      confidence: 'low',
      progress: 10,
      sensitivity: 'personal',
      operationId: randomUUID(),
    })
  ).json().topic.id;
  expect(
    (
      await write('PUT', '/api/v1/study/preferences', {
        ...prefs,
        ...change(1),
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await write('PUT', `/api/v1/study/goals/${courseId}`, {
        minutesPerWeek: 100,
        priority: 3,
        targetDate: '2030-04-07',
        ...change(1),
      })
    ).statusCode,
  ).toBe(200);
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app?.close();
});
it('explains open academic deadlines, importance and effort without changing weekly budgets', async () => {
  const original = await preview();
  await work({ dueDate: '2030-03-31', estimatedMinutes: 100, priority: 5 });
  await work({ dueDate: '2030-04-15', estimatedMinutes: 0, priority: 1 });
  await work({ dueDate: '2030-04-16', estimatedMinutes: null, priority: 2 });
  await work();
  const p = await preview();
  expect(p.priorities[0]!.academicWork).toEqual({
    openCount: 4,
    overdueCount: 1,
    dueSoonCount: 1,
    earliestDueDate: '2030-03-31',
    estimatedOpenMinutes: 100,
    missingDeadlineCount: 1,
    missingEstimateCount: 2,
    highestPriority: 5,
  });
  expect(p.priorities[0]!.score).toBe(original.priorities[0]!.score + 354);
  expect(p.priorities[0]!.reasons).toEqual(
    expect.arrayContaining([
      'ACADEMIC_WORK_OVERDUE',
      'ACADEMIC_WORK_DUE_SOON',
      'WORK_IMPORTANCE',
      'ESTIMATED_WORKLOAD',
    ]),
  );
  expect(p.warnings).toEqual(
    expect.arrayContaining([
      'ACADEMIC_DEADLINES_MISSING',
      'ACADEMIC_ESTIMATES_MISSING',
    ]),
  );
  expect(p.slots).toEqual(original.slots);
  expect(p.priorities[0]!.targetMinutes).toBe(100);
  expect(p.priorities[0]!.remainingMinutes).toBe(100);
  expect(JSON.stringify(p)).not.toContain('Private synthetic');
  expect(await db.query('SELECT * FROM ai_requests')).toHaveLength(0);
});
it('excludes submissions, cancellations, tombstones, archived classes and foreign work', async () => {
  const baseline = await preview();
  await work({ status: 'submitted', grade: { earned: 0, possible: 100 } });
  await work({ status: 'cancelled' });
  const deleted = await work();
  await write('DELETE', `/api/v1/academic-work/${deleted.id}`, change(1));
  const foreign = randomUUID();
  await db.query(
    'INSERT INTO courses(id,owner_id,name) SELECT $1,id,$2 FROM users WHERE id<>$3',
    [foreign, 'Foreign', owner],
  );
  await db.query(
    'INSERT INTO study_goals(owner_id,course_id,minutes_per_week,priority) SELECT owner_id,id,100,3 FROM courses WHERE id=$1',
    [foreign],
  );
  await db.query(
    "INSERT INTO academic_work(id,owner_id,course_id,title,due_date,estimated_minutes,kind,priority,status,sensitivity) SELECT $1,owner_id,id,$2,$3,60000,'assignment',5,'planned','unlabeled' FROM courses WHERE id=$4",
    [randomUUID(), 'Foreign', '2030-03-01', foreign],
  );
  const archived = (
    await write('POST', '/api/v1/courses', {
      name: 'Archive',
      operationId: randomUUID(),
    })
  ).json().course;
  await write('PUT', `/api/v1/study/goals/${archived.id}`, {
    minutesPerWeek: 100,
    priority: 3,
    targetDate: null,
    ...change(1),
  });
  await work({ courseId: archived.id });
  await write('DELETE', `/api/v1/courses/${archived.id}`, change(1));
  const p = await preview();
  expect(p.priorities).toEqual(baseline.priorities);
  expect(p.contextRevision).toBe(baseline.contextRevision);
  expect(p.warnings).toEqual(baseline.warnings);
});
it('leaves zero goals disabled even with urgent estimated work', async () => {
  await work({ dueDate: '2030-03-01', estimatedMinutes: 60000, priority: 5 });
  await write('PUT', `/api/v1/study/goals/${courseId}`, {
    minutesPerWeek: 0,
    priority: 3,
    targetDate: null,
    ...change(2),
  });
  const p = await preview();
  expect(p.priorities).toEqual([]);
  expect(p.slots).toEqual([]);
  expect(p.warnings).toContain('NO_GOALS');
  expect(p.warnings).not.toContain('ACADEMIC_ESTIMATES_MISSING');
});
it('changes class allocation deterministically using deadlines while retaining full-session capacity', async () => {
  const second = (
    await write('POST', '/api/v1/courses', {
      name: 'Chemistry',
      operationId: randomUUID(),
    })
  ).json().course;
  await write('PUT', `/api/v1/study/goals/${second.id}`, {
    minutesPerWeek: 100,
    priority: 3,
    targetDate: null,
    ...change(1),
  });
  expect((await preview()).priorities[0]!.courseId).toBe(courseId);
  await work({
    courseId: second.id,
    dueDate: range.from,
    estimatedMinutes: 60000,
    priority: 5,
  });
  const first = await preview();
  expect(first.priorities[0]!.courseId).toBe(second.id);
  expect(first.slots[0]!.courseId).toBe(second.id);
  expect(first.slots).toHaveLength(8);
  expect(await preview()).toEqual(first);
});
it('invalidates drafts on academic edits, deletes and restores and permits deliberate revision', async () => {
  const source = await work({ dueDate: '2030-04-02', estimatedMinutes: 200 });
  const plan = await draft();
  await write('PUT', `/api/v1/academic-work/${source.id}`, {
    courseId,
    title: source.title,
    dueDate: '2030-04-03',
    estimatedMinutes: 100,
    status: 'in_progress',
    grade: null,
    ...change(1),
  });
  expect(
    (
      await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1))
    ).json().error.code,
  ).toBe('STUDY_CONTEXT_CONFLICT');
  expect((await get('/api/v1/calendar')).json().events).toHaveLength(0);
  const edited = await preview();
  await write('DELETE', `/api/v1/academic-work/${source.id}`, change(2));
  expect((await preview()).contextRevision).not.toBe(edited.contextRevision);
  await write('POST', `/api/v1/academic-work/${source.id}/restore`, change(3));
  const fresh = await preview();
  expect(fresh.contextRevision).not.toBe(edited.contextRevision);
  expect(
    (
      await write('PUT', `/api/v1/study/plans/${plan.id}`, {
        ...change(1),
        expectedContextRevision: fresh.contextRevision,
        slots: fresh.slots,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(2)))
      .statusCode,
  ).toBe(200);
  const after = await preview();
  expect(after.priorities[0]!.remainingMinutes).toBe(0);
  expect(after.priorities[0]!.academicWork!.estimatedOpenMinutes).toBe(100);
});
it('reads historical preview snapshots as unevaluated workload and exports new evaluated snapshots', async () => {
  const p = await preview();
  const legacy = {
    ...p,
    priorities: p.priorities.map((priority) => {
      const copy: Partial<typeof priority> = { ...priority };
      delete copy.academicWork;
      return copy;
    }),
  };
  expect(
    studyPreviewSchema.parse(legacy).priorities[0]!.academicWork,
  ).toBeNull();
  await work({ estimatedMinutes: 0, dueDate: range.from });
  const plan = await draft();
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(
    exported.records.studyPlans.find((entry) => entry.id === plan.id)!.preview
      .priorities[0]!.academicWork!.missingEstimateCount,
  ).toBe(0);
});
it('serializes academic edits with draft approval and does not advance locks on receipt replay', async () => {
  const source = await work({ dueDate: range.from, estimatedMinutes: 50 });
  const plan = await draft();
  const payload = {
    courseId,
    title: source.title,
    dueDate: range.to,
    estimatedMinutes: 100,
    status: 'planned',
    grade: null,
    ...change(1),
  };
  const [edit, approval] = await Promise.all([
    write('PUT', `/api/v1/academic-work/${source.id}`, payload),
    write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1)),
  ]);
  expect(edit.statusCode).toBe(200);
  expect(approval.statusCode).toBe(409);
  expect(approval.json().error.code).toBe('STUDY_CONTEXT_CONFLICT');
  expect((await get('/api/v1/calendar')).json().events).toHaveLength(0);
  const before = await db.query(
    'SELECT revision FROM planner_schedule_locks WHERE owner_id=$1',
    [owner],
  );
  expect(
    (await write('PUT', `/api/v1/academic-work/${source.id}`, payload)).json(),
  ).toEqual(edit.json());
  expect(
    await db.query(
      'SELECT revision FROM planner_schedule_locks WHERE owner_id=$1',
      [owner],
    ),
  ).toEqual(before);
});
it('keeps workload-derived calendar provenance incomplete and preserves the strongest contributing labels', async () => {
  await work({
    sensitivity: 'restricted',
    dueDate: range.from,
    estimatedMinutes: 50,
  });
  const second = (
    await write('POST', '/api/v1/courses', {
      name: 'Unlabeled class',
      operationId: randomUUID(),
    })
  ).json().course;
  await write('PUT', `/api/v1/study/goals/${second.id}`, {
    minutesPerWeek: 25,
    priority: 1,
    targetDate: null,
    ...change(1),
  });
  const plan = await draft();
  expect(
    (await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1)))
      .statusCode,
  ).toBe(200);
  const events = (await get('/api/v1/calendar')).json().events;
  expect(events).toHaveLength(5);
  expect(plan.preview.warnings).toContain(
    'ACADEMIC_WORK_PROVENANCE_INCOMPLETE',
  );
  for (const event of events) {
    expect(event).toMatchObject({
      academicLabels: null,
      sensitivity: 'restricted',
    });
    await expect(
      resolveAIContext(db, owner, {
        kind: 'event',
        id: event.id,
        expectedVersion: event.version,
      }),
    ).rejects.toMatchObject({ code: 'PROVENANCE_UNAVAILABLE' });
  }
  expect(
    events.find((e: { courseId: string }) => e.courseId === second.id),
  ).toBeDefined();
});
it('blocks oversized eligible workload instead of generating a partial preview', async () => {
  await db.query(
    `INSERT INTO academic_work(id,owner_id,course_id,title,kind,priority,status,sensitivity) SELECT md5('study-work-'||n)::uuid,$1,$2,'Synthetic','assignment',3,'planned','unlabeled' FROM generate_series(1,5001) n`,
    [owner, courseId],
  );
  const response = await write('POST', '/api/v1/study/preview', range);
  expect(response.statusCode).toBe(413);
  expect(response.json().error.code).toBe('STUDY_TOO_LARGE');
});
it('captures one metadata-only workload context per draft and preserves exact creation receipts', async () => {
  const source = await work({
    dueDate: range.from,
    estimatedMinutes: 0,
    sensitivity: 'personal',
  });
  const p = await preview();
  const payload = {
    ...range,
    operationId: randomUUID(),
    expectedContextRevision: p.contextRevision,
  };
  const first = await write('POST', '/api/v1/study/plans', payload);
  expect(first.statusCode).toBe(201);
  expect((await write('POST', '/api/v1/study/plans', payload)).json()).toEqual(
    first.json(),
  );
  const inspected = await workload(first.json().id);
  expect(inspected).toMatchObject({
    history: 'captured',
    planStatus: 'draft',
    planVersion: 1,
    context: { sourceCount: 1, contextRevision: p.contextRevision },
    nextAfter: null,
  });
  expect(inspected.sources[0]).toMatchObject({
    changed: false,
    snapshot: {
      id: source.id,
      version: 1,
      courseId,
      estimatedMinutes: 0,
      academicLabels: ['personal', 'restricted'],
      provenance: 'owner-entered-planning-fields',
    },
  });
  expect(JSON.stringify(inspected)).not.toContain('Private synthetic');
  expect(JSON.stringify(inspected)).not.toContain('grade');
  expect(await db.query('SELECT * FROM study_workload_contexts')).toHaveLength(
    1,
  );
  expect(await db.query('SELECT * FROM study_workload_sources')).toHaveLength(
    1,
  );
});
it('distinguishes captured empty workload, legacy unknown history and unlinked manual Calendar records', async () => {
  const plan = await draft();
  const captured = await workload(plan.id);
  expect(captured).toMatchObject({
    history: 'captured',
    context: { sourceCount: 0 },
    sources: [],
  });
  await db.query(
    'DELETE FROM study_workload_contexts WHERE owner_id=$1 AND plan_id=$2',
    [owner, plan.id],
  );
  expect(await workload(plan.id)).toMatchObject({
    history: 'unavailable',
    context: null,
    sources: [],
  });
  const event = (
    await write('POST', '/api/v1/calendar', {
      title: 'Manual',
      startsAt: '2030-04-01T08:00:00Z',
      endsAt: '2030-04-01T08:30:00Z',
      timeZone: 'UTC',
      operationId: randomUUID(),
    })
  ).json().event;
  expect(
    (await get(`/api/v1/calendar/${event.id}/workload`)).json(),
  ).toMatchObject({
    history: 'not-linked',
    planId: null,
    eventId: event.id,
    context: null,
    sources: [],
  });
  expect(
    (await app.inject(`/api/v1/calendar/${event.id}/workload`)).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        url: `/api/v1/calendar/${event.id}/workload`,
        headers: { cookie: otherCookie },
      })
    ).statusCode,
  ).toBe(404);
});
it('protects source paging, draft versions and relational references by owner', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await work()).id);
  const plan = await draft();
  const first = await workload(plan.id, '?limit=1&expectedPlanVersion=1');
  const second = await workload(
    plan.id,
    `?limit=1&after=${first.nextAfter}&expectedPlanVersion=1`,
  );
  const third = await workload(
    plan.id,
    `?limit=1&after=${second.nextAfter}&expectedPlanVersion=1`,
  );
  expect([
    first.sources[0]!.snapshot.id,
    second.sources[0]!.snapshot.id,
    third.sources[0]!.snapshot.id,
  ]).toEqual(ids.sort());
  expect(third.nextAfter).toBeNull();
  expect(
    (await get(`/api/v1/study/plans/${plan.id}/workload?after=${randomUUID()}`))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await get(`/api/v1/study/plans/${plan.id}/workload?expectedPlanVersion=2`)
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
  expect(
    (await app.inject(`/api/v1/study/plans/${plan.id}/workload`)).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        url: `/api/v1/study/plans/${plan.id}/workload`,
        headers: { cookie: otherCookie },
      })
    ).statusCode,
  ).toBe(404);
  const [foreign] = await db.query<{ id: string }>(
    'SELECT id FROM users WHERE id<>$1',
    [owner],
  );
  await expect(
    db.query(
      'INSERT INTO study_workload_contexts(plan_id,owner_id,context_revision,source_count) VALUES($1,$2,$3,0)',
      [plan.id, foreign!.id, plan.preview.contextRevision],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  const foreignEvent = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/calendar',
      headers: { origin, cookie: otherCookie },
      payload: {
        title: 'Foreign event',
        startsAt: '2030-04-01T08:00:00Z',
        endsAt: '2030-04-01T08:30:00Z',
        timeZone: 'UTC',
        operationId: randomUUID(),
      },
    })
  ).json().event;
  await expect(
    db.query(
      'INSERT INTO study_event_contexts(event_id,owner_id,plan_id) VALUES($1,$2,$3)',
      [foreignEvent.id, owner, plan.id],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  const foreignCourse = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: { origin, cookie: otherCookie },
      payload: { name: 'Foreign', operationId: randomUUID() },
    })
  ).json().course;
  const foreignWork = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/academic-work',
      headers: { origin, cookie: otherCookie },
      payload: {
        courseId: foreignCourse.id,
        title: 'Foreign',
        operationId: randomUUID(),
      },
    })
  ).json().work;
  await expect(
    db.query(
      'INSERT INTO study_workload_sources(plan_id,owner_id,work_id,snapshot) VALUES($1,$2,$3,$4::jsonb)',
      [
        plan.id,
        owner,
        foreignWork.id,
        JSON.stringify({ ...first.sources[0]!.snapshot, id: foreignWork.id }),
      ],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await write(
    'DELETE',
    `/api/v1/academic-work/${first.sources[0]!.snapshot.id}`,
    change(1),
  );
  const fresh = await preview();
  await write('PUT', `/api/v1/study/plans/${plan.id}`, {
    ...change(1),
    slots: fresh.slots,
    expectedContextRevision: fresh.contextRevision,
  });
  expect(
    (
      await get(
        `/api/v1/study/plans/${plan.id}/workload?after=${first.nextAfter}`,
      )
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await get(`/api/v1/study/plans/${plan.id}/workload?expectedPlanVersion=1`)
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
});
it('advances source-class relabel versions once and ignores already captured work labels', async () => {
  const second = (
    await write('POST', '/api/v1/courses', {
      name: 'Unlabeled source',
      operationId: randomUUID(),
    })
  ).json().course;
  await write('PUT', `/api/v1/study/goals/${second.id}`, {
    minutesPerWeek: 25,
    priority: 1,
    targetDate: null,
    ...change(1),
  });
  const source = await work({ courseId: second.id, estimatedMinutes: 0 });
  const plan = await draft();
  await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1));
  await write('PUT', `/api/v1/courses/${second.id}`, {
    name: second.name,
    sensitivity: 'personal',
    ...change(1),
  });
  const events = (await get('/api/v1/calendar')).json().events;
  expect(events).toHaveLength(5);
  for (const event of events) expect(event.version).toBe(2);
  expect(
    events.find((event: { courseId: string }) => event.courseId === second.id)
      .sensitivity,
  ).toBe('personal');
  await write('PUT', `/api/v1/academic-work/${source.id}`, {
    courseId: second.id,
    title: source.title,
    status: 'planned',
    grade: null,
    sensitivity: 'personal',
    ...change(2),
  });
  expect(
    (await get('/api/v1/calendar'))
      .json()
      .events.map((event: { version: number }) => event.version),
  ).toEqual(events.map((event: { version: number }) => event.version));
});
it('keeps captured facts stable through source changes and deliberately replaces draft snapshots once', async () => {
  const source = await work({ dueDate: range.from, estimatedMinutes: 100 });
  const plan = await draft();
  const before = await workload(plan.id);
  await write('PUT', `/api/v1/academic-work/${source.id}`, {
    courseId,
    title: source.title,
    dueDate: range.to,
    estimatedMinutes: 200,
    status: 'in_progress',
    grade: null,
    ...change(1),
  });
  const stale = await workload(plan.id);
  expect(stale.sources[0]!.snapshot).toEqual(before.sources[0]!.snapshot);
  expect(stale.sources[0]).toMatchObject({
    changed: true,
    current: {
      version: 2,
      dueDate: range.to,
      estimatedMinutes: 200,
      status: 'in_progress',
    },
  });
  const fresh = await preview();
  const payload = {
    ...change(1),
    slots: fresh.slots,
    expectedContextRevision: fresh.contextRevision,
  };
  const edited = await write('PUT', `/api/v1/study/plans/${plan.id}`, payload);
  expect(edited.statusCode).toBe(200);
  const after = await workload(plan.id);
  expect(after.sources[0]).toMatchObject({
    changed: false,
    snapshot: { version: 2, estimatedMinutes: 200 },
  });
  expect(
    (await write('PUT', `/api/v1/study/plans/${plan.id}`, payload)).json(),
  ).toEqual(edited.json());
  expect(await workload(plan.id)).toEqual(after);
  await write('DELETE', `/api/v1/academic-work/${source.id}`, change(2));
  expect((await workload(plan.id)).sources[0]).toMatchObject({
    changed: true,
    current: { version: 3, deletedAt: expect.any(String) },
  });
  await write('POST', `/api/v1/academic-work/${source.id}/restore`, change(3));
  expect((await workload(plan.id)).sources[0]).toMatchObject({
    changed: true,
    current: { version: 4, deletedAt: null },
  });
});
it('retains source links through block detachment, completion, deletion, cancellation and hiding', async () => {
  const source = await work({ dueDate: range.from, estimatedMinutes: 50 });
  const plan = await draft();
  expect(
    (await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1)))
      .statusCode,
  ).toBe(200);
  const events = (await get('/api/v1/calendar')).json().events;
  await write('DELETE', `/api/v1/calendar/${events[0].id}`, change(1));
  await write('PUT', `/api/v1/calendar/${events[1].id}`, {
    title: 'Owner completed',
    notes: 'Owner notes',
    startsAt: events[1].startsAt,
    endsAt: events[1].endsAt,
    timeZone: 'UTC',
    allDay: false,
    startDate: null,
    endDate: null,
    recurrence: null,
    courseId: null,
    topicId: null,
    studyStatus: 'completed',
    sensitivity: 'restricted',
    ...change(1),
  });
  await write('PUT', `/api/v1/academic-work/${source.id}`, {
    courseId,
    title: source.title,
    status: 'planned',
    grade: null,
    sensitivity: 'personal',
    ...change(1),
  });
  const deleted = studyWorkloadResponseSchema.parse(
    (await get(`/api/v1/calendar/${events[0].id}/workload`)).json(),
  );
  expect(deleted).toMatchObject({
    history: 'captured',
    eventVersion: 3,
    eventDeletedAt: expect.any(String),
  });
  expect(deleted.sources[0]).toMatchObject({
    changed: true,
    snapshot: { academicLabels: ['restricted'] },
    current: { academicLabels: ['personal', 'restricted'] },
  });
  const detached = (await get(`/api/v1/calendar/${events[1].id}`)).json().event;
  expect(detached).toMatchObject({
    version: 3,
    title: 'Owner completed',
    notes: 'Owner notes',
    courseId: null,
    studyStatus: 'completed',
    academicLabels: null,
  });
  await expect(
    resolveAIContext(db, owner, {
      kind: 'event',
      id: detached.id,
      expectedVersion: 3,
    }),
  ).rejects.toMatchObject({ code: 'PROVENANCE_UNAVAILABLE' });
  const cancelled = await write(
    'POST',
    `/api/v1/study/plans/${plan.id}/cancel`,
    change(2),
  );
  expect(cancelled.json().preservedEventIds.sort()).toEqual(
    events.map((e: { id: string }) => e.id).sort(),
  );
  await write('DELETE', `/api/v1/study/plans/${plan.id}`, change(3));
  expect(await workload(plan.id)).toMatchObject({
    history: 'captured',
    planStatus: 'cancelled',
    planHidden: true,
  });
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(exported.records.studyWorkloadSources).toHaveLength(1);
  expect(exported.records.studyEventContexts).toHaveLength(4);
  expect(
    exported.records.studyWorkloadSources[0]!.snapshot.academicLabels,
  ).toEqual(['restricted']);
});
it('propagates masked labels from a contributing class with no allocated blocks and retains archive facts', async () => {
  const contributor = (
    await write('POST', '/api/v1/courses', {
      name: 'Contributing class',
      operationId: randomUUID(),
    })
  ).json().course;
  await write('PUT', `/api/v1/study/goals/${contributor.id}`, {
    minutesPerWeek: 5,
    priority: 1,
    targetDate: null,
    ...change(1),
  });
  await work({ courseId: contributor.id, estimatedMinutes: 0 });
  const plan = await draft();
  expect(plan.preview.slots.every((slot) => slot.courseId === courseId)).toBe(
    true,
  );
  await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1));
  await write('PUT', `/api/v1/courses/${contributor.id}`, {
    name: contributor.name,
    sensitivity: 'personal',
    ...change(1),
  });
  const events = (await get('/api/v1/calendar')).json().events;
  expect(events).toHaveLength(4);
  for (const event of events)
    expect(event).toMatchObject({
      version: 2,
      sensitivity: 'restricted',
      academicLabels: null,
    });
  expect((await workload(plan.id)).sources[0]).toMatchObject({
    changed: true,
    snapshot: { courseSensitivity: 'unlabeled' },
    current: { courseSensitivity: 'personal', academicLabels: ['personal'] },
  });
  await write('DELETE', `/api/v1/courses/${contributor.id}`, change(2));
  expect((await workload(plan.id)).sources[0]!.current.courseArchived).toBe(
    true,
  );
});
it('rolls back Calendar and event-context links together and admits duplicate approval receipts once', async () => {
  await work();
  const plan = await draft();
  await db.exec(`CREATE FUNCTION fail_study_context() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic context failure'; END $$;
    CREATE TRIGGER fail_study_context BEFORE INSERT ON study_event_contexts FOR EACH ROW EXECUTE FUNCTION fail_study_context()`);
  const payload = change(1);
  expect(
    (await write('POST', `/api/v1/study/plans/${plan.id}/approve`, payload))
      .statusCode,
  ).toBe(500);
  expect(await db.query('SELECT * FROM events')).toHaveLength(0);
  expect(await db.query('SELECT * FROM study_event_contexts')).toHaveLength(0);
  expect((await workload(plan.id)).context!.sourceCount).toBe(1);
  await db.exec(
    'DROP TRIGGER fail_study_context ON study_event_contexts; DROP FUNCTION fail_study_context()',
  );
  const approvals = await Promise.all(
    [0, 1].map(() =>
      write('POST', `/api/v1/study/plans/${plan.id}/approve`, payload),
    ),
  );
  expect(approvals.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(approvals[0]!.json()).toEqual(approvals[1]!.json());
  expect(await db.query('SELECT * FROM study_workload_sources')).toHaveLength(
    1,
  );
  expect(await db.query('SELECT * FROM study_event_contexts')).toHaveLength(4);
});
it('upgrades populated workload-era plans without reconstructing unknown source history', async () => {
  const source = await work({ estimatedMinutes: 50 });
  const plan = await draft();
  await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1));
  const before = (await get(`/api/v1/study/plans/${plan.id}`)).json();
  const events = (await get('/api/v1/calendar')).json().events;
  const receipts = await db.query(
    'SELECT operation_id,payload_hash,result FROM mutation_receipts ORDER BY operation_id',
  );
  await removeWorkloadMigration();
  await migrate(db);
  expect((await get(`/api/v1/study/plans/${plan.id}`)).json()).toEqual(before);
  expect((await get('/api/v1/calendar')).json().events).toEqual(events);
  expect(
    (await get(`/api/v1/academic-work/${source.id}`)).json().work.version,
  ).toBe(1);
  expect(await workload(plan.id)).toMatchObject({
    history: 'unavailable',
    context: null,
    sources: [],
  });
  expect(
    (await get(`/api/v1/calendar/${events[0].id}/workload`)).json(),
  ).toMatchObject({ history: 'not-linked', planId: null });
  await expect(
    resolveAIContext(db, owner, {
      kind: 'event',
      id: events[0].id,
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ code: 'PROVENANCE_UNAVAILABLE' });
  expect(
    await db.query(
      'SELECT operation_id,payload_hash,result FROM mutation_receipts ORDER BY operation_id',
    ),
  ).toEqual(receipts);
});
it('requires deliberate revision when workload history is absent or incomplete', async () => {
  await work();
  const plan = await draft();
  await db.query(
    'DELETE FROM study_workload_sources WHERE owner_id=$1 AND plan_id=$2',
    [owner, plan.id],
  );
  expect(
    (
      await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1))
    ).json().error.code,
  ).toBe('PROVENANCE_UNAVAILABLE');
  await db.query(
    'DELETE FROM study_workload_contexts WHERE owner_id=$1 AND plan_id=$2',
    [owner, plan.id],
  );
  expect(
    (
      await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1))
    ).json().error.code,
  ).toBe('STUDY_WORKLOAD_UNCAPTURED');
  const fresh = await preview();
  expect(
    (
      await write('PUT', `/api/v1/study/plans/${plan.id}`, {
        ...change(1),
        slots: fresh.slots,
        expectedContextRevision: fresh.contextRevision,
      })
    ).statusCode,
  ).toBe(200);
  expect((await workload(plan.id)).context!.sourceCount).toBe(1);
  expect(
    (await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(2)))
      .statusCode,
  ).toBe(200);
});
it('keeps versioned preferences and goals with exact retry identities and strict validation', async () => {
  const payload = { ...prefs, sessionMinutes: 30, ...change(2) };
  const first = await write('PUT', '/api/v1/study/preferences', payload);
  expect(first.statusCode).toBe(200);
  expect(
    (await write('PUT', '/api/v1/study/preferences', payload)).json(),
  ).toEqual(first.json());
  expect(
    (
      await write('PUT', '/api/v1/study/preferences', {
        ...payload,
        sessionMinutes: 35,
      })
    ).json().error.code,
  ).toBe('OPERATION_CONFLICT');
  expect(
    (
      await write('PUT', '/api/v1/study/preferences', {
        ...prefs,
        ...change(2),
      })
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
  expect(
    (
      await write('PUT', '/api/v1/study/preferences', {
        ...prefs,
        windows: [prefs.windows[0], prefs.windows[0]],
        ...change(3),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await write('PUT', `/api/v1/study/goals/${courseId}`, {
        minutesPerWeek: -1,
        priority: 3,
        targetDate: null,
        ...change(2),
      })
    ).statusCode,
  ).toBe(400);
  const zero = await write('PUT', `/api/v1/study/goals/${courseId}`, {
    minutesPerWeek: 0,
    priority: 3,
    targetDate: null,
    ...change(2),
  });
  expect(zero.statusCode).toBe(200);
  expect((await preview()).warnings).toContain('NO_GOALS');
});
it('protects every study route, goals, plans and deleted cursors by owner', async () => {
  const plan = await draft();
  for (const path of [
    '/api/v1/study/preferences',
    '/api/v1/study/goals',
    '/api/v1/study/plans',
    `/api/v1/study/plans/${plan.id}`,
    '/api/v1/planner/deleted?kind=task',
  ])
    expect((await app.inject(path)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        url: `/api/v1/study/plans/${plan.id}`,
        headers: { origin, cookie: otherCookie },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/study/plans/${plan.id}/approve`,
        headers: { origin, cookie: otherCookie },
        payload: change(1),
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `/api/v1/study/goals/${courseId}`,
        headers: { origin, cookie: otherCookie },
        payload: {
          minutesPerWeek: 100,
          priority: 3,
          targetDate: null,
          ...change(1),
        },
      })
    ).statusCode,
  ).toBe(404);
});
it('ranks manual topic assessments with reasons and previews without writing Calendar or calling AI', async () => {
  const p = await preview();
  expect(p.priorities[0]).toMatchObject({
    courseId,
    topicId,
    targetMinutes: 100,
    remainingMinutes: 100,
  });
  expect(p.priorities[0]!.reasons).toEqual(
    expect.arrayContaining([
      'LOW_CONFIDENCE',
      'INCOMPLETE_PROGRESS',
      'TARGET_DATE',
    ]),
  );
  expect(p.slots).toHaveLength(4);
  expect(p.warnings).toContain('EXTERNAL_CALENDARS_NOT_CHECKED');
  expect((await get('/api/v1/calendar')).json().events).toHaveLength(0);
  expect(await db.query('SELECT * FROM ai_requests')).toHaveLength(0);
});
it('respects recurring events, moved/cancelled exceptions, all-day spans and daily limits', async () => {
  await write('PUT', `/api/v1/study/goals/${courseId}`, {
    minutesPerWeek: 500,
    priority: 3,
    targetDate: null,
    ...change(2),
  });
  const event = (
    await write('POST', '/api/v1/calendar', {
      title: 'Lecture',
      startsAt: '2030-04-01T09:00:00Z',
      endsAt: '2030-04-01T10:00:00Z',
      timeZone: 'UTC',
      recurrence: { frequency: 'daily', interval: 1, count: 7, until: null },
      operationId: randomUUID(),
    })
  ).json().event;
  expect(
    (
      await write(
        'DELETE',
        `/api/v1/calendar/${event.id}/occurrences/2030-04-02`,
        change(1),
      )
    ).statusCode,
  ).toBe(200);
  await write('POST', '/api/v1/calendar', {
    title: 'Away',
    startsAt: '2030-04-03T00:00:00Z',
    endsAt: '2030-04-04T00:00:00Z',
    timeZone: 'UTC',
    allDay: true,
    startDate: '2030-04-03',
    endDate: '2030-04-04',
    operationId: randomUUID(),
  });
  const p = await preview();
  expect(p.slots.some((s) => s.startsAt === '2030-04-02T09:00:00.000Z')).toBe(
    true,
  );
  expect(p.slots.some((s) => s.startsAt.startsWith('2030-04-03'))).toBe(false);
  expect(
    p.slots
      .filter((s) => s.startsAt.startsWith('2030-04-01'))
      .every((s) => s.startsAt >= '2030-04-01T10:00:00.000Z'),
  ).toBe(true);
  for (const date of new Set(p.slots.map((s) => s.startsAt.slice(0, 10))))
    expect(
      p.slots.filter((s) => s.startsAt.startsWith(date)).length * 25,
    ).toBeLessThanOrEqual(100);
});
it('skips DST gaps and folds instead of silently shifting availability', async () => {
  await write('PUT', `/api/v1/study/goals/${courseId}`, {
    minutesPerWeek: 700,
    priority: 3,
    targetDate: null,
    ...change(2),
  });
  await write('PUT', '/api/v1/study/preferences', {
    ...prefs,
    timeZone: 'America/Denver',
    windows: [{ day: 7, startMinute: 120, endMinute: 180 }],
    ...change(2),
  });
  const result = await write('POST', '/api/v1/study/preview', {
    from: '2030-03-10',
    to: '2030-03-11',
  });
  expect(result.statusCode).toBe(200);
  expect(result.json().slots).toHaveLength(0);
  expect(result.json().warnings).toContain('DST_WINDOW_SKIPPED');
  await write('PUT', '/api/v1/study/preferences', {
    ...prefs,
    timeZone: 'America/Denver',
    windows: [{ day: 7, startMinute: 120, endMinute: 240 }],
    ...change(3),
  });
  const gapRange = { from: '2030-03-10', to: '2030-03-11' };
  const wider = (await write('POST', '/api/v1/study/preview', gapRange)).json();
  expect(wider.slots.length).toBeGreaterThan(0);
  const widePlan = (
    await write('POST', '/api/v1/study/plans', {
      ...gapRange,
      operationId: randomUUID(),
      expectedContextRevision: wider.contextRevision,
    })
  ).json();
  expect(
    (
      await write(
        'POST',
        `/api/v1/study/plans/${widePlan.id}/approve`,
        change(1),
      )
    ).statusCode,
  ).toBe(200);
  await write('PUT', '/api/v1/study/preferences', {
    ...prefs,
    timeZone: 'America/Denver',
    windows: [{ day: 7, startMinute: 60, endMinute: 120 }],
    ...change(4),
  });
  const fold = await write('POST', '/api/v1/study/preview', {
    from: '2030-11-03',
    to: '2030-11-04',
  });
  expect(fold.json().slots).toHaveLength(0);
  expect(fold.json().warnings).toContain('DST_WINDOW_SKIPPED');
});
it('retains insufficient-time warnings and makes empty drafts explicitly unapprovable', async () => {
  await write('PUT', '/api/v1/study/preferences', {
    ...prefs,
    windows: [],
    ...change(2),
  });
  const plan = await draft();
  expect(plan.preview.warnings).toEqual(
    expect.arrayContaining(['NO_AVAILABILITY', 'INSUFFICIENT_TIME']),
  );
  expect(
    (
      await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1))
    ).json().error.code,
  ).toBe('STUDY_EMPTY');
});
it('rejects stale previews and permits deliberate draft revisions against fresh context', async () => {
  const plan = await draft();
  await write('POST', '/api/v1/calendar', {
    title: 'New conflict',
    startsAt: plan.preview.slots[0]!.startsAt,
    endsAt: plan.preview.slots[0]!.endsAt,
    timeZone: 'UTC',
    operationId: randomUUID(),
  });
  expect(
    (
      await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1))
    ).json().error.code,
  ).toBe('STUDY_CONTEXT_CONFLICT');
  expect(
    (
      await write('POST', '/api/v1/study/plans', {
        ...range,
        operationId: randomUUID(),
        expectedContextRevision: plan.preview.contextRevision,
      })
    ).json().error.code,
  ).toBe('STUDY_CONTEXT_CONFLICT');
  const fresh = await preview();
  const edited = await write('PUT', `/api/v1/study/plans/${plan.id}`, {
    ...change(1),
    expectedContextRevision: fresh.contextRevision,
    slots: fresh.slots.slice(0, 2),
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().preview.slots).toHaveLength(2);
  expect(
    (await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(2)))
      .statusCode,
  ).toBe(200);
});
it('rejects manual overlapping, unavailable, foreign-topic and excess-daily blocks without losing the draft', async () => {
  const plan = await draft(),
    slot = plan.preview.slots[0]!;
  for (const slots of [
    [slot, slot],
    [
      {
        ...slot,
        startsAt: '2030-04-01T08:00:00Z',
        endsAt: '2030-04-01T08:25:00Z',
      },
    ],
    [{ ...slot, topicId: randomUUID() }],
    [
      {
        ...slot,
        startsAt: '2030-04-01T09:00:00Z',
        endsAt: '2030-04-01T11:00:00Z',
      },
    ],
  ]) {
    const result = await write('PUT', `/api/v1/study/plans/${plan.id}`, {
      ...change(1),
      expectedContextRevision: plan.preview.contextRevision,
      slots,
    });
    expect(result.statusCode).toBe(409);
  }
  expect((await get(`/api/v1/study/plans/${plan.id}`)).json().version).toBe(1);
});
it('approves once under concurrent retries and preserves inherited labels on normal editable calendar records', async () => {
  const plan = await draft(),
    payload = change(1);
  const results = await Promise.all(
    [0, 1].map(() =>
      write('POST', `/api/v1/study/plans/${plan.id}/approve`, payload),
    ),
  );
  expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
  expect(results[0]!.json()).toEqual(results[1]!.json());
  expect(results[0]!.json().eventLinks).toHaveLength(4);
  const events = (await get('/api/v1/calendar')).json().events;
  expect(events).toHaveLength(4);
  for (const event of events)
    expect(event).toMatchObject({
      courseId,
      topicId,
      sensitivity: 'restricted',
      academicLabels: ['personal', 'restricted'],
      studyStatus: 'planned',
      recurrence: null,
    });
  expect(
    (
      await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1))
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
  expect((await preview()).slots).toHaveLength(0);
});
it('allows only one competing draft to occupy its shared preview and blocks changed academic context', async () => {
  const one = await draft(),
    two = await draft();
  const results = await Promise.all(
    [one, two].map((plan) =>
      write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1)),
    ),
  );
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(results.find((r) => r.statusCode === 409)!.json().error.code).toBe(
    'STUDY_CONTEXT_CONFLICT',
  );
  expect((await get('/api/v1/calendar')).json().events).toHaveLength(4);
  const nextRange = { from: '2030-04-08', to: '2030-04-15' };
  const p = (await write('POST', '/api/v1/study/preview', nextRange)).json();
  const plan = (
    await write('POST', '/api/v1/study/plans', {
      ...nextRange,
      operationId: randomUUID(),
      expectedContextRevision: p.contextRevision,
    })
  ).json();
  await write('PUT', `/api/v1/courses/${courseId}`, {
    name: 'Relabeled physics',
    sensitivity: 'personal',
    ...change(1),
  });
  expect(
    (
      await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1))
    ).json().error.code,
  ).toBe('STUDY_CONTEXT_CONFLICT');
  expect((await get('/api/v1/calendar')).json().events).toHaveLength(4);
});
it('requires future approval and separates deleted study minutes from completed work', async () => {
  const plan = await draft();
  await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1));
  const event = (await get('/api/v1/calendar')).json().events[0];
  await write('DELETE', `/api/v1/calendar/${event.id}`, change(1));
  const report = (
    await get(`/api/v1/study/progress?from=${range.from}&to=${range.to}`)
  ).json();
  expect(report.courses[0]).toMatchObject({
    plannedMinutes: 75,
    deletedMinutes: 25,
    completedMinutes: 0,
    completionPercent: 0,
  });
  const pastRange = { from: '2020-04-01', to: '2020-04-08' };
  const p = (await write('POST', '/api/v1/study/preview', pastRange)).json();
  const past = (
    await write('POST', '/api/v1/study/plans', {
      ...pastRange,
      operationId: randomUUID(),
      expectedContextRevision: p.contextRevision,
    })
  ).json();
  expect(
    (
      await write('POST', `/api/v1/study/plans/${past.id}/approve`, change(1))
    ).json().error.code,
  ).toBe('STUDY_PAST');
});
it('rolls back every created block when approval fails partway through', async () => {
  const plan = await draft();
  await db.exec(
    `CREATE FUNCTION reject_second_study() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.starts_at='${plan.preview.slots[1]!.startsAt}'::timestamptz THEN RAISE EXCEPTION 'Synthetic failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_second_study BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_second_study();`,
  );
  const result = await write(
    'POST',
    `/api/v1/study/plans/${plan.id}/approve`,
    change(1),
  );
  expect(result.statusCode).toBe(500);
  expect((await get('/api/v1/calendar')).json().events).toHaveLength(0);
  expect((await get(`/api/v1/study/plans/${plan.id}`)).json()).toMatchObject({
    status: 'draft',
    version: 1,
    eventLinks: [],
  });
  await db.exec(
    'DROP TRIGGER reject_second_study ON events; DROP FUNCTION reject_second_study();',
  );
  expect(
    (await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1)))
      .statusCode,
  ).toBe(200);
});
it('cancels untouched blocks while preserving later edits and completed work, and reports actual status minutes', async () => {
  const plan = await draft();
  await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1));
  const events = (await get('/api/v1/calendar')).json().events;
  for (const [index, event] of events.slice(0, 2).entries()) {
    const {
      id,
      version,
      createdAt,
      updatedAt,
      deletedAt,
      canvasSource,
      academicSource,
      academicLabels,
      ...input
    } = event;
    void createdAt;
    void updatedAt;
    void deletedAt;
    void canvasSource;
    void academicSource;
    void academicLabels;
    expect(
      (
        await write('PUT', `/api/v1/calendar/${id}`, {
          ...input,
          title: index === 0 ? 'Owner edited' : input.title,
          studyStatus: index === 1 ? 'completed' : 'planned',
          ...change(version),
        })
      ).statusCode,
    ).toBe(200);
  }
  const cancelled = await write(
    'POST',
    `/api/v1/study/plans/${plan.id}/cancel`,
    change(2),
  );
  expect(cancelled.statusCode).toBe(200);
  expect(cancelled.json().preservedEventIds.sort()).toEqual(
    events
      .slice(0, 2)
      .map((e: { id: string }) => e.id)
      .sort(),
  );
  const progress = (
    await get(`/api/v1/study/progress?from=${range.from}&to=${range.to}`)
  ).json();
  expect(progress.courses[0]).toMatchObject({
    plannedMinutes: 25,
    completedMinutes: 25,
    cancelledMinutes: 50,
    completionPercent: 25,
  });
  expect(
    (await write('DELETE', `/api/v1/study/plans/${plan.id}`, change(3)))
      .statusCode,
  ).toBe(200);
});
it('pages hidden draft cursors and exports goals, preferences, plans and tombstones', async () => {
  await draft();
  await draft();
  await db.query(
    "UPDATE study_plans SET created_at='2031-01-01T00:00:00.123456Z' WHERE owner_id=$1",
    [owner],
  );
  const first = (await get('/api/v1/study/plans?limit=1')).json();
  const id = first.plans[0].id;
  await write('DELETE', `/api/v1/study/plans/${id}`, change(1));
  const second = (
    await get(`/api/v1/study/plans?limit=1&before=${first.nextBefore}`)
  ).json();
  expect(second.plans).toHaveLength(1);
  expect(second.plans[0].id).not.toBe(id);
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(exported.records.studyGoals[0]!.courseId).toBe(courseId);
  expect(exported.records.studyPlans).toHaveLength(2);
  expect(exported.records.studyPlans.some((p) => p.deletedAt)).toBe(true);
});
it('browses deleted task/calendar records with versions, microsecond ties, owner cursors and restore recovery', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const task = (
      await write('POST', '/api/v1/tasks', {
        title: `Deleted ${i}`,
        operationId: randomUUID(),
      })
    ).json().task;
    await write('DELETE', `/api/v1/tasks/${task.id}`, change(1));
    ids.push(task.id);
  }
  await db.query(
    "UPDATE tasks SET deleted_at='2031-01-01T00:00:00.123456Z' WHERE owner_id=$1",
    [owner],
  );
  const first = (await get('/api/v1/planner/deleted?kind=task&limit=1')).json();
  expect(first.tasks[0].version).toBe(2);
  const second = (
    await get(
      `/api/v1/planner/deleted?kind=task&limit=1&before=${first.nextBefore}`,
    )
  ).json();
  expect(second.tasks[0].id).not.toBe(first.tasks[0].id);
  expect(
    (
      await app.inject({
        url: `/api/v1/planner/deleted?kind=task&before=${first.nextBefore}`,
        headers: { cookie: otherCookie },
      })
    ).statusCode,
  ).toBe(404);
  await write('POST', `/api/v1/tasks/${first.tasks[0].id}/restore`, change(2));
  expect(
    (await get(`/api/v1/planner/deleted?kind=task&before=${first.nextBefore}`))
      .statusCode,
  ).toBe(404);
  const event = (
    await write('POST', '/api/v1/calendar', {
      title: 'Deleted lecture',
      timeZone: 'UTC',
      startsAt: '2030-04-01T08:00:00Z',
      endsAt: '2030-04-01T08:30:00Z',
      operationId: randomUUID(),
    })
  ).json().event;
  await write('DELETE', `/api/v1/calendar/${event.id}`, change(1));
  expect(
    (await get('/api/v1/planner/deleted?kind=calendar')).json().events[0],
  ).toMatchObject({ id: event.id, version: 2 });
});
it('upgrades a populated original study schema without changing drafts, goals or receipts', async () => {
  const plan = await draft();
  const receipts = await db.query(
    'SELECT operation_id,payload_hash,result FROM mutation_receipts WHERE owner_id=$1 ORDER BY operation_id',
    [owner],
  );
  // This isolated fixture recreates the pre-024 schema; migration files are untouched.
  await db.exec('ALTER TABLE planner_schedule_locks DROP COLUMN revision');
  await db.query(
    "DELETE FROM schema_migrations WHERE name='024_schedule_snapshot_revision.sql'",
  );
  await migrate(db);
  expect((await get(`/api/v1/study/plans/${plan.id}`)).json()).toEqual(plan);
  expect((await get('/api/v1/study/goals')).json().goals[0]).toMatchObject({
    minutesPerWeek: 100,
    version: 2,
  });
  expect(
    await db.query(
      'SELECT operation_id,payload_hash,result FROM mutation_receipts WHERE owner_id=$1 ORDER BY operation_id',
      [owner],
    ),
  ).toEqual(receipts);
  expect(
    (await write('POST', `/api/v1/study/plans/${plan.id}/approve`, change(1)))
      .statusCode,
  ).toBe(200);
});
it('persists approved plans through an isolated database restart without recreating blocks', async () => {
  const root = resolve('.artifacts', 'study-persistence');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'run-'));
  let persistent: typeof app | undefined;
  try {
    const persistentConfig = readConfig({
      NODE_ENV: 'test',
      PGLITE_DATA_DIR: path,
    });
    let persistentDb = await openDatabase(persistentConfig);
    persistent = await buildApp(
      { logger: false },
      { config: persistentConfig, database: persistentDb },
    );
    const enrollment = await persistent.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persist-study@example.test',
        password: 'synthetic-study-password',
      },
    });
    const session = String(enrollment.headers['set-cookie']).split(';')[0]!;
    const send = (
      url: string,
      payload: object,
      method: 'POST' | 'PUT' = 'POST',
    ) =>
      persistent!.inject({
        method,
        url,
        headers: { origin, cookie: session },
        payload,
      });
    const course = (
      await send('/api/v1/courses', {
        name: 'Persistent study',
        operationId: randomUUID(),
      })
    ).json().course;
    await send('/api/v1/study/preferences', { ...prefs, ...change(1) }, 'PUT');
    await send(
      `/api/v1/study/goals/${course.id}`,
      { minutesPerWeek: 100, priority: 3, targetDate: null, ...change(1) },
      'PUT',
    );
    const source = (
      await send('/api/v1/academic-work', {
        courseId: course.id,
        title: 'Persistent private title',
        notes: 'Persistent private notes',
        estimatedMinutes: 50,
        operationId: randomUUID(),
      })
    ).json().work;
    const p = (await send('/api/v1/study/preview', range)).json();
    const plan = (
      await send('/api/v1/study/plans', {
        ...range,
        operationId: randomUUID(),
        expectedContextRevision: p.contextRevision,
      })
    ).json();
    const approvalPayload = change(1);
    const approved = await send(
      `/api/v1/study/plans/${plan.id}/approve`,
      approvalPayload,
    );
    expect(approved.statusCode).toBe(200);
    await persistent.close();
    persistent = undefined;
    persistentDb = await openDatabase(persistentConfig);
    persistent = await buildApp(
      { logger: false },
      { config: persistentConfig, database: persistentDb },
    );
    expect(
      await persistentDb.query(
        'SELECT status,version FROM study_plans WHERE owner_id=$1',
        [enrollment.json().user.id],
      ),
    ).toEqual([{ status: 'approved', version: 2 }]);
    expect(
      (
        await send(`/api/v1/study/plans/${plan.id}/approve`, approvalPayload)
      ).json(),
    ).toEqual(approved.json());
    expect(await persistentDb.query('SELECT * FROM events')).toHaveLength(4);
    const inspected = studyWorkloadResponseSchema.parse(
      (
        await persistent.inject({
          url: `/api/v1/study/plans/${plan.id}/workload`,
          headers: { cookie: session },
        })
      ).json(),
    );
    expect(inspected.sources[0]).toMatchObject({
      changed: false,
      snapshot: { id: source.id, estimatedMinutes: 50 },
    });
    expect(JSON.stringify(inspected)).not.toContain('Persistent private');
    expect(
      await persistentDb.query('SELECT * FROM study_event_contexts'),
    ).toHaveLength(4);
  } finally {
    await persistent?.close();
    if (dirname(resolve(path)) === root)
      await rm(path, { recursive: true, force: true });
  }
});
