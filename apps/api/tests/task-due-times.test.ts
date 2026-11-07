import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  plannerExportSchema,
  taskAgendaResponseSchema,
  taskBatchResponseSchema,
  taskBrowseResponseSchema,
  taskResponseSchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
const headers = () => ({ origin, cookie });

async function create(fields: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    headers: headers(),
    payload: { title: 'Timed task', operationId: randomUUID(), ...fields },
  });
  expect(response.statusCode).toBe(200);
  return taskResponseSchema.parse(response.json()).task;
}

async function update(id: string, fields: Record<string, unknown>) {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/v1/tasks/${id}`,
    headers: headers(),
    payload: { title: 'Timed task', operationId: randomUUID(), ...fields },
  });
  expect(response.statusCode).toBe(200);
  return taskResponseSchema.parse(response.json()).task;
}

beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in timed task tests.');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'timed-tasks@example.test',
      password: 'synthetic-timed-task-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
});

afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app?.close();
});

it('keeps date-only compatibility and applies stale-client-safe timed updates', async () => {
  const operationId = randomUUID();
  const payload = {
    title: 'Timed task',
    dueDate: '2027-11-07',
    dueAt: '2027-11-07T06:30:00-00:00',
    dueTimeZone: 'America/New_York',
    operationId,
  };
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    headers: headers(),
    payload,
  });
  expect(first.statusCode).toBe(200);
  expect(taskResponseSchema.parse(first.json()).task).toMatchObject({
    dueDate: '2027-11-07',
    dueAt: '2027-11-07T06:30:00.000Z',
    dueTimeZone: 'America/New_York',
  });
  const retry = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    headers: headers(),
    payload,
  });
  expect(retry.json()).toEqual(first.json());

  const invalid = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    headers: headers(),
    payload: {
      title: 'Wrong date',
      dueDate: '2027-11-08',
      dueAt: '2027-11-07T06:30:00Z',
      dueTimeZone: 'America/New_York',
      operationId: randomUUID(),
    },
  });
  expect(invalid.statusCode).toBe(400);

  let task = taskResponseSchema.parse(first.json()).task;
  task = await update(task.id, {
    dueDate: task.dueDate,
    expectedVersion: task.version,
  });
  expect(task).toMatchObject({
    dueDate: '2027-11-07',
    dueAt: '2027-11-07T06:30:00.000Z',
    dueTimeZone: 'America/New_York',
  });

  task = await update(task.id, {
    dueAt: null,
    dueTimeZone: null,
    expectedVersion: task.version,
  });
  expect(task).toMatchObject({
    dueDate: '2027-11-07',
    dueAt: null,
    dueTimeZone: null,
  });

  task = await update(task.id, {
    dueDate: '2027-11-07',
    dueAt: '2027-11-07T05:30:00Z',
    dueTimeZone: 'America/New_York',
    expectedVersion: task.version,
  });
  task = await update(task.id, {
    completed: true,
    expectedVersion: task.version,
  });
  expect(task).toMatchObject({
    dueDate: '2027-11-07',
    dueAt: '2027-11-07T05:30:00.000Z',
    dueTimeZone: 'America/New_York',
    completed: true,
  });

  task = await update(task.id, {
    dueDate: '2027-11-08',
    completed: false,
    expectedVersion: task.version,
  });
  expect(task).toMatchObject({
    dueDate: '2027-11-08',
    dueAt: null,
    dueTimeZone: null,
  });

  const exported = plannerExportSchema.parse(
    (
      await app.inject({
        url: '/api/v1/planner/export',
        headers: { cookie },
      })
    ).json(),
  );
  expect(
    exported.records.tasks.find((value) => value.id === task.id),
  ).toMatchObject({
    dueDate: '2027-11-08',
    dueAt: null,
    dueTimeZone: null,
  });
});

it('preserves time for non-date batches and clears or replaces it for explicit deadline batches', async () => {
  let task = await create({
    dueDate: '2030-04-04',
    dueAt: '2030-04-04T15:00:00Z',
    dueTimeZone: 'UTC',
  });
  const run = async (changes: Record<string, unknown>) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/batch',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        items: [{ id: task.id, expectedVersion: task.version }],
        action: { kind: 'update', changes },
      },
    });
    expect(response.statusCode).toBe(200);
    task = taskBatchResponseSchema.parse(response.json()).tasks[0]!;
  };
  await run({ priority: 'high' });
  expect(task.dueAt).toBe('2030-04-04T15:00:00.000Z');
  await run({ dueDate: '2030-04-04' });
  expect(task.dueAt).toBe('2030-04-04T15:00:00.000Z');
  await run({ dueDate: '2030-04-05' });
  expect(task).toMatchObject({
    dueDate: '2030-04-05',
    dueAt: null,
    dueTimeZone: null,
  });
  await run({
    dueDate: '2030-04-05',
    dueAt: '2030-04-05T19:00:00Z',
    dueTimeZone: 'UTC',
  });
  expect(task.dueAt).toBe('2030-04-05T19:00:00.000Z');
  await run({ dueAt: null, dueTimeZone: null });
  expect(task).toMatchObject({
    dueDate: '2030-04-05',
    dueAt: null,
    dueTimeZone: null,
  });
});

it('orders timed tasks by instant inside the existing date buckets', async () => {
  await create({ dueDate: '2030-04-04' });
  await create({
    title: 'Late',
    dueDate: '2030-04-04',
    dueAt: '2030-04-04T20:00:00Z',
    dueTimeZone: 'UTC',
  });
  await create({
    title: 'Early',
    dueDate: '2030-04-04',
    dueAt: '2030-04-04T10:00:00Z',
    dueTimeZone: 'UTC',
  });
  const agenda = taskAgendaResponseSchema.parse(
    (
      await app.inject({
        url: '/api/v1/tasks/agenda?asOf=2030-04-04&to=2030-04-05&bucket=today',
        headers: { cookie },
      })
    ).json(),
  );
  expect(agenda.entries.map((entry) => entry.task.title)).toEqual([
    'Early',
    'Late',
    'Timed task',
  ]);
  const browse = taskBrowseResponseSchema.parse(
    (
      await app.inject({
        url: '/api/v1/tasks/browse?status=open&due=dated',
        headers: { cookie },
      })
    ).json(),
  );
  expect(browse.tasks.map((value) => value.title)).toEqual([
    'Early',
    'Late',
    'Timed task',
  ]);
});

it('enforces the migration pair and date constraints in storage', async () => {
  const owners = await db.query<{ id: string }>('SELECT id FROM users LIMIT 1');
  const owner = owners[0]?.id;
  expect(owner).toBeDefined();
  await expect(
    db.query(
      "INSERT INTO tasks(id,owner_id,title,due_date,due_at) VALUES($1,$2,'Bad pair','2030-04-04','2030-04-04T12:00:00Z')",
      [randomUUID(), owner!],
    ),
  ).rejects.toThrow();
  await expect(
    db.query(
      "INSERT INTO tasks(id,owner_id,title,due_at,due_time_zone) VALUES($1,$2,'Missing date','2030-04-04T12:00:00Z','UTC')",
      [randomUUID(), owner!],
    ),
  ).rejects.toThrow();
});
