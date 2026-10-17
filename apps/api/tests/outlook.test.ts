import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { outlookAccessGateSchema, plannerExportSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/database.js';
import { readConfig } from '../src/config.js';

const origin = 'http://127.0.0.1:5173';
const base = '/api/v1/connections/outlook/access';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let otherCookie: string;
const headers = (session = cookie) => ({ origin, cookie: session });

beforeEach(async () => {
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'outlook-gate@example.test',
      password: 'synthetic-password-only',
    },
  });
  const setCookie = setup.headers['set-cookie']!;
  cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
    ';',
  )[0]!;
  const other = randomUUID();
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-outlook-gate@example.test',
    'unused',
  ]);
  const token = randomBytes(32).toString('hex');
  await db.query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '1 day')",
    [createHash('sha256').update(token).digest('hex'), other],
  );
  otherCookie = `hub_session=${token}`;
});

afterEach(async () => {
  await app?.close();
});

const read = async (session = cookie) =>
  outlookAccessGateSchema.parse(
    (await app.inject({ url: base, headers: headers(session) })).json(),
  );

const save = (payload: object, session = cookie) =>
  app.inject({ method: 'PUT', url: base, headers: headers(session), payload });

it('records the Outlook access gate without creating OAuth or mailbox state and retries exactly', async () => {
  const initial = await read();
  expect(initial).toEqual({
    backend: 'unknown',
    tenant: 'unknown',
    mailboxScope: 'unknown',
    appRegistration: 'unknown',
    consent: 'unknown',
    status: 'unknown',
    version: 1,
    checkedAt: null,
  });
  const body = {
    operationId: randomUUID(),
    expectedVersion: initial.version,
    backend: 'exchange-online',
    tenant: 'school-managed',
    mailboxScope: 'primary-only',
    appRegistration: 'owner-can-register',
    consent: 'user-can-consent',
  };
  const first = await save(body);
  expect(first.statusCode).toBe(200);
  const ready = outlookAccessGateSchema.parse(first.json());
  expect(ready).toMatchObject({
    status: 'ready-for-adapter',
    version: 2,
  });
  expect(ready.checkedAt).toEqual(expect.any(String));
  expect((await save(body)).json()).toEqual(first.json());
  expect(
    (
      await save({
        ...body,
        operationId: randomUUID(),
        consent: 'admin-consent-required',
      })
    ).statusCode,
  ).toBe(409);
  expect(
    await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'outlook_%' ORDER BY table_name",
    ),
  ).toEqual([{ table_name: 'outlook_access_gate' }]);
});

it('derives admin, scope-review and blocked states without inferring permission from an Outlook client name', async () => {
  let state = await read();
  const write = async (
    patch: Partial<{
      backend: 'unknown' | 'exchange-online' | 'other';
      tenant: 'unknown' | 'school-managed' | 'other';
      mailboxScope: 'unknown' | 'primary-only' | 'shared-required';
      appRegistration:
        | 'unknown'
        | 'owner-can-register'
        | 'admin-must-register'
        | 'registration-blocked';
      consent:
        | 'unknown'
        | 'user-can-consent'
        | 'admin-consent-required'
        | 'consent-blocked';
    }>,
  ) => {
    const result = await save({
      operationId: randomUUID(),
      expectedVersion: state.version,
      backend: state.backend,
      tenant: state.tenant,
      mailboxScope: state.mailboxScope,
      appRegistration: state.appRegistration,
      consent: state.consent,
      ...patch,
    });
    expect(result.statusCode).toBe(200);
    state = outlookAccessGateSchema.parse(result.json());
  };
  await write({
    backend: 'exchange-online',
    tenant: 'school-managed',
    mailboxScope: 'primary-only',
    appRegistration: 'admin-must-register',
    consent: 'admin-consent-required',
  });
  expect(state.status).toBe('admin-action-required');
  await write({
    appRegistration: 'owner-can-register',
    consent: 'user-can-consent',
    mailboxScope: 'shared-required',
  });
  expect(state.status).toBe('scope-review-required');
  await write({ mailboxScope: 'primary-only', consent: 'consent-blocked' });
  expect(state.status).toBe('blocked');
  await write({ backend: 'other', consent: 'unknown' });
  expect(state.status).toBe('blocked');
  await write({ backend: 'exchange-online', tenant: 'other' });
  expect(state.status).toBe('blocked');
});

it('isolates access findings by owner and exports only bounded readiness metadata', async () => {
  const initial = await read();
  await save({
    operationId: randomUUID(),
    expectedVersion: initial.version,
    backend: 'exchange-online',
    tenant: 'school-managed',
    mailboxScope: 'primary-only',
    appRegistration: 'admin-must-register',
    consent: 'admin-consent-required',
  });
  expect((await read(otherCookie)).status).toBe('unknown');
  expect((await app.inject(base)).statusCode).toBe(401);
  const exported = plannerExportSchema.parse(
    (
      await app.inject({ url: '/api/v1/planner/export', headers: headers() })
    ).json(),
  );
  expect(exported.records.outlookAccessGate).toMatchObject({
    backend: 'exchange-online',
    tenant: 'school-managed',
    mailboxScope: 'primary-only',
    appRegistration: 'admin-must-register',
    consent: 'admin-consent-required',
    status: 'admin-action-required',
  });
});
