import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  Temporal,
  responsibilityLocalRuleSchema,
  plannerExportSchema,
} from '@hub/contracts';
import type { ResponsibilityLocalRule } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import {
  localReviewSlot,
  advanceLocalReview,
  firstSlotAfter,
} from '../src/features/responsibility-local-cadence.js';
const base = '/api/v1/responsibilities',
  origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>,
  db: Awaited<ReturnType<typeof openDatabase>>,
  cookie: string;
const headers = () => ({ origin, cookie });
const get = (url: string) => app.inject({ url, headers: headers() });
const write = (
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload: object,
) => app.inject({ method, url, headers: headers(), payload });
const change = (expectedVersion: number) => ({
  operationId: randomUUID(),
  expectedVersion,
});
const rule = (fields: object = {}): ResponsibilityLocalRule =>
  responsibilityLocalRuleSchema.parse({
    startDate: '2026-03-07',
    localTime: '02:30',
    timeZone: 'America/Denver',
    frequency: 'daily',
    interval: 1,
    ...fields,
  });
async function active() {
  const created = await write('POST', base, {
    operationId: randomUUID(),
    title: 'Synthetic local review',
    goal: 'Private synthetic local review',
  });
  expect(created.statusCode).toBe(200);
  const id = created.json().responsibility.id;
  const resumed = await write('POST', `${base}/${id}/resume`, change(1));
  expect(resumed.statusCode).toBe(200);
  return resumed.json().responsibility as { id: string; version: number };
}
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in local schedule tests.');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'local-schedule@example.test',
      password: 'synthetic-local-schedule-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  await app.close();
  expect(fetch).not.toHaveBeenCalled();
});
it('shifts a spring gap forward and restores the selected time on the next civil day', () => {
  const saved = rule();
  expect(localReviewSlot(saved, 0)).toBe('2026-03-07T09:30:00.000Z');
  expect(localReviewSlot(saved, 1)).toBe('2026-03-08T09:30:00.000Z');
  expect(localReviewSlot(saved, 2)).toBe('2026-03-09T08:30:00.000Z');
  expect(
    advanceLocalReview(
      saved,
      0,
      localReviewSlot(saved, 0)!,
      Date.parse('2026-03-08T09:00:00Z'),
    ),
  ).toEqual({
    next: '2026-03-08T09:30:00.000Z',
    nextLocalIndex: 1,
    skippedIntervals: 0,
  });
  expect(
    advanceLocalReview(
      saved,
      0,
      localReviewSlot(saved, 0)!,
      Date.parse('2026-03-08T09:35:00Z'),
    ),
  ).toEqual({
    next: '2026-03-09T08:30:00.000Z',
    nextLocalIndex: 2,
    skippedIntervals: 1,
  });
});
it('selects the earlier folded instant once and keeps weekly anchors through DST', () => {
  const saved = rule({ startDate: '2026-10-31', localTime: '01:30' });
  expect(localReviewSlot(saved, 1)).toBe('2026-11-01T07:30:00.000Z');
  expect(localReviewSlot(saved, 2)).toBe('2026-11-02T08:30:00.000Z');
  expect(
    advanceLocalReview(
      saved,
      1,
      localReviewSlot(saved, 1)!,
      Date.parse('2026-11-01T08:45:00Z'),
    ),
  ).toEqual({
    next: '2026-11-02T08:30:00.000Z',
    nextLocalIndex: 2,
    skippedIntervals: 0,
  });
  const weekly = rule({
    startDate: '2026-03-01',
    localTime: '09:00',
    frequency: 'weekly',
    interval: 2,
  });
  expect(localReviewSlot(weekly, 0)).toBe('2026-03-01T16:00:00.000Z');
  expect(localReviewSlot(weekly, 1)).toBe('2026-03-15T15:00:00.000Z');
  expect(
    advanceLocalReview(
      weekly,
      0,
      localReviewSlot(weekly, 0)!,
      Date.parse('2026-03-16T16:00:00Z'),
    ),
  ).toEqual({
    next: '2026-03-29T15:00:00.000Z',
    nextLocalIndex: 2,
    skippedIntervals: 1,
  });
});
it('coalesces skipped civil dates without duplicate instants and bounds unsupported positions', () => {
  const saved = rule({
    startDate: '2011-12-29',
    localTime: '09:00',
    timeZone: 'Pacific/Apia',
  });
  expect(localReviewSlot(saved, 1)).toBe(localReviewSlot(saved, 2));
  const advanced = advanceLocalReview(
    saved,
    1,
    localReviewSlot(saved, 1)!,
    Date.parse(localReviewSlot(saved, 1)!) + 60000,
  );
  expect(advanced).toEqual({
    next: localReviewSlot(saved, 3),
    nextLocalIndex: 3,
    skippedIntervals: 1,
  });
  expect(
    localReviewSlot(
      rule({ startDate: '9999-12-31', timeZone: 'UTC', localTime: '12:00' }),
      1,
    ),
  ).toBeNull();
  expect(localReviewSlot(rule(), 2147483647)).toBeNull();
  expect(() => localReviewSlot(rule(), -1)).toThrow();
  expect(() =>
    advanceLocalReview(rule(), 0, '2026-01-01T00:00:00.000Z', Date.now()),
  ).toThrow();
  expect(() =>
    advanceLocalReview(rule(), 0, localReviewSlot(rule(), 0)!, Number.NaN),
  ).toThrow();
});
it('saves strict local rules with parent versions and retries, and keeps legacy UTC modes explicit', async () => {
  const value = await active();
  const request = { ...change(value.version), rule: rule() };
  const responses = await Promise.all(
    [1, 2].map(() =>
      write('PUT', `${base}/${value.id}/local-schedule`, request),
    ),
  );
  expect(responses[0]!.statusCode).toBe(200);
  expect(responses[1]!.json()).toEqual(responses[0]!.json());
  expect(responses[0]!.json().schedule).toMatchObject({
    localRule: rule(),
    intervalMinutes: null,
    nextLocalIndex: 0,
    startsAt: localReviewSlot(rule(), 0),
    nextDueAt: localReviewSlot(rule(), 0),
    version: 1,
  });
  expect(
    (
      await write('PUT', `${base}/${value.id}/local-schedule`, {
        ...request,
        rule: rule({ localTime: '03:30' }),
      })
    ).statusCode,
  ).toBe(409);
  const utc = await write('PUT', `${base}/${value.id}/schedule`, {
    ...change(3),
    schedule: { startsAt: '2030-01-01T09:00:00.000Z', intervalMinutes: 1440 },
  });
  expect(utc.statusCode).toBe(200);
  expect(utc.json().schedule).toMatchObject({
    localRule: null,
    nextLocalIndex: null,
    intervalMinutes: 1440,
    version: 2,
  });
  expect(
    (await write('PUT', `${base}/${value.id}/local-schedule`, request)).json(),
  ).toEqual(responses[0]!.json());
  expect(
    (await get(`${base}/${value.id}/schedule`)).json().schedule.localRule,
  ).toBeNull();
  for (const fields of [
    { localTime: '24:00' },
    { localTime: '09:00:00' },
    { startDate: '0000-01-01' },
    { startDate: '2026-02-30' },
    { frequency: 'monthly' },
    { interval: 0 },
    { interval: 53 },
    { timeZone: 'Invalid/Zone' },
    { attachments: [] },
  ])
    expect(
      (
        await write('PUT', `${base}/${value.id}/local-schedule`, {
          ...change(4),
          rule: { ...rule(), ...fields },
        })
      ).statusCode,
    ).toBe(400);
  expect(
    (
      await write('PUT', `${base}/${value.id}/local-schedule`, {
        ...change(4),
        rule: rule({
          startDate: '0001-01-01',
          timeZone: '+14:00',
          localTime: '00:00',
        }),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await write('PUT', `${base}/${randomUUID()}/local-schedule`, {
        ...change(1),
        rule: rule(),
      })
    ).statusCode,
  ).toBe(404);
});
it('admits one coalesced local review with durable civil position and paused/source invalidation', async () => {
  const value = await active();
  const today = Temporal.Now.plainDateISO('America/Denver');
  const saved = rule({
    startDate: today.subtract({ days: 3 }).toString(),
    localTime: '00:00',
  });
  const response = await write('PUT', `${base}/${value.id}/local-schedule`, {
    ...change(2),
    rule: saved,
  });
  expect(response.statusCode).toBe(200);
  expect((await get(`${base}/due`)).json().dueCount).toBe(1);
  const request = {
    operationId: randomUUID(),
    items: [{ id: value.id, expectedVersion: 3, expectedScheduleVersion: 1 }],
  };
  const admitted = await Promise.all(
    [1, 2].map(() => write('POST', `${base}/admit-due`, request)),
  );
  expect(admitted[0]!.statusCode).toBe(200);
  expect(admitted[1]!.json()).toEqual(admitted[0]!.json());
  expect(admitted[0]!.json()).toMatchObject({
    executionEnabled: false,
    runs: [
      {
        status: 'blocked',
        scheduledFor: localReviewSlot(saved, 0),
        skippedIntervals: 3,
      },
    ],
  });
  const next = (await get(`${base}/${value.id}/schedule`)).json().schedule;
  expect(next).toMatchObject({
    version: 2,
    nextLocalIndex: 4,
    nextDueAt: localReviewSlot(saved, 4),
    localRule: saved,
  });
  expect((await get(`${base}/due`)).json().dueCount).toBe(0);
  expect(
    (await write('POST', `${base}/${value.id}/pause`, change(3))).statusCode,
  ).toBe(200);
  expect(
    (await get(`${base}/${value.id}/runs`)).json().runs[0].cancelReason,
  ).toBe('responsibility-paused');
  expect((await write('POST', `${base}/admit-due`, request)).json()).toEqual(
    admitted[0]!.json(),
  );
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(exported.records.responsibilitySchedules[0]).toMatchObject({
    localRule: saved,
    nextLocalIndex: 4,
  });
  expect(await db.query('SELECT id FROM ai_requests')).toEqual([]);
  expect(await db.query('SELECT id FROM email_attempts')).toEqual([]);
});
it('clears/replaces local rules atomically and rolls back admission when civil-slot integrity fails', async () => {
  const value = await active();
  await write('PUT', `${base}/${value.id}/local-schedule`, {
    ...change(2),
    rule: rule(),
  });
  await db.query(
    'UPDATE responsibility_schedules SET next_local_index=1 WHERE responsibility_id=$1',
    [value.id],
  );
  const request = {
    operationId: randomUUID(),
    items: [{ id: value.id, expectedVersion: 3, expectedScheduleVersion: 1 }],
  };
  expect(
    (await write('POST', `${base}/admit-due`, request)).json().error.code,
  ).toBe('LOCAL_SCHEDULE_UNAVAILABLE');
  expect(await db.query('SELECT id FROM responsibility_runs')).toEqual([]);
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE operation_id=$1',
      [request.operationId],
    ),
  ).toEqual([]);
  await db.query(
    'UPDATE responsibility_schedules SET next_local_index=0 WHERE responsibility_id=$1',
    [value.id],
  );
  await db.exec(
    "CREATE FUNCTION reject_local_advance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version>OLD.version THEN RAISE EXCEPTION 'Synthetic pointer failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_local_advance BEFORE UPDATE ON responsibility_schedules FOR EACH ROW EXECUTE FUNCTION reject_local_advance();",
  );
  expect((await write('POST', `${base}/admit-due`, request)).statusCode).toBe(
    500,
  );
  expect(await db.query('SELECT id FROM responsibility_runs')).toEqual([]);
  expect(
    (await get(`${base}/${value.id}/schedule`)).json().schedule,
  ).toMatchObject({ version: 1, nextLocalIndex: 0 });
  await db.exec(
    'DROP TRIGGER reject_local_advance ON responsibility_schedules; DROP FUNCTION reject_local_advance();',
  );
  expect((await write('POST', `${base}/admit-due`, request)).statusCode).toBe(
    200,
  );
  const clear = await write('PUT', `${base}/${value.id}/schedule`, {
    ...change(3),
    schedule: null,
  });
  expect(clear.statusCode).toBe(200);
  expect(clear.json().schedule).toMatchObject({
    localRule: rule(),
    nextLocalIndex: null,
    nextDueAt: null,
    deletedAt: expect.any(String),
  });
  expect(
    (await get(`${base}/${value.id}/runs`)).json().runs[0].cancelReason,
  ).toBe('schedule-changed');
  await expect(
    db.query(
      'UPDATE responsibility_schedules SET next_local_index=1 WHERE responsibility_id=$1',
      [value.id],
    ),
  ).rejects.toBeDefined();
});
it('upgrades existing UTC schedules without rewriting instants, receipts or history and parses older exports', async () => {
  const value = await active();
  const utc = await write('PUT', `${base}/${value.id}/schedule`, {
    ...change(2),
    schedule: { startsAt: '2030-01-01T12:00:00Z', intervalMinutes: 60 },
  });
  expect(utc.statusCode).toBe(200);
  const before = await db.query(
    'SELECT * FROM mutation_receipts ORDER BY operation_id',
  );
  await db.exec(
    'ALTER TABLE responsibility_schedules DROP CONSTRAINT responsibility_schedules_local_state; ALTER TABLE responsibility_schedules DROP COLUMN local_rule; ALTER TABLE responsibility_schedules DROP COLUMN next_local_index;',
  );
  await db.query(
    "DELETE FROM schema_migrations WHERE name='037_responsibility_local_schedules.sql'",
  );
  await migrate(db);
  expect((await get(`${base}/${value.id}/schedule`)).json().schedule).toEqual(
    utc.json().schedule,
  );
  expect(
    await db.query('SELECT * FROM mutation_receipts ORDER BY operation_id'),
  ).toEqual(before);
  const exported = (await get('/api/v1/planner/export')).json();
  delete exported.records.responsibilitySchedules[0].localRule;
  delete exported.records.responsibilitySchedules[0].nextLocalIndex;
  expect(
    plannerExportSchema.parse(exported).records.responsibilitySchedules[0],
  ).toMatchObject({ localRule: null, nextLocalIndex: null });
});
it('preserves local rules/position and exact admission retries across persisted restart', async () => {
  const root = resolve('.artifacts');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'local-review-'));
  const persistent = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: path });
  let server: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    server = await buildApp({ logger: false }, { config: persistent });
    const setup = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persisted-local-review@example.test',
        password: 'synthetic-persisted-local-review',
      },
    });
    const h = {
      origin,
      cookie: String(setup.headers['set-cookie']).split(';')[0]!,
    };
    const created = await server.inject({
      method: 'POST',
      url: base,
      headers: h,
      payload: {
        operationId: randomUUID(),
        title: 'Local review',
        goal: 'Synthetic persisted goal',
      },
    });
    const id = created.json().responsibility.id;
    await server.inject({
      method: 'POST',
      url: `${base}/${id}/resume`,
      headers: h,
      payload: change(1),
    });
    await server.inject({
      method: 'PUT',
      url: `${base}/${id}/local-schedule`,
      headers: h,
      payload: { ...change(2), rule: rule() },
    });
    const request = {
      operationId: randomUUID(),
      items: [{ id, expectedVersion: 3, expectedScheduleVersion: 1 }],
    };
    const admitted = await server.inject({
      method: 'POST',
      url: `${base}/admit-due`,
      headers: h,
      payload: request,
    });
    expect(admitted.statusCode).toBe(200);
    const saved = (
      await server.inject({ url: `${base}/${id}/schedule`, headers: h })
    ).json();
    await server.close();
    server = undefined;
    server = await buildApp({ logger: false }, { config: persistent });
    expect(
      (
        await server.inject({ url: `${base}/${id}/schedule`, headers: h })
      ).json(),
    ).toEqual(saved);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `${base}/admit-due`,
          headers: h,
          payload: request,
        })
      ).json(),
    ).toEqual(admitted.json());
    expect(
      (await server.inject({ url: `${base}/${id}/runs`, headers: h })).json()
        .runs,
    ).toHaveLength(1);
  } finally {
    await server?.close();
    expect(dirname(path)).toBe(root);
    await rm(path, { recursive: true, force: true });
  }
});

