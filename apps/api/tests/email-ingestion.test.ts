import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let database: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;

const owner = (method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET',
    url,
    headers: { origin, cookie },
    ...(payload ? { payload: { operationId: randomUUID(), ...payload } } : {}),
  });
const connector = (
  token: string,
  method: 'GET' | 'POST',
  path: string,
  payload?: object,
) =>
  app.inject({
    method,
    url: `/api/v1/email/connector/${path}`,
    // No Origin header: the connector is not a browser.
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });
const message = (uid: number, key: string, extra: object = {}) => ({
  uid,
  messageKey: key,
  from: { name: 'Advisor', address: 'advisor@example.test' },
  to: [{ name: null, address: 'owner@example.test' }],
  cc: [],
  subject: `Subject ${uid}`,
  sentAt: '2026-10-10T12:00:00.000Z',
  receivedAt: `2026-10-${String(10 + uid).padStart(2, '0')}T12:00:00.000Z`,
  body: `Body ${uid}`,
  bodyTruncated: false,
  attachmentCount: 0,
  ...extra,
});
const batch = (path: string, lastUid: number, messages: object[]) => ({
  path,
  role: path === 'INBOX' ? '\\Inbox' : null,
  uidValidity: '7',
  exists: 10,
  inWindow: 3,
  lastUid,
  messages,
});

beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden.');
    }),
  );
  database = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: { email: 'mail@example.test', password: 'synthetic-password' },
  });
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

