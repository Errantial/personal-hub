import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { resolveAIContext } from '../src/features/ai-routing.js';

const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
const origin = 'http://127.0.0.1:5173';
let app: Awaited<ReturnType<typeof buildApp>>,
  db: Awaited<ReturnType<typeof openDatabase>>,
  cookie: string,
  owner: string,
  message: string;
const quote = 'Please submit the form by October 20. 📨';
const call = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  session = cookie,
) =>
  app.inject({
    method,
    url,
    headers: { origin, cookie: session },
    ...(payload ? { payload } : {}),
  });
const input = (extra: object = {}) => ({
  operationId: randomUUID(),
  expectedVersion: 1,
  title: 'Submit form',
  quote,
  ...extra,
});
const capture = (body = input(), id = message) =>
  call('POST', `/api/v1/email/messages/${id}/tasks`, body);
const task = async (id: string) =>
  (await call('GET', `/api/v1/tasks/${id}`)).json().task;
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await call(
    'POST',
    '/api/v1/auth/setup',
    {
      email: 'mail-tasks@example.test',
      password: 'synthetic-mail-tasks-password',
    },
    '',
  );
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  owner = setup.json().user.id;
  const created = await call('POST', '/api/v1/email/connectors', {
    operationId: randomUUID(),
    name: 'Synthetic Bridge',
    sensitivity: 'restricted',
  });
  const { token, connector } = created.json();
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/email/connector/batch',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          path: 'INBOX',
          role: null,
          uidValidity: '1',
          exists: 1,
          inWindow: 1,
          lastUid: 1,
          messages: [
            {
              uid: 1,
              textOrigin: 'message-body-v1',
              messageKey: `<${randomUUID()}@example.test>`,
              from: null,
              to: [],
              cc: [],
              subject: 'Synthetic request',
              sentAt: null,
              receivedAt: '2026-10-13T12:00:00.000Z',
              body: `Hello.\n${quote}\nThank you.`,
              bodyTruncated: true,
              attachmentCount: 1,
            },
          ],
        },
      })
    ).statusCode,
  ).toBe(200);
  const [row] = await db.query(
    'SELECT id FROM email_messages WHERE connector_id=$1',
    [connector.id],
  );
  message = String(row!.id);
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app.close();
});

it('captures exact text, inherited labels and confirmed date once with metadata-only retry receipts', async () => {
  const clientId = randomUUID();
  const body = input({
    dueDate: '2026-10-20',
    deadlineConfirmed: true,
    clientId,
  });
  const first = await capture(body);
  expect(first.statusCode).toBe(201);
  expect((await capture(body)).json()).toEqual(first.json());
  const saved = await task(first.json().taskId);
  expect(saved).toMatchObject({
    title: 'Submit form',
    sensitivity: 'restricted',
    dueDate: '2026-10-20',
    mailSource: {
      quote,
      messageId: message,
      messageVersion: 1,
      confirmedDueDate: '2026-10-20',
      labels: ['restricted'],
      provenance: 'owner-reviewed-mail-body',
    },
  });
  const [count] = await db.query(
    'SELECT count(*)::int AS n FROM mail_task_sources',
  );
  expect(count!.n).toBe(1);
  const [receipt] = await db.query(
    'SELECT result FROM mutation_receipts WHERE operation_id=$1',
    [body.operationId],
  );
  expect(JSON.stringify(receipt!.result)).not.toContain(quote);
  expect(JSON.stringify(receipt!.result)).not.toContain('Submit form');
  expect((await capture({ ...body, title: 'Different' })).statusCode).toBe(409);
  expect((await capture(input({ clientId }))).statusCode).toBe(409);
});
it('rejects unconfirmed dates, nonmatching quotes, stale and uncertified imports without partial tasks', async () => {
  expect((await capture(input({ dueDate: '2026-10-20' }))).statusCode).toBe(
    400,
  );
  expect(
    (await capture(input({ dueDate: '2026-02-30', deadlineConfirmed: true })))
      .statusCode,
  ).toBe(400);
  expect(
    (await capture(input({ quote: 'Attachment-only instruction' }))).json()
      .error.code,
  ).toBe('MAIL_QUOTE_MISMATCH');
  expect((await capture(input({ expectedVersion: 2 }))).json().error.code).toBe(
    'VERSION_CONFLICT',
  );
  await db.query('UPDATE email_messages SET text_origin=NULL WHERE id=$1', [
    message,
  ]);
  expect((await capture()).json().error.code).toBe('PROVENANCE_UNAVAILABLE');
  const [count] = await db.query('SELECT count(*)::int AS n FROM tasks');
  expect(count!.n).toBe(0);
});
it('preserves origin through edits, tombstones and restore; prohibits label lowering and AI selection', async () => {
  const made = (await capture()).json();
  let saved = await task(made.taskId);
  const edit = await call('PUT', `/api/v1/tasks/${saved.id}`, {
    operationId: randomUUID(),
    expectedVersion: saved.version,
    title: 'Edited',
    notes: '',
    dueDate: null,
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
  });
  expect(edit.statusCode).toBe(200);
  saved = edit.json().task;
  expect(saved.sensitivity).toBe('restricted');
  expect(saved.mailSource.quote).toBe(quote);
  await expect(
    db.transaction((tx) =>
      resolveAIContext(tx, owner, {
        kind: 'task',
        id: saved.id,
        expectedVersion: saved.version,
      }),
    ),
  ).rejects.toMatchObject({ code: 'PROVENANCE_UNAVAILABLE' });
  const removed = await call('DELETE', `/api/v1/tasks/${saved.id}`, {
    operationId: randomUUID(),
    expectedVersion: saved.version,
  });
  const restored = await call('POST', `/api/v1/tasks/${saved.id}/restore`, {
    operationId: randomUUID(),
    expectedVersion: removed.json().task.version,
  });
  expect(restored.statusCode).toBe(200);
  expect(restored.json().task.mailSource).toEqual(saved.mailSource);
  await expect(
    db.query('UPDATE mail_task_sources SET quote=$1 WHERE task_id=$2', [
      'Changed',
      saved.id,
    ]),
  ).rejects.toThrow('immutable');
  await expect(
    db.query('DELETE FROM mail_task_sources WHERE task_id=$1', [saved.id]),
  ).rejects.toThrow('immutable');
});
it('requires authorization for fresh writes and historical receipt replay', async () => {
  const body = input();
  expect((await capture(body)).statusCode).toBe(201);
  expect(
    (await call('POST', `/api/v1/email/messages/${message}/tasks`, body, ''))
      .statusCode,
  ).toBe(401);
  expect((await capture(input(), randomUUID())).statusCode).toBe(404);
  await db.query(
    "UPDATE sessions SET expires_at=CURRENT_TIMESTAMP - interval '1 day' WHERE owner_id=$1",
    [owner],
  );
  expect((await capture(body)).statusCode).toBe(401);
});