const fourTimes = () =>
  responsibilityLocalRuleSchema.parse({
    startDate: '2026-11-01',
    localTime: '08:00',
    times: ['08:00', '12:00', '16:00', '20:00'],
    timeZone: 'America/Denver',
    frequency: 'daily',
  });
const denver = (value: string) =>
  new Date(
    Temporal.PlainDateTime.from(value)
      .toZonedDateTime('America/Denver')
      .toInstant().epochMilliseconds,
  ).toISOString();

it('lists each local time once per day for multi-time daily rules across the fall-back day', () => {
  const slots = Array.from({ length: 8 }, (_, index) =>
    localReviewSlot(fourTimes(), index),
  );
  expect(slots).toEqual([
    denver('2026-11-01T08:00'),
    denver('2026-11-01T12:00'),
    denver('2026-11-01T16:00'),
    denver('2026-11-01T20:00'),
    denver('2026-11-02T08:00'),
    denver('2026-11-02T12:00'),
    denver('2026-11-02T16:00'),
    denver('2026-11-02T20:00'),
  ]);
  expect(new Set(slots).size).toBe(8);
});

it('coalesces missed multi-time slots to the next future time', () => {
  const now = Date.parse(denver('2026-11-02T13:00'));
  expect(
    advanceLocalReview(fourTimes(), 0, denver('2026-11-01T08:00'), now),
  ).toEqual({
    next: denver('2026-11-02T16:00'),
    nextLocalIndex: 6,
    skippedIntervals: 5,
  });
});

