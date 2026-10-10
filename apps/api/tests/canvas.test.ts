import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import {
  canvasConnectionSchema,
  plannerExportSchema,
  canvasItemsResponseSchema,
} from '@hub/contracts';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { buildApp } from '../src/app.js';
import {
  parseCanvasFeed,
  fetchCanvasFeed,
  FeedError,
} from '../src/connections/canvas-feed.js';
import { runCanvasSync } from '../src/connections/canvas.js';

const base = '/api/v1/connections/canvas';
const origin = 'http://127.0.0.1:5173';
const config = readConfig({
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  CANVAS_CALENDAR_FEED_URL:
    'https://canvas.colorado.edu/feeds/calendars/synthetic-feed.ics',
});
export const calendar = (events: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic Hub//EN\r\n${events}END:VCALENDAR\r\n`;
const entry = (title = 'Synthetic deadline', date = '20270301T170000Z') =>
  `BEGIN:VEVENT\r\nUID:synthetic-1\r\nDTSTART:${date}\r\nDTEND:${date}\r\nSUMMARY:${title}\r\nDESCRIPTION:Source description\\nsecond line\r\nURL:https://canvas.colorado.edu/courses/1/assignments/2\r\nEND:VEVENT\r\n`;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let otherCookie: string;
let owner: string;
const headers = (session = cookie) => ({ origin, cookie: session });
const read = async (session = cookie) =>
  canvasConnectionSchema.parse(
    (await app.inject({ url: base, headers: headers(session) })).json(),
  );
const post = (
  path: string,
  payload: Record<string, unknown>,
  session = cookie,
) =>
  app.inject({
    method: 'POST',
    url: `${base}${path}`,
    headers: headers(session),
    payload,
  });
const upload = (feed: string, operationId = randomUUID()) =>
  post('/import', { feed, operationId });

it('projects point deadlines and intervals in the viewing timezone with exclusive day boundaries', async () => {
  const event = (
    uid: string,
    start: string,
    end: string | null = null,
    extra = '',
  ) =>
    `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART${start}\r\n${end ? `DTEND${end}\r\n` : ''}SUMMARY:${uid}\r\n${extra}END:VEVENT\r\n`;
  const snapshot = calendar(
    event('point-start', ':20270314T070000Z') +
      event('point-end', ':20270315T060000Z') +
      event('all-days', ';VALUE=DATE:20270313', ';VALUE=DATE:20270316') +
      event('overnight', ':20270313T230000Z', ':20270314T080000Z') +
      event('cancelled', ':20270314T120000Z', null, 'STATUS:CANCELLED\r\n') +
      event('exclusive-end', ';VALUE=DATE:20270313', ';VALUE=DATE:20270314'),
  );
  expect((await upload(snapshot)).statusCode).toBe(200);
  const route = `${base}/calendar?from=2027-03-14&to=2027-03-15&timeZone=America%2FDenver`;
  expect((await app.inject(route)).statusCode).toBe(401);
  const list = canvasItemsResponseSchema.parse(
    (await app.inject({ url: route, headers: headers() })).json(),
  );
  expect(list.items.map((item) => item.uid).sort()).toEqual([
    'all-days',
    'cancelled',
    'overnight',
    'point-start',
  ]);
  expect(
    canvasItemsResponseSchema.parse(
      (await app.inject({ url: route, headers: headers(otherCookie) })).json(),
    ).items,
  ).toHaveLength(0);
  // A missing point remains visible at its last-known time, not as a reserved interval.
  await upload(
    calendar(event('all-days', ';VALUE=DATE:20270313', ';VALUE=DATE:20270316')),
  );
  const missing = canvasItemsResponseSchema.parse(
    (await app.inject({ url: route, headers: headers() })).json(),
  );
  expect(
    missing.items.find((item) => item.uid === 'point-start')!.availability,
  ).toBe('missing');
  expect(
    (
      await app.inject({
        url: `${base}/calendar?from=2027-01-01&to=2028-01-01&timeZone=UTC`,
        headers: headers(),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        url: `${base}/calendar?from=2027-03-14&to=2027-03-15&timeZone=Unknown`,
        headers: headers(),
      })
    ).statusCode,
  ).toBe(400);
  await db.query('DELETE FROM canvas_sync_jobs WHERE owner_id=$1', [owner]);
  await db.query('DELETE FROM canvas_items WHERE owner_id=$1', [owner]);
});
beforeAll(async () => {
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'canvas@example.test',
      password: 'synthetic-canvas-password',
    },
  });
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  owner = setup.json().user.id;
  const other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-canvas@example.test',
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
});
afterAll(async () => {
  await app?.close();
});

