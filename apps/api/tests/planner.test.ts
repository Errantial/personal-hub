import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';

const origin = 'http://127.0.0.1:5173';
const credentials = {
  email: 'owner@example.test',
  password: 'synthetic-password-123',
};
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let database: Awaited<ReturnType<typeof openDatabase>>;
let ownerId: string;
let cookie: string;
function headers(session = cookie) {
  return { origin, cookie: session };
}
const eventInput = () => ({
  title: 'Study time',
  startsAt: '2026-11-01T09:00:00-07:00',
  endsAt: '2026-11-01T10:00:00-07:00',
  timeZone: 'America/Denver',
  operationId: randomUUID(),
});
beforeAll(async () => {
  database = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: credentials,
  });
  expect(response.statusCode).toBe(201);
  ownerId = response.json().user.id;
  cookie = String(response.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => {
  await app?.close();
});

describe('ownership and sessions', () => {
  it('stores password and session hashes, and closes owner enrollment', async () => {
    const [user] = await database.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [ownerId],
    );
    expect(user!.password_hash).toMatch(/^scrypt-v1:/);
    expect(user!.password_hash).not.toContain(credentials.password);
    const [session] = await database.query(
      'SELECT token_hash FROM sessions WHERE owner_id = $1',
      [ownerId],
    );
    expect(session!.token_hash).not.toBe(cookie.split('=')[1]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: { ...credentials, email: 'second@example.test' },
    });
    expect(response.statusCode).toBe(409);
    expect((await database.query('SELECT id FROM users')).length).toBe(1);
  });
  it('blocks anonymous planner access and cross-origin mutations', async () => {
    expect((await app.inject('/api/v1/tasks')).statusCode).toBe(401);
    expect((await app.inject('/api/v1/events')).statusCode).toBe(401);
    for (const rejectedOrigin of [
      undefined,
      'https://untrusted.example.test',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers: {
          cookie,
          ...(rejectedOrigin ? { origin: rejectedOrigin } : {}),
        },
        payload: { title: 'Blocked', operationId: randomUUID() },
      });
      expect(response.statusCode).toBe(403);
    }
  });
  it('does not reveal whether invalid login accounts exist', async () => {
    for (const email of [credentials.email, 'missing@example.test']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin },
        payload: { email, password: 'wrong-password' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
      });
    }
  });
  it('sets protected cookies, revokes logout, and rejects expired sessions', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin },
      payload: credentials,
    });
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    const session = setCookie.split(';')[0]!;
    expect(
      (await app.inject({ url: '/api/v1/tasks', headers: { cookie: session } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/logout',
          headers: headers(session),
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/v1/tasks', headers: { cookie: session } }))
        .statusCode,
    ).toBe(401);
    const expired = randomBytes(32).toString('hex');
    await database.query(
      'INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES ($1, $2, $3)',
      [
        createHash('sha256').update(expired).digest('hex'),
        ownerId,
        new Date(0),
      ],
    );
    expect(
      (
        await app.inject({
          url: '/api/v1/tasks',
          headers: { cookie: `hub_session=${expired}` },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('durable planner mutations', () => {
  it('retries concurrent creates without duplicating records and rejects changed operation payloads', async () => {
    const payload = {
      title: 'Retry-safe task',
      dueDate: '2026-11-01',
      sensitivity: 'personal',
      operationId: randomUUID(),
    };
    const create = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers: headers(),
        payload,
      });
    const [first, retry] = await Promise.all([create(), create()]);
    expect(first.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(first.json().task).toMatchObject({
      dueDate: '2026-11-01',
      sensitivity: 'personal',
      version: 1,
    });
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: headers(),
      payload: { ...payload, title: 'Changed' },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('OPERATION_CONFLICT');
    const records = await database.query(
      'SELECT id FROM tasks WHERE title = $1',
      [payload.title],
    );
    expect(records).toHaveLength(1);
  });
  it('preserves the newer edit on a version conflict and returns tombstones for retried deletes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: headers(),
      payload: { title: 'Original', operationId: randomUUID() },
    });
    const id = created.json().task.id as string;
    const update = {
      title: 'Newer edit',
      completed: true,
      expectedVersion: 1,
      operationId: randomUUID(),
    };
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers: headers(),
      payload: update,
    });
    expect(saved.json().task).toMatchObject({
      version: 2,
      title: 'Newer edit',
      completed: true,
    });
    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers: headers(),
      payload: { ...update, title: 'Stale edit', operationId: randomUUID() },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    const deletion = { expectedVersion: 2, operationId: randomUUID() };
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/${id}`,
      headers: headers(),
      payload: deletion,
    });
    expect(removed.json().task.deletedAt).not.toBeNull();
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/tasks/${id}`,
          headers: headers(),
          payload: deletion,
        })
      ).json(),
    ).toEqual(removed.json());
    const list = await app.inject({ url: '/api/v1/tasks', headers: headers() });
    expect(
      list.json().tasks.some((task: { id: string }) => task.id === id),
    ).toBe(false);
  });
  it('validates calendar dates, timezones, event ranges, and unexpected fields', async () => {
    for (const payload of [
      { title: 'Invalid date', dueDate: '2026-02-30' },
      { title: 'Invalid owner', ownerId: randomUUID() },
      { title: ' ' },
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/tasks',
            headers: headers(),
            payload: { ...payload, operationId: randomUUID() },
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const payload of [
      { ...eventInput(), endsAt: '2026-10-01T00:00:00Z' },
      { ...eventInput(), timeZone: 'Invalid/Zone' },
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/events',
            headers: headers(),
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
  });
  it('stores UTC instants with display timezone and versions event updates/deletes', async () => {
    const payload = eventInput();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: headers(),
      payload,
    });
    expect(created.statusCode).toBe(200);
    const event = created.json().event;
    expect(event).toMatchObject({
      startsAt: '2026-11-01T16:00:00.000Z',
      timeZone: 'America/Denver',
      version: 1,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/events',
          headers: headers(),
          payload,
        })
      ).json(),
    ).toEqual(created.json());
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/events/${event.id}`,
      headers: headers(),
      payload: {
        ...payload,
        operationId: randomUUID(),
        expectedVersion: 1,
        title: 'Revised study',
      },
    });
    expect(updated.json().event.version).toBe(2);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/events/${event.id}`,
          headers: headers(),
          payload: { expectedVersion: 1, operationId: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/events/${event.id}`,
          headers: headers(),
          payload: { expectedVersion: 2, operationId: randomUUID() },
        })
      ).json().event.deletedAt,
    ).not.toBeNull();
  });
  it('isolates lists and writes by owner for both record types', async () => {
    const secondId = randomUUID();
    const token = randomBytes(32).toString('hex');
    await database.query(
      'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
      [secondId, 'isolation@example.test', 'unused-test-hash'],
    );
    await database.query(
      'INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES ($1, $2, $3)',
      [
        createHash('sha256').update(token).digest('hex'),
        secondId,
        new Date(Date.now() + 60000),
      ],
    );
    const secondCookie = `hub_session=${token}`;
    for (const [kind, payload] of [
      ['tasks', { title: 'Owner-only task', operationId: randomUUID() }],
      ['events', eventInput()],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/${kind}`,
        headers: headers(),
        payload,
      });
      const item =
        kind === 'tasks' ? response.json().task : response.json().event;
      const list = await app.inject({
        url: `/api/v1/${kind}`,
        headers: headers(secondCookie),
      });
      expect(list.json()[kind]).toEqual([]);
      const attempt = await app.inject({
        method: 'DELETE',
        url: `/api/v1/${kind}/${item.id}`,
        headers: headers(secondCookie),
        payload: { operationId: randomUUID(), expectedVersion: 1 },
      });
      expect(attempt.statusCode).toBe(404);
      const write = await app.inject({
        method: 'PUT',
        url: `/api/v1/${kind}/${item.id}`,
        headers: headers(secondCookie),
        payload: { ...payload, operationId: randomUUID(), expectedVersion: 1 },
      });
      expect(write.statusCode).toBe(404);
    }
    expect(
      await database.query(
        'SELECT operation_id FROM mutation_receipts WHERE owner_id = $1',
        [secondId],
      ),
    ).toEqual([]);
  });
  it('reruns migrations without changing existing data', async () => {
    const before = await database.query(
      'SELECT id, title FROM tasks ORDER BY id',
    );
    await migrate(database);
    expect(
      await database.query('SELECT id, title FROM tasks ORDER BY id'),
    ).toEqual(before);
  });

  it('preserves explicit sensitivity labels when an update omits the label', async () => {
    for (const [kind, payload] of [
      ['tasks', { title: 'Labeled task', operationId: randomUUID() }],
      ['events', eventInput()],
    ] as const) {
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/${kind}`,
        headers: headers(),
        payload: { ...payload, sensitivity: 'restricted' },
      });
      const item =
        kind === 'tasks' ? created.json().task : created.json().event;
      const saved = await app.inject({
        method: 'PUT',
        url: `/api/v1/${kind}/${item.id}`,
        headers: headers(),
        payload: {
          ...payload,
          title: 'Still labeled',
          expectedVersion: 1,
          operationId: randomUUID(),
        },
      });
      expect(saved.statusCode).toBe(200);
      const updated = kind === 'tasks' ? saved.json().task : saved.json().event;
      expect(updated.sensitivity).toBe('restricted');
    }
  });
});

it('persists a planner item across closing and reopening the database', async () => {
  const root = resolve('.artifacts', 'persistence-tests');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'run-'));
  const persistentConfig = readConfig({
    NODE_ENV: 'test',
    PGLITE_DATA_DIR: directory,
  });
  let persistentApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    persistentApp = await buildApp(
      { logger: false },
      { config: persistentConfig },
    );
    const setup = await persistentApp.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: credentials,
    });
    const persistentCookie = String(setup.headers['set-cookie']).split(';')[0]!;
    const created = await persistentApp.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: headers(persistentCookie),
      payload: { title: 'Survives restart', operationId: randomUUID() },
    });
    expect(created.statusCode).toBe(200);
    await persistentApp.close();
    persistentApp = undefined;
    persistentApp = await buildApp(
      { logger: false },
      { config: persistentConfig },
    );
    const list = await persistentApp.inject({
      url: '/api/v1/tasks',
      headers: headers(persistentCookie),
    });
    expect(list.json().tasks[0].title).toBe('Survives restart');
  } finally {
    await persistentApp?.close();
    if (dirname(resolve(directory)) === root)
      await rm(directory, { recursive: true, force: true });
  }
});

it('requires production HTTPS/PostgreSQL and gates enrollment with a server token', async () => {
  expect(() => readConfig({ NODE_ENV: 'production' })).toThrow(
    'Invalid environment',
  );
  const setupToken = 'synthetic-setup-token-for-tests-12345';
  const productionConfig = readConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://synthetic.invalid/test',
    WEB_ORIGINS: 'https://hub.example.test',
    SETUP_TOKEN: setupToken,
  });
  const productionDb = await openDatabase(config);
  const productionApp = await buildApp(
    { logger: false },
    { config: productionConfig, database: productionDb },
  );
  try {
    const rejected = await productionApp.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin: 'https://hub.example.test' },
      payload: credentials,
    });
    expect(rejected.statusCode).toBe(403);
    const allowed = await productionApp.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin: 'https://hub.example.test' },
      payload: { ...credentials, setupToken },
    });
    expect(allowed.statusCode).toBe(201);
    expect(allowed.headers['set-cookie']).toContain('Secure');
  } finally {
    await productionApp.close();
  }
});