it("starts new schedules at the first future slot, skipping today's past times", () => {
  expect(
    firstSlotAfter(fourTimes(), Date.parse(denver('2026-11-01T13:00'))),
  ).toEqual({ index: 2, at: denver('2026-11-01T16:00') });
  const single = responsibilityLocalRuleSchema.parse({
    startDate: '2026-11-01',
    localTime: '07:00',
    timeZone: 'America/Denver',
    frequency: 'daily',
  });
  expect(
    firstSlotAfter(single, Date.parse(denver('2026-11-01T15:00'))),
  ).toEqual({ index: 1, at: denver('2026-11-02T07:00') });
  expect(
    firstSlotAfter(single, Date.parse(denver('2026-10-30T15:00'))),
  ).toEqual({ index: 0, at: denver('2026-11-01T07:00') });
});

it('rejects unordered or duplicate times and times not starting with localTime', () => {
  for (const times of [
    ['12:00', '08:00'],
    ['08:00', '08:00'],
    ['09:00'],
    Array.from({ length: 7 }, (_, index) => `0${index + 1}:00`),
  ])
    expect(
      responsibilityLocalRuleSchema.safeParse({
        startDate: '2026-11-01',
        localTime: '08:00',
        times,
        timeZone: 'America/Denver',
        frequency: 'daily',
      }).success,
    ).toBe(false);
});
