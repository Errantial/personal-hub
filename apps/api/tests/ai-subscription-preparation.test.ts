import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  aiProviderReadinessResponseSchema,
  aiProviderReadinessSchema,
  aiContextManifestSchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { publicAIRegistry } from '../src/ai/profiles.js';
import { readAIBudget } from '../src/features/ai-budget.js';
import { buildClaudeSubscriptionRequest } from '../src/ai/claude-subscription-request.js';
import { beginSyntheticAttempt } from '../src/ai/synthetic-execution.js';

const pricing = {
  revision: 'synthetic-price-v1',
  validUntil: '2050-01-01T00:00:00.000Z',
  inputTokenLimit: 1001,
  inputMicrosPerMillionTokens: 3000001,
  outputMicrosPerMillionTokens: 7000001,
};
const profile = {
  alias: 'routine',
  adapter: 'claude-code',
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
  { ...profile, alias: 'codex', adapter: 'codex-subscription' },
  { ...profile, alias: 'api', adapter: 'anthropic' },
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

const text = 'Synthetic subscription-only text';
const manifest = (payload = text) =>
  aiContextManifestSchema.parse({
    formatVersion: 1,
    boundary: 'text-only',
    projection: 'owned-text-v1',
    request: {
      provenance: 'owner-entered',
      sensitivity: 'unlabeled',
      characters: payload.length,
    },
    sources: [],
    payloadCharacters: payload.length,
  });
const declared = registry.profiles.find(
  (profile) => profile.alias === 'routine',
)!;

it('prepares one shell-free Claude draft with text only on stdin and no account/network access', () => {
  const request = buildClaudeSubscriptionRequest(declared, text, manifest());
  expect(request).toMatchObject({
    adapter: 'claude-code',
    dispatchEnabled: false,
    verification: 'required',
    shell: false,
    stdin: text,
  });
  expect(request.argv).not.toContain(text);
  expect(request.argv).not.toContain('--bare');
  expect(request.argv).not.toContain('--fallback-model');
  expect(request.argv).not.toContain('--continue');
  expect(request.argv).not.toContain('--resume');
  expect(request.argv).not.toContain('--max-budget-usd');
  expect(request).not.toHaveProperty('env');
  expect(request).not.toHaveProperty('cwd');
  expect(JSON.stringify(request)).not.toContain('synthetic-never-disclose');
});

it('explicitly disables built-in tools, MCP, discovery, persistence and unattended approvals in the draft', () => {
  const { argv } = buildClaudeSubscriptionRequest(declared, text, manifest());
  for (const flag of [
    '--safe-mode',
    '--restricted',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--no-chrome',
    '--strict-mcp-config',
  ])
    expect(argv).toContain(flag);
  expect(argv[argv.indexOf('--tools') + 1]).toBe('');
  expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('');
  expect(argv[argv.indexOf('--disallowedTools') + 1]).toBe('*');
  expect(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!)).toEqual({
    mcpServers: {},
  });
  expect(argv[argv.indexOf('--permission-prompts') + 1]).toBe('none');
  expect(argv[argv.indexOf('--model') + 1]).toBe(declared.model);
});

it('keeps shell-looking text literal and rejects empty/NUL text, manifest mismatch and envelope overflow', () => {
  const payload = '$(Get-Content secret) `echo` --fallback-model private';
  const request = buildClaudeSubscriptionRequest(
    declared,
    payload,
    manifest(payload),
  );
  expect(request.stdin).toBe(payload);
  expect(request.argv).not.toContain(payload);
  for (const payload of ['', 'a\0b'])
    expect(() =>
      buildClaudeSubscriptionRequest(declared, payload, manifest(payload)),
    ).toThrow();
  expect(() =>
    buildClaudeSubscriptionRequest(declared, text + 'x', manifest()),
  ).toThrowError(expect.objectContaining({ code: 'CONTEXT_CONFLICT' }));
  expect(() =>
    buildClaudeSubscriptionRequest(
      { ...declared, maxInputCharacters: text.length },
      text,
      manifest(),
    ),
  ).toThrowError(expect.objectContaining({ code: 'INPUT_LIMIT' }));
});

