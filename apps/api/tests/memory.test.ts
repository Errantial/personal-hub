import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  memoryResponseSchema,
  memoryMutationResponseSchema,
  memoryPageSchema,
  plannerExportSchema,
} from '@hub/contracts';
import type { Memory } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';

const base = '/api/v1/memory';
const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
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
const input = (fields: object = {}) => ({
  operationId: randomUUID(),
  kind: 'fact',
  title: 'Synthetic remembered fact',
  content: 'Synthetic owner-entered text',
  ...fields,
});
const change = (expectedVersion: number) => ({
  operationId: randomUUID(),
  expectedVersion,
});
async function create(fields: object = {}, session = cookie): Promise<Memory> {
  const response = await write('POST', base, input(fields), session);
  expect(response.statusCode).toBe(200);
  const { memory } = memoryMutationResponseSchema.parse(response.json());
  return memoryResponseSchema.parse(
    (await get(`${base}/${memory.id}`, session)).json(),
  ).memory;
}
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in memory tests.');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'memory-owner@example.test',
      password: 'synthetic-memory-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-memory@example.test',
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

it('stores explicit owned preferences/goals/facts and metadata-only receipts with strict content boundaries', async () => {
  expect((await get(`${base}/settings`)).json()).toEqual({
    version: 1,
    enabled: false,
  });
  for (const kind of ['preference', 'goal', 'fact']) {
    const value = await create({
      kind,
      title: '  Synthetic title  ',
      content: '  Synthetic body\nSecond line  ',
      observedOn: '2030-04-05',
    });
    expect(value).toMatchObject({
      kind,
      title: 'Synthetic title',
      content: 'Synthetic body\nSecond line',
      observedOn: '2030-04-05',
      source: 'owner-entered',
      labels: ['unlabeled'],
      enabled: true,
      version: 1,
    });
    expect(value.createdAt).toEqual(value.updatedAt);
  }
  for (const fields of [
    { title: ' ' },
    { content: ' ' },
    { content: 'x'.repeat(4001) },
    { title: 'x'.repeat(161) },
    { content: 'null\0' },
    { kind: 'attachment' },
    { observedOn: '2030-02-30' },
    { attachments: [] },
    { source: 'canvas' },
    { labels: ['restricted'] },
    { derivedFrom: [] },
    { provider: 'anything' },
    { deletedAt: '2030-01-01T00:00:00Z' },
  ])
    expect((await write('POST', base, input(fields))).statusCode).toBe(400);
  const receipts = await db.query(
    'SELECT result FROM mutation_receipts WHERE owner_id=$1',
    [owner],
  );
  expect(receipts).toHaveLength(3);
  for (const row of receipts)
    expect(
      Object.keys((row.result as { memory: object }).memory).sort(),
    ).toEqual(['deletedAt', 'id', 'version']);
  expect(JSON.stringify(receipts)).not.toContain('Synthetic body');
});

it('makes competing writes and retry identities atomic while accumulating all owner label history', async () => {
  const request = input({ sensitivity: 'restricted' });
  const created = await Promise.all(
    [1, 2].map(() => write('POST', base, request)),
  );
  expect(created[0]!.statusCode).toBe(200);
  expect(created[1]!.json()).toEqual(created[0]!.json());
  expect(
    (await write('POST', base, { ...request, content: 'Different' }))
      .statusCode,
  ).toBe(409);
  const id = created[0]!.json().memory.id;
  const save = {
    ...input({ sensitivity: 'personal', enabled: false }),
    expectedVersion: 1,
  };
  const saved = await Promise.all(
    [1, 2].map(() => write('PUT', `${base}/${id}`, save)),
  );
  expect(saved[0]!.statusCode).toBe(200);
  expect(saved[1]!.json()).toEqual(saved[0]!.json());
  expect((await get(`${base}/${id}`)).json().memory).toMatchObject({
    version: 2,
    sensitivity: 'personal',
    labels: ['restricted', 'personal'],
    enabled: false,
  });
  const competing = await Promise.all(
    ['unlabeled', 'restricted'].map((sensitivity) =>
      write('PUT', `${base}/${id}`, {
        ...input({ sensitivity }),
        expectedVersion: 2,
      }),
    ),
  );
  expect(competing.map((response) => response.statusCode).sort()).toEqual([
    200, 409,
  ]);
  const current = (await get(`${base}/${id}`)).json().memory as Memory;
  expect(current.labels).toEqual(
    expect.arrayContaining(['restricted', 'personal']),
  );
  const final = await write('PUT', `${base}/${id}`, {
    ...input({ sensitivity: 'unlabeled' }),
    expectedVersion: 3,
  });
  expect(final.statusCode).toBe(200);
  expect((await get(`${base}/${id}`)).json().memory.labels).toEqual(
    expect.arrayContaining(['restricted', 'personal', 'unlabeled']),
  );
  expect((await write('PUT', `${base}/${id}`, save)).json()).toEqual(
    saved[0]!.json(),
  );
  expect((await get(`${base}/${id}`)).json().memory.version).toBe(4);
});

