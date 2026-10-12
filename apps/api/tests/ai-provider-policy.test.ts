import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  aiProviderReadinessResponseSchema,
  plannerExportSchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { publicAIRegistry, readAIProfiles } from '../src/ai/profiles.js';
import {
  quoteAIProfile,
  readAIProviderReadiness,
} from '../src/ai/provider-policy.js';
import { readAIBudget } from '../src/features/ai-budget.js';
import { reserveAIBudget } from '../src/ai/budget.js';

const pricing = {
  revision: 'synthetic-price-v1',
  validUntil: '2050-01-01T00:00:00.000Z',
  inputTokenLimit: 1001,
  inputMicrosPerMillionTokens: 3000001,
  outputMicrosPerMillionTokens: 7000001,
};
const profile = {
  alias: 'routine',
  adapter: 'anthropic',
  model: 'synthetic-model',
  credentialEnv: 'AI_SECRET_ROUTINE',
  enabled: true,
  maxInputCharacters: 48000,
  maxOutputTokens: 13,
  pricing,
  retentionDisclosure: {
    revision: 'synthetic-terms-v1',
    summary: 'Synthetic server disclosure for tests.',
  },
};
const profiles = [
  profile,
  {
    ...profile,
    alias: 'undisclosed',
    pricing: null,
    retentionDisclosure: null,
  },
];
const environment = {
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  AI_PROVIDER_PROFILES: JSON.stringify(profiles),
  AI_SECRET_ROUTINE: 'synthetic-never-disclose',
};
const origin = 'http://127.0.0.1:5173';
const config = readConfig(environment);
const registry = publicAIRegistry(config.AI_PROVIDER_PROFILES);
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let otherCookie: string;
let owner: string;
const network = vi.fn(() => {
  throw new Error('Network forbidden');
});
const headers = (session = cookie) => ({ origin, cookie: session });
const input = (approved: boolean, expectedVersion: number) => ({
  approved,
  expectedVersion,
  expectedRegistryRevision: registry.revision,
  operationId: randomUUID(),
});
const consent = (payload: object, alias = 'routine', session = cookie) =>
  app.inject({
    method: 'PUT',
    url: `/api/v1/ai/provider-consents/${alias}`,
    headers: headers(session),
    payload,
  });
const readiness = async (session = cookie) => {
  const response = await app.inject({
    url: '/api/v1/ai/provider-readiness',
    headers: headers(session),
  });
  expect(response.statusCode).toBe(200);
  return aiProviderReadinessResponseSchema.parse(response.json());
};
beforeAll(async () => {
  vi.stubGlobal('fetch', network);
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'consent@example.test',
      password: 'synthetic-consent-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  const other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-consent@example.test',
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
  vi.unstubAllGlobals();
  await app?.close();
});

it('rounds each configured token allowance upward exactly and expires prices at their deadline', () => {
  const current = registry.profiles.find((row) => row.alias === 'routine')!;
  expect(quoteAIProfile(current)).toMatchObject({
    inputMaximumMicros: 3004,
    outputMaximumMicros: 92,
    maximumChargeMicros: 3096,
    inputTokenLimit: 1001,
    outputTokenLimit: 13,
  });
  expect(quoteAIProfile(current, Date.parse(pricing.validUntil))).toBeNull();
  expect(
    quoteAIProfile({
      ...current,
      pricing: {
        ...pricing,
        inputMicrosPerMillionTokens: 0,
        outputMicrosPerMillionTokens: 0,
      },
    })!.maximumChargeMicros,
  ).toBe(0);
  expect(
    quoteAIProfile({
      ...current,
      maxOutputTokens: 32000,
      pricing: {
        ...pricing,
        inputTokenLimit: 2000000,
        inputMicrosPerMillionTokens: 1000000000,
        outputMicrosPerMillionTokens: 1000000000,
      },
    })!.maximumChargeMicros,
  ).toBe(2032000000);
});

