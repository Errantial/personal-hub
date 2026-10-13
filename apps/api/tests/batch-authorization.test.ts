import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import type { Database } from '../src/db/database.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
const network = vi.fn(() => {
  throw Error('Network forbidden');
});
let db: Database,
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  hash: string;
let gate: 'none' | 'before' | 'after-write' | 'after-receipt' = 'none';
let expiresAt: unknown;
const cases: {
  url: string;
  read: string;
  payload: object;
  initial: unknown;
  key: string;
}[] = [];
const headers = () => ({ origin, cookie });
const send = (value: (typeof cases)[number]) =>
  app.inject({
    method: 'POST',
    url: value.url,
    headers: headers(),
    payload: value.payload,
  });
beforeEach(() => vi.stubGlobal('fetch', network));
beforeAll(async () => {
  vi.stubGlobal('fetch', network);
  db = await openDatabase(config);
  const proxy: Database = {
    ...db,
    close: async () => {},
    async transaction(work) {
      if (gate === 'before') {
        gate = 'none';
        await db.query(
          "UPDATE sessions SET expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE token_hash=$1",
          [hash],
        );
      }
      return db.transaction(async (tx) => {
        let deny = false;
        return work({
          ...tx,
          async query<T extends Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ): Promise<T[]> {
            if (deny && sql.startsWith('SELECT u.id, u.email FROM sessions'))
              return [];
            const rows = await tx.query<T>(sql, params);
            if (
              gate === 'after-write' &&
              /^UPDATE (academic_work|events) SET/.test(sql) &&
              sql.includes('RETURNING')
            )
              deny = true;
            if (
              gate === 'after-receipt' &&
              sql.startsWith(
                'SELECT payload_hash, result FROM mutation_receipts',
              )
            )
              deny = true;
            return rows;
          },
        });
      });
    },
  };
  app = await buildApp({ logger: false }, { config, database: proxy });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'batch-auth@example.test',
      password: 'synthetic-batch-auth-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  hash = createHash('sha256').update(cookie.split('=')[1]!).digest('hex');
  expiresAt = (
    await db.query('SELECT expires_at FROM sessions WHERE token_hash=$1', [
      hash,
    ])
  )[0]!.expires_at;
  const course = await app.inject({
    method: 'POST',
    url: '/api/v1/courses',
    headers: headers(),
    payload: { operationId: randomUUID(), name: 'Synthetic auth class' },
  });
  const academic = await app.inject({
    method: 'POST',
    url: '/api/v1/academic-work',
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      courseId: course.json().course.id,
      title: 'Private batch work',
      notes: 'Private batch authorization text',
    },
  });
  const work = academic.json().work;
  cases.push({
    url: '/api/v1/academic-work/batch',
    read: `/api/v1/academic-work/${work.id}`,
    key: 'work',
    initial: work,
    payload: {
      operationId: randomUUID(),
      items: [{ id: work.id, expectedVersion: 1, expectedCourseVersion: 1 }],
      action: { kind: 'update', changes: { priority: 5 } },
    },
  });
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/calendar',
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      title: 'Private batch calendar',
      notes: 'Private batch authorization text',
      startsAt: '2030-04-04T09:00:00Z',
      endsAt: '2030-04-04T09:25:00Z',
      timeZone: 'UTC',
    },
  });
  const event = created.json().event;
  cases.push({
    url: '/api/v1/calendar/batch',
    read: `/api/v1/calendar/${event.id}`,
    key: 'event',
    initial: event,
    payload: {
      operationId: randomUUID(),
      items: [{ id: event.id, expectedVersion: 1 }],
      action: { kind: 'delete' },
    },
  });
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('rejects sessions that expire after initial authentication before entering either batch transaction', async () => {
  for (const value of cases) {
    gate = 'before';
    const response = await send(value);
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('Private batch authorization text');
    await db.query('UPDATE sessions SET expires_at=$2 WHERE token_hash=$1', [
      hash,
      expiresAt,
    ]);
    expect(
      (await app.inject({ url: value.read, headers: headers() })).json()[
        value.key
      ],
    ).toEqual(value.initial);
  }
});

it('rolls back both new batch changes when final authorization fails', async () => {
  gate = 'after-write';
  for (const value of cases) {
    const response = await send(value);
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('Private batch authorization text');
    expect(
      (await app.inject({ url: value.read, headers: headers() })).json()[
        value.key
      ],
    ).toEqual(value.initial);
    expect(
      await db.query(
        'SELECT operation_id FROM mutation_receipts WHERE operation_id=$1',
        [(value.payload as { operationId: string }).operationId],
      ),
    ).toEqual([]);
  }
  gate = 'none';
});

it('denies private historical receipts after authorization is lost while replaying either batch', async () => {
  const successful = [];
  for (const value of cases) {
    const response = await send(value);
    expect(response.statusCode).toBe(200);
    successful.push(response.json());
  }
  gate = 'after-receipt';
  for (const value of cases) {
    const response = await send(value);
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('Private batch authorization text');
  }
  gate = 'none';
  for (const [index, value] of cases.entries())
    expect((await send(value)).json()).toEqual(successful[index]);
});
