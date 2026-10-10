import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { canvasLmsConnectionSchema, plannerExportSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  fetchCanvasApi,
  CanvasApiError,
} from '../src/connections/canvas-api.js';
import type { CanvasApiSnapshot } from '../src/connections/canvas-api.js';
import { runCanvasLmsSync } from '../src/connections/canvas-lms.js';
const base = '/api/v1/connections/canvas/lms';
const origin = 'http://127.0.0.1:5173';
const config = readConfig({
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  CANVAS_API_TOKEN: 'synthetic-api-token',
});
const snapshot = (
  title = 'Synthetic API assignment',
  dueAt: string | null = '2027-05-01T17:00:00.000Z',
): CanvasApiSnapshot => ({
  courses: [
    {
      providerId: '10',
      data: {
        name: 'Synthetic API course',
        code: 'API 101',
        term: 'Synthetic term',
        timeZone: 'America/Denver',
      },
    },
  ],
  assignments: [
    {
      providerId: '20',
      courseProviderId: '10',
      data: {
        title,
        dueAt,
        pointsPossible: 25,
        published: true,
        locked: false,
      },
    },
  ],
});
const response = (body: unknown, link?: string, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(link ? { Link: link } : {}),
    },
  });
it('reads paginated course/assignment metadata with header-only authorization and ignores rich/private fields', async () => {
  const transport = vi.fn<typeof fetch>(async (input, options) => {
    expect(options?.method).toBe('GET');
    expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).get('Authorization')).toBe(
      'Bearer synthetic-api-token',
    );
    expect(String(input)).not.toContain('synthetic-api-token');
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/courses')
      return response([
        {
          id: 10,
          name: 'Course',
          course_code: 'CODE',
          term: { name: 'Term' },
          time_zone: 'America/Denver',
          syllabus_body: 'Private syllabus',
          calendar: { ics: 'private-feed' },
        },
      ]);
    expect(url.searchParams.get('override_assignment_dates')).toBe('true');
    if (!url.searchParams.has('page'))
      return response(
        [
          {
            id: 20,
            course_id: 10,
            name: 'Assignment',
            due_at: '2027-05-01T11:00:00-06:00',
            description: '<script>private</script>',
            attachments: [{ url: 'https://example.com/private' }],
            submission: { score: 22 },
            points_possible: 25,
          },
        ],
        `<https://canvas.colorado.edu/api/v1/courses/10/assignments?per_page=100&page=opaque&override_assignment_dates=true>; rel="next"`,
      );
    return response([
      { id: '21', course_id: '10', name: 'No date', due_at: null },
    ]);
  });
  const result = await fetchCanvasApi('synthetic-api-token', transport);
  expect(transport).toHaveBeenCalledTimes(3);
  expect(result.assignments).toHaveLength(2);
  expect(result.assignments[0]?.data.dueAt).toBe('2027-05-01T17:00:00.000Z');
  expect(result.assignments[1]?.data.dueAt).toBeNull();
  const text = JSON.stringify(result);
  for (const forbidden of [
    'description',
    'attachments',
    'submission',
    'private',
    'score',
    'ics',
  ])
    expect(text).not.toContain(forbidden);
});
it('rejects unsafe pagination before forwarding credentials and refuses malformed or duplicate snapshots', async () => {
  for (const next of [
    'https://example.com/api/v1/courses?page=2',
    'https://canvas.colorado.edu/api/v1/users/self',
    'https://canvas.colorado.edu/api/v1/courses?access_token=private',
    'https://user:pass@canvas.colorado.edu/api/v1/courses',
  ]) {
    const transport = vi.fn<typeof fetch>(async () =>
      response([], `<${next}>; rel="next"`),
    );
    await expect(
      fetchCanvasApi('synthetic-api-token', transport),
    ).rejects.toMatchObject({ code: 'UNSAFE_API_PAGE' });
    expect(transport).toHaveBeenCalledTimes(1);
  }
  for (const header of [
    'malformed next',
    '<https://canvas.colorado.edu/api/v1/courses?page=2>; rel="next", <https://canvas.colorado.edu/api/v1/courses?page=3>; rel="next"',
  ])
    await expect(
      fetchCanvasApi('synthetic-api-token', async () => response([], header)),
    ).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' });
  const cycle = vi.fn<typeof fetch>(async () =>
    response(
      [],
      `<https://canvas.colorado.edu/api/v1/courses?per_page=100&enrollment_type=student&enrollment_state=active&include%5B%5D=term>; rel="next"`,
    ),
  );
  await expect(
    fetchCanvasApi('synthetic-api-token', cycle),
  ).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' });
  expect(cycle).toHaveBeenCalledTimes(1);
  await expect(
    fetchCanvasApi('synthetic-api-token', async () =>
      response([
        { id: 10, name: 'Duplicate' },
        { id: 10, name: 'Duplicate' },
      ]),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' });
  await expect(
    fetchCanvasApi('synthetic-api-token', async () =>
      response({ errors: 'private' }),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' });
});
it('bounds API reads and reports sanitized authentication, permission and rate errors', async () => {
  for (const [status, code] of [
    [401, 'API_AUTH_FAILED'],
    [403, 'API_ACCESS_DENIED'],
    [429, 'API_RATE_LIMITED'],
    [500, 'API_FETCH_FAILED'],
  ] as const)
    await expect(
      fetchCanvasApi('synthetic-api-token', async () =>
        response({ secret: 'private response' }, undefined, status),
      ),
    ).rejects.toMatchObject({ code });
  await expect(
    fetchCanvasApi(
      'synthetic-api-token',
      async () =>
        new Response('x'.repeat(1024 * 1024 + 1), {
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  ).rejects.toMatchObject({ code: 'API_LIMIT' });
  await expect(
    fetchCanvasApi(
      'synthetic-api-token',
      async () =>
        new Response('<html>login</html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    ),
  ).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' });
  for (const bad of ['token\nleak', 'token\rleak', 'token with spaces'])
    expect(() => readConfig({ CANVAS_API_TOKEN: bad })).toThrow(
      'Invalid environment configuration: CANVAS_API_TOKEN',
    );
});
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let otherCookie: string;
let owner: string;
const headers = (session = cookie) => ({ origin, cookie: session });
const get = async (session = cookie) =>
  canvasLmsConnectionSchema.parse(
    (await app.inject({ url: base, headers: headers(session) })).json(),
  );
const sync = () =>
  app.inject({
    method: 'POST',
    url: `${base}/sync`,
    headers: headers(),
    payload: { operationId: randomUUID() },
  });
beforeAll(async () => {
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'lms-synthetic@example.com',
      password: 'synthetic-password-only',
    },
  });
  const setCookie = setup.headers['set-cookie']!;
  cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
    ';',
  )[0]!;
  owner = setup.json().user.id;
  const other = randomUUID();
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-lms@example.com',
    'unused',
  ]);
  const token = randomBytes(32).toString('hex');
  await db.query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '1 day')",
    [createHash('sha256').update(token).digest('hex'), other],
  );
  otherCookie = `hub_session=${token}`;
});
afterAll(async () => {
  await app?.close();
});
it('binds API credentials to the enrolled owner and protects every read/write', async () => {
  expect((await app.inject(base)).statusCode).toBe(401);
  expect((await get()).configured).toBe(true);
  expect((await get(otherCookie)).configured).toBe(false);
  const blocked = await app.inject({
    method: 'POST',
    url: `${base}/sync`,
    headers: headers(otherCookie),
    payload: { operationId: randomUUID() },
  });
  expect(blocked.statusCode).toBe(409);
  const state = await get(otherCookie);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: base,
        headers: headers(otherCookie),
        payload: {
          operationId: randomUUID(),
          expectedVersion: state.version,
          enabled: true,
          sensitivity: 'unlabeled',
        },
      })
    ).statusCode,
  ).toBe(409);
  const fetcher = vi.fn(async () => snapshot());
  await runCanvasLmsSync(db, config, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
});
it('deduplicates imports, preserves explicit class links and notes, inherits labels and retains missing records', async () => {
  await get();
  const queued = await sync();
  expect(queued.statusCode).toBe(200);
  const job = queued.json().job;
  expect((await sync()).json().job.id).toBe(job.id);
  await runCanvasLmsSync(db, config, async () => snapshot());
  let state = await get();
  expect(state.courses).toHaveLength(1);
  expect(state.assignments).toHaveLength(1);
  const local = await app.inject({
    method: 'POST',
    url: '/api/v1/courses',
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      name: 'Manual class',
      sensitivity: 'restricted',
    },
  });
  const localId = local.json().course.id;
  const course = state.courses[0]!;
  const assignment = state.assignments[0]!;
  const body = {
    operationId: randomUUID(),
    expectedVersion: course.version,
    notes: 'Course owner notes',
    sensitivity: 'personal',
    courseId: localId,
  };
  const edit = await app.inject({
    method: 'PUT',
    url: `${base}/courses/${course.id}`,
    headers: headers(),
    payload: body,
  });
  expect(edit.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${base}/courses/${course.id}`,
        headers: headers(),
        payload: body,
      })
    ).json(),
  ).toEqual(edit.json());
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${base}/courses/${course.id}`,
        headers: headers(otherCookie),
        payload: { ...body, operationId: randomUUID() },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${base}/assignments/${assignment.id}`,
        headers: headers(),
        payload: {
          operationId: randomUUID(),
          expectedVersion: assignment.version,
          notes: 'Assignment owner notes',
          sensitivity: 'unlabeled',
        },
      })
    ).statusCode,
  ).toBe(200);
  await sync();
  await runCanvasLmsSync(db, config, async () =>
    snapshot('Changed assignment', null),
  );
  state = await get();
  expect(state.courses[0]).toMatchObject({
    id: course.id,
    notes: 'Course owner notes',
    courseId: localId,
  });
  expect(state.assignments[0]).toMatchObject({
    id: assignment.id,
    notes: 'Assignment owner notes',
    effectiveSensitivity: 'restricted',
    providerData: { title: 'Changed assignment', dueAt: null },
  });
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${base}/assignments/${assignment.id}`,
        headers: headers(),
        payload: {
          operationId: randomUUID(),
          expectedVersion: assignment.version,
          notes: 'Must not save',
          sensitivity: 'unlabeled',
        },
      })
    ).statusCode,
  ).toBe(409);
  const route = `${base}/records?courseId=${localId}`;
  expect((await app.inject(route)).statusCode).toBe(401);
  expect(
    (await app.inject({ url: route, headers: headers(otherCookie) }))
      .statusCode,
  ).toBe(404);
  expect(
    (await app.inject({ url: route, headers: headers() })).json().assignments,
  ).toHaveLength(1);
  await sync();
  await runCanvasLmsSync(db, config, async () => ({
    courses: [],
    assignments: [],
  }));
  state = await get();
  expect(state.courses[0]?.availability).toBe('missing');
  expect(state.assignments[0]?.availability).toBe('missing');
  const archive = await app.inject({
    method: 'DELETE',
    url: `/api/v1/courses/${localId}`,
    headers: headers(),
    payload: { operationId: randomUUID(), expectedVersion: 1 },
  });
  expect(archive.statusCode).toBe(200);
  state = await get();
  expect(state.courses[0]).toMatchObject({
    courseDeleted: true,
    effectiveSensitivity: 'restricted',
  });
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${base}/courses/${course.id}`,
        headers: headers(),
        payload: {
          ...body,
          operationId: randomUUID(),
          expectedVersion: state.courses[0]!.version,
        },
      })
    ).statusCode,
  ).toBe(200);
  const exported = await app.inject({
    url: '/api/v1/planner/export',
    headers: headers(),
  });
  expect(exported.statusCode).toBe(200);
  expect(
    plannerExportSchema.parse(exported.json()).records.canvasLmsAssignments[0],
  ).toMatchObject({
    notes: 'Assignment owner notes',
    availability: 'missing',
    effectiveSensitivity: 'restricted',
  });
  expect(exported.body).not.toContain('synthetic-api-token');
  expect((await get(otherCookie)).assignments).toHaveLength(0);
});
it('keeps the previous snapshot on partial failure, recovers leases and discards results after pause', async () => {
  await sync();
  await runCanvasLmsSync(db, config, async () => snapshot());
  const previous = await get();
  await sync();
  await runCanvasLmsSync(db, config, async () => {
    throw new CanvasApiError('API_ACCESS_DENIED');
  });
  let state = await get();
  expect(state.assignments).toEqual(previous.assignments);
  expect(state.lastImportedAt).toBe(previous.lastImportedAt);
  expect(state.jobs[0]?.errorCode).toBe('API_ACCESS_DENIED');
  const queued = await sync();
  await db.query(
    "UPDATE canvas_lms_jobs SET status='running',attempts=1,lease_token=$2,lease_until=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE id=$1",
    [queued.json().job.id, randomUUID()],
  );
  const fetcher = vi.fn(async () => snapshot());
  await Promise.all([
    runCanvasLmsSync(db, config, fetcher),
    runCanvasLmsSync(db, config, fetcher),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  let release!: (value: CanvasApiSnapshot) => void;
  let started!: () => void;
  const pending = new Promise<CanvasApiSnapshot>((resolve) => {
    release = resolve;
  });
  const claimed = new Promise<void>((resolve) => {
    started = resolve;
  });
  await sync();
  const running = runCanvasLmsSync(db, config, async () => {
    started();
    return pending;
  });
  await claimed;
  state = await get();
  await app.inject({
    method: 'PUT',
    url: base,
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      expectedVersion: state.version,
      enabled: false,
      sensitivity: 'personal',
    },
  });
  release(snapshot('Late result'));
  await running;
  expect((await get()).assignments[0]?.providerData.title).not.toBe(
    'Late result',
  );
  const retry = await sync();
  await db.query(
    "UPDATE canvas_lms_jobs SET status='running',attempts=3,lease_token=$2,lease_until=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE id=$1",
    [retry.json().job.id, randomUUID()],
  );
  const blocked = vi.fn(async () => snapshot());
  await runCanvasLmsSync(db, config, blocked);
  expect(blocked).not.toHaveBeenCalled();
  expect(
    (await get()).jobs.find((item) => item.id === retry.json().job.id)
      ?.errorCode,
  ).toBe('LEASE_EXPIRED');
  expect(
    (
      await db.query(
        'SELECT owner_id FROM canvas_lms_sources WHERE owner_id=$1',
        [owner],
      )
    ).length,
  ).toBe(1);
});
