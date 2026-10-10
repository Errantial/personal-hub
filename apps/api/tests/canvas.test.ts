import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { canvasConnectionSchema, plannerExportSchema } from '@hub/contracts';
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
