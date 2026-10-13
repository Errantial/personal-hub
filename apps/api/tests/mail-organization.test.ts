import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { resolveAIContext } from '../src/features/ai-routing.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>,
  db: Awaited<ReturnType<typeof openDatabase>>,
  cookie: string,
  owner: string;
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
const write = (
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload: object,
) => call(method, url, { operationId: randomUUID(), ...payload });
const rules = async () => (await call('GET', '/api/v1/email/rules')).json();
const getMail = async (id: string) =>
  (await call('GET', `/api/v1/email/messages/${id}`)).json().message;
const reference = (record: { id: string; version: number }) => ({
  id: record.id,
  expectedVersion: record.version,
});
const preview = (records: { id: string; version: number }[]) =>
  call('POST', '/api/v1/email/rules/preview', {
    messages: records.map(reference),
  });
const apply = (
  records: { id: string; version: number }[],
  revision: number,
  operationId = randomUUID(),
) =>
  write('POST', '/api/v1/email/rules/apply', {
    messages: records.map(reference),
    expectedRevision: revision,
    operationId,
  });
async function rule(extra: object = {}) {
  const input = {
    name: 'Advisor rule',
    field: 'sender',
    match: 'ADVISOR@example.test',
    category: 'academic',
    enabled: true,
    expectedRevision: (await rules()).revision,
    ...extra,
  };
  const result = await write('POST', '/api/v1/email/rules', input);
  expect(result.statusCode).toBe(201);
  return { ...result.json(), input };
}
async function mail(subject = 'Synthetic message', label = 'restricted') {
  const created = await write('POST', '/api/v1/email/connectors', {
    name: 'Synthetic Bridge',
    sensitivity: label,
  });
  const { connector, token } = created.json();
  const payload = {
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
        from: { name: 'Advisor', address: 'advisor@example.test' },
        to: [],
        cc: [],
        subject,
        sentAt: null,
        receivedAt: '2026-10-13T12:00:00.000Z',
        body: 'SYNTHETIC_BODY_NOT_A_RECEIPT',
        bodyTruncated: false,
        attachmentCount: 0,
      },
    ],
  };
  const upload = () =>
    app.inject({
      method: 'POST',
      url: '/api/v1/email/connector/batch',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  expect((await upload()).statusCode).toBe(200);
  const [row] = await db.query(
    'SELECT id FROM email_messages WHERE connector_id=$1',
    [connector.id],
  );
  return { record: await getMail(String(row!.id)), upload, token };
}
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
      email: 'organization@example.test',
      password: 'synthetic-organization-password',
    },
    '',
  );
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app.close();
});