it('fingerprints safe declarations, rejects unknown/invalid price fields and never fingerprints secrets', () => {
  const safe = JSON.stringify(registry);
  expect(safe).not.toContain('synthetic-never-disclose');
  expect(safe).not.toContain('AI_SECRET_ROUTINE');
  expect(
    publicAIRegistry(
      readAIProfiles({
        ...environment,
        AI_SECRET_ROUTINE: 'rotated-synthetic-secret',
      }),
    ),
  ).toEqual(registry);
  for (const bad of [
    { ...pricing, inputMicrosPerMillionTokens: -1 },
    { ...pricing, validUntil: 'not-a-date' },
    { ...pricing, endpoint: 'https://synthetic.invalid' },
  ]) {
    expect(() =>
      readAIProfiles({
        ...environment,
        AI_PROVIDER_PROFILES: JSON.stringify([{ ...profile, pricing: bad }]),
      }),
    ).toThrow('Invalid environment configuration: AI_PROVIDER_PROFILES');
  }
  for (const change of [
    { model: 'different-model' },
    { pricing: { ...pricing, revision: 'v2' } },
    {
      retentionDisclosure: {
        ...profile.retentionDisclosure,
        summary: 'Changed terms',
      },
    },
  ]) {
    const changed = publicAIRegistry(
      readAIProfiles({
        ...environment,
        AI_PROVIDER_PROFILES: JSON.stringify([{ ...profile, ...change }]),
      }),
    );
    expect(changed.profiles[0]!.policyRevision).not.toBe(
      registry.profiles[0]!.policyRevision,
    );
  }
});

it('defaults consent off, requires a disclosure, rejects overrides and protects private endpoints', async () => {
  const state = await readiness();
  expect(state.profiles[0]).toMatchObject({
    consentCurrent: false,
    consent: { approved: false, version: 1 },
    blockers: expect.arrayContaining([
      'DISPATCH_DISABLED',
      'TOKEN_BOUND_UNVERIFIED',
      'CONSENT_REQUIRED',
      'BUDGET_UNSET',
    ]),
  });
  expect(state.profiles[1]!.blockers).toEqual(
    expect.arrayContaining(['PRICING_UNSET', 'RETENTION_UNSET']),
  );
  expect((await consent(input(true, 1), 'undisclosed')).json().error.code).toBe(
    'RETENTION_UNSET',
  );
  expect(
    (await consent({ ...input(true, 1), promptRetentionDays: 1 })).statusCode,
  ).toBe(400);
  expect((await consent(input(true, 1), 'missing')).statusCode).toBe(404);
  expect((await app.inject('/api/v1/ai/provider-readiness')).statusCode).toBe(
    401,
  );
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/v1/ai/provider-consents/routine',
        headers: { origin },
        payload: input(true, 1),
      })
    ).statusCode,
  ).toBe(401);
  expect(
    await db.query('SELECT * FROM ai_provider_consents WHERE owner_id=$1', [
      owner,
    ]),
  ).toHaveLength(0);
});

it('deduplicates approvals, preserves conflict versions and keeps historical retry receipts after revocation', async () => {
  const approval = input(true, 1);
  const results = await Promise.all([consent(approval), consent(approval)]);
  expect(results.map((response) => response.statusCode)).toEqual([200, 200]);
  expect(results[0]!.json()).toEqual(results[1]!.json());
  expect(results[0]!.json().profileSnapshot).toMatchObject({
    model: profile.model,
    retentionDisclosure: profile.retentionDisclosure,
    pricing,
  });
  expect((await readiness()).profiles[0]!.consentCurrent).toBe(true);
  expect((await readiness(otherCookie)).profiles[0]!.consentCurrent).toBe(
    false,
  );
  expect((await consent(input(false, 1))).json().error.code).toBe(
    'VERSION_CONFLICT',
  );
  expect(
    (await consent({ ...approval, approved: false })).json().error.code,
  ).toBe('OPERATION_CONFLICT');
  expect(
    (
      await consent({
        ...input(false, 2),
        expectedRegistryRevision: 'a'.repeat(64),
      })
    ).json().error.code,
  ).toBe('REGISTRY_CONFLICT');
  expect((await consent(input(false, 2))).json()).toMatchObject({
    version: 3,
    approved: false,
    profileRevision: null,
  });
  expect((await consent(approval)).json()).toEqual(results[0]!.json());
  expect((await readiness()).profiles[0]!.consentCurrent).toBe(false);
  expect((await consent(input(true, 3))).statusCode).toBe(200);
});