it('links owned classes without overwriting notes, preserves links on refresh, and inherits archived class labels', async () => {
  const source = await read();
  await app.inject({
    method: 'PUT',
    url: base,
    headers: headers(),
    payload: {
      enabled: false,
      sensitivity: 'unlabeled',
      expectedVersion: source.version,
      operationId: randomUUID(),
    },
  });
  const ownClass = await app.inject({
    method: 'POST',
    url: '/api/v1/courses',
    headers: headers(),
    payload: {
      name: 'Linked source class',
      sensitivity: 'restricted',
      operationId: randomUUID(),
    },
  });
  const course = ownClass.json().course;
  const foreignClass = await app.inject({
    method: 'POST',
    url: '/api/v1/courses',
    headers: headers(otherCookie),
    payload: { name: 'Foreign class', operationId: randomUUID() },
  });
  await upload(
    calendar(
      entry('Class-linked entry').replace('synthetic-1', 'class-linked'),
    ),
  );
  let item = (await read()).items.find((item) => item.uid === 'class-linked')!;
  const payload = {
    notes: 'Owner class note',
    sensitivity: 'unlabeled',
    courseId: course.id,
    expectedVersion: item.version,
    operationId: randomUUID(),
  };
  const path = `${base}/items/${item.id}`;
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: path,
        headers: headers(),
        payload: { ...payload, courseId: foreignClass.json().course.id },
      })
    ).statusCode,
  ).toBe(404);
  const linked = await app.inject({
    method: 'PUT',
    url: path,
    headers: headers(),
    payload,
  });
  expect(linked.statusCode).toBe(200);
  expect(linked.json().item).toMatchObject({
    courseId: course.id,
    courseName: 'Linked source class',
    effectiveSensitivity: 'restricted',
  });
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: path,
        headers: headers(),
        payload,
      })
    ).json(),
  ).toEqual(linked.json());
  await upload(
    calendar(
      entry('Provider changed title', '20270302T170000Z').replace(
        'synthetic-1',
        'class-linked',
      ),
    ),
  );
  item = (await read()).items.find((item) => item.uid === 'class-linked')!;
  expect(item).toMatchObject({
    courseId: course.id,
    notes: 'Owner class note',
    inputKind: 'calendar-file',
  });
  // Old clients can change notes without clearing the new link field.
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: path,
        headers: headers(),
        payload: {
          notes: 'Updated owner note',
          sensitivity: 'unlabeled',
          expectedVersion: item.version,
          operationId: randomUUID(),
        },
      })
    ).json().item.courseId,
  ).toBe(course.id);
  const portfolioPath = `${base}/items?courseId=${course.id}`;
  expect((await app.inject({ url: portfolioPath })).statusCode).toBe(401);
  expect(
    (await app.inject({ url: portfolioPath, headers: headers(otherCookie) }))
      .statusCode,
  ).toBe(404);
  expect(
    canvasItemsResponseSchema.parse(
      (await app.inject({ url: portfolioPath, headers: headers() })).json(),
    ).items,
  ).toHaveLength(1);
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/courses/${course.id}`,
        headers: headers(),
        payload: { expectedVersion: course.version, operationId: randomUUID() },
      })
    ).statusCode,
  ).toBe(200);
  item = (await read()).items.find((item) => item.uid === 'class-linked')!;
  expect(item).toMatchObject({
    courseDeleted: true,
    effectiveSensitivity: 'restricted',
    courseId: course.id,
  });
  const archivedEdit = await app.inject({
    method: 'PUT',
    url: path,
    headers: headers(),
    payload: {
      ...payload,
      operationId: randomUUID(),
      expectedVersion: item.version,
      notes: 'Archived note',
    },
  });
  expect(archivedEdit.statusCode).toBe(200);
  const exported = plannerExportSchema.parse(
    (
      await app.inject({ url: '/api/v1/planner/export', headers: headers() })
    ).json(),
  );
  expect(
    exported.records.canvasItems.find((item) => item.uid === 'class-linked'),
  ).toMatchObject({
    courseId: course.id,
    courseDeleted: true,
    effectiveSensitivity: 'restricted',
  });
  const unlinked = await app.inject({
    method: 'PUT',
    url: path,
    headers: headers(),
    payload: {
      ...payload,
      operationId: randomUUID(),
      expectedVersion: archivedEdit.json().item.version,
      courseId: null,
    },
  });
  expect(unlinked.json().item).toMatchObject({
    courseId: null,
    effectiveSensitivity: 'unlabeled',
  });
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: path,
        headers: headers(),
        payload: {
          ...payload,
          operationId: randomUUID(),
          expectedVersion: unlinked.json().item.version,
        },
      })
    ).statusCode,
  ).toBe(404);
  // Reset only this synthetic fixture before the pre-existing snapshot assertions.
  await db.query('DELETE FROM canvas_sync_jobs WHERE owner_id=$1', [owner]);
  await db.query('DELETE FROM canvas_items WHERE owner_id=$1', [owner]);
});

it('schedules automatic refreshes only when enabled and retains upload provenance until fresh network content', async () => {
  await read();
  await db.query(
    'UPDATE canvas_sources SET enabled=true,next_sync_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
    [owner],
  );
  const fetcher = vi.fn(async () => calendar(entry('Automatic entry')));
  await runCanvasSync(db, config, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await read()).jobs[0]).toMatchObject({
    trigger: 'automatic',
    status: 'succeeded',
  });
  expect((await read()).items[0]!.inputKind).toBe('calendar-feed');
  await runCanvasSync(db, config, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await upload(calendar(entry()));
  expect((await read()).items[0]!.inputKind).toBe('calendar-file');
  await upload(
    calendar(
      'BEGIN:VEVENT\r\nUID:synthetic-1\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n',
    ),
  );
  expect((await read()).items[0]!.inputKind).toBe('calendar-file');
  await post('/sync', { operationId: randomUUID() });
  await runCanvasSync(db, config, fetcher);
  expect((await read()).items[0]!.inputKind).toBe('calendar-feed');
  // Leave the independent snapshot cases below with a clean synthetic source.
  await db.query('DELETE FROM canvas_sync_jobs WHERE owner_id=$1', [owner]);
  await db.query('DELETE FROM canvas_items WHERE owner_id=$1', [owner]);
  await db.query('UPDATE canvas_sources SET enabled=false WHERE owner_id=$1', [
    owner,
  ]);
});

it('parses UTC, IANA and date-only entries while rejecting unsupported or ambiguous feeds', () => {
  const parsed = parseCanvasFeed(calendar(entry()));
  expect(parsed[0]!.data.startsAt).toBe('2027-03-01T17:00:00.000Z');
  expect(parsed[0]!.data.description).toContain('\nsecond line');
  const allDay = parseCanvasFeed(
    calendar(
      entry()
        .replaceAll('20270301T170000Z', '2027-03-01'.replaceAll('-', ''))
        .replace('DTSTART:', 'DTSTART;VALUE=DATE:')
        .replace('DTEND:20270301', 'DTEND;VALUE=DATE:20270302'),
    ),
  );
  expect(allDay[0]!.data).toMatchObject({
    allDay: true,
    startDate: '2027-03-01',
    endDate: '2027-03-02',
  });
  const local = calendar(
    entry()
      .replaceAll('20270301T170000Z', '20270301T090000')
      .replaceAll('DTSTART:', 'DTSTART;TZID=America/Denver:')
      .replaceAll('DTEND:', 'DTEND;TZID=America/Denver:'),
  );
  expect(parseCanvasFeed(local)[0]!.data.startsAt).toBe(
    '2027-03-01T16:00:00.000Z',
  );
  expect(() => parseCanvasFeed(calendar(entry() + entry()))).toThrow(
    'DUPLICATE_UID',
  );
  expect(() =>
    parseCanvasFeed(
      calendar(entry().replace('END:VEVENT', 'RRULE:FREQ=DAILY\r\nEND:VEVENT')),
    ),
  ).toThrow('UNSUPPORTED_FEED');
  expect(() =>
    parseCanvasFeed(calendar(entry('floating', '20270301T090000'))),
  ).toThrow('UNSUPPORTED_FEED');
  expect(() =>
    parseCanvasFeed(local.replaceAll('20270301T090000', '20271107T013000')),
  ).toThrow('INVALID_FEED');
  expect(() => parseCanvasFeed('<html>Login required</html>')).toThrow(
    'INVALID_FEED',
  );
  expect(() =>
    parseCanvasFeed(calendar(entry('Invalid date', '20270230T170000Z'))),
  ).toThrow('INVALID_FEED');
  expect(() =>
    parseCanvasFeed(calendar(entry()).replace('END:VCALENDAR', '')),
  ).toThrow('INVALID_FEED');
  expect(() => parseCanvasFeed('x'.repeat(1024 * 1024 + 1))).toThrow(
    'FEED_TOO_LARGE',
  );
  const unsafe = calendar(
    entry().replace(
      'https://canvas.colorado.edu/courses/1/assignments/2',
      'javascript:alert(1)',
    ),
  );
  expect(parseCanvasFeed(unsafe)[0]!.data.sourceUrl).toBeNull();
});

it('bounds network reads, refuses redirects and never reflects private feed errors', async () => {
  const mocked = vi.spyOn(globalThis, 'fetch');
  try {
    mocked.mockRejectedValue(new Error('private URL and provider response'));
    await expect(
      fetchCanvasFeed(config.CANVAS_CALENDAR_FEED_URL!),
    ).rejects.toMatchObject({ code: 'FETCH_FAILED', message: 'FETCH_FAILED' });
    expect(mocked.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
    mocked.mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(
      fetchCanvasFeed(config.CANVAS_CALENDAR_FEED_URL!),
    ).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
    mocked.mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1)));
    await expect(
      fetchCanvasFeed(config.CANVAS_CALENDAR_FEED_URL!),
    ).rejects.toMatchObject({ code: 'FEED_TOO_LARGE' });
  } finally {
    mocked.mockRestore();
  }
  for (const bad of [
    'http://canvas.colorado.edu/feeds/calendars/test.ics',
    'https://example.test/feed.ics',
    'https://canvas.colorado.edu/feeds/calendars/test.ics?token=private',
    'https://canvas.colorado.edu/courses/1',
  ]) {
    expect(() => readConfig({ CANVAS_CALENDAR_FEED_URL: bad })).toThrow(
      'Invalid environment configuration: CANVAS_CALENDAR_FEED_URL',
    );
  }
});

it('protects records, deduplicates snapshots and preserves owner notes through provider updates', async () => {
  expect((await app.inject(base)).statusCode).toBe(401);
  expect(
    (
      await post(
        '/import',
        { feed: calendar(entry()), operationId: randomUUID() },
        '',
      )
    ).statusCode,
  ).toBe(401);
  const operation = randomUUID();
  const first = await upload(calendar(entry()), operation);
  expect(first.statusCode).toBe(200);
  expect((await upload(calendar(entry()), operation)).json()).toEqual(
    first.json(),
  );
  expect((await upload(calendar(entry('Changed')), operation)).statusCode).toBe(
    409,
  );
  const item = (await read()).items[0]!;
  await upload(calendar(entry()));
  expect((await read()).items[0]!.version).toBe(1);
  const payload = {
    notes: 'Personal retained note',
    sensitivity: 'restricted',
    expectedVersion: item.version,
    operationId: randomUUID(),
  };
  const annotation = await app.inject({
    method: 'PUT',
    url: `${base}/items/${item.id}`,
    headers: headers(),
    payload,
  });
  expect(annotation.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${base}/items/${item.id}`,
        headers: headers(otherCookie),
        payload,
      })
    ).statusCode,
  ).toBe(404);
  await upload(calendar(entry('New deadline', '20270302T180000Z')));
  const current = (await read()).items[0]!;
  expect(current).toMatchObject({
    id: item.id,
    notes: 'Personal retained note',
    sensitivity: 'restricted',
    version: 3,
    providerData: {
      title: 'New deadline',
      startsAt: '2027-03-02T18:00:00.000Z',
    },
  });
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `${base}/items/${item.id}`,
        headers: headers(),
        payload: { ...payload, operationId: randomUUID() },
      })
    ).statusCode,
  ).toBe(409);
  expect((await read(otherCookie)).items).toHaveLength(0);
  expect((await read(otherCookie)).configured).toBe(false);
  expect(
    (await post('/sync', { operationId: randomUUID() }, otherCookie))
      .statusCode,
  ).toBe(409);
  await db.query(
    'UPDATE canvas_sources SET enabled=true,next_sync_at=CURRENT_TIMESTAMP WHERE owner_id<>$1',
    [owner],
  );
  const prohibitedFetch = vi.fn(async () => calendar(entry()));
  await runCanvasSync(db, config, prohibitedFetch);
  expect(prohibitedFetch).not.toHaveBeenCalled();
});

