import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  mailBrokerSettingsResponseSchema,
  mailBrokerSettingsWriteSchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { brokerModel } from '../src/ai/broker-protocol.js';
import { jevModel } from '../src/ai/jev-broker-protocol.js';

const origin = 'http://127.0.0.1:5173';
const openRouterProfile = {
  alias: 'mail-broker',
  adapter: 'openrouter',
  upstreamProvider: 'google-vertex',
  model: brokerModel,
  credentialEnv: 'AI_SECRET_OPENROUTER',
  enabled: true,
  maxInputCharacters: 20480,
  maxOutputTokens: 2048,
  pricing: {
    revision: 'synthetic-openrouter-price',
    validUntil: '2099-01-01T00:00:00Z',
    inputTokenLimit: 32000,
    inputMicrosPerMillionTokens: 100000,
    outputMicrosPerMillionTokens: 400000,
  },
  retentionDisclosure: {
    revision: 'synthetic-openrouter-terms',
    summary: 'Synthetic OpenRouter terms.',
  },
};
const jevProfile = {
  alias: 'jev-mail',
  adapter: 'typesafe',
  upstreamProvider: null,
  model: jevModel,
  credentialEnv: 'AI_SECRET_JEV',
  enabled: true,
  maxInputCharacters: 20480,
  maxOutputTokens: 1000,
  pricing: {
    revision: 'synthetic-jev-price',
    validUntil: '2099-01-01T00:00:00Z',
    inputTokenLimit: 32000,
    inputMicrosPerMillionTokens: 42000,
    outputMicrosPerMillionTokens: 0,
  },
  retentionDisclosure: {
    revision: 'synthetic-jev-terms',
    summary: 'Synthetic account-bound TypeSafe terms.',
  },
};
const environment = {
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  AI_SECRET_OPENROUTER: 'synthetic-openrouter',
  AI_SECRET_JEV: 'synthetic-jev',
  AI_PROVIDER_PROFILES: JSON.stringify([openRouterProfile, jevProfile]),
};
const config = readConfig(environment);
let db: Awaited<ReturnType<typeof openDatabase>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: string;
let cookie: string;
let otherCookie: string;

const call = (
  method: 'GET' | 'PUT',
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

beforeAll(async () => {
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'broker-settings@example.test',
      password: 'synthetic-broker-settings-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;

  const other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-broker-settings@example.test',
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

beforeEach(async () => {
  await db.exec(
    'DELETE FROM mail_broker_settings; DELETE FROM mutation_receipts;',
  );
});

afterAll(async () => {
  await app?.close();
});

it('defaults to OpenRouter version one and keeps settings owner-isolated', async () => {
  expect(
    mailBrokerSettingsResponseSchema.parse(
      (await call('GET', '/api/v1/mail-broker/settings')).json(),
    ),
  ).toEqual({ settings: { version: 1, selectedAlias: 'mail-broker' } });
  expect(
    (
      await call('GET', '/api/v1/mail-broker/settings', undefined, otherCookie)
    ).json(),
  ).toEqual({ settings: { version: 1, selectedAlias: 'mail-broker' } });
  expect(await db.query('SELECT * FROM mail_broker_settings')).toEqual([]);
});

it('versions selector writes, replays exact operations and mutates no broker authority', async () => {
  const before = await authorityCounts();
  const operationId = randomUUID();
  const input = {
    operationId,
    expectedVersion: 1,
    selectedAlias: 'jev-mail',
  };
  expect(mailBrokerSettingsWriteSchema.parse(input)).toEqual(input);
  const first = await call('PUT', '/api/v1/mail-broker/settings', input);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json()).toEqual({
    settings: { version: 2, selectedAlias: 'jev-mail' },
  });
  expect(
    (await call('PUT', '/api/v1/mail-broker/settings', input)).json(),
  ).toEqual(first.json());
  const changed = await call('PUT', '/api/v1/mail-broker/settings', {
    ...input,
    selectedAlias: 'mail-broker',
  });
  expect(changed.statusCode).toBe(409);
  expect(changed.json().error.code).toBe('OPERATION_CONFLICT');
  const stale = await call('PUT', '/api/v1/mail-broker/settings', {
    operationId: randomUUID(),
    expectedVersion: 1,
    selectedAlias: 'mail-broker',
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error.code).toBe('VERSION_CONFLICT');
  const saved = await call('PUT', '/api/v1/mail-broker/settings', {
    operationId: randomUUID(),
    expectedVersion: 2,
    selectedAlias: 'mail-broker',
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual({
    settings: { version: 3, selectedAlias: 'mail-broker' },
  });
  expect(await authorityCounts()).toEqual(before);
});

it('serializes distinct concurrent first writes with exactly one winner', async () => {
  const responses = await Promise.all([
    call('PUT', '/api/v1/mail-broker/settings', {
      operationId: randomUUID(),
      expectedVersion: 1,
      selectedAlias: 'mail-broker',
    }),
    call('PUT', '/api/v1/mail-broker/settings', {
      operationId: randomUUID(),
      expectedVersion: 1,
      selectedAlias: 'jev-mail',
    }),
  ]);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([
    200, 409,
  ]);
  expect(
    responses.find((response) => response.statusCode === 409)!.json().error
      .code,
  ).toBe('VERSION_CONFLICT');
  expect(
    (await call('GET', '/api/v1/mail-broker/settings')).json().settings,
  ).toMatchObject({ version: 2 });
  expect(
    await db.query('SELECT owner_id FROM mail_broker_settings'),
  ).toHaveLength(1);
});

it('rejects a known selector when that server profile is absent', async () => {
  const localConfig = readConfig({
    ...environment,
    PGLITE_DATA_DIR: 'memory://',
    AI_PROVIDER_PROFILES: JSON.stringify([openRouterProfile]),
  });
  const localDb = await openDatabase(localConfig);
  const localApp = await buildApp(
    { logger: false },
    { config: localConfig, database: localDb },
  );
  try {
    const setup = await localApp.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'missing-jev@example.test',
        password: 'synthetic-missing-jev-password',
      },
    });
    const session = String(setup.headers['set-cookie']).split(';')[0]!;
    const response = await localApp.inject({
      method: 'PUT',
      url: '/api/v1/mail-broker/settings',
      headers: { origin, cookie: session },
      payload: {
        operationId: randomUUID(),
        expectedVersion: 1,
        selectedAlias: 'jev-mail',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(
      'MAIL_BROKER_DESTINATION_UNAVAILABLE',
    );
    expect(await localDb.query('SELECT * FROM mail_broker_settings')).toEqual(
      [],
    );
  } finally {
    await localApp.close();
  }
});

async function authorityCounts() {
  const counts: Record<string, number> = {};
  for (const table of [
    'ai_provider_consents',
    'ai_routing_policies',
    'mail_broker_grants',
    'ai_budget_policies',
  ]) {
    const [row] = await db.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`,
      [owner],
    );
    counts[table] = Number(row!.n);
  }
  return counts;
}