it('preserves manual categories, retries and privacy labels through connector refreshes', async () => {
  const value = await mail();
  const operationId = randomUUID();
  const input = {
    expectedVersion: 1,
    mode: 'owner',
    category: 'personal',
    operationId,
  };
  expect(
    (
      await write(
        'PUT',
        `/api/v1/email/messages/${value.record.id}/category`,
        input,
      )
    ).json(),
  ).toMatchObject({
    version: 2,
    category: 'personal',
    categorySource: 'owner',
  });
  expect(
    (
      await write(
        'PUT',
        `/api/v1/email/messages/${value.record.id}/category`,
        input,
      )
    ).json().version,
  ).toBe(2);
  expect(
    (
      await write('PUT', `/api/v1/email/messages/${value.record.id}/category`, {
        ...input,
        category: 'academic',
      })
    ).json().error.code,
  ).toBe('OPERATION_CONFLICT');
  expect((await value.upload()).statusCode).toBe(200);
  const current = await getMail(value.record.id);
  expect(current).toMatchObject({
    version: 2,
    category: 'personal',
    categorySource: 'owner',
    sensitivity: 'restricted',
    body: 'SYNTHETIC_BODY_NOT_A_RECEIPT',
  });
  const source = await resolveAIContext(
    db,
    owner,
    { kind: 'mail-message', id: current.id, expectedVersion: 2 },
    true,
  );
  expect(source.labels).toEqual(['restricted']);
  await expect(
    resolveAIContext(
      db,
      owner,
      { kind: 'mail-message', id: current.id, expectedVersion: 1 },
      true,
    ),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  expect(
    JSON.stringify(await db.query('SELECT result FROM mutation_receipts')),
  ).not.toContain(current.body);
});

it('uses the oldest enabled literal rule and captures its explanation without writing during preview', async () => {
  const value = await mail('News .* and updates');
  await rule({
    name: 'Disabled',
    field: 'subject',
    match: 'news',
    category: 'receipts',
    enabled: false,
  });
  const first = await rule({
    field: 'subject',
    match: '.*',
    category: 'newsletters',
  });
  await rule({ category: 'academic' });
  const before = await getMail(value.record.id);
  const result = await preview([value.record]);
  expect(result.statusCode).toBe(200);
  expect(result.json().decisions[0]).toMatchObject({
    category: 'newsletters',
    categoryRuleId: first.id,
    ruleVersion: 1,
    changed: true,
    protected: false,
  });
  expect(await getMail(value.record.id)).toEqual(before);
  const applied = await apply([value.record], result.json().revision);
  expect(applied.json().changed).toBe(1);
  expect(await getMail(value.record.id)).toMatchObject({
    version: 2,
    category: 'newsletters',
    sensitivity: 'restricted',
    categoryRuleCapture: { id: first.id, version: 1, match: '.*' },
  });
  const noRegex = await mail('News without the literal pattern');
  const check = await preview([noRegex.record]);
  expect(check.json().decisions[0].category).toBe('academic');
});

it('protects an explicit Uncategorized choice and lets the owner allow rules again', async () => {
  const value = await mail();
  await rule();
  await write('PUT', `/api/v1/email/messages/${value.record.id}/category`, {
    expectedVersion: 1,
    mode: 'owner',
    category: null,
  });
  const current = await getMail(value.record.id);
  const check = await preview([current]);
  expect(check.json().decisions[0]).toMatchObject({
    protected: true,
    category: null,
    changed: false,
  });
  expect((await apply([current], check.json().revision)).json().changed).toBe(
    0,
  );
  await write('PUT', `/api/v1/email/messages/${current.id}/category`, {
    expectedVersion: 2,
    mode: 'rules',
  });
  const cleared = await getMail(current.id),
    next = await preview([cleared]);
  expect((await apply([cleared], next.json().revision)).json().changed).toBe(1);
  expect((await getMail(current.id)).categorySource).toBe('rule');
});

it('rejects stale rules or message versions atomically before changing other selected messages', async () => {
  const first = await mail(),
    second = await mail();
  const saved = await rule();
  const check = await preview([first.record, second.record]);
  await write('PUT', `/api/v1/email/messages/${first.record.id}/category`, {
    expectedVersion: 1,
    mode: 'owner',
    category: 'personal',
  });
  expect(
    (await apply([first.record, second.record], check.json().revision)).json()
      .error.code,
  ).toBe('VERSION_CONFLICT');
  expect((await getMail(second.record.id)).category).toBeNull();
  const current = await getMail(first.record.id);
  expect(
    (
      await write('PUT', `/api/v1/email/rules/${saved.id}`, {
        ...saved.input,
        expectedRevision: saved.revision,
        expectedVersion: 1,
        category: 'receipts',
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await apply([current, second.record], check.json().revision)).json().error
      .code,
  ).toBe('VERSION_CONFLICT');
  expect((await getMail(second.record.id)).version).toBe(1);
});

it('deduplicates apply retries and retains captured rule text after edits and tombstones', async () => {
  const value = await mail(),
    saved = await rule();
  const check = await preview([value.record]);
  const operationId = randomUUID();
  expect(
    (await apply([value.record], check.json().revision, operationId)).json()
      .changed,
  ).toBe(1);
  expect(
    (await apply([value.record], check.json().revision, operationId)).json()
      .messages[0].version,
  ).toBe(2);
  const updated = await write('PUT', `/api/v1/email/rules/${saved.id}`, {
    ...saved.input,
    name: 'Changed rule',
    match: 'another@example.test',
    expectedVersion: 1,
    expectedRevision: saved.revision,
  });
  expect(updated.statusCode).toBe(200);
  const deleted = await write('DELETE', `/api/v1/email/rules/${saved.id}`, {
    expectedVersion: 2,
    expectedRevision: updated.json().revision,
  });
  expect(deleted.statusCode).toBe(200);
  expect((await getMail(value.record.id)).categoryRuleCapture).toMatchObject({
    name: 'Advisor rule',
    match: 'ADVISOR@example.test',
    version: 1,
  });
  expect(
    (
      await db.query('SELECT deleted_at,version FROM mail_rules WHERE id=$1', [
        saved.id,
      ])
    )[0],
  ).toMatchObject({ version: 3, deleted_at: expect.anything() });
  const current = await getMail(value.record.id),
    next = await preview([current]);
  expect(next.json().decisions[0]).toMatchObject({
    changed: true,
    category: null,
  });
  expect((await apply([current], next.json().revision)).json().changed).toBe(1);
  expect((await getMail(current.id)).categoryRuleCapture).toBeNull();
});

it('guards ownership, authentication, duplicate selections and metadata-only receipts', async () => {
  const value = await mail(),
    saved = await rule();
  const other = randomUUID(),
    token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-organization@example.test',
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
  expect(
    (
      await call(
        'POST',
        '/api/v1/email/rules/preview',
        { messages: [reference(value.record)] },
        `hub_session=${token}`,
      )
    ).statusCode,
  ).toBe(404);
  expect(
    (await call('GET', '/api/v1/email/rules', undefined, '')).statusCode,
  ).toBe(401);
  expect((await preview([value.record, value.record])).statusCode).toBe(400);
  expect(
    (
      await apply(
        [value.record, { id: randomUUID(), version: 1 }],
        saved.revision,
      )
    ).statusCode,
  ).toBe(404);
  expect((await getMail(value.record.id)).version).toBe(1);
  expect(
    JSON.stringify(await db.query('SELECT result FROM mutation_receipts')),
  ).not.toContain(saved.input.match);
  await expect(
    db.query(
      "UPDATE email_messages SET category_rule_capture='{}'::jsonb WHERE id=$1",
      [value.record.id],
    ),
  ).rejects.toThrow();
});

it('filters category pages with stable owned cursors, including protected Uncategorized', async () => {
  const first = await mail(),
    second = await mail(),
    third = await mail();
  for (const record of [first.record, second.record])
    await write('PUT', `/api/v1/email/messages/${record.id}/category`, {
      expectedVersion: 1,
      mode: 'owner',
      category: 'academic',
    });
  await write('PUT', `/api/v1/email/messages/${third.record.id}/category`, {
    expectedVersion: 1,
    mode: 'owner',
    category: null,
  });
  const one = (
    await call('GET', '/api/v1/email/messages?category=academic&limit=1')
  ).json();
  expect(one.messages).toHaveLength(1);
  const two = (
    await call(
      'GET',
      `/api/v1/email/messages?category=academic&limit=1&before=${one.nextBefore}`,
    )
  ).json();
  expect(two.messages).toHaveLength(1);
  expect(two.messages[0].id).not.toBe(one.messages[0].id);
  expect(two.nextBefore).toBeNull();
  const uncategorized = (
    await call('GET', '/api/v1/email/messages?category=uncategorized')
  ).json();
  expect(
    uncategorized.messages.map((record: { id: string }) => record.id),
  ).toEqual([third.record.id]);
  expect(
    (await call('GET', '/api/v1/email/messages?category=invalid')).statusCode,
  ).toBe(400);
});
