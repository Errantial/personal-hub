import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  responsibilityResponseSchema,
  responsibilityPageSchema,
  responsibilityDuePageSchema,
  responsibilityRunPageSchema,
  responsibilityActivityPageSchema,
  plannerExportSchema,
} from '@hub/contracts';
import type { Responsibility } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
const base = '/api/v1/responsibilities',
  origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>,
  db: Awaited<ReturnType<typeof openDatabase>>;
let owner: string, cookie: string, other: string, otherCookie: string;
const headers = (session = cookie) => ({ origin, cookie: session });
const get = (url = base, session = cookie) =>
  app.inject({ url, headers: headers(session) });
const write = (
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload: object,
  session = cookie,
) => app.inject({ method, url, payload, headers: headers(session) });
const change = (expectedVersion: number) => ({
  operationId: randomUUID(),
  expectedVersion,
});
const input = (fields: object = {}) => ({
  operationId: randomUUID(),
  title: 'Synthetic review',
  goal: 'Synthetic private review goal',
  ...fields,
});
async function read(id: string, session = cookie) {
  return responsibilityResponseSchema.parse(
    (await get(`${base}/${id}`, session)).json(),
  ).responsibility;
}
async function create(
  fields: object = {},
  session = cookie,
): Promise<Responsibility> {
  const response = await write('POST', base, input(fields), session);
  expect(response.statusCode).toBe(200);
  return read(response.json().responsibility.id, session);
}
async function resume(value: Responsibility) {
  expect(
    (await write('POST', `${base}/${value.id}/resume`, change(value.version)))
      .statusCode,
  ).toBe(200);
  return read(value.id);
}
async function scheduled(
  value: Responsibility,
  startsAt = new Date(Date.now() - 60000).toISOString(),
  intervalMinutes: number | null = null,
) {
  const response = await write('PUT', `${base}/${value.id}/schedule`, {
    ...change(value.version),
    schedule: { startsAt, intervalMinutes },
  });
  expect(response.statusCode).toBe(200);
  return {
    value: await read(value.id),
    schedule: response.json().schedule as {
      version: number;
      nextDueAt: string | null;
      startsAt: string;
      intervalMinutes: number | null;
    },
  };
}
const admit = (
  value: Responsibility,
  scheduleVersion: number,
  operationId = randomUUID(),
) =>
  write('POST', `${base}/admit-due`, {
    operationId,
    items: [
      {
        id: value.id,
        expectedVersion: value.version,
        expectedScheduleVersion: scheduleVersion,
      },
    ],
  });
async function manual(value: Responsibility) {
  const response = await write(
    'POST',
    `${base}/${value.id}/runs`,
    change(value.version),
  );
  expect(response.statusCode).toBe(200);
  return response.json().run as { id: string; version: number; status: string };
}
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in responsibility tests.');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'responsibility-owner@example.test',
      password: 'synthetic-responsibility-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-responsibility@example.test',
    'unused',
  ]);
  await db.query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '1 day')",
    [createHash('sha256').update(token).digest('hex'), other],
  );
  otherCookie = `hub_session=${token}`;
});
afterEach(async () => {
  await app.close();
  expect(fetch).not.toHaveBeenCalled();
});

