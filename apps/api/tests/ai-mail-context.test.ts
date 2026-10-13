import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { aiContextManifestSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { beginSyntheticAttempt } from '../src/ai/synthetic-execution.js';
import { executeSyntheticTextRequest } from '../src/ai/synthetic-text-execution.js';
import type { Database } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  AI_SECRET_TEST: 'synthetic-only',
  AI_PROVIDER_PROFILES: JSON.stringify([
    {
      alias: 'test',
      adapter: 'anthropic',
      model: 'synthetic-only',
      credentialEnv: 'AI_SECRET_TEST',
      enabled: true,
      maxInputCharacters: 48000,
      maxOutputTokens: 2000,
      pricing: {
        revision: 'synthetic-v1',
        validUntil: '2050-01-01T00:00:00.000Z',
        inputTokenLimit: 48000,
        inputMicrosPerMillionTokens: 1000000,
        outputMicrosPerMillionTokens: 1000000,
      },
      retentionDisclosure: {
        revision: 'synthetic-v1',
        summary: 'Synthetic test disclosure.',
      },
    },
  ]),
});
let app: Awaited<ReturnType<typeof buildApp>>,
  db: Awaited<ReturnType<typeof openDatabase>>;
let owner: string, cookie: string, otherCookie: string, registry: string;
const network = vi.fn(() => {
  throw new Error('Network forbidden');
});
beforeEach(() => vi.stubGlobal('fetch', network));
const write = (
  url: string,
  payload: object,
  session = cookie,
  method: 'POST' | 'PUT' = 'POST',
) => app.inject({ method, url, payload, headers: { origin, cookie: session } });
const get = (url: string) => app.inject({ url, headers: { origin, cookie } });
const text = 'Classify the selected message for local review.';
const input = (sources: unknown[]) => ({
  text,
  sensitivity: 'unlabeled',
  sources,
  expectedPolicyVersion: 2,
  expectedBudgetVersion: 2,
  expectedRegistryRevision: registry,
});
const ref = (message: { id: string; version: number }) => ({
  kind: 'mail-message',
  id: message.id,
  expectedVersion: message.version,
});
const preview = (sources: unknown[], session = cookie) =>
  write('/api/v1/ai/context/preview', input(sources), session);