it('invalidates consent for changed models/disclosures and compares quotes against exact remaining budget including holds', async () => {
  const current = registry.profiles[0]!;
  const budget = await readAIBudget(db, owner);
  const exactBudget = {
    ...budget,
    policy: { monthlyLimitMicros: 5000, perRequestLimitMicros: 3096 },
    usage: { ...budget.usage, spentMicros: '0', heldMicros: '1904' },
  };
  expect(
    (await readAIProviderReadiness(db, owner, current, exactBudget)).blockers,
  ).not.toContain('MONTHLY_BUDGET_EXCEEDED');
  const changed = publicAIRegistry(
    readAIProfiles({
      ...environment,
      AI_PROVIDER_PROFILES: JSON.stringify([
        { ...profile, model: 'changed-model' },
      ]),
    }),
  ).profiles[0]!;
  expect(
    (await readAIProviderReadiness(db, owner, changed, budget)).consentCurrent,
  ).toBe(false);
  expect(
    (
      await readAIProviderReadiness(
        db,
        owner,
        current,
        budget,
        Date.parse(pricing.validUntil),
      )
    ).blockers,
  ).toContain('PRICING_EXPIRED');
  const setBudget = async (
    expectedVersion: number,
    monthlyLimitMicros: number,
    perRequestLimitMicros: number,
  ) =>
    app.inject({
      method: 'PUT',
      url: '/api/v1/ai/budget',
      headers: headers(),
      payload: {
        expectedVersion,
        operationId: randomUUID(),
        policy: { monthlyLimitMicros, perRequestLimitMicros },
      },
    });
  expect((await setBudget(1, 5000, 3095)).statusCode).toBe(200);
  expect((await readiness()).profiles[0]!.blockers).toContain(
    'REQUEST_BUDGET_EXCEEDED',
  );
  expect((await setBudget(2, 5000, 3096)).statusCode).toBe(200);
  await reserveAIBudget(db, owner, {
    requestId: randomUUID(),
    provider: 'routine',
    model: 'synthetic-model',
    expectedPolicyVersion: 3,
    maximumChargeMicros: 1905,
  });
  expect((await readiness()).profiles[0]!.blockers).toContain(
    'MONTHLY_BUDGET_EXCEEDED',
  );
});

it('records safe readiness metadata in preflights/export without retaining text or creating reservations', async () => {
  const settings = (
    await app.inject({ url: '/api/v1/ai/routing', headers: headers() })
  ).json();
  const policy = await app.inject({
    method: 'PUT',
    url: '/api/v1/ai/routing',
    headers: headers(),
    payload: {
      expectedVersion: settings.version,
      operationId: randomUUID(),
      policy: {
        unlabeled: { allowed: ['routine'], preferred: 'routine' },
        personal: { allowed: ['routine'], preferred: 'routine' },
        restricted: { allowed: ['routine'], preferred: 'routine' },
      },
    },
  });
  expect(policy.statusCode).toBe(200);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/ai/preflights',
    headers: headers(),
    payload: {
      text: 'Private synthetic request must be discarded.',
      sensitivity: 'unlabeled',
      sources: [],
      expectedPolicyVersion: policy.json().version,
      expectedBudgetVersion: 3,
      expectedRegistryRevision: registry.revision,
      operationId: randomUUID(),
    },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().executionReadiness).toMatchObject({
    consentCurrent: true,
    quote: { maximumChargeMicros: 3096 },
    blockers: expect.arrayContaining([
      'DISPATCH_DISABLED',
      'MONTHLY_BUDGET_EXCEEDED',
    ]),
  });
  const exported = plannerExportSchema.parse(
    (
      await app.inject({ url: '/api/v1/planner/export', headers: headers() })
    ).json(),
  );
  expect(exported.records.aiProviderConsents).toEqual([
    expect.objectContaining({ alias: 'routine', version: 4, approved: true }),
  ]);
  expect(JSON.stringify(exported)).not.toContain('Private synthetic request');
  expect(
    await db.query('SELECT * FROM ai_budget_reservations WHERE owner_id=$1', [
      owner,
    ]),
  ).toHaveLength(1);
  expect(
    await db.query(
      "SELECT * FROM mutation_receipts WHERE result::text LIKE '%Private synthetic request%'",
    ),
  ).toHaveLength(0);
});