it('forgets logical text/date copies and old successful create/update retries neither disclose nor restore them', async () => {
  const secretTitle = 'Synthetic forgotten title unique';
  const secretBody = 'Synthetic forgotten body unique';
  const request = input({
    title: secretTitle,
    content: secretBody,
    observedOn: '2031-05-06',
    sensitivity: 'restricted',
  });
  const created = await write('POST', base, request);
  const id = created.json().memory.id;
  const update = {
    ...input({
      title: secretTitle,
      content: secretBody,
      observedOn: '2031-06-07',
    }),
    expectedVersion: 1,
  };
  const saved = await write('PUT', `${base}/${id}`, update);
  expect(saved.statusCode).toBe(200);
  const forget = change(2);
  const forgotten = await Promise.all(
    [1, 2].map(() => write('DELETE', `${base}/${id}`, forget)),
  );
  expect(forgotten[0]!.statusCode).toBe(200);
  expect(forgotten[1]!.json()).toEqual(forgotten[0]!.json());
  expect((await get(`${base}/${id}`)).json().memory).toMatchObject({
    version: 3,
    title: null,
    content: null,
    observedOn: null,
    enabled: false,
    deletedAt: expect.any(String),
    labels: ['restricted', 'unlabeled'],
  });
  expect((await get()).json().memories).toEqual([]);
  expect(
    (await get(`${base}?state=forgotten`)).json().memories[0].title,
  ).toBeNull();
  expect((await write('POST', base, request)).json()).toEqual(created.json());
  expect((await write('PUT', `${base}/${id}`, update)).json()).toEqual(
    saved.json(),
  );
  expect(
    (
      await write('PUT', `${base}/${id}`, { ...input(), expectedVersion: 3 })
    ).json().error.code,
  ).toBe('MEMORY_FORGOTTEN');
  expect(
    (await write('DELETE', `${base}/${id}`, change(3))).json().error.code,
  ).toBe('MEMORY_FORGOTTEN');
  expect(
    (await write('POST', `${base}/${id}/restore`, change(3))).statusCode,
  ).toBe(404);
  const exported = (await get('/api/v1/planner/export')).json();
  const raw = await db.query(
    'SELECT title,content,observed_on FROM memories WHERE id=$1',
    [id],
  );
  const receipts = await db.query(
    'SELECT result FROM mutation_receipts WHERE owner_id=$1',
    [owner],
  );
  for (const retained of [exported, raw, receipts]) {
    expect(JSON.stringify(retained)).not.toContain(secretTitle);
    expect(JSON.stringify(retained)).not.toContain(secretBody);
  }
  expect(
    await create({ title: secretTitle, content: secretBody }),
  ).toMatchObject({ version: 1, deletedAt: null });
  expect((await get(`${base}/${id}`)).json().memory.content).toBeNull();
});

it('versions global disable independently and never creates retrieval, AI requests or execution', async () => {
  const value = await create({ enabled: false });
  const settings = { ...change(1), enabled: true };
  const saved = await Promise.all(
    [1, 2].map(() => write('PUT', `${base}/settings`, settings)),
  );
  expect(saved[0]!.json()).toEqual({ version: 2, enabled: true });
  expect(saved[1]!.json()).toEqual(saved[0]!.json());
  expect(
    (await write('PUT', `${base}/settings`, { ...change(1), enabled: false }))
      .statusCode,
  ).toBe(409);
  expect(
    (
      await write('PUT', `${base}/settings`, { ...change(2), enabled: false })
    ).json(),
  ).toEqual({ version: 3, enabled: false });
  expect((await write('PUT', `${base}/settings`, settings)).json()).toEqual({
    version: 2,
    enabled: true,
  });
  expect((await get(`${base}/settings`)).json()).toEqual({
    version: 3,
    enabled: false,
  });
  expect((await get(`${base}/${value.id}`)).json().memory.enabled).toBe(false);
  expect((await get(`${base}?state=disabled`)).json().memories).toHaveLength(1);
  const routing = await write('POST', '/api/v1/ai/routing/preview', {
    refs: [{ kind: 'memory', id: value.id, expectedVersion: 1 }],
    text: 'Synthetic',
    sensitivity: 'unlabeled',
    providers: [],
  });
  expect(routing.statusCode).toBe(400);
  for (const table of [
    'ai_requests',
    'ai_preflights',
    'ai_attempts',
    'email_attempts',
  ])
    expect(
      await db.query(`SELECT id FROM ${table} WHERE owner_id=$1`, [owner]),
    ).toEqual([]);
});