it('retains absent/cancelled entries, inherits source labels and exports safe provenance', async () => {
  await upload(calendar(''));
  expect((await read()).items[0]!.availability).toBe('missing');
  const cancelled = calendar(
    'BEGIN:VEVENT\r\nUID:synthetic-1\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n',
  );
  await upload(cancelled);
  expect((await read()).items[0]).toMatchObject({
    availability: 'cancelled',
    notes: 'Personal retained note',
    providerData: { title: 'New deadline' },
  });
  const state = await read();
  const settings = {
    enabled: false,
    sensitivity: 'restricted',
    expectedVersion: state.version,
    operationId: randomUUID(),
  };
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: base,
        headers: headers(),
        payload: settings,
      })
    ).statusCode,
  ).toBe(200);
  const second = calendar(
    entry('Second entry').replace('synthetic-1', 'synthetic-2'),
  );
  await upload(second);
  expect(
    (await read()).items.find((item) => item.uid === 'synthetic-2')!
      .effectiveSensitivity,
  ).toBe('restricted');
  const exported = await app.inject({
    url: '/api/v1/planner/export',
    headers: headers(),
  });
  expect(exported.statusCode).toBe(200);
  expect(
    plannerExportSchema.parse(exported.json()).records.canvasItems,
  ).toHaveLength(2);
  expect(exported.body).not.toContain('synthetic-feed.ics');
  expect(exported.body).not.toContain('lease_token');
});

