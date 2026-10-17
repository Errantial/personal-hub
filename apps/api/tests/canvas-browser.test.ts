import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canvasBrowserConnectionSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
const base = '/api/v1/connections/canvas/browser';
const collectorBase = '/api/v1/canvas/browser/collector';

let app: Awaited<ReturnType<typeof buildApp>>;
let database: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let ownerId: string;
let otherCookie: string;

const owner = (method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET',
    url,
    headers: { origin, cookie },
    ...(payload ? { payload } : {}),
  });

const collector = (
  token: string,
  method: 'GET' | 'POST',
  path: string,
  payload?: object,
) =>
  app.inject({
    method,
    url: `${collectorBase}/${path}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

const get = async () =>
  canvasBrowserConnectionSchema.parse((await owner('GET', base)).json());

const issueToken = async () => {
  const state = await get();
  const response = await owner('POST', `${base}/token`, {
    operationId: randomUUID(),
    expectedVersion: state.version,
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
};

const course = (providerId = '10', name = 'Browser course') => ({
  providerId,
  name,
  canonicalUrl: `https://canvas.colorado.edu/courses/${providerId}`,
});

const item = (
  providerId = '20',
  kind: 'assignment' | 'quiz' = 'assignment',
  title = 'Browser assignment',
  dueAt: string | null = '2027-04-02T18:00:00.000Z',
) => ({
  resourceKind: kind,
  providerId,
  canonicalUrl: `https://canvas.colorado.edu/courses/10/${
    kind === 'assignment' ? 'assignments' : 'quizzes'
  }/${providerId}`,
  title,
  dueAt,
});

async function begin(token: string) {
  const state = (await collector(token, 'GET', 'state')).json();
  const attemptId = randomUUID();
  const response = await collector(token, 'POST', 'attempt', {
    attemptId,
    expectedSourceVersion: state.sourceVersion,
  });
  expect(response.statusCode).toBe(200);
  return attemptId;
}

async function discover(
  token: string,
  attemptId: string,
  status: 'complete' | 'partial' = 'complete',
  courses = [course()],
) {
  return collector(token, 'POST', 'discovery', {
    attemptId,
    status,
    capturedAt: '2026-10-16T18:00:00.000Z',
    courses,
  });
}

async function selectFirstCourse() {
  const state = await get();
  const selected = state.courses[0]!;
  const response = await owner('PUT', `${base}/courses/${selected.id}`, {
    operationId: randomUUID(),
    expectedVersion: selected.version,
    selected: true,
    courseId: null,
    notes: '',
    sensitivity: 'unlabeled',
  });
  expect(response.statusCode).toBe(200);
  return canvasBrowserConnectionSchema.parse((await owner('GET', base)).json())
    .courses[0]!;
}

beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden.');
    }),
  );
  database = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'canvas-browser@example.test',
      password: 'synthetic-password-only',
    },
  });
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  ownerId = setup.json().user.id;
  const other = randomUUID();
  await database.query(
    'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',
    [other, 'other-browser@example.test', 'unused'],
  );
  const session = randomBytes(32).toString('hex');
  await database.query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '1 day')",
    [createHash('sha256').update(session).digest('hex'), other],
  );
  otherCookie = `hub_session=${session}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

it('issues a one-time hash-only collector token, isolates it from browser sessions and revokes it', async () => {
  let state = await get();
  expect(state).toMatchObject({
    configured: false,
    healthStatus: 'never-synced',
    courses: [],
    items: [],
  });
  const operationId = randomUUID();
  const issued = await owner('POST', `${base}/token`, {
    operationId,
    expectedVersion: state.version,
  });
  expect(issued.statusCode).toBe(200);
  const { token } = issued.json();
  expect(token).toMatch(/^hubcb_/);
  const [stored] = await database.query(
    'SELECT token_hash FROM canvas_browser_sources WHERE owner_id=$1',
    [ownerId],
  );
  expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(
    JSON.stringify(
      await database.query('SELECT result FROM mutation_receipts'),
    ),
  ).not.toContain(token);
  expect(
    (
      await owner('POST', `${base}/token`, {
        operationId,
        expectedVersion: state.version,
      })
    ).statusCode,
  ).toBe(409);
  expect((await collector(token, 'GET', 'state')).statusCode).toBe(200);
  expect((await owner('GET', `${collectorBase}/state`)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        url: base,
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(401);

  state = await get();
  const revoked = await owner('POST', `${base}/revoke`, {
    operationId: randomUUID(),
    expectedVersion: state.version,
  });
  expect(revoked.statusCode).toBe(200);
  expect(revoked.json().healthStatus).toBe('revoked');
  expect((await collector(token, 'GET', 'state')).statusCode).toBe(401);
});

it('keeps browser discovery separate, requires explicit selection and preserves owner class links', async () => {
  const token = await issueToken();
  const attemptId = await begin(token);
  const discovery = await discover(token, attemptId, 'complete', [
    course('10', 'First browser course'),
    course('11', 'Second browser course'),
  ]);
  expect(discovery.statusCode).toBe(200);
  expect(discovery.json()).toEqual({ added: 2, updated: 0, missing: 0 });
  expect(
    (
      await discover(token, attemptId, 'complete', [
        course('10', 'First browser course'),
        course('11', 'Second browser course'),
      ])
    ).json(),
  ).toEqual(discovery.json());
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: null,
  });
  let state = await get();
  expect(state.healthStatus).toBe('partial');
  expect(state.courses).toHaveLength(2);
  expect(state.courses.every((value) => !value.selected)).toBe(true);

  const local = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: { origin, cookie },
      payload: {
        operationId: randomUUID(),
        name: 'Explicit local class',
        sensitivity: 'restricted',
      },
    })
  ).json().course;
  const first = state.courses[0]!;
  const linked = await owner('PUT', `${base}/courses/${first.id}`, {
    operationId: randomUUID(),
    expectedVersion: first.version,
    selected: true,
    courseId: local.id,
    notes: 'Owner-only note',
    sensitivity: 'personal',
  });
  expect(linked.statusCode).toBe(200);
  state = await get();
  expect(state.courses[0]).toMatchObject({
    selected: true,
    courseId: local.id,
    courseName: 'Explicit local class',
    notes: 'Owner-only note',
    effectiveSensitivity: 'restricted',
  });
  expect(
    (
      await app.inject({
        url: base,
        headers: { origin, cookie: otherCookie },
      })
    ).json().courses,
  ).toEqual([]);
});

it('reconciles only complete course observations, keeps quizzes distinct and makes retries exact', async () => {
  const token = await issueToken();
  let attemptId = await begin(token);
  await discover(token, attemptId);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: null,
  });
  const selected = await selectFirstCourse();

  attemptId = await begin(token);
  await discover(token, attemptId);
  const capturedAt = '2026-10-16T18:10:00.000Z';
  const payload = {
    attemptId,
    courseId: selected.id,
    status: 'complete',
    capturedAt,
    items: [
      item('20', 'assignment', 'Shared numeric ID assignment'),
      item('20', 'quiz', 'Shared numeric ID quiz', null),
    ],
  } as const;
  const observed = await collector(token, 'POST', 'course', payload);
  expect(observed.statusCode).toBe(200);
  expect(observed.json()).toEqual({ added: 2, updated: 0, missing: 0 });
  expect((await collector(token, 'POST', 'course', payload)).json()).toEqual(
    observed.json(),
  );
  expect(
    (
      await collector(token, 'POST', 'course', {
        ...payload,
        items: [item('20', 'assignment', 'Changed retry')],
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await collector(token, 'POST', 'attempt/finish', {
        attemptId,
        outcome: 'complete',
        errorCode: null,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await collector(token, 'POST', 'attempt/finish', {
        attemptId,
        outcome: 'complete',
        errorCode: null,
      })
    ).statusCode,
  ).toBe(200);
  let state = await get();
  expect(state.healthStatus).toBe('current');
  expect(state.items).toHaveLength(2);
  expect(new Set(state.items.map((value) => value.resourceKind))).toEqual(
    new Set(['assignment', 'quiz']),
  );
  let captures = await database.query<{
    snapshot: { resourceKind: string; title: string };
    capturedAt: string;
  }>(
    `SELECT snapshot,captured_at AS "capturedAt" FROM canvas_browser_item_captures
     WHERE owner_id=$1 ORDER BY captured_at,id`,
    [ownerId],
  );
  expect(captures).toHaveLength(2);
  expect(captures.map((value) => value.snapshot.title).sort()).toEqual([
    'Shared numeric ID assignment',
    'Shared numeric ID quiz',
  ]);
  const exported = (await owner('GET', '/api/v1/planner/export')).json();
  expect(exported.records.canvasBrowserSource).toEqual({
    sensitivity: 'unlabeled',
    version: state.version,
  });
  expect(exported.records.canvasBrowserCourses).toHaveLength(1);
  expect(exported.records.canvasBrowserItems).toHaveLength(2);
  expect(exported.records.canvasBrowserItemCaptures).toHaveLength(2);
  expect(JSON.stringify(exported)).not.toContain(token);
  expect(JSON.stringify(exported.records)).not.toContain('activeAttemptId');
  expect(JSON.stringify(exported.records)).not.toContain('discoveryHash');

  attemptId = await begin(token);
  await discover(token, attemptId, 'complete', [
    course('10', 'Browser course'),
    course('11', 'New browser course'),
  ]);
  await collector(token, 'POST', 'course', {
    attemptId,
    courseId: selected.id,
    status: 'complete',
    capturedAt: '2026-10-16T18:15:00.000Z',
    items: [
      item('20', 'assignment', 'Shared numeric ID assignment'),
      item('20', 'quiz', 'Shared numeric ID quiz', null),
    ],
  });
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'complete',
    errorCode: null,
  });
  state = await get();
  expect(state.healthStatus).toBe('current');
  const newCourse = state.courses.find((value) => value.providerId === '11')!;
  expect(
    (
      await owner('PUT', `${base}/courses/${newCourse.id}`, {
        operationId: randomUUID(),
        expectedVersion: newCourse.version,
        selected: true,
        courseId: null,
        notes: '',
        sensitivity: 'unlabeled',
      })
    ).statusCode,
  ).toBe(200);
  state = await get();
  expect(state.healthStatus).toBe('partial');
  expect(state.lastCompleteAt).not.toBeNull();

  attemptId = await begin(token);
  await discover(token, attemptId);
  await collector(token, 'POST', 'course', {
    attemptId,
    courseId: selected.id,
    status: 'partial',
    capturedAt: '2026-10-16T18:20:00.000Z',
    items: [item('20', 'assignment', 'Changed title', null)],
  });
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: 'traversal-limit',
  });
  state = await get();
  expect(state.healthStatus).toBe('partial');
  expect(state.items).toHaveLength(2);
  expect(
    state.items.find((value) => value.resourceKind === 'quiz')?.availability,
  ).toBe('available');
  expect(
    state.items.find((value) => value.resourceKind === 'assignment'),
  ).toMatchObject({ title: 'Changed title', dueAt: null });
  captures = await database.query<{
    snapshot: { resourceKind: string; title: string };
    capturedAt: string;
  }>(
    `SELECT snapshot,captured_at AS "capturedAt" FROM canvas_browser_item_captures
     WHERE owner_id=$1 ORDER BY captured_at,id`,
    [ownerId],
  );
  expect(captures).toHaveLength(5);
  expect(
    captures
      .filter((value) => value.snapshot.resourceKind === 'assignment')
      .map((value) => value.snapshot.title),
  ).toEqual([
    'Shared numeric ID assignment',
    'Shared numeric ID assignment',
    'Changed title',
  ]);

  attemptId = await begin(token);
  await discover(token, attemptId);
  const complete = await collector(token, 'POST', 'course', {
    attemptId,
    courseId: selected.id,
    status: 'complete',
    capturedAt: '2026-10-16T18:30:00.000Z',
    items: [item('20', 'assignment', 'Changed title', null)],
  });
  expect(complete.json().missing).toBe(1);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'complete',
    errorCode: null,
  });
  state = await get();
  expect(
    state.items.find((value) => value.resourceKind === 'quiz')?.availability,
  ).toBe('missing');
  captures = await database.query<{
    snapshot: { resourceKind: string; title: string };
    capturedAt: string;
  }>(
    `SELECT snapshot FROM canvas_browser_item_captures
     WHERE owner_id=$1 ORDER BY captured_at,id`,
    [ownerId],
  );
  expect(captures).toHaveLength(6);
  expect(captures.map((value) => value.snapshot.title)).toContain(
    'Shared numeric ID assignment',
  );
});

it('requires complete selected-course coverage and surfaces sign-in-required without pruning', async () => {
  const token = await issueToken();
  let attemptId = await begin(token);
  await discover(token, attemptId);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: null,
  });
  const selected = await selectFirstCourse();

  attemptId = await begin(token);
  await discover(token, attemptId);
  const incomplete = await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'complete',
    errorCode: null,
  });
  expect(incomplete.statusCode).toBe(409);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'failed',
    errorCode: 'sign-in-required',
  });
  let state = await get();
  expect(state).toMatchObject({
    healthStatus: 'sign-in-required',
    lastAttemptOutcome: 'failed',
    lastErrorCode: 'sign-in-required',
  });
  expect(state.courses[0]?.lastCompleteAt).toBeNull();

  attemptId = await begin(token);
  await discover(token, attemptId, 'partial');
  await collector(token, 'POST', 'course', {
    attemptId,
    courseId: selected.id,
    status: 'inaccessible',
    capturedAt: '2026-10-16T19:00:00.000Z',
    items: [],
  });
  expect(
    (
      await collector(token, 'POST', 'attempt/finish', {
        attemptId,
        outcome: 'complete',
        errorCode: null,
      })
    ).statusCode,
  ).toBe(409);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: null,
  });
  state = await get();
  expect(state.healthStatus).toBe('partial');
  expect(state.courses[0]).toMatchObject({
    lastObservationStatus: 'inaccessible',
    lastObservedCount: 0,
  });
});

it('keeps an active attempt leased by recent progress instead of its start time', async () => {
  const token = await issueToken();
  const first = await begin(token);
  await database.query(
    `UPDATE canvas_browser_sources SET last_attempt_at=CURRENT_TIMESTAMP-INTERVAL '2 hours',active_attempt_progress_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1`,
    [ownerId],
  );
  let state = await get();
  expect(state.healthStatus).toBe('syncing');
  const current = (await collector(token, 'GET', 'state')).json();
  const blocked = await collector(token, 'POST', 'attempt', {
    attemptId: randomUUID(),
    expectedSourceVersion: current.sourceVersion,
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().error.code).toBe('ATTEMPT_ACTIVE');

  await database.query(
    `UPDATE canvas_browser_sources SET active_attempt_progress_at=CURRENT_TIMESTAMP-INTERVAL '2 hours'
     WHERE owner_id=$1`,
    [ownerId],
  );
  state = await get();
  expect(state.healthStatus).toBe('partial');
  const replacement = randomUUID();
  expect(
    (
      await collector(token, 'POST', 'attempt', {
        attemptId: replacement,
        expectedSourceVersion: current.sourceVersion,
      })
    ).statusCode,
  ).toBe(200);
  const [oldAttempt] = await database.query(
    'SELECT outcome FROM canvas_browser_attempts WHERE owner_id=$1 AND id=$2',
    [ownerId, first],
  );
  expect(oldAttempt?.outcome).toBe('partial');
});