it('returns bounded content-free pages, independent state counts, literal search and guarded owned cursors', async () => {
  const first = await create({ title: 'Literal %_ marker', kind: 'goal' });
  const disabled = await create({
    enabled: false,
    kind: 'goal',
    sensitivity: 'personal',
  });
  const forgotten = await create({ kind: 'preference' });
  await write('DELETE', `${base}/${forgotten.id}`, change(1));
  const page = memoryPageSchema.parse(
    (await get(`${base}?state=all&limit=1`)).json(),
  );
  expect(page.counts).toEqual({ active: 1, disabled: 1, forgotten: 1 });
  expect(page.memories).toHaveLength(1);
  expect(JSON.stringify(page)).not.toContain('Synthetic owner-entered text');
  expect(page.settings).toEqual({ version: 1, enabled: false });
  const anchor = page.nextAfter!;
  const next = memoryPageSchema.parse(
    (
      await get(
        `${base}?state=all&limit=1&after=${anchor.id}&expectedCursorVersion=${anchor.version}`,
      )
    ).json(),
  );
  expect(next.memories[0]!.id).not.toBe(anchor.id);
  expect(next.counts).toEqual(page.counts);
  expect(
    (await get(`${base}?q=${encodeURIComponent('%_')}`))
      .json()
      .memories.map((entry: { id: string }) => entry.id),
  ).toEqual([first.id]);
  expect(
    (await get(`${base}?q=OWNER-ENTERED&kind=goal&state=all`)).json().counts,
  ).toEqual({ active: 1, disabled: 1, forgotten: 0 });
  expect(
    (await get(`${base}?sensitivity=personal&state=all`))
      .json()
      .memories.map((entry: { id: string }) => entry.id),
  ).toEqual([disabled.id]);
  const anchorMemory = (await get(`${base}/${anchor.id}`)).json()
    .memory as Memory;
  if (!anchorMemory.deletedAt)
    await write('PUT', `${base}/${anchor.id}`, {
      ...input({ kind: anchorMemory.kind }),
      expectedVersion: anchorMemory.version,
    });
  else {
    // Forgotten tombstones are immutable; test version guard with a live cursor separately.
    await write('PUT', `${base}/${first.id}`, {
      ...input({ kind: 'goal' }),
      expectedVersion: 1,
    });
  }
  const cursorId = anchorMemory.deletedAt ? first.id : anchor.id;
  expect(
    (await get(`${base}?state=all&after=${cursorId}&expectedCursorVersion=1`))
      .statusCode,
  ).toBe(409);
  expect(
    (await get(`${base}?after=${forgotten.id}&expectedCursorVersion=2`))
      .statusCode,
  ).toBe(404);
  for (const query of [
    'limit=101',
    'limit=0',
    `after=${randomUUID()}`,
    'expectedCursorVersion=1',
    'q=',
    'state=other',
    'unexpected=yes',
  ])
    expect((await get(`${base}?${query}`)).statusCode).toBe(400);
});

it('isolates every private route/export and rejects revoked sessions and invalid origin writes', async () => {
  const value = await create();
  const foreign = await create({ title: 'Other owned memory' }, otherCookie);
  expect(
    (await get(base, otherCookie))
      .json()
      .memories.map((entry: { id: string }) => entry.id),
  ).toEqual([foreign.id]);
  expect((await get(`${base}/${value.id}`, otherCookie)).statusCode).toBe(404);
  for (const [method, payload] of [
    ['PUT', { ...input(), expectedVersion: 1 }],
    ['DELETE', change(1)],
  ] as const)
    expect(
      (await write(method, `${base}/${value.id}`, payload, otherCookie))
        .statusCode,
    ).toBe(404);
  expect(
    (
      await get(
        `${base}?after=${value.id}&expectedCursorVersion=1`,
        otherCookie,
      )
    ).statusCode,
  ).toBe(404);
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export', otherCookie)).json(),
  );
  expect(exported.records.memories.map((record) => record.id)).toEqual([
    foreign.id,
  ]);
  for (const path of [base, `${base}/settings`, `${base}/${value.id}`])
    expect((await get(path, '')).statusCode).toBe(401);
  expect((await write('POST', base, input(), '')).statusCode).toBe(401);
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
  expect((await get(base)).statusCode).toBe(401);
  expect(
    (await write('DELETE', `${base}/${value.id}`, change(1))).statusCode,
  ).toBe(401);
});