it('fails malformed snapshots atomically without erasing prior entries or retaining provider secrets', async () => {
  const before = (await read()).items;
  expect((await upload(calendar(entry() + entry()))).statusCode).toBe(400);
  expect((await read()).items).toEqual(before);
  const job = await post('/sync', { operationId: randomUUID() });
  expect(job.statusCode).toBe(200);
  await runCanvasSync(db, config, async () => {
    throw new Error('synthetic private provider secret');
  });
  const result = await read();
  expect(result.items).toEqual(before);
  expect(result.jobs[0]).toMatchObject({
    status: 'failed',
    errorCode: 'SYNC_FAILED',
  });
  expect(JSON.stringify(result)).not.toContain(
    'synthetic private provider secret',
  );
});

it('recovers interrupted leases once, suppresses duplicate fetches, and discards results after pause', async () => {
  const first = await post('/sync', { operationId: randomUUID() });
  const id = first.json().job.id;
  expect(
    (await post('/sync', { operationId: randomUUID() })).json().job.id,
  ).toBe(id);
  await db.query(
    "UPDATE canvas_sync_jobs SET status='running',attempts=1,lease_token=$2,lease_until=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE id=$1",
    [id, randomUUID()],
  );
  const fetcher = vi.fn(async () => calendar(entry()));
  await Promise.all([
    runCanvasSync(db, config, fetcher),
    runCanvasSync(db, config, fetcher),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await read()).jobs.find((job) => job.id === id)).toMatchObject({
    status: 'succeeded',
    attempts: 2,
  });
  await post('/sync', { operationId: randomUUID() });
  let release!: (feed: string) => void;
  const waiting = new Promise<string>((resolve) => {
    release = resolve;
  });
  let claimed!: () => void;
  const started = new Promise<void>((resolve) => {
    claimed = resolve;
  });
  const running = runCanvasSync(db, config, async () => {
    claimed();
    return waiting;
  });
  await started;
  const state = await read();
  await app.inject({
    method: 'PUT',
    url: base,
    headers: headers(),
    payload: {
      enabled: false,
      sensitivity: 'restricted',
      expectedVersion: state.version,
      operationId: randomUUID(),
    },
  });
  release(calendar(entry('Must not commit')));
  await running;
  expect(
    (await read()).items.some(
      (item) => item.providerData.title === 'Must not commit',
    ),
  ).toBe(false);
  const failedJob = await post('/sync', { operationId: randomUUID() });
  await db.query(
    "UPDATE canvas_sync_jobs SET status='running',attempts=3,lease_token=$2,lease_until=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE id=$1",
    [failedJob.json().job.id, randomUUID()],
  );
  await runCanvasSync(db, config, async () => {
    throw new FeedError('FETCH_FAILED');
  });
  expect(
    (await read()).jobs.find((job) => job.id === failedJob.json().job.id),
  ).toMatchObject({ status: 'failed', errorCode: 'LEASE_EXPIRED' });
});
