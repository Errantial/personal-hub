import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { rm } from 'node:fs/promises';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  reserveAIBudget,
  changeAIBudgetReservation,
  readBudgetUsage,
  readBudgetReservations,
} from '../src/ai/budget.js';
import { plannerExportSchema } from '@hub/contracts';
const origin = 'http://127.0.0.1:5173';
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let owner: string;
let other: string;
let cookie: string;
const reservation = (overrides: object = {}) => ({
  requestId: randomUUID(),
  expectedPolicyVersion: 1,
  provider: 'routine',
  model: 'synthetic-model',
  maximumChargeMicros: 250,
  ...overrides,
});
beforeAll(async () => {
  const config = readConfig({
    NODE_ENV: 'test',
    PGLITE_DATA_DIR: 'memory://',
    AI_PROVIDER_PROFILES: JSON.stringify([
      {
        alias: 'routine',
        adapter: 'anthropic',
        model: 'synthetic-model',
        credentialEnv: 'AI_SECRET_TEST',
        enabled: true,
        maxInputCharacters: 48000,
        maxOutputTokens: 1000,
      },
    ]),
    AI_SECRET_TEST: 'synthetic-accounting-only',
  });
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'budget@example.test',
      password: 'synthetic-budget-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  other = randomUUID();
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-budget@example.test',
    'unused',
  ]);
  await db.query(
    'INSERT INTO ai_budget_policies(owner_id,monthly_limit_micros,per_request_limit_micros) VALUES($1,1000,300),($2,1000,300)',
    [owner, other],
  );
});
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Provider calls forbidden in accounting tests');
    }),
  );
  // This fixture is exclusively the synthetic memory database opened above.
  await db.query('DELETE FROM ai_budget_reservations');
  await db.query('DELETE FROM mutation_receipts');
  await db.query(
    'UPDATE ai_budget_policies SET version=1,monthly_limit_micros=1000,per_request_limit_micros=300',
  );
});
afterAll(async () => {
  await app?.close();
});
it('serializes concurrent reservations, holds the worst-case cost and rejects exhaustion without alternate-provider admission', async () => {
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, () => reserveAIBudget(db, owner, reservation())),
  );
  expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(
    4,
  );
  expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
  expect(attempts.find((item) => item.status === 'rejected')).toMatchObject({
    reason: { code: 'MONTHLY_BUDGET_EXCEEDED' },
  });
  expect(await readBudgetUsage(db, owner)).toMatchObject({
    spentMicros: '0',
    heldMicros: '1000',
    uncertainMicros: '0',
  });
  await expect(
    reserveAIBudget(db, owner, reservation({ provider: 'private' })),
  ).rejects.toMatchObject({ code: 'MONTHLY_BUDGET_EXCEEDED' });
  await expect(
    reserveAIBudget(db, owner, reservation({ maximumChargeMicros: 301 })),
  ).rejects.toMatchObject({ code: 'REQUEST_BUDGET_EXCEEDED' });
});
it('deduplicates a reservation request across retries and refuses changed destination, price or policy payloads', async () => {
  const body = reservation();
  const [first, second] = await Promise.all([
    reserveAIBudget(db, owner, body),
    reserveAIBudget(db, owner, body),
  ]);
  expect(second).toEqual(first);
  expect(await readBudgetUsage(db, owner)).toMatchObject({ heldMicros: '250' });
  for (const change of [
    { provider: 'private' },
    { maximumChargeMicros: 251 },
    { expectedPolicyVersion: 2 },
  ])
    await expect(
      reserveAIBudget(db, owner, { ...body, ...change }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  expect(await readBudgetReservations(db, owner)).toHaveLength(1);
});
it('fails closed for unset/zero limits and stale versions while preserving approved holds through limit reductions', async () => {
  await db.query(
    'UPDATE ai_budget_policies SET monthly_limit_micros=NULL,per_request_limit_micros=NULL WHERE owner_id=$1',
    [owner],
  );
  await expect(reserveAIBudget(db, owner, reservation())).rejects.toMatchObject(
    { code: 'BUDGET_UNSET' },
  );
  await db.query(
    'UPDATE ai_budget_policies SET monthly_limit_micros=0,per_request_limit_micros=0 WHERE owner_id=$1',
    [owner],
  );
  await expect(reserveAIBudget(db, owner, reservation())).rejects.toMatchObject(
    { code: 'REQUEST_BUDGET_EXCEEDED' },
  );
  await db.query(
    'UPDATE ai_budget_policies SET version=2,monthly_limit_micros=1000,per_request_limit_micros=300 WHERE owner_id=$1',
    [owner],
  );
  await expect(reserveAIBudget(db, owner, reservation())).rejects.toMatchObject(
    { code: 'VERSION_CONFLICT' },
  );
  const body = reservation({ expectedPolicyVersion: 2 });
  const held = await reserveAIBudget(db, owner, body);
  await db.query(
    'UPDATE ai_budget_policies SET version=3,monthly_limit_micros=0,per_request_limit_micros=0 WHERE owner_id=$1',
    [owner],
  );
  expect(await reserveAIBudget(db, owner, body)).toEqual(held);
  expect(await readBudgetUsage(db, owner)).toMatchObject({ heldMicros: '250' });
});
it('retains uncertain holds, rejects release after transmission claim and settles confirmed usage once', async () => {
  const held = await reserveAIBudget(db, owner, reservation());
  const claim = {
    operationId: randomUUID(),
    expectedVersion: held.version,
    outcome: 'uncertain' as const,
  };
  const uncertain = await changeAIBudgetReservation(db, owner, held.id, claim);
  expect(uncertain).toMatchObject({
    status: 'uncertain',
    version: 2,
    actualMicros: null,
  });
  expect(await changeAIBudgetReservation(db, owner, held.id, claim)).toEqual(
    uncertain,
  );
  expect(await readBudgetUsage(db, owner)).toMatchObject({
    heldMicros: '250',
    uncertainMicros: '250',
  });
  await expect(
    changeAIBudgetReservation(db, owner, held.id, {
      operationId: randomUUID(),
      expectedVersion: 2,
      outcome: 'released',
    }),
  ).rejects.toMatchObject({ code: 'BUDGET_STATE' });
  await expect(
    changeAIBudgetReservation(db, owner, held.id, {
      operationId: randomUUID(),
      expectedVersion: 1,
      outcome: 'settled',
      actualMicros: 100,
    }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  const settle = {
    operationId: randomUUID(),
    expectedVersion: 2,
    outcome: 'settled' as const,
    actualMicros: 100,
  };
  const spent = await changeAIBudgetReservation(db, owner, held.id, settle);
  expect(spent).toMatchObject({
    status: 'settled',
    version: 3,
    actualMicros: 100,
    overrun: false,
  });
  expect(await changeAIBudgetReservation(db, owner, held.id, settle)).toEqual(
    spent,
  );
  expect(await readBudgetUsage(db, owner)).toMatchObject({
    spentMicros: '100',
    heldMicros: '0',
    uncertainMicros: '0',
  });
  await expect(
    changeAIBudgetReservation(db, owner, held.id, {
      ...settle,
      operationId: randomUUID(),
      expectedVersion: 3,
    }),
  ).rejects.toMatchObject({ code: 'BUDGET_STATE' });
});
it('records confirmed overrun costs rather than understating them and frees only unclaimed or confirmed-zero charges', async () => {
  const body = reservation();
  const held = await reserveAIBudget(db, owner, body);
  const released = await changeAIBudgetReservation(db, owner, held.id, {
    operationId: randomUUID(),
    expectedVersion: 1,
    outcome: 'released',
  });
  expect(released).toMatchObject({ status: 'released', actualMicros: 0 });
  expect((await reserveAIBudget(db, owner, body)).status).toBe('released'); // never renews an old inference step
  expect(await readBudgetUsage(db, owner)).toMatchObject({
    heldMicros: '0',
    spentMicros: '0',
  });
  const expensive = await reserveAIBudget(db, owner, reservation());
  const settled = await changeAIBudgetReservation(db, owner, expensive.id, {
    operationId: randomUUID(),
    expectedVersion: 1,
    outcome: 'settled',
    actualMicros: 1100,
  });
  expect(settled.overrun).toBe(true);
  expect(await readBudgetUsage(db, owner)).toMatchObject({
    spentMicros: '1100',
    heldMicros: '0',
    overruns: 1,
  });
  await expect(reserveAIBudget(db, owner, reservation())).rejects.toMatchObject(
    { code: 'MONTHLY_BUDGET_EXCEEDED' },
  );
});
it('isolates owner accounting and applies creation-month attribution without re-reserving old request IDs', async () => {
  const body = reservation();
  const first = await reserveAIBudget(db, owner, body);
  const independent = await reserveAIBudget(db, other, body);
  expect(first.id).not.toBe(independent.id);
  await expect(
    changeAIBudgetReservation(db, other, first.id, {
      operationId: randomUUID(),
      expectedVersion: 1,
      outcome: 'released',
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await db.query(
    "UPDATE ai_budget_reservations SET month='2000-01-01' WHERE owner_id=$1",
    [owner],
  );
  expect(await readBudgetUsage(db, owner)).toMatchObject({ heldMicros: '0' });
  expect(await readBudgetUsage(db, owner)).toMatchObject({
    outstandingHeldMicros: '250',
  });
  const retry = await reserveAIBudget(db, owner, body);
  expect(retry).toMatchObject({
    id: first.id,
    month: '2000-01',
    status: 'reserved',
  });
  await changeAIBudgetReservation(db, owner, first.id, {
    operationId: randomUUID(),
    expectedVersion: 1,
    outcome: 'settled',
    actualMicros: 100,
  });
  expect(await readBudgetUsage(db, owner)).toMatchObject({ spentMicros: '0' });
  expect(await readBudgetUsage(db, other)).toMatchObject({
    spentMicros: '0',
    heldMicros: '250',
  });
});
it('exports safe accounting and blocks exhausted server preflight without exposing internal ledger writes', async () => {
  const rule = { allowed: ['routine'], preferred: 'routine' };
  const routing = await app.inject({
    method: 'PUT',
    url: '/api/v1/ai/routing',
    headers: { origin, cookie },
    payload: {
      operationId: randomUUID(),
      expectedVersion: 1,
      policy: { unlabeled: rule, personal: rule, restricted: rule },
    },
  });
  expect(routing.statusCode).toBe(200);
  await Promise.all(
    Array.from({ length: 4 }, () => reserveAIBudget(db, owner, reservation())),
  );
  const registry = (
    await app.inject({ url: '/api/v1/ai/providers', headers: { cookie } })
  ).json();
  const preflight = await app.inject({
    method: 'POST',
    url: '/api/v1/ai/preflights',
    headers: { origin, cookie },
    payload: {
      operationId: randomUUID(),
      expectedRegistryRevision: registry.revision,
      expectedPolicyVersion: routing.json().version,
      expectedBudgetVersion: 1,
      text: 'Synthetic exhausted budget check',
      sensitivity: 'unlabeled',
      sources: [],
    },
  });
  expect(preflight.statusCode).toBe(201);
  expect(preflight.json()).toMatchObject({
    reason: 'MONTHLY_BUDGET_EXCEEDED',
    dispatchEnabled: false,
    budgetUsage: { heldMicros: '1000' },
  });
  const exported = plannerExportSchema.parse(
    (
      await app.inject({ url: '/api/v1/planner/export', headers: { cookie } })
    ).json(),
  );
  expect(exported.records.aiBudgetReservations).toHaveLength(4);
  expect(exported.records.aiBudget!.usage!.heldMicros).toBe('1000');
  const { usage: omittedUsage, ...oldBudget } = exported.records.aiBudget!;
  void omittedUsage;
  const legacy = plannerExportSchema.parse({
    ...exported,
    records: {
      ...exported.records,
      aiBudget: oldBudget,
      aiBudgetReservations: undefined,
    },
  });
  expect(legacy.records.aiBudget!.usage).toBeNull();
  expect(legacy.records.aiBudgetReservations).toEqual([]);
  expect(JSON.stringify(exported)).not.toContain('synthetic-accounting-only');
  for (const path of [
    '/api/v1/ai/budget/reserve',
    '/api/v1/ai/budget/settle',
    '/api/v1/ai/budget/release',
  ])
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { origin, cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
});
it('retains uncertain accounting and operation receipts across an isolated database restart', async () => {
  const testRoot = resolve('.artifacts/budget-restart');
  const directory = resolve(testRoot, randomUUID());
  if (!directory.startsWith(`${testRoot}${sep}`))
    throw new Error('Invalid synthetic database path');
  const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: directory });
  let current: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    let store = await openDatabase(config);
    current = await buildApp({ logger: false }, { config, database: store });
    const setup = await current.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'restart-budget@example.test',
        password: 'synthetic-budget-restart',
      },
    });
    const isolatedOwner = setup.json().user.id;
    await store.query(
      'INSERT INTO ai_budget_policies(owner_id,monthly_limit_micros,per_request_limit_micros) VALUES($1,1000,300)',
      [isolatedOwner],
    );
    const body = reservation();
    const held = await reserveAIBudget(store, isolatedOwner, body);
    const claim = {
      operationId: randomUUID(),
      expectedVersion: 1,
      outcome: 'uncertain' as const,
    };
    const uncertain = await changeAIBudgetReservation(
      store,
      isolatedOwner,
      held.id,
      claim,
    );
    await current.close();
    current = undefined;
    store = await openDatabase(config);
    current = await buildApp({ logger: false }, { config, database: store });
    expect(await reserveAIBudget(store, isolatedOwner, body)).toEqual(
      uncertain,
    );
    expect(
      await changeAIBudgetReservation(store, isolatedOwner, held.id, claim),
    ).toEqual(uncertain);
    expect(await readBudgetUsage(store, isolatedOwner)).toMatchObject({
      heldMicros: '250',
      uncertainMicros: '250',
      spentMicros: '0',
    });
  } finally {
    await current?.close();
    // The checked UUID child above is the only target; never an owner database.
    await rm(directory, { recursive: true, force: true });
  }
});