it('rolls back text clearing, tombstones and receipts when forgetting fails and enforces SQL states', async () => {
  const value = await create({ sensitivity: 'restricted' });
  const before = await db.query(
    'SELECT * FROM mutation_receipts WHERE owner_id=$1',
    [owner],
  );
  await db.exec(
    "CREATE FUNCTION reject_memory_forget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Synthetic forgetting failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_memory_forget BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION reject_memory_forget();",
  );
  const forget = change(1);
  expect(
    (await write('DELETE', `${base}/${value.id}`, forget)).statusCode,
  ).toBe(500);
  expect((await get(`${base}/${value.id}`)).json().memory).toEqual(value);
  expect(
    await db.query('SELECT * FROM mutation_receipts WHERE owner_id=$1', [
      owner,
    ]),
  ).toEqual(before);
  await db.exec(
    'DROP TRIGGER reject_memory_forget ON memories; DROP FUNCTION reject_memory_forget();',
  );
  for (const sql of [
    "UPDATE memories SET labels=ARRAY['personal'] WHERE id=$1",
    "UPDATE memories SET labels=ARRAY['restricted','restricted'] WHERE id=$1",
    'UPDATE memories SET title=NULL WHERE id=$1',
    'UPDATE memories SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1',
    "UPDATE memories SET source='attachment' WHERE id=$1",
  ])
    await expect(db.query(sql, [value.id])).rejects.toBeDefined();
  expect(
    (await write('DELETE', `${base}/${value.id}`, forget)).statusCode,
  ).toBe(200);
  await expect(
    db.query(
      "UPDATE memories SET content='Retained forbidden copy' WHERE id=$1",
      [value.id],
    ),
  ).rejects.toBeDefined();
});

it('upgrades populated storage without changing planner, draft, memory settings or retry receipts', async () => {
  const task = await write('POST', '/api/v1/tasks', {
    operationId: randomUUID(),
    title: 'Retained synthetic planner task',
  });
  expect(task.statusCode).toBe(200);
  const before = await db.query(
    'SELECT * FROM mutation_receipts WHERE owner_id=$1',
    [owner],
  );
  await db.exec('DROP TABLE memories; DROP TABLE memory_settings;');
  await db.query("DELETE FROM schema_migrations WHERE name='033_memory.sql'");
  await migrate(db);
  expect((await get(`/api/v1/tasks/${task.json().task.id}`)).json()).toEqual(
    task.json(),
  );
  expect(
    await db.query('SELECT * FROM mutation_receipts WHERE owner_id=$1', [
      owner,
    ]),
  ).toEqual(before);
  expect((await get(`${base}/settings`)).json()).toEqual({
    version: 1,
    enabled: false,
  });
  const exported = (await get('/api/v1/planner/export')).json();
  delete exported.records.memories;
  delete exported.records.memorySettings;
  expect(plannerExportSchema.parse(exported).records).toMatchObject({
    memories: [],
    memorySettings: null,
  });
  expect(await create()).toMatchObject({ version: 1, deletedAt: null });
});

it('preserves forgotten text removal and historical receipts after a persisted restart', async () => {
  const root = resolve('.artifacts');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'memory-'));
  const persistent = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: path });
  let server: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    server = await buildApp({ logger: false }, { config: persistent });
    const setup = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persisted-memory@example.test',
        password: 'synthetic-persisted-memory',
      },
    });
    const h = {
      origin,
      cookie: String(setup.headers['set-cookie']).split(';')[0]!,
    };
    const request = input({ content: 'Persisted synthetic forgotten text' });
    const created = await server.inject({
      method: 'POST',
      url: base,
      headers: h,
      payload: request,
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().memory.id;
    const settings = await server.inject({
      method: 'PUT',
      url: `${base}/settings`,
      headers: h,
      payload: { ...change(1), enabled: true },
    });
    const forgotten = await server.inject({
      method: 'DELETE',
      url: `${base}/${id}`,
      headers: h,
      payload: change(1),
    });
    expect(forgotten.statusCode).toBe(200);
    await server.close();
    server = undefined;
    server = await buildApp({ logger: false }, { config: persistent });
    expect(
      (
        await server.inject({
          method: 'POST',
          url: base,
          headers: h,
          payload: request,
        })
      ).json(),
    ).toEqual(created.json());
    expect(
      (await server.inject({ url: `${base}/settings`, headers: h })).json(),
    ).toEqual(settings.json());
    expect(
      (await server.inject({ url: `${base}/${id}`, headers: h })).json().memory,
    ).toMatchObject({ version: 2, title: null, content: null, enabled: false });
    const exported = plannerExportSchema.parse(
      (
        await server.inject({ url: '/api/v1/planner/export', headers: h })
      ).json(),
    );
    expect(exported.records.memories).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain(
      'Persisted synthetic forgotten text',
    );
  } finally {
    await server?.close();
    expect(dirname(path)).toBe(root);
    await rm(path, { recursive: true, force: true });
  }
});