it('creates paused owned text with strict boundaries and no executor or content in receipts/activity', async () => {
  const value = await create({
    title: '  Review  ',
    goal: '  Owner text\nSecond line  ',
    sensitivity: 'restricted',
  });
  expect(value).toMatchObject({
    title: 'Review',
    goal: 'Owner text\nSecond line',
    status: 'paused',
    source: 'owner-entered',
    labels: ['restricted'],
    version: 1,
  });
  expect((await get(`${base}/${value.id}/schedule`)).json()).toEqual({
    schedule: null,
  });
  expect(
    (await write('POST', `${base}/${value.id}/runs`, change(1))).json().error
      .code,
  ).toBe('RESPONSIBILITY_PAUSED');
  for (const fields of [
    { title: '' },
    { goal: 'x'.repeat(4001) },
    { goal: 'null\0' },
    { status: 'active' },
    { source: 'attachment' },
    { attachments: [] },
    { refs: [] },
    { tool: 'shell' },
    { labels: ['personal'] },
    { provider: 'selected' },
    { budget: 1 },
  ])
    expect((await write('POST', base, input(fields))).statusCode).toBe(400);
  const events = responsibilityActivityPageSchema.parse(
    (await get(`${base}/${value.id}/activity`)).json(),
  );
  expect(events.activities.map((event) => event.kind)).toEqual(['created']);
  const receipts = await db.query(
    'SELECT result FROM mutation_receipts WHERE owner_id=$1',
    [owner],
  );
  expect(JSON.stringify(receipts)).not.toContain('Owner text');
  expect(JSON.stringify(events)).not.toContain('Owner text');
  expect(
    (
      await write('POST', '/api/v1/ai/routing/preview', {
        refs: [{ kind: 'responsibility', id: value.id, expectedVersion: 1 }],
        text: 'Synthetic',
        providers: [],
        sensitivity: 'unlabeled',
      })
    ).statusCode,
  ).toBe(400);
});
it('serializes creates/edits with exact retries, conflicts and complete owner label history', async () => {
  const request = input({ sensitivity: 'restricted' });
  const creates = await Promise.all(
    [1, 2].map(() => write('POST', base, request)),
  );
  expect(creates[0]!.statusCode).toBe(200);
  expect(creates[1]!.json()).toEqual(creates[0]!.json());
  const id = creates[0]!.json().responsibility.id;
  expect(
    (await write('POST', base, { ...request, goal: 'Changed' })).statusCode,
  ).toBe(409);
  const changes = await Promise.all(
    ['personal', 'unlabeled'].map((sensitivity) =>
      write('PUT', `${base}/${id}`, {
        ...input({ sensitivity }),
        expectedVersion: 1,
      }),
    ),
  );
  expect(changes.map((response) => response.statusCode).sort()).toEqual([
    200, 409,
  ]);
  expect((await read(id)).labels).toContain('restricted');
  const saved = { ...input({ sensitivity: 'unlabeled' }), expectedVersion: 2 };
  const result = await write('PUT', `${base}/${id}`, saved);
  expect(result.statusCode).toBe(200);
  expect((await write('PUT', `${base}/${id}`, saved)).json()).toEqual(
    result.json(),
  );
  expect((await read(id)).version).toBe(3);
  expect((await write('POST', base, request)).json()).toEqual(
    creates[0]!.json(),
  );
  expect(
    await db.query('SELECT id FROM responsibilities WHERE owner_id=$1', [
      owner,
    ]),
  ).toHaveLength(1);
});
it('pauses/cancels blocked runs atomically and resume never reactivates historical work', async () => {
  let value = await resume(await create());
  const request = change(value.version);
  const run = await write('POST', `${base}/${value.id}/runs`, request);
  expect(run.json()).toMatchObject({
    executionEnabled: false,
    run: {
      status: 'blocked',
      trigger: 'manual',
      scheduledFor: null,
      scheduleVersion: null,
      skippedIntervals: 0,
    },
  });
  expect(
    (await write('POST', `${base}/${value.id}/pause`, change(value.version)))
      .statusCode,
  ).toBe(200);
  value = await read(value.id);
  expect(value.status).toBe('paused');
  const history = (await get(`${base}/${value.id}/runs`)).json().runs;
  expect(history[0]).toMatchObject({
    version: 2,
    status: 'cancelled',
    cancelReason: 'responsibility-paused',
  });
  expect(
    (await write('POST', `${base}/${value.id}/runs`, request)).json(),
  ).toEqual(run.json());
  value = await resume(value);
  expect((await get(`${base}/${value.id}/runs`)).json().runs[0].status).toBe(
    'cancelled',
  );
  await manual(value);
  expect(
    (await write('POST', `${base}/${value.id}/cancel`, change(value.version)))
      .statusCode,
  ).toBe(200);
  value = await read(value.id);
  expect(
    (await write('POST', `${base}/${value.id}/resume`, change(value.version)))
      .statusCode,
  ).toBe(409);
  expect(
    (
      await write('PUT', `${base}/${value.id}`, {
        ...input(),
        expectedVersion: value.version,
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (await write('DELETE', `${base}/${value.id}`, change(value.version)))
      .statusCode,
  ).toBe(200);
  value = await read(value.id);
  expect(value).toMatchObject({
    status: 'cancelled',
    deletedAt: expect.any(String),
    goal: 'Synthetic private review goal',
  });
  expect((await get()).json().responsibilities).toEqual([]);
  expect(
    (await get(`${base}?deleted=true`)).json().responsibilities,
  ).toHaveLength(1);
  expect(
    (await write('POST', `${base}/${value.id}/restore`, change(value.version)))
      .statusCode,
  ).toBe(404);
});
it('previews due schedules read-only and admits one-time reviews once with versioned historical retries', async () => {
  const value = await resume(await create());
  const saved = await scheduled(value);
  const before = await db.query(
    'SELECT * FROM mutation_receipts WHERE owner_id=$1',
    [owner],
  );
  const due = responsibilityDuePageSchema.parse(
    (await get(`${base}/due`)).json(),
  );
  expect(due).toMatchObject({
    dueCount: 1,
    executionEnabled: false,
    items: [{ id: value.id, version: saved.value.version, scheduleVersion: 1 }],
  });
  expect(
    await db.query('SELECT * FROM mutation_receipts WHERE owner_id=$1', [
      owner,
    ]),
  ).toEqual(before);
  const operationId = randomUUID();
  const results = await Promise.all(
    [1, 2].map(() => admit(saved.value, 1, operationId)),
  );
  expect(results[0]!.statusCode).toBe(200);
  expect(results[1]!.json()).toEqual(results[0]!.json());
  expect(results[0]!.json()).toMatchObject({
    executionEnabled: false,
    runs: [
      {
        status: 'blocked',
        trigger: 'schedule',
        scheduleVersion: 1,
        scheduledFor: saved.schedule.nextDueAt,
      },
    ],
  });
  expect(
    (await get(`${base}/${value.id}/schedule`)).json().schedule,
  ).toMatchObject({ version: 2, nextDueAt: null, deletedAt: null });
  expect((await get(`${base}/due`)).json().dueCount).toBe(0);
  expect((await admit(saved.value, 1)).statusCode).toBe(409);
  expect((await admit(saved.value, 1, operationId)).json()).toEqual(
    results[0]!.json(),
  );
  expect(await db.query('SELECT id FROM responsibility_runs')).toHaveLength(1);
  for (const table of [
    'ai_requests',
    'ai_attempts',
    'email_attempts',
    'tasks',
    'events',
  ])
    expect(
      await db.query(`SELECT id FROM ${table} WHERE owner_id=$1`, [owner]),
    ).toEqual([]);
});
it('coalesces missed UTC intervals without backlog fan-out or local-time promises', async () => {
  const value = await resume(await create());
  const startsAt = new Date(Date.now() - 85 * 60000).toISOString();
  const saved = await scheduled(value, startsAt, 15);
  const response = await admit(saved.value, 1);
  expect(response.statusCode).toBe(200);
  expect(response.json().runs).toHaveLength(1);
  expect(response.json().runs[0]).toMatchObject({
    scheduledFor: startsAt,
    skippedIntervals: 5,
    status: 'blocked',
  });
  const next = (await get(`${base}/${value.id}/schedule`)).json().schedule
    .nextDueAt;
  expect(Date.parse(next)).toBe(Date.parse(startsAt) + 90 * 60000);
  expect(Date.parse(next)).toBeGreaterThan(Date.now());
  expect((await get(`${base}/due`)).json().dueCount).toBe(0);
  for (const schedule of [
    { startsAt, intervalMinutes: 14 },
    { startsAt, intervalMinutes: 10081 },
    { startsAt, intervalMinutes: 15, timeZone: 'America/Denver' },
    { startsAt: 'not-a-time' },
  ])
    expect(
      (
        await write('PUT', `${base}/${value.id}/schedule`, {
          ...change(saved.value.version),
          schedule,
        })
      ).statusCode,
    ).toBe(400);
});
it('rolls back an entire selected due admission on future/foreign/stale selections', async () => {
  const a = await scheduled(await resume(await create()));
  const b = await scheduled(
    await resume(await create()),
    new Date(Date.now() + 3600000).toISOString(),
  );
  const request = {
    operationId: randomUUID(),
    items: [
      {
        id: a.value.id,
        expectedVersion: a.value.version,
        expectedScheduleVersion: 1,
      },
      {
        id: b.value.id,
        expectedVersion: b.value.version,
        expectedScheduleVersion: 1,
      },
    ],
  };
  expect((await write('POST', `${base}/admit-due`, request)).statusCode).toBe(
    409,
  );
  expect(await db.query('SELECT id FROM responsibility_runs')).toEqual([]);
  expect(
    (await get(`${base}/${a.value.id}/schedule`)).json().schedule.version,
  ).toBe(1);
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE operation_id=$1',
      [request.operationId],
    ),
  ).toEqual([]);
  const missing = {
    ...request,
    items: [request.items[0]!, { ...request.items[1]!, id: randomUUID() }],
  };
  expect((await write('POST', `${base}/admit-due`, missing)).statusCode).toBe(
    404,
  );
  expect(
    (
      await write('POST', `${base}/admit-due`, {
        ...request,
        items: [request.items[0]!, request.items[0]!],
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await write('POST', `${base}/admit-due`, { ...request, items: [] }))
      .statusCode,
  ).toBe(400);
  const good = await admit(a.value, 1, request.operationId);
  expect(good.statusCode).toBe(200);
  expect((await write('POST', `${base}/admit-due`, request)).statusCode).toBe(
    409,
  );
});
it('serializes distinct due batches and opposing selection order without duplicate slots', async () => {
  const a = await scheduled(await resume(await create()));
  const b = await scheduled(await resume(await create()));
  const items = [a, b].map((saved) => ({
    id: saved.value.id,
    expectedVersion: saved.value.version,
    expectedScheduleVersion: 1,
  }));
  const results = await Promise.all(
    [items, [...items].reverse()].map((selected) =>
      write('POST', `${base}/admit-due`, {
        operationId: randomUUID(),
        items: selected,
      }),
    ),
  );
  expect(results.map((response) => response.statusCode).sort()).toEqual([
    200, 409,
  ]);
  expect(await db.query('SELECT id FROM responsibility_runs')).toHaveLength(2);
});
it('invalidates blocked runs on goal/label and schedule changes and retains cleared schedule history', async () => {
  let value = await resume(await create({ sensitivity: 'restricted' }));
  const run = await manual(value);
  expect(
    (
      await write('PUT', `${base}/${value.id}`, {
        ...input({ sensitivity: 'personal' }),
        expectedVersion: value.version,
      })
    ).statusCode,
  ).toBe(200);
  value = await read(value.id);
  expect(value.labels).toEqual(['restricted', 'personal']);
  expect(
    (await get(`${base}/${value.id}/runs/${run.id}`)).json().run,
  ).toMatchObject({
    status: 'cancelled',
    cancelReason: 'source-changed',
    labels: ['restricted'],
  });
  const saved = await scheduled(value);
  await admit(saved.value, 1);
  const cleared = await write('PUT', `${base}/${value.id}/schedule`, {
    ...change(saved.value.version),
    schedule: null,
  });
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json().schedule).toMatchObject({
    version: 3,
    nextDueAt: null,
    deletedAt: expect.any(String),
  });
  expect(
    (await get(`${base}/${value.id}/runs`))
      .json()
      .runs.every(
        (record: { status: string }) => record.status === 'cancelled',
      ),
  ).toBe(true);
  value = await read(value.id);
  const restored = await scheduled(value);
  expect(restored.schedule.version).toBe(4);
  expect(restored.schedule.nextDueAt).not.toBeNull();
  expect((await get(`${base}/due`)).json().dueCount).toBe(1);
});
it('does not re-admit an old schedule slot after clearing/replacing the schedule', async () => {
  const original = await scheduled(await resume(await create()));
  expect((await admit(original.value, 1)).statusCode).toBe(200);
  const cleared = await write('PUT', `${base}/${original.value.id}/schedule`, {
    ...change(original.value.version),
    schedule: null,
  });
  expect(cleared.statusCode).toBe(200);
  const replaced = await scheduled(
    await read(original.value.id),
    original.schedule.startsAt,
  );
  const duplicate = await admit(replaced.value, replaced.schedule.version);
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json().error.code).toBe('DUE_ALREADY_ADMITTED');
  expect(await db.query('SELECT id FROM responsibility_runs')).toHaveLength(1);
  const item = {
    id: replaced.value.id,
    expectedVersion: replaced.value.version,
    expectedScheduleVersion: replaced.schedule.version,
  };
  expect(
    (
      await write('POST', `${base}/admit-due`, {
        operationId: randomUUID(),
        items: [item, { ...item, id: item.id.toUpperCase() }],
      })
    ).statusCode,
  ).toBe(400);
});

it('dismisses a blocked run with its own version and exact retries never restore it', async () => {
  const value = await resume(await create());
  const run = await manual(value);
  const request = change(1);
  const results = await Promise.all(
    [1, 2].map(() =>
      write('POST', `${base}/${value.id}/runs/${run.id}/dismiss`, request),
    ),
  );
  expect(results[0]!.statusCode).toBe(200);
  expect(results[1]!.json()).toEqual(results[0]!.json());
  expect(results[0]!.json()).toMatchObject({
    executionEnabled: false,
    run: { status: 'cancelled', version: 2, cancelReason: 'owner-dismissed' },
  });
  expect(
    (
      await write(
        'POST',
        `${base}/${value.id}/runs/${run.id}/dismiss`,
        change(2),
      )
    ).statusCode,
  ).toBe(409);
  expect((await read(value.id)).version).toBe(value.version);
  expect(
    (await get(`${base}/${value.id}/activity`))
      .json()
      .activities.filter(
        (event: { kind: string }) => event.kind === 'run-dismissed',
      ),
  ).toHaveLength(1);
});
it('rolls back root changes/run cancellations/activity/receipts when an activity write fails', async () => {
  const value = await resume(await create());
  const run = await manual(value);
  const before = await db.query(
    'SELECT * FROM mutation_receipts WHERE owner_id=$1',
    [owner],
  );
  await db.exec(
    "CREATE FUNCTION reject_responsibility_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='runs-cancelled' THEN RAISE EXCEPTION 'Synthetic activity failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_responsibility_activity BEFORE INSERT ON responsibility_activities FOR EACH ROW EXECUTE FUNCTION reject_responsibility_activity();",
  );
  const request = change(value.version);
  expect(
    (await write('POST', `${base}/${value.id}/pause`, request)).statusCode,
  ).toBe(500);
  expect(await read(value.id)).toEqual(value);
  expect(
    (await get(`${base}/${value.id}/runs/${run.id}`)).json().run.status,
  ).toBe('blocked');
  expect(
    await db.query('SELECT * FROM mutation_receipts WHERE owner_id=$1', [
      owner,
    ]),
  ).toEqual(before);
  await db.exec(
    'DROP TRIGGER reject_responsibility_activity ON responsibility_activities; DROP FUNCTION reject_responsibility_activity();',
  );
  expect(
    (await write('POST', `${base}/${value.id}/pause`, request)).statusCode,
  ).toBe(200);
});
it('pages content-free responsibility/run/activity and due histories with owned version guards', async () => {
  const a = await scheduled(await resume(await create()));
  const b = await scheduled(await resume(await create()));
  const page = responsibilityPageSchema.parse(
    (await get(`${base}?limit=1`)).json(),
  );
  expect(page.nextAfter).not.toBeNull();
  expect(JSON.stringify(page)).not.toContain(a.value.goal);
  const due = responsibilityDuePageSchema.parse(
    (await get(`${base}/due?limit=1`)).json(),
  );
  expect(due.dueCount).toBe(2);
  const anchor = due.nextAfter!;
  const next = responsibilityDuePageSchema.parse(
    (
      await get(
        `${base}/due?limit=1&after=${anchor.id}&expectedCursorVersion=${anchor.version}&expectedScheduleVersion=${anchor.scheduleVersion}`,
      )
    ).json(),
  );
  expect(next.items).toHaveLength(1);
  expect(next.dueCount).toBe(2);
  expect(
    (
      await get(
        `${base}/due?after=${anchor.id}&expectedCursorVersion=${anchor.version}&expectedScheduleVersion=2`,
      )
    ).statusCode,
  ).toBe(409);
  const first = await manual(a.value);
  await manual(a.value);
  const runPage = responsibilityRunPageSchema.parse(
    (await get(`${base}/${a.value.id}/runs?limit=1`)).json(),
  );
  expect(runPage.nextAfter).not.toBeNull();
  expect(JSON.stringify(runPage)).not.toContain(a.value.goal);
  const runAnchor = runPage.nextAfter!;
  await write(
    'POST',
    `${base}/${a.value.id}/runs/${runAnchor.id}/dismiss`,
    change(1),
  );
  expect(
    (
      await get(
        `${base}/${a.value.id}/runs?after=${runAnchor.id}&expectedCursorVersion=1`,
      )
    ).statusCode,
  ).toBe(409);
  const events = responsibilityActivityPageSchema.parse(
    (await get(`${base}/${a.value.id}/activity?limit=1`)).json(),
  );
  expect(events.nextAfter).not.toBeNull();
  expect(
    (
      await get(
        `${base}/${a.value.id}/activity?limit=1&after=${events.nextAfter}`,
      )
    ).json().activities,
  ).toHaveLength(1);
  expect(
    (
      await get(
        `${base}/${b.value.id}/runs?after=${first.id}&expectedCursorVersion=1`,
      )
    ).statusCode,
  ).toBe(404);
  for (const url of [
    `${base}?limit=101`,
    `${base}/due?after=${anchor.id}`,
    `${base}/${a.value.id}/activity?limit=0`,
    `${base}/${a.value.id}/runs?after=${first.id}`,
  ])
    expect((await get(url)).statusCode).toBe(400);
});
it('isolates all reads/writes/export and enforces owned SQL relationships and revoked sessions', async () => {
  const value = await resume(await create());
  const saved = await scheduled(value);
  const run = await manual(saved.value);
  const foreign = await create({}, otherCookie);
  for (const suffix of [
    '',
    '/schedule',
    '/runs',
    `/runs/${run.id}`,
    '/activity',
  ])
    expect(
      (await get(`${base}/${value.id}${suffix}`, otherCookie)).statusCode,
    ).toBe(404);
  for (const path of [
    `${base}/${value.id}/resume`,
    `${base}/${value.id}/runs`,
    `${base}/${value.id}/runs/${run.id}/dismiss`,
  ])
    expect(
      (await write('POST', path, change(saved.value.version), otherCookie))
        .statusCode,
    ).toBe(404);
  expect(
    (
      await write(
        'PUT',
        `${base}/${value.id}/schedule`,
        { ...change(saved.value.version), schedule: null },
        otherCookie,
      )
    ).statusCode,
  ).toBe(404);
  const localInput = {
    ...change(saved.value.version),
    rule: {
      startDate: '2026-03-07',
      localTime: '09:00',
      timeZone: 'America/Denver',
      frequency: 'daily',
      interval: 1,
    },
  };
  expect(
    (
      await write(
        'PUT',
        `${base}/${value.id}/local-schedule`,
        localInput,
        otherCookie,
      )
    ).statusCode,
  ).toBe(404);
  expect(
    (await write('PUT', `${base}/${value.id}/local-schedule`, localInput, ''))
      .statusCode,
  ).toBe(401);
  expect((await admit(saved.value, 1)).statusCode).toBe(200);
  expect((await get(`${base}/due`, otherCookie)).json().items).toEqual([]);
  expect(
    (await get(base, otherCookie))
      .json()
      .responsibilities.map((record: { id: string }) => record.id),
  ).toEqual([foreign.id]);
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export', otherCookie)).json(),
  );
  expect(exported.records.responsibilities.map((record) => record.id)).toEqual([
    foreign.id,
  ]);
  expect(exported.records.responsibilityRuns).toEqual([]);
  await expect(
    db.query(
      'INSERT INTO responsibility_schedules(owner_id,responsibility_id,starts_at,next_due_at) VALUES($1,$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
      [other, value.id],
    ),
  ).rejects.toBeDefined();
  await expect(
    db.query(
      "INSERT INTO responsibility_activities(id,owner_id,responsibility_id,responsibility_version,kind,run_id) VALUES($1,$2,$3,1,'run-created',$4)",
      [randomUUID(), owner, value.id, randomUUID()],
    ),
  ).rejects.toBeDefined();
  await expect(
    db.query("UPDATE responsibility_runs SET status='cancelled' WHERE id=$1", [
      run.id,
    ]),
  ).rejects.toBeDefined();
  expect((await get(base, '')).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: base,
        headers: { ...headers(), origin: 'https://invalid.example.test' },
        payload: input(),
      })
    ).statusCode,
  ).toBe(403);
  await db.query(
    'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
    [owner],
  );
  expect((await get(`${base}/due`)).statusCode).toBe(401);
  expect(
    (
      await write(
        'POST',
        `${base}/${value.id}/pause`,
        change(saved.value.version),
      )
    ).statusCode,
  ).toBe(401);
});
it('upgrades populated storage through all three new migrations without changing private planner/memory receipts', async () => {
  const task = await write('POST', '/api/v1/tasks', {
    operationId: randomUUID(),
    title: 'Retained synthetic task',
  });
  expect(task.statusCode).toBe(200);
  const memory = await write('POST', '/api/v1/memory', {
    operationId: randomUUID(),
    kind: 'fact',
    title: 'Retained memory',
    content: 'Synthetic retained owner text',
  });
  expect(memory.statusCode).toBe(200);
  const before = await db.query(
    'SELECT * FROM mutation_receipts WHERE owner_id=$1',
    [owner],
  );
  // Later agent migrations reference these tables; reverse their additions in
  // this synthetic upgrade fixture before rebuilding the legacy schema.
  await db.exec(
    'DROP TABLE mail_broker_forwardings; DROP TABLE mail_broker_workflows; ALTER TABLE ai_conversation_turns DROP COLUMN mail_broker; DROP TABLE mail_broker_batches; DROP TABLE mail_broker_retrievals; DROP TABLE mail_broker_grants; ALTER TABLE ai_assistant_requests DROP COLUMN agent_id; ALTER TABLE notifications DROP CONSTRAINT notifications_source, DROP COLUMN run_id, DROP COLUMN conversation_id; ALTER TABLE ai_conversations DROP COLUMN responsibility_id; ALTER TABLE ai_conversation_turns DROP COLUMN trigger, DROP COLUMN not_allowed; DROP TABLE responsibility_activities; DROP TABLE responsibility_runs; DROP TABLE responsibility_schedules; DROP TABLE responsibilities; DROP FUNCTION hub_valid_local_times;',
  );
  await db.query(
    "DELETE FROM schema_migrations WHERE name IN ('034_responsibilities.sql','035_responsibility_schedules.sql','036_responsibility_runs.sql','037_responsibility_local_schedules.sql','057_persistent_agents.sql','058_agent_request_budget.sql','059_agent_run_visibility.sql','064_mail_broker.sql','065_mail_broker_selection_receipts.sql','066_mail_broker_workflows.sql')",
  );
  await migrate(db);
  expect(
    await db.query(
      'SELECT started_at,progress_at,progress_stage FROM responsibility_runs',
    ),
  ).toEqual([]);
  expect((await get(`/api/v1/tasks/${task.json().task.id}`)).json()).toEqual(
    task.json(),
  );
  expect(
    (await get(`/api/v1/memory/${memory.json().memory.id}`)).json().memory
      .content,
  ).toBe('Synthetic retained owner text');
  expect(
    await db.query('SELECT * FROM mutation_receipts WHERE owner_id=$1', [
      owner,
    ]),
  ).toEqual(before);
  const exported = (await get('/api/v1/planner/export')).json();
  for (const key of [
    'responsibilities',
    'responsibilitySchedules',
    'responsibilityRuns',
    'responsibilityActivities',
  ])
    delete exported.records[key];
  expect(plannerExportSchema.parse(exported).records.responsibilities).toEqual(
    [],
  );
  expect(await create()).toMatchObject({ status: 'paused', version: 1 });
});
it('persists blocked reviews, due-pointer advancement, lifecycle invalidation and historical admission receipts across restart', async () => {
  const root = resolve('.artifacts');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'responsibility-'));
  const persistent = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: path });
  let server: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    server = await buildApp({ logger: false }, { config: persistent });
    const setup = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persisted-responsibility@example.test',
        password: 'synthetic-persisted-responsibility',
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
      payload: input(),
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
      url: `${base}/${id}/schedule`,
      headers: h,
      payload: {
        ...change(2),
        schedule: {
          startsAt: new Date(Date.now() - 60000).toISOString(),
          intervalMinutes: null,
        },
      },
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
    await server.close();
    server = undefined;
    server = await buildApp({ logger: false }, { config: persistent });
    expect(
      (await server.inject({ url: `${base}/due`, headers: h })).json().dueCount,
    ).toBe(0);
    expect(
      (await server.inject({ url: `${base}/${id}/runs`, headers: h })).json()
        .runs,
    ).toHaveLength(1);
    await server.inject({
      method: 'POST',
      url: `${base}/${id}/pause`,
      headers: h,
      payload: change(3),
    });
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
    const exported = plannerExportSchema.parse(
      (
        await server.inject({ url: '/api/v1/planner/export', headers: h })
      ).json(),
    );
    expect(exported.records.responsibilityRuns).toHaveLength(1);
    expect(exported.records.responsibilityRuns[0]).toMatchObject({
      status: 'cancelled',
      version: 2,
      cancelReason: 'responsibility-paused',
    });
    expect(exported.records.responsibilitySchedules[0]!.nextDueAt).toBeNull();
  } finally {
    await server?.close();
    expect(dirname(path)).toBe(root);
    await rm(path, { recursive: true, force: true });
  }
});