it('creates a connector whose token is shown once and stored only as a hash', async () => {
  const created = await owner('POST', '/api/v1/email/connectors', {
    name: 'Desktop Bridge',
    sensitivity: 'personal',
  });
  expect(created.statusCode).toBe(201);
  const { token, connector: record } = created.json();
  const [stored] = await database.query(
    'SELECT token_hash FROM email_connectors WHERE id=$1',
    [record.id],
  );
  expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(
    JSON.stringify(
      await database.query('SELECT result FROM mutation_receipts'),
    ),
  ).not.toContain(token);
  expect(token).toMatch(/^hubc_/);
  expect(record).toMatchObject({ name: 'Desktop Bridge', folders: [] });
  const listed = await owner('GET', '/api/v1/email/connectors');
  expect(JSON.stringify(listed.json())).not.toContain(token);
  expect((await connector('wrong_token', 'GET', 'state')).statusCode).toBe(401);
  expect((await connector(token, 'GET', 'state')).json()).toEqual({
    since: record.since,
    folders: [],
  });
  // Session cookies cannot use connector routes, and tokens cannot read mail.
  expect((await owner('GET', '/api/v1/email/connector/state')).statusCode).toBe(
    401,
  );
  expect(
    (
      await app.inject({
        url: '/api/v1/email/messages',
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(401);
});

it('stores messages once across folders and resumes from the stored position', async () => {
  const { token } = (
    await owner('POST', '/api/v1/email/connectors', {
      name: 'Bridge',
      sensitivity: 'personal',
    })
  ).json();
  const first = await connector(
    token,
    'POST',
    'batch',
    batch('INBOX', 2, [
      message(1, '<a@example.test>'),
      message(2, '<b@example.test>', { attachmentCount: 2 }),
    ]),
  );
  expect(first.json()).toEqual({ stored: 2, lastUid: 2 });
  await connector(
    token,
    'POST',
    'batch',
    batch('All Mail', 9, [message(9, '<a@example.test>')]),
  );
  // An older position never moves the folder backwards.
  expect(
    (await connector(token, 'POST', 'batch', batch('INBOX', 1, []))).json()
      .lastUid,
  ).toBe(2);
  expect((await connector(token, 'GET', 'state')).json().folders).toEqual([
    { path: 'All Mail', uidValidity: '7', lastUid: 9 },
    { path: 'INBOX', uidValidity: '7', lastUid: 2 },
  ]);
  // A new UIDVALIDITY restarts the folder.
  await connector(token, 'POST', 'batch', {
    ...batch('INBOX', 0, []),
    uidValidity: '8',
  });
  expect(
    (await connector(token, 'GET', 'state')).json().folders[1].lastUid,
  ).toBe(0);

  const page = (await owner('GET', '/api/v1/email/messages?limit=1')).json();
  expect(page.messages).toHaveLength(1);
  expect(page.messages[0]).toMatchObject({
    subject: 'Subject 2',
    snippet: 'Body 2',
    attachmentCount: 2,
    sensitivity: 'personal',
  });
  const next = (
    await owner(
      'GET',
      `/api/v1/email/messages?limit=1&before=${page.nextBefore}`,
    )
  ).json();
  expect(next.messages[0].folders).toEqual(['INBOX', 'All Mail']);
  expect(next.nextBefore).toBeNull();
  const inbox = (
    await owner('GET', '/api/v1/email/messages?folder=All%20Mail')
  ).json();
  expect(inbox.messages).toHaveLength(1);
  const detail = (
    await owner('GET', `/api/v1/email/messages/${next.messages[0].id}`)
  ).json().message;
  expect(detail).toMatchObject({
    body: 'Body 1',
    to: [{ name: null, address: 'owner@example.test' }],
  });
  const folders = (await owner('GET', '/api/v1/email/connectors')).json()
    .connectors[0].folders;
  expect(
    folders.find((f: { path: string }) => f.path === 'INBOX'),
  ).toMatchObject({ exists: 10, inWindow: 3, imported: 2 });
});

it('rejects oversized bodies and revoked tokens', async () => {
  const created = (
    await owner('POST', '/api/v1/email/connectors', {
      name: 'Bridge',
      sensitivity: 'unlabeled',
    })
  ).json();
  expect(
    (
      await connector(
        created.token,
        'POST',
        'batch',
        batch('INBOX', 1, [
          message(1, '<big@example.test>', { body: 'x'.repeat(32001) }),
        ]),
      )
    ).statusCode,
  ).toBe(400);
  const revoked = await owner(
    'POST',
    `/api/v1/email/connectors/${created.connector.id}/revoke`,
    { expectedVersion: 1 },
  );
  expect(revoked.json().connectors[0].revokedAt).not.toBeNull();
  expect((await connector(created.token, 'GET', 'state')).statusCode).toBe(401);
  expect(
    (
      await owner(
        'POST',
        `/api/v1/email/connectors/${created.connector.id}/revoke`,
        { expectedVersion: 1 },
      )
    ).json().error.code,
  ).toBe('VERSION_CONFLICT');
});

it('keeps connector retries duplicate-safe without storing the one-time token in a receipt', async () => {
  const input = {
    operationId: randomUUID(),
    name: 'Retry Bridge',
    sensitivity: 'personal',
  };
  const first = await owner('POST', '/api/v1/email/connectors', input);
  expect(first.statusCode).toBe(201);
  const repeated = await owner('POST', '/api/v1/email/connectors', input);
  expect(repeated.statusCode).toBe(409);
  expect(repeated.json().error.code).toBe('TOKEN_ALREADY_ISSUED');
  expect(
    (await owner('GET', '/api/v1/email/connectors')).json().connectors,
  ).toHaveLength(1);
  expect(
    (
      await owner('POST', '/api/v1/email/connectors', {
        ...input,
        name: 'Changed',
      })
    ).json().error.code,
  ).toBe('OPERATION_CONFLICT');
  const { connector: record, token } = first.json();
  const revoke = { operationId: randomUUID(), expectedVersion: 1 };
  const path = `/api/v1/email/connectors/${record.id}/revoke`;
  expect((await owner('POST', path, revoke)).statusCode).toBe(200);
  expect((await owner('POST', path, revoke)).statusCode).toBe(200);
  expect(
    (await owner('GET', '/api/v1/email/connectors')).json().connectors[0]
      .version,
  ).toBe(2);
  expect(
    (
      await connector(
        token,
        'POST',
        'batch',
        batch('INBOX', 1, [message(1, '<revoked@example.test>')]),
      )
    ).statusCode,
  ).toBe(401);
});
