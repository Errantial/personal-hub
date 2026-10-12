import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  responsibilityInboxSchema,
  responsibilityAttentionSchema,
  plannerExportSchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
const base = '/api/v1/responsibilities',
  inbox = `${base}/runs/inbox`,
  batch = `${base}/runs/dismiss-batch`,
  attention = `${base}/attention`,
  origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>,
  db: Awaited<ReturnType<typeof openDatabase>>;
let owner: string, cookie: string, other: string, otherCookie: string;
const headers = (session = cookie) => ({ origin, cookie: session });
const get = (url: string, session = cookie) =>
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
async function parent(session = cookie) {
  const created = await write(
    'POST',
    base,
    {
      operationId: randomUUID(),
      title: 'Synthetic inbox review',
      goal: 'Synthetic private inbox goal',
      sensitivity: 'restricted',
    },
    session,
  );
  expect(created.statusCode).toBe(200);
  return created.json().responsibility as { id: string; version: number };
}
async function active(session = cookie) {
  const value = await parent(session);
  const response = await write(
    'POST',
    `${base}/${value.id}/resume`,
    change(1),
    session,
  );
  expect(response.statusCode).toBe(200);
  return response.json().responsibility as { id: string; version: number };
}
async function run(value: { id: string; version: number }, session = cookie) {
  const response = await write(
    'POST',
    `${base}/${value.id}/runs`,
    change(value.version),
    session,
  );
  expect(response.statusCode).toBe(200);
  return response.json().run as {
    id: string;
    version: number;
    responsibilityId: string;
  };
}
const dismiss = (
  items: { id: string; expectedVersion: number }[],
  operationId = randomUUID(),
  session = cookie,
) => write('POST', batch, { operationId, items }, session);
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in responsibility inbox tests.');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'review-inbox@example.test',
      password: 'synthetic-review-inbox-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-review-inbox@example.test',
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
it('shows full owned attention counts without changing reviews, receipts or delivery state', async () => {
  expect(
    responsibilityAttentionSchema.parse((await get(attention)).json()),
  ).toMatchObject({
    responsibilities: { active: 0, paused: 0, cancelled: 0, deleted: 0 },
    dueCount: 0,
    runs: { blocked: 0, cancelled: 0 },
    executionEnabled: false,
  });
  const a = await active();
  await run(a);
  await parent();
  const c = await active();
  await run(c);
  await write('POST', `${base}/${c.id}/cancel`, change(c.version));
  const d = await parent();
  await write('DELETE', `${base}/${d.id}`, change(1));
  const scheduled = await write('PUT', `${base}/${a.id}/schedule`, {
    ...change(a.version),
    schedule: {
      startsAt: new Date(Date.now() - 60000).toISOString(),
      intervalMinutes: null,
    },
  });
  expect(scheduled.statusCode).toBe(200);
  await run(scheduled.json().responsibility);
  await run(await active(otherCookie), otherCookie);
  const receipts = await db.query(
    'SELECT * FROM mutation_receipts WHERE owner_id=$1 ORDER BY operation_id',
    [owner],
  );
  const runs = await db.query(
    'SELECT * FROM responsibility_runs WHERE owner_id=$1 ORDER BY id',
    [owner],
  );
  expect(
    responsibilityAttentionSchema.parse((await get(attention)).json()),
  ).toMatchObject({
    responsibilities: { active: 1, paused: 1, cancelled: 1, deleted: 1 },
    dueCount: 1,
    runs: { blocked: 1, cancelled: 2 },
    executionEnabled: false,
  });
  expect(
    await db.query(
      'SELECT * FROM mutation_receipts WHERE owner_id=$1 ORDER BY operation_id',
      [owner],
    ),
  ).toEqual(receipts);
  expect(
    await db.query(
      'SELECT * FROM responsibility_runs WHERE owner_id=$1 ORDER BY id',
      [owner],
    ),
  ).toEqual(runs);
  for (const table of ['notifications', 'ai_requests', 'email_attempts'])
    expect(
      await db.query(`SELECT id FROM ${table} WHERE owner_id=$1`, [owner]),
    ).toEqual([]);
});
it('returns current source metadata and independent filtered totals without goal text', async () => {
  const a = await active();
  const first = await run(a);
  await run(a);
  await dismiss([{ id: first.id, expectedVersion: 1 }]);
  expect(
    (
      await write('PUT', `${base}/${a.id}`, {
        ...change(a.version),
        title: 'Changed current title',
        goal: 'Changed private goal',
        sensitivity: 'personal',
      })
    ).statusCode,
  ).toBe(200);
  const page = responsibilityInboxSchema.parse(
    (await get(`${inbox}?status=all&limit=1`)).json(),
  );
  expect(page.counts).toEqual({ blocked: 0, cancelled: 2 });
  expect(page.entries).toHaveLength(1);
  expect(page.entries[0]).toMatchObject({
    sourceChanged: true,
    current: {
      title: 'Changed current title',
      version: 3,
      labels: ['restricted', 'personal'],
    },
  });
  expect(page.entries[0]!.run.labels).toEqual(['restricted']);
  expect(JSON.stringify(page)).not.toContain('Synthetic private inbox goal');
  expect(JSON.stringify(page)).not.toContain('Changed private goal');
  const scheduled = await write('PUT', `${base}/${a.id}/schedule`, {
    ...change(3),
    schedule: {
      startsAt: new Date(Date.now() - 60000).toISOString(),
      intervalMinutes: null,
    },
  });
  expect(scheduled.statusCode).toBe(200);
  await write('POST', `${base}/admit-due`, {
    operationId: randomUUID(),
    items: [{ id: a.id, expectedVersion: 4, expectedScheduleVersion: 1 }],
  });
  const filtered = responsibilityInboxSchema.parse(
    (await get(`${inbox}?trigger=schedule&responsibilityId=${a.id}`)).json(),
  );
  expect(filtered.counts).toEqual({ blocked: 1, cancelled: 0 });
  expect(filtered.entries[0]!.sourceChanged).toBe(false);
  expect(
    (await get(`${inbox}?status=cancelled&responsibilityId=${a.id}`)).json()
      .counts,
  ).toEqual({ blocked: 1, cancelled: 2 });
});
it('pages newest first without losing microsecond timestamps and guards eligible cursor versions', async () => {
  const value = await active();
  const runs = await Promise.all([1, 2, 3].map(() => run(value)));
  for (let index = 0; index < runs.length; index++)
    await db.query(
      'UPDATE responsibility_runs SET created_at=$2::timestamptz WHERE id=$1',
      [runs[index]!.id, `2030-01-01T00:00:00.000${index + 1}00Z`],
    );
  const ids: string[] = [];
  let cursor: { id: string; version: number } | null = null;
  do {
    const page = responsibilityInboxSchema.parse(
      (
        await get(
          `${inbox}?status=all&limit=1${cursor ? `&after=${cursor.id}&expectedCursorVersion=${cursor.version}` : ''}`,
        )
      ).json(),
    );
    expect(page.counts).toEqual({ blocked: 3, cancelled: 0 });
    ids.push(...page.entries.map((entry) => entry.run.id));
    cursor = page.nextAfter;
  } while (cursor);
  expect(ids).toEqual([...runs].reverse().map((item) => item.id));
  const first = responsibilityInboxSchema.parse(
    (await get(`${inbox}?status=all&limit=1`)).json(),
  ).nextAfter!;
  await dismiss([{ id: first.id, expectedVersion: 1 }]);
  expect(
    (await get(`${inbox}?status=all&after=${first.id}&expectedCursorVersion=1`))
      .statusCode,
  ).toBe(409);
  expect(
    (await get(`${inbox}?after=${first.id}&expectedCursorVersion=2`))
      .statusCode,
  ).toBe(404);
  for (const query of [
    'limit=101',
    'limit=0',
    `after=${randomUUID()}`,
    'expectedCursorVersion=1',
    'status=running',
    'trigger=provider',
    'unexpected=1',
  ])
    expect((await get(`${inbox}?${query}`)).statusCode).toBe(400);
  expect((await get(`${attention}?now=2030`)).statusCode).toBe(400);
});
it('atomically dismisses explicit runs across parents and exact concurrent/historical retries never duplicate activity', async () => {
  const a = await active(),
    b = await active();
  const selected = [await run(a), await run(b), await run(a)];
  const items = selected.map((value) => ({ id: value.id, expectedVersion: 1 }));
  const operationId = randomUUID();
  const responses = await Promise.all(
    [1, 2].map(() => dismiss(items, operationId)),
  );
  expect(responses[0]!.statusCode).toBe(200);
  expect(responses[1]!.json()).toEqual(responses[0]!.json());
  expect(responses[0]!.json()).toMatchObject({ executionEnabled: false });
  expect(
    responses[0]!
      .json()
      .runs.every(
        (item: { status: string; version: number; cancelReason: string }) =>
          item.status === 'cancelled' &&
          item.version === 2 &&
          item.cancelReason === 'owner-dismissed',
      ),
  ).toBe(true);
  expect(
    await db.query(
      "SELECT id FROM responsibility_activities WHERE owner_id=$1 AND kind='run-dismissed'",
      [owner],
    ),
  ).toHaveLength(3);
  expect((await get(`${base}/${a.id}`)).json().responsibility.version).toBe(
    a.version,
  );
  const later = await run(a);
  expect((await dismiss(items, operationId)).json()).toEqual(
    responses[0]!.json(),
  );
  expect(
    (await get(inbox))
      .json()
      .entries.map((entry: { run: { id: string } }) => entry.run.id),
  ).toEqual([later.id]);
  expect((await dismiss(items, randomUUID())).statusCode).toBe(409);
  expect(
    (await dismiss([{ id: later.id, expectedVersion: 1 }], operationId))
      .statusCode,
  ).toBe(409);
});
it('rolls back all selected dismissals and receipts on stale/foreign/missing items or activity failure', async () => {
  const value = await active();
  const a = await run(value),
    b = await run(value);
  const before = await db.query(
    'SELECT * FROM mutation_receipts WHERE owner_id=$1 ORDER BY operation_id',
    [owner],
  );
  const operationId = randomUUID();
  expect(
    (
      await dismiss(
        [
          { id: a.id, expectedVersion: 1 },
          { id: b.id, expectedVersion: 2 },
        ],
        operationId,
      )
    ).statusCode,
  ).toBe(409);
  expect((await get(inbox)).json().counts.blocked).toBe(2);
  expect(
    await db.query(
      'SELECT * FROM mutation_receipts WHERE owner_id=$1 ORDER BY operation_id',
      [owner],
    ),
  ).toEqual(before);
  expect(
    (
      await dismiss([
        { id: a.id, expectedVersion: 1 },
        { id: randomUUID(), expectedVersion: 1 },
      ])
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await dismiss([
        { id: a.id, expectedVersion: 1 },
        { id: a.id.toUpperCase(), expectedVersion: 1 },
      ])
    ).statusCode,
  ).toBe(400);
  expect((await dismiss([])).statusCode).toBe(400);
  expect(
    (
      await dismiss(
        Array.from({ length: 51 }, () => ({
          id: randomUUID(),
          expectedVersion: 1,
        })),
      )
    ).statusCode,
  ).toBe(400);
  await db.exec(
    "CREATE FUNCTION reject_batch_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='run-dismissed' THEN RAISE EXCEPTION 'Synthetic activity failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_batch_activity BEFORE INSERT ON responsibility_activities FOR EACH ROW EXECUTE FUNCTION reject_batch_activity();",
  );
  expect(
    (
      await dismiss(
        [
          { id: a.id, expectedVersion: 1 },
          { id: b.id, expectedVersion: 1 },
        ],
        operationId,
      )
    ).statusCode,
  ).toBe(500);
  expect((await get(inbox)).json().counts.blocked).toBe(2);
  expect(
    await db.query(
      'SELECT * FROM mutation_receipts WHERE owner_id=$1 ORDER BY operation_id',
      [owner],
    ),
  ).toEqual(before);
  await db.exec(
    'DROP TRIGGER reject_batch_activity ON responsibility_activities; DROP FUNCTION reject_batch_activity();',
  );
  expect(
    (
      await dismiss(
        [
          { id: a.id, expectedVersion: 1 },
          { id: b.id, expectedVersion: 1 },
        ],
        operationId,
      )
    ).statusCode,
  ).toBe(200);
});
it('serializes overlapping batches and lifecycle races without overwriting a cancellation reason', async () => {
  const a = await active(),
    b = await active();
  const first = await run(a),
    second = await run(b);
  const items = [first, second].map((value) => ({
    id: value.id,
    expectedVersion: 1,
  }));
  const results = await Promise.all(
    [items, [...items].reverse()].map((selection) => dismiss(selection)),
  );
  expect(results.map((response) => response.statusCode).sort()).toEqual([
    200, 409,
  ]);
  const next = await run(a);
  const [dismissed, paused] = await Promise.all([
    dismiss([{ id: next.id, expectedVersion: 1 }]),
    write('POST', `${base}/${a.id}/pause`, change(a.version)),
  ]);
  expect(paused.statusCode).toBe(200);
  expect([200, 409]).toContain(dismissed.statusCode);
  const current = (await get(`${base}/${a.id}/runs/${next.id}`)).json().run;
  expect(current).toMatchObject({ status: 'cancelled', version: 2 });
  expect(current.cancelReason).toBe(
    dismissed.statusCode === 200 ? 'owner-dismissed' : 'responsibility-paused',
  );
});
it('scopes inbox/attention/batch/cursors to the owner and rejects expired/revoked sessions', async () => {
  const value = await active(),
    foreign = await active(otherCookie);
  const a = await run(value),
    otherRun = await run(foreign, otherCookie);
  expect(
    (await get(inbox, otherCookie))
      .json()
      .entries.map((entry: { run: { id: string } }) => entry.run.id),
  ).toEqual([otherRun.id]);
  expect((await get(attention, otherCookie)).json().runs).toEqual({
    blocked: 1,
    cancelled: 0,
  });
  expect(
    (await get(`${inbox}?responsibilityId=${value.id}`, otherCookie))
      .statusCode,
  ).toBe(404);
  expect(
    (await get(`${inbox}?after=${a.id}&expectedCursorVersion=1`, otherCookie))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await dismiss([
        { id: a.id, expectedVersion: 1 },
        { id: otherRun.id, expectedVersion: 1 },
      ])
    ).statusCode,
  ).toBe(404);
  expect((await get(inbox)).json().counts.blocked).toBe(1);
  for (const url of [inbox, attention])
    expect((await get(url, '')).statusCode).toBe(401);
  expect(
    (await dismiss([{ id: a.id, expectedVersion: 1 }], randomUUID(), ''))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: batch,
        headers: { ...headers(), origin: 'https://invalid.example.test' },
        payload: {
          operationId: randomUUID(),
          items: [{ id: a.id, expectedVersion: 1 }],
        },
      })
    ).statusCode,
  ).toBe(403);
  await db.query(
    'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
    [owner],
  );
  expect((await get(attention)).statusCode).toBe(401);
  expect((await dismiss([{ id: a.id, expectedVersion: 1 }])).statusCode).toBe(
    401,
  );
});
it('retains tombstone source inspection and selected dismissal history in export after persisted restart', async () => {
  const root = resolve('.artifacts');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'responsibility-inbox-'));
  const persistent = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: path });
  let server: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    server = await buildApp({ logger: false }, { config: persistent });
    const setup = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persisted-review-inbox@example.test',
        password: 'synthetic-persisted-review-inbox',
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
        title: 'Persisted inbox review',
        goal: 'Private persisted inbox goal',
      },
    });
    const id = created.json().responsibility.id;
    await server.inject({
      method: 'POST',
      url: `${base}/${id}/resume`,
      headers: h,
      payload: change(1),
    });
    const admitted = await server.inject({
      method: 'POST',
      url: `${base}/${id}/runs`,
      headers: h,
      payload: change(2),
    });
    const request = {
      operationId: randomUUID(),
      items: [{ id: admitted.json().run.id, expectedVersion: 1 }],
    };
    const dismissed = await server.inject({
      method: 'POST',
      url: batch,
      headers: h,
      payload: request,
    });
    expect(dismissed.statusCode).toBe(200);
    await server.inject({
      method: 'DELETE',
      url: `${base}/${id}`,
      headers: h,
      payload: change(2),
    });
    await server.close();
    server = undefined;
    server = await buildApp({ logger: false }, { config: persistent });
    expect(
      (
        await server.inject({
          method: 'POST',
          url: batch,
          headers: h,
          payload: request,
        })
      ).json(),
    ).toEqual(dismissed.json());
    const page = responsibilityInboxSchema.parse(
      (
        await server.inject({ url: `${inbox}?status=cancelled`, headers: h })
      ).json(),
    );
    expect(page.entries[0]).toMatchObject({
      sourceChanged: true,
      current: { deletedAt: expect.any(String) },
      run: { version: 2, cancelReason: 'owner-dismissed' },
    });
    expect(JSON.stringify(page)).not.toContain('Private persisted inbox goal');
    const exported = plannerExportSchema.parse(
      (
        await server.inject({ url: '/api/v1/planner/export', headers: h })
      ).json(),
    );
    expect(
      exported.records.responsibilityActivities.filter(
        (event) => event.kind === 'run-dismissed',
      ),
    ).toHaveLength(1);
    expect(exported.records.responsibilityRuns).toHaveLength(1);
  } finally {
    await server?.close();
    expect(dirname(path)).toBe(root);
    await rm(path, { recursive: true, force: true });
  }
});