beforeAll(async () => {
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await write(
    '/api/v1/auth/setup',
    {
      email: 'mail-context@example.test',
      password: 'synthetic-mail-context-password',
    },
    '',
  );
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  registry = (await get('/api/v1/ai/providers')).json().revision;
  const route = { allowed: ['test', 'fallback'], preferred: 'test' };
  expect(
    (
      await write(
        '/api/v1/ai/routing',
        {
          operationId: randomUUID(),
          expectedVersion: 1,
          policy: { unlabeled: route, personal: route, restricted: route },
        },
        cookie,
        'PUT',
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await write(
        '/api/v1/ai/budget',
        {
          operationId: randomUUID(),
          expectedVersion: 1,
          policy: {
            monthlyLimitMicros: 10000000,
            perRequestLimitMicros: 100000,
          },
        },
        cookie,
        'PUT',
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await write(
        '/api/v1/ai/provider-consents/test',
        {
          operationId: randomUUID(),
          expectedVersion: 1,
          approved: true,
          expectedRegistryRevision: registry,
        },
        cookie,
        'PUT',
      )
    ).statusCode,
  ).toBe(200);
  const other = randomUUID(),
    token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-mail-context@example.test',
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
  otherCookie = `hub_session=${token}`;
});
afterAll(async () => {
  expect(network).not.toHaveBeenCalled();
  await app?.close();
  vi.unstubAllGlobals();
});

async function mail(
  verified = true,
  body = 'Synthetic message body',
  sensitivity = 'personal',
) {
  const created = await write('/api/v1/email/connectors', {
    operationId: randomUUID(),
    name: 'Synthetic Bridge',
    sensitivity,
  });
  expect(created.statusCode).toBe(201);
  const { token, connector } = created.json();
  const messageKey = `<${randomUUID()}@example.test>`;
  const payload = {
    path: 'Excluded folder metadata',
    role: null,
    uidValidity: '1',
    exists: 1,
    inWindow: 1,
    lastUid: 1,
    messages: [
      {
        uid: 1,
        ...(verified ? { textOrigin: 'message-body-v1' } : {}),
        messageKey,
        from: { name: 'Advisor', address: 'advisor@example.test' },
        to: [],
        cc: [],
        subject: 'Synthetic subject',
        sentAt: null,
        receivedAt: '2026-10-13T12:00:00.000Z',
        body,
        bodyTruncated: false,
        attachmentCount: 4,
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
  const [message] = await db.query<{ id: string; version: number }>(
    'SELECT id,version FROM email_messages WHERE connector_id=$1',
    [connector.id],
  );
  return { message: message!, token, connector, payload, upload };
}

it('projects only bounded mail text and binds connector identity, versions and inherited labels', async () => {
  const value = await mail();
  const result = await preview([ref(value.message)]);
  expect(result.statusCode).toBe(200);
  const data = result.json();
  expect(data.dispatchEnabled).toBe(false);
  expect(data.retained).toBe(false);
  const projected = JSON.parse(data.payload).sources[0].content;
  expect(projected).toEqual({
    subject: 'Synthetic subject',
    from: { name: 'Advisor', address: 'advisor@example.test' },
    to: [],
    cc: [],
    receivedAt: '2026-10-13T12:00:00.000Z',
    sentAt: null,
    body: 'Synthetic message body',
    bodyTruncated: false,
  });
  expect(data.payload).not.toContain(value.token);
  expect(data.payload).not.toContain(value.payload.path);
  expect(data.payload).not.toContain(value.payload.messages[0]!.messageKey);
  const manifest = data.assessment.contextManifest;
  expect(manifest.sources[0]).toMatchObject({
    kind: 'mail-message',
    version: 1,
    labels: ['personal'],
    attachmentDerived: false,
    mailConnector: { id: value.connector.id, version: 1 },
  });
  expect(
    aiContextManifestSchema.safeParse({
      ...manifest,
      sources: [{ ...manifest.sources[0], mailConnector: undefined }],
    }).success,
  ).toBe(false);
  const request = await write('/api/v1/ai/requests', {
    ...input([ref(value.message)]),
    operationId: randomUUID(),
  });
  expect(request.statusCode).toBe(201);
  expect(JSON.stringify(request.json())).not.toContain(projected.body);
  expect(
    JSON.stringify(await db.query('SELECT input_manifest FROM ai_requests')),
  ).not.toContain(projected.body);
});

it('rejects foreign sources, stale versions and duplicate references', async () => {
  const value = await mail();
  expect(
    (
      await write(
        '/api/v1/ai/context/preview',
        {
          ...input([ref(value.message)]),
          expectedPolicyVersion: 1,
          expectedBudgetVersion: 1,
        },
        otherCookie,
      )
    ).statusCode,
  ).toBe(404);
  expect(
    (await preview([{ ...ref(value.message), expectedVersion: 2 }])).statusCode,
  ).toBe(409);
  expect(
    (
      await preview([
        ref(value.message),
        { ...ref(value.message), id: value.message.id.toUpperCase() },
      ])
    ).statusCode,
  ).toBe(400);
});

it('does not retroactively certify legacy text when a later collector retries it', async () => {
  const value = await mail(false);
  expect((await preview([ref(value.message)])).json().error.code).toBe(
    'PROVENANCE_UNAVAILABLE',
  );
  Object.assign(value.payload.messages[0]!, { textOrigin: 'message-body-v1' });
  expect((await value.upload()).statusCode).toBe(200);
  expect((await preview([ref(value.message)])).json().error.code).toBe(
    'PROVENANCE_UNAVAILABLE',
  );
  expect(
    (await get(`/api/v1/email/messages/${value.message.id}`)).statusCode,
  ).toBe(200);
});

it('blocks an unavailable approved destination rather than falling back, without classifying sensitivity', async () => {
  const value = await mail(true, 'Very private synthetic content', 'unlabeled');
  const result = await write('/api/v1/ai/routing/preview', {
    text,
    sensitivity: 'unlabeled',
    sources: [ref(value.message)],
    expectedPolicyVersion: 2,
    simulatedAvailableProviders: ['fallback'],
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    status: 'blocked',
    reason: 'PROVIDER_UNAVAILABLE',
    provider: 'test',
    labels: ['unlabeled'],
    dispatchEnabled: false,
  });
});

it('detects changed message bytes before admission even without a version bump', async () => {
  const value = await mail();
  const saved = await write('/api/v1/ai/requests', {
    ...input([ref(value.message)]),
    operationId: randomUUID(),
  });
  expect(saved.statusCode).toBe(201);
  await db.query('UPDATE email_messages SET body=$2 WHERE id=$1', [
    value.message.id,
    'Changed synthetic body',
  ]);
  await expect(
    beginSyntheticAttempt(db, config, owner, saved.json().id, 1, text),
  ).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
  expect(
    await db.query('SELECT id FROM ai_attempts WHERE request_id=$1', [
      saved.json().id,
    ]),
  ).toEqual([]);
});

it('invalidates a pending binding after connector revocation but keeps stored mail locally available', async () => {
  const value = await mail();
  const saved = await write('/api/v1/ai/requests', {
    ...input([ref(value.message)]),
    operationId: randomUUID(),
  });
  expect(saved.statusCode).toBe(201);
  expect(
    (
      await write(`/api/v1/email/connectors/${value.connector.id}/revoke`, {
        operationId: randomUUID(),
        expectedVersion: 1,
      })
    ).statusCode,
  ).toBe(200);
  await expect(
    beginSyntheticAttempt(db, config, owner, saved.json().id, 1, text),
  ).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
  const renewed = await preview([ref(value.message)]);
  expect(renewed.statusCode).toBe(200);
  expect(
    renewed.json().assessment.contextManifest.sources[0].mailConnector.version,
  ).toBe(2);
});

it('blocks oversized combined mail context without partial assembly', async () => {
  const first = await mail(true, 'x'.repeat(32000));
  const second = await mail(true, 'y'.repeat(32000));
  const result = await preview([ref(first.message), ref(second.message)]);
  expect(result.statusCode).toBe(200);
  expect(result.json().payload).toBeNull();
  expect(result.json().assessment.reason).toBe('INPUT_LIMIT');
});

it('blocks a post-admission connector change before the callback and retains the uncertain hold', async () => {
  const value = await mail();
  const saved = await write('/api/v1/ai/requests', {
    ...input([ref(value.message)]),
    operationId: randomUUID(),
  });
  expect(saved.statusCode).toBe(201);
  const proxy: Database = {
    ...db,
    async transaction(work) {
      const result = await db.transaction(work);
      if (
        result &&
        typeof result === 'object' &&
        'claimed' in result &&
        result.claimed === true
      )
        await db.query(
          'UPDATE email_connectors SET version=version+1,revoked_at=CURRENT_TIMESTAMP WHERE id=$1',
          [value.connector.id],
        );
      return result;
    },
  };
  const execute = vi.fn(async () => ({
    usage: { outcome: 'completed', inputTokens: 0, outputTokens: 0 },
    output: { answer: 'Never delivered', suggestions: [] },
  }));
  const result = await executeSyntheticTextRequest(
    proxy,
    config,
    owner,
    saved.json().id,
    1,
    text,
    { kind: 'synthetic-text', execute },
  );
  expect(result.request.status).toBe('uncertain');
  expect(result.result).toBeNull();
  expect(execute).not.toHaveBeenCalled();
  const [hold] = await db.query(
    'SELECT r.status FROM ai_budget_reservations r JOIN ai_attempts a ON a.reservation_id=r.id WHERE a.request_id=$1',
    [saved.json().id],
  );
  expect(hold?.status).toBe('uncertain');
});

it('upgrades a populated legacy mail table without rewriting text or certifying its origin', async () => {
  const store = await openDatabase(config);
  try {
    await migrate(store);
    // Reconstruct the previous schema in this disposable memory database only.
    await store.exec(
      'ALTER TABLE email_messages DROP COLUMN version; ALTER TABLE email_messages DROP COLUMN text_origin',
    );
    await store.query(
      "DELETE FROM schema_migrations WHERE name='048_email_context.sql'",
    );
    const account = randomUUID(),
      connector = randomUUID(),
      message = randomUUID();
    await store.query(
      'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',
      [account, 'upgrade-mail@example.test', 'unused'],
    );
    await store.query(
      "INSERT INTO email_connectors(id,owner_id,name,token_hash,sensitivity,since) VALUES($1,$2,'Legacy Bridge',$3,'personal','2026-10-01')",
      [connector, account, 'a'.repeat(64)],
    );
    await store.query(
      "INSERT INTO email_messages(id,owner_id,connector_id,message_key,subject,received_at,body,body_truncated,folders,sensitivity) VALUES($1,$2,$3,'<legacy@example.test>','Preserved subject','2026-10-13T12:00:00Z','Preserved legacy body',false,ARRAY['INBOX'],'personal')",
      [message, account, connector],
    );
    await migrate(store);
    expect(
      await store.query(
        'SELECT id,subject,body,version,text_origin FROM email_messages WHERE id=$1',
        [message],
      ),
    ).toEqual([
      {
        id: message,
        subject: 'Preserved subject',
        body: 'Preserved legacy body',
        version: 1,
        text_origin: null,
      },
    ]);
    expect(
      (
        await store.query(
          'SELECT token_hash FROM email_connectors WHERE id=$1',
          [connector],
        )
      )[0]?.token_hash,
    ).toBe('a'.repeat(64));
  } finally {
    await store.close();
  }
});