it('rejects unpinned or flag-like models and unavailable/non-Claude profiles', () => {
  for (const model of [
    'sonnet',
    'opus',
    'haiku',
    'fable',
    'latest',
    'claude-model-latest',
    '--model',
    'a b',
    'a\nb',
  ])
    expect(() =>
      buildClaudeSubscriptionRequest({ ...declared, model }, text, manifest()),
    ).toThrowError(expect.objectContaining({ code: 'MODEL_PIN_REQUIRED' }));
  for (const value of [
    { ...declared, configuration: 'disabled' as const },
    { ...declared, configuration: 'credential_missing' as const },
    registry.profiles.find((profile) => profile.alias === 'codex')!,
    registry.profiles.find((profile) => profile.alias === 'api')!,
  ])
    expect(() =>
      buildClaudeSubscriptionRequest(value, text, manifest()),
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }));
});

it('exposes unverified subscription requirements and distinct usage/isolation gates for both runtimes', async () => {
  const result = await readiness();
  for (const alias of ['routine', 'codex']) {
    const profile = result.profiles.find((row) => row.alias === alias)!;
    expect(profile.blockers).toEqual(
      expect.arrayContaining([
        'DISPATCH_DISABLED',
        'SUBSCRIPTION_ISOLATION_REQUIRED',
        'SUBSCRIPTION_USAGE_VERIFICATION_REQUIRED',
      ]),
    );
    expect(profile.subscriptionRequirements).toMatchObject({
      status: 'unverified',
      requestPreparation:
        alias === 'routine' ? 'claude-cli-draft' : 'unavailable',
    });
    expect(profile.subscriptionRequirements?.checks).toContain(
      'dedicated-account',
    );
    expect(profile.subscriptionRequirements?.checks).toContain('empty-toolset');
    expect(profile.subscriptionRequirements?.checks).toContain(
      'complete-usage-bound',
    );
    expect(profile.subscriptionRequirements?.checks).toContain(
      'retry-behavior',
    );
  }
  const api = result.profiles.find((row) => row.alias === 'api')!;
  expect(api.subscriptionRequirements).toBeNull();
  expect(api.blockers).not.toContain('SUBSCRIPTION_ISOLATION_REQUIRED');
  const legacy = { ...api };
  delete (legacy as Partial<typeof api>).subscriptionRequirements;
  expect(
    aiProviderReadinessSchema.parse(legacy).subscriptionRequirements,
  ).toBeNull();
});

it('keeps readiness owner-authorized and free of server credentials', async () => {
  expect(
    (
      await app.inject({
        url: '/api/v1/ai/provider-readiness',
        headers: { origin },
      })
    ).statusCode,
  ).toBe(401);
  expect(JSON.stringify(await readiness())).not.toContain(
    'synthetic-never-disclose',
  );
  expect(
    (await readiness(otherCookie)).profiles.every(
      (row) => !row.consent.approved,
    ),
  ).toBe(true);
});

it('does not treat approved profile configuration or an API-priced quote as subscription readiness', async () => {
  expect((await consent(input(true, 1))).statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/v1/ai/budget',
        headers: headers(),
        payload: {
          operationId: randomUUID(),
          expectedVersion: 1,
          policy: {
            monthlyLimitMicros: 50000000,
            perRequestLimitMicros: 250000,
          },
        },
      })
    ).statusCode,
  ).toBe(200);
  const current = (await readiness()).profiles.find(
    (row) => row.alias === 'routine',
  )!;
  expect(current.consentCurrent).toBe(true);
  expect(current.quote).not.toBeNull();
  expect(current.blockers).toContain(
    'SUBSCRIPTION_USAGE_VERIFICATION_REQUIRED',
  );
  expect(current.subscriptionRequirements?.status).toBe('unverified');
});

it('blocks synthetic byte-token admission through a declared subscription route before any attempt/hold', async () => {
  const route = { allowed: ['routine'], preferred: 'routine' };
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/v1/ai/routing',
        headers: headers(),
        payload: {
          operationId: randomUUID(),
          expectedVersion: 1,
          policy: { unlabeled: route, personal: route, restricted: route },
        },
      })
    ).statusCode,
  ).toBe(200);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/ai/requests',
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      text,
      sensitivity: 'unlabeled',
      sources: [],
      expectedPolicyVersion: 2,
      expectedBudgetVersion: 2,
      expectedRegistryRevision: registry.revision,
    },
  });
  expect(created.statusCode).toBe(201);
  await expect(
    beginSyntheticAttempt(db, config, owner, created.json().id, 1, text),
  ).rejects.toMatchObject({ code: 'AI_REQUEST_BLOCKED' });
  expect((await readAIBudget(db, owner)).usage.heldMicros).toBe('0');
  expect(
    await db.query('SELECT id FROM ai_attempts WHERE request_id=$1', [
      created.json().id,
    ]),
  ).toHaveLength(0);
});
