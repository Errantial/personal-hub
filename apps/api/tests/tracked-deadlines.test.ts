import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  plannerExportSchema,
  trackedDeadlineListSchema,
  trackedDeadlineResponseSchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { runCanvasSync } from '../src/connections/canvas.js';
import { runCanvasLmsSync } from '../src/connections/canvas-lms.js';
import { duesCompatible } from '../src/connections/canvas-deadlines.js';
import type { CanvasApiSnapshot } from '../src/connections/canvas-api.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  CANVAS_CALENDAR_FEED_URL:
    'https://canvas.colorado.edu/feeds/calendars/synthetic-deadlines.ics',
  CANVAS_API_TOKEN: 'synthetic-api-token',
});

let app: Awaited<ReturnType<typeof buildApp>>;
let database: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let otherCookie: string;
let ownerId: string;
let browserToken = '';
let browserCourseId = '';

const headers = (session = cookie) => ({ origin, cookie: session });
const owner = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: object,
  session = cookie,
) =>
  app.inject({
    method,
    url,
    headers: headers(session),
    ...(payload ? { payload } : {}),
  });

const calendar = (events: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic Hub//EN\r\n${events}END:VCALENDAR\r\n`;

const dateEntry = (
  uid: string,
  assignmentId: string,
  title: string,
  date = '20270501',
) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:${date}\r\nDTEND;VALUE=DATE:${date.slice(0, 6)}${String(Number(date.slice(6)) + 1).padStart(2, '0')}\r\nSUMMARY:${title}\r\nURL:https://canvas.colorado.edu/courses/10/assignments/${assignmentId}\r\nEND:VEVENT\r\n`;

const cancelledEntry = (uid: string) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n`;

const apiSnapshot = (
  assignmentId = '20',
  title = 'Richer API title',
  dueAt: string | null = '2027-05-02T05:30:00.000Z',
): CanvasApiSnapshot => ({
  accountProviderId: '30',
  courses: [
    {
      providerId: '10',
      data: {
        name: 'Synthetic course',
        code: 'SYN 10',
        term: 'Synthetic term',
        timeZone: 'America/Denver',
      },
    },
  ],
  assignments: [
    {
      providerId: assignmentId,
      courseProviderId: '10',
      data: {
        title,
        dueAt,
        pointsPossible: 10,
        published: true,
        locked: false,
      },
    },
  ],
});

async function deadlines(session = cookie) {
  return trackedDeadlineListSchema.parse(
    (
      await owner('GET', '/api/v1/deadlines?status=all', undefined, session)
    ).json(),
  ).deadlines;
}

async function syncFeed(feed: string) {
  expect(
    (
      await owner('POST', '/api/v1/connections/canvas/sync', {
        operationId: randomUUID(),
      })
    ).statusCode,
  ).toBe(200);
  await runCanvasSync(database, config, async () => feed);
}

async function syncLms(snapshot: CanvasApiSnapshot) {
  expect(
    (
      await owner('POST', '/api/v1/connections/canvas/lms/sync', {
        operationId: randomUUID(),
      })
    ).statusCode,
  ).toBe(200);
  await runCanvasLmsSync(database, config, async () => snapshot);
}

const collector = (method: 'GET' | 'POST', path: string, payload?: object) =>
  app.inject({
    method,
    url: `/api/v1/canvas/browser/collector/${path}`,
    headers: { authorization: `Bearer ${browserToken}` },
    ...(payload ? { payload } : {}),
  });

async function beginBrowserAttempt() {
  const state = (await collector('GET', 'state')).json();
  const attemptId = randomUUID();
  const response = await collector('POST', 'attempt', {
    attemptId,
    expectedSourceVersion: state.sourceVersion,
  });
  expect(response.statusCode).toBe(200);
  return attemptId;
}

beforeAll(async () => {
  database = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database });
  const setup = await owner(
    'POST',
    '/api/v1/auth/setup',
    {
      email: 'tracked-deadlines@example.test',
      password: 'synthetic-password-only',
    },
    '',
  );
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  ownerId = setup.json().user.id;

  const other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await database.query(
    'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',
    [other, 'other-deadlines@example.test', 'unused'],
  );
  await database.query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '1 day')",
    [createHash('sha256').update(token).digest('hex'), other],
  );
  otherCookie = `hub_session=${token}`;

  const feed = (await owner('GET', '/api/v1/connections/canvas')).json();
  expect(
    (
      await owner('PUT', '/api/v1/connections/canvas', {
        operationId: randomUUID(),
        expectedVersion: feed.version,
        enabled: true,
        sensitivity: 'unlabeled',
      })
    ).statusCode,
  ).toBe(200);
  const lms = (await owner('GET', '/api/v1/connections/canvas/lms')).json();
  expect(
    (
      await owner('PUT', '/api/v1/connections/canvas/lms', {
        operationId: randomUUID(),
        expectedVersion: lms.version,
        enabled: true,
        sensitivity: 'unlabeled',
      })
    ).statusCode,
  ).toBe(200);

  const browser = (
    await owner('GET', '/api/v1/connections/canvas/browser')
  ).json();
  const issued = await owner(
    'POST',
    '/api/v1/connections/canvas/browser/token',
    {
      operationId: randomUUID(),
      expectedVersion: browser.version,
    },
  );
  browserToken = issued.json().token;
  const discoveryAttempt = await beginBrowserAttempt();
  expect(
    (
      await collector('POST', 'discovery', {
        attemptId: discoveryAttempt,
        status: 'complete',
        capturedAt: '2026-10-19T20:00:00.000Z',
        courses: [
          {
            providerId: '10',
            name: 'Synthetic browser course',
            canonicalUrl: 'https://canvas.colorado.edu/courses/10',
          },
        ],
      })
    ).statusCode,
  ).toBe(200);
  const browserState = (
    await owner('GET', '/api/v1/connections/canvas/browser')
  ).json();
  browserCourseId = browserState.courses[0].id;
  expect(
    (
      await owner(
        'PUT',
        `/api/v1/connections/canvas/browser/courses/${browserCourseId}`,
        {
          operationId: randomUUID(),
          expectedVersion: browserState.courses[0].version,
          selected: true,
          courseId: null,
          notes: '',
          sensitivity: 'unlabeled',
        },
      )
    ).statusCode,
  ).toBe(200);
});

afterAll(async () => {
  await app?.close();
});

it('treats equal timed instants with different offsets as compatible', () => {
  expect(
    duesCompatible(
      {
        kind: 'timed',
        dueAt: '2027-05-02T05:30:00-06:00',
        timeZone: 'America/Denver',
      },
      {
        kind: 'timed',
        dueAt: '2027-05-02T11:30:00.000Z',
        timeZone: 'UTC',
      },
    ),
  ).toBe(true);
  expect(
    duesCompatible(
      {
        kind: 'timed',
        dueAt: '2027-05-02T05:30:00-06:00',
        timeZone: 'America/Denver',
      },
      {
        kind: 'timed',
        dueAt: '2027-05-02T11:31:00.000Z',
        timeZone: 'UTC',
      },
    ),
  ).toBe(false);
});

it('keeps the first exact source primary, reviews richer alternates, and changes effective data only after owner adoption', async () => {
  await syncFeed(calendar(dateEntry('feed-20', '20', 'Primary feed title')));
  let tracked = await deadlines();
  expect(tracked).toHaveLength(1);
  const first = tracked[0]!;
  const primarySourceId = first.sources.find(
    (source) => source.primary,
  )!.sourceId;
  expect(first).toMatchObject({
    title: 'Primary feed title',
    providerDue: { kind: 'date', dueDate: '2027-05-01' },
    due: { kind: 'date', dueDate: '2027-05-01' },
    sourceCoverage: ['calendar-feed'],
    sourceConflict: false,
  });

  await syncLms(apiSnapshot());
  tracked = await deadlines();
  expect(tracked).toHaveLength(1);
  let deadline = tracked[0]!;
  expect(deadline.sources.find((source) => source.primary)?.sourceId).toBe(
    primarySourceId,
  );
  expect(deadline).toMatchObject({
    title: 'Primary feed title',
    providerDue: { kind: 'date', dueDate: '2027-05-01' },
    sourceConflict: false,
    alternateTimedDue: {
      kind: 'timed',
      dueAt: '2027-05-02T05:30:00.000Z',
      timeZone: 'America/Denver',
    },
  });

  const browserAttempt = await beginBrowserAttempt();
  expect(
    (
      await collector('POST', 'course', {
        attemptId: browserAttempt,
        courseId: browserCourseId,
        status: 'complete',
        capturedAt: '2026-10-19T20:05:00.000Z',
        items: [
          {
            resourceKind: 'assignment',
            providerId: '20',
            canonicalUrl:
              'https://canvas.colorado.edu/courses/10/assignments/20',
            title: 'Browser richer title',
            dueAt: '2027-05-02T05:30:00.000Z',
          },
        ],
      })
    ).statusCode,
  ).toBe(200);
  deadline = (await deadlines())[0]!;
  expect(deadline.sources).toHaveLength(3);
  expect(deadline.sources.find((source) => source.primary)?.sourceId).toBe(
    primarySourceId,
  );
  expect(deadline.title).toBe('Primary feed title');
  expect(deadline.providerDue).toEqual({ kind: 'date', dueDate: '2027-05-01' });
  const beforeLocalWrite = await database.query(
    'SELECT provider_data FROM canvas_lms_assignments WHERE owner_id=$1',
    [ownerId],
  );

  const operationId = randomUUID();
  const edit = {
    operationId,
    expectedVersion: deadline.version,
    titleOverride: 'Owner deadline title',
    priority: 'high',
    notes: 'Owner-only tracked note',
    dueOverride: {
      kind: 'timed',
      dueAt: deadline.alternateTimedDue!.dueAt,
      timeZone: 'America/Denver',
    },
    sensitivity: 'unlabeled',
  } as const;
  const edited = await owner('PUT', `/api/v1/deadlines/${deadline.id}`, edit);
  expect(edited.statusCode).toBe(200);
  const editedDeadline = trackedDeadlineResponseSchema.parse(
    edited.json(),
  ).deadline;
  expect(
    (await owner('PUT', `/api/v1/deadlines/${deadline.id}`, edit)).json(),
  ).toEqual(edited.json());
  expect(
    (
      await owner('PUT', `/api/v1/deadlines/${deadline.id}`, {
        ...edit,
        notes: 'Changed replay payload',
      })
    ).statusCode,
  ).toBe(409);
  expect(editedDeadline).toMatchObject({
    title: 'Owner deadline title',
    priority: 'high',
    notes: 'Owner-only tracked note',
    due: { kind: 'timed', dueAt: '2027-05-02T05:30:00.000Z' },
  });

  const completed = await owner(
    'POST',
    `/api/v1/deadlines/${deadline.id}/complete`,
    {
      operationId: randomUUID(),
      expectedVersion: editedDeadline.version,
    },
  );
  expect(completed.statusCode).toBe(200);
  const completedDeadline = trackedDeadlineResponseSchema.parse(
    completed.json(),
  ).deadline;
  expect(completedDeadline.completedAt).not.toBeNull();
  expect(
    await database.query(
      'SELECT provider_data FROM canvas_lms_assignments WHERE owner_id=$1',
      [ownerId],
    ),
  ).toEqual(beforeLocalWrite);

  await syncLms(
    apiSnapshot('20', 'API changed later', '2027-05-03T05:30:00.000Z'),
  );
  deadline = (await deadlines())[0]!;
  expect(deadline).toMatchObject({
    version: completedDeadline.version,
    completedAt: completedDeadline.completedAt,
    title: 'Owner deadline title',
    priority: 'high',
    notes: 'Owner-only tracked note',
    due: { kind: 'timed', dueAt: '2027-05-02T05:30:00.000Z' },
    providerDue: { kind: 'date', dueDate: '2027-05-01' },
    sourceConflict: true,
  });
  expect(deadline.sources.find((source) => source.primary)?.sourceId).toBe(
    primarySourceId,
  );

  expect(await deadlines(otherCookie)).toHaveLength(0);
  expect(
    (
      await owner(
        'GET',
        `/api/v1/deadlines/${deadline.id}`,
        undefined,
        otherCookie,
      )
    ).statusCode,
  ).toBe(404);

  const reopened = await owner(
    'POST',
    `/api/v1/deadlines/${deadline.id}/reopen`,
    {
      operationId: randomUUID(),
      expectedVersion: deadline.version,
    },
  );
  expect(reopened.statusCode).toBe(200);
  expect(
    trackedDeadlineResponseSchema.parse(reopened.json()).deadline.completedAt,
  ).toBeNull();

  const exported = await owner('GET', '/api/v1/planner/export');
  const parsed = plannerExportSchema.parse(exported.json());
  expect(parsed.records.trackedDeadlines).toHaveLength(1);
  expect(parsed.records.trackedDeadlines[0]).toMatchObject({
    id: deadline.id,
    title: 'Owner deadline title',
    sourceConflict: true,
  });
  expect(exported.body).not.toContain(browserToken);
  expect(JSON.stringify(parsed.records.trackedDeadlines)).not.toContain(
    'pointsPossible',
  );
  expect(exported.body).not.toContain('payload_hash');
});

it('never fuzzy-merges matching title/date records and retains missing or cancelled exact sources', async () => {
  await syncFeed(
    calendar(
      dateEntry('feed-20', '20', 'Primary feed title') +
        dateEntry('feed-21', '21', 'Primary feed title'),
    ),
  );
  let tracked = await deadlines();
  expect(tracked).toHaveLength(2);
  const second = tracked.find((deadline) =>
    deadline.canonicalKey.endsWith('/21'),
  )!;
  expect(second.title).toBe('Primary feed title');
  expect(second.providerDue).toEqual({ kind: 'date', dueDate: '2027-05-01' });

  await syncFeed(calendar(dateEntry('feed-20', '20', 'Primary feed title')));
  tracked = await deadlines();
  expect(tracked).toHaveLength(2);
  expect(
    tracked.find((deadline) => deadline.id === second.id)?.sourceAvailability,
  ).toBe('missing');

  await syncFeed(
    calendar(
      dateEntry('feed-20', '20', 'Primary feed title') +
        cancelledEntry('feed-21'),
    ),
  );
  tracked = await deadlines();
  expect(tracked.find((deadline) => deadline.id === second.id)).toMatchObject({
    title: 'Primary feed title',
    sourceAvailability: 'cancelled',
    providerDue: { kind: 'date', dueDate: '2027-05-01' },
  });
});

it('retains the strongest observed source label even if the source is later weakened', async () => {
  let source = (await owner('GET', '/api/v1/connections/canvas')).json();
  expect(
    (
      await owner('PUT', '/api/v1/connections/canvas', {
        operationId: randomUUID(),
        expectedVersion: source.version,
        enabled: true,
        sensitivity: 'restricted',
      })
    ).statusCode,
  ).toBe(200);
  let tracked = await deadlines();
  expect(
    tracked.every((deadline) => deadline.effectiveSensitivity === 'restricted'),
  ).toBe(true);
  expect(
    tracked.every((deadline) => deadline.sourceLabels.includes('restricted')),
  ).toBe(true);

  source = (await owner('GET', '/api/v1/connections/canvas')).json();
  expect(
    (
      await owner('PUT', '/api/v1/connections/canvas', {
        operationId: randomUUID(),
        expectedVersion: source.version,
        enabled: true,
        sensitivity: 'unlabeled',
      })
    ).statusCode,
  ).toBe(200);
  tracked = await deadlines();
  expect(
    tracked.every((deadline) => deadline.effectiveSensitivity === 'restricted'),
  ).toBe(true);
  expect(
    tracked.every((deadline) => deadline.sourceLabels.includes('restricted')),
  ).toBe(true);
});

it('retains a linked class label after that class is later weakened', async () => {
  await syncFeed(
    calendar(
      dateEntry('feed-20', '20', 'Primary feed title') +
        dateEntry('feed-22', '22', 'Class-linked deadline'),
    ),
  );
  const [item] = await database.query<{ id: string; version: number }>(
    "SELECT id,version FROM canvas_items WHERE owner_id=$1 AND uid='feed-22'",
    [ownerId],
  );
  expect(item).toBeTruthy();
  const created = await owner('POST', '/api/v1/courses', {
    operationId: randomUUID(),
    name: 'Deadline class',
    term: '',
    instructor: '',
    notes: '',
    sensitivity: 'unlabeled',
  });
  expect(created.statusCode).toBe(200);
  let course = created.json().course;
  expect(
    (
      await owner('PUT', `/api/v1/connections/canvas/items/${item!.id}`, {
        operationId: randomUUID(),
        expectedVersion: item!.version,
        courseId: course.id,
        notes: '',
        sensitivity: 'unlabeled',
      })
    ).statusCode,
  ).toBe(200);
  let deadline = (await deadlines()).find((entry) =>
    entry.canonicalKey.endsWith('/22'),
  )!;
  expect(deadline.sourceLabels).toEqual(['unlabeled']);

  const strengthen = await owner('PUT', `/api/v1/courses/${course.id}`, {
    operationId: randomUUID(),
    expectedVersion: course.version,
    name: course.name,
    term: course.term,
    instructor: course.instructor,
    notes: course.notes,
    sensitivity: 'personal',
  });
  expect(strengthen.statusCode).toBe(200);
  course = strengthen.json().course;
  deadline = (await deadlines()).find((entry) =>
    entry.canonicalKey.endsWith('/22'),
  )!;
  expect(deadline.sourceLabels).toContain('personal');
  expect(deadline.effectiveSensitivity).toBe('personal');

  const weaken = await owner('PUT', `/api/v1/courses/${course.id}`, {
    operationId: randomUUID(),
    expectedVersion: course.version,
    name: course.name,
    term: course.term,
    instructor: course.instructor,
    notes: course.notes,
    sensitivity: 'unlabeled',
  });
  expect(weaken.statusCode).toBe(200);
  deadline = (await deadlines()).find((entry) =>
    entry.canonicalKey.endsWith('/22'),
  )!;
  expect(deadline.sourceLabels).toContain('personal');
  expect(deadline.effectiveSensitivity).toBe('personal');
});

it('supports explicit unknown and date owner due overrides and can return to the provider deadline', async () => {
  let deadline = (await deadlines()).find((entry) =>
    entry.canonicalKey.endsWith('/21'),
  )!;
  expect(deadline.providerDue).toEqual({ kind: 'date', dueDate: '2027-05-01' });
  const write = async (dueOverride: Record<string, unknown>) => {
    const response = await owner('PUT', `/api/v1/deadlines/${deadline.id}`, {
      operationId: randomUUID(),
      expectedVersion: deadline.version,
      titleOverride: null,
      priority: 'normal',
      notes: '',
      dueOverride,
      sensitivity: 'unlabeled',
    });
    expect(response.statusCode).toBe(200);
    deadline = trackedDeadlineResponseSchema.parse(response.json()).deadline;
  };

  await write({ kind: 'unknown' });
  expect(deadline.due).toEqual({ kind: 'unknown' });
  await write({ kind: 'date', dueDate: '2027-06-15' });
  expect(deadline.due).toEqual({ kind: 'date', dueDate: '2027-06-15' });
  await write({ kind: 'provider' });
  expect(deadline.due).toEqual({ kind: 'date', dueDate: '2027-05-01' });

  expect(
    (
      await owner('PUT', `/api/v1/deadlines/${deadline.id}`, {
        operationId: randomUUID(),
        expectedVersion: deadline.version,
        titleOverride: null,
        priority: 'normal',
        notes: '',
        dueOverride: {
          kind: 'timed',
          dueAt: '2027-06-15T18:00:00.000Z',
          timeZone: 'Not/AZone',
        },
        sensitivity: 'unlabeled',
      })
    ).statusCode,
  ).toBe(400);
});
