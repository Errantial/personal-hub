import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { aiContextManifestSchema } from '@hub/contracts';
import { readConfig } from '../src/config.js';
import { publicAIRegistry } from '../src/ai/profiles.js';
import { decodeClaudeSubscriptionResponse } from '../src/ai/claude-subscription-response.js';

const config = readConfig({
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  AI_SECRET_TEST: 'synthetic-never-disclose',
  AI_PROVIDER_PROFILES: JSON.stringify([
    {
      alias: 'subscription',
      adapter: 'claude-code',
      model: 'synthetic-pinned-model',
      credentialEnv: 'AI_SECRET_TEST',
      enabled: true,
      maxInputCharacters: 48000,
      maxOutputTokens: 100,
    },
  ]),
});
const profile = publicAIRegistry(config.AI_PROVIDER_PROFILES).profiles[0]!;
const id = randomUUID();
const manifest = aiContextManifestSchema.parse({
  formatVersion: 1,
  boundary: 'text-only',
  projection: 'owned-text-v1',
  request: {
    provenance: 'owner-entered',
    sensitivity: 'unlabeled',
    characters: 9,
  },
  sources: [
    {
      kind: 'task',
      id,
      version: 2,
      labels: ['unlabeled'],
      attachmentDerived: false,
      memorySettingsVersion: null,
      characters: 10,
    },
  ],
  payloadCharacters: 30,
});
const output = {
  answer: 'Synthetic guidance',
  suggestions: [
    {
      source: { kind: 'task', id, version: 2 },
      note: 'Synthetic source-linked note',
    },
  ],
};
const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadInputTokens: 3,
  cacheCreationInputTokens: 2,
  costUSD: 0.000123,
};
const packet = (extra: object = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  result: JSON.stringify(output),
  total_cost_usd: 0.000123,
  modelUsage: { [profile.model]: usage },
  permission_denials: [],
  session_id: 'private-session-never-retain',
  privateExtra: 'private-native-metadata',
  ...extra,
});
const decode = (extra: object = {}, exitCode: number | null = 0) =>
  decodeClaudeSubscriptionResponse(
    JSON.stringify(packet(extra)),
    exitCode,
    profile,
    manifest,
  );
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  network = vi.fn(() => {
    throw Error('Network forbidden');
  });
  vi.stubGlobal('fetch', network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('decodes source-linked guidance while keeping billing and accounting unverified', () => {
  const result = decode();
  expect(result).toEqual({
    dispatchEnabled: false,
    billing: 'unverified',
    accounting: 'unsettled',
    outputState: 'validated',
    reason: null,
    output,
    usageEstimate: {
      scope: 'unverified',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
      totalEstimatedMicros: 123,
      modelEstimatedMicros: 123,
    },
  });
  expect(result.usageEstimate).not.toHaveProperty('actualMicros');
  expect(JSON.stringify(result)).not.toContain('private-');
  expect(
    decodeClaudeSubscriptionResponse(
      new TextEncoder().encode(JSON.stringify(packet())),
      0,
      profile,
      manifest,
    ),
  ).toEqual(result);
});

it('preserves exact decimal estimates without float rounding or fabricated subscription invoices', () => {
  const raw = JSON.stringify(packet()).replaceAll(
    '0.000123',
    '0.000123000000000000001',
  );
  const result = decodeClaudeSubscriptionResponse(raw, 0, profile, manifest);
  expect(result.usageEstimate?.totalEstimatedMicros).toBe(124);
  expect(result.usageEstimate?.modelEstimatedMicros).toBe(124);
  for (const cost of [0, 0.00000001, 1e-7]) {
    const estimate = decode({
      total_cost_usd: cost,
      modelUsage: { [profile.model]: { ...usage, costUSD: cost } },
    });
    expect(estimate.billing).toBe('unverified');
    expect(estimate.accounting).toBe('unsettled');
    expect(estimate.usageEstimate?.totalEstimatedMicros).toBe(
      cost === 0 ? 0 : 1,
    );
  }
});

it('retains reported estimates on native errors without trusting partial or error text', () => {
  for (const [extra, exit] of [
    [{ is_error: true, result: 'private-error' }, 0],
    [{ subtype: 'error_max_budget_usd', result: 'private-error' }, 1],
    [
      {
        subtype: 'error_during_execution',
        total_cost_usd: 0,
        modelUsage: { [profile.model]: { ...usage, costUSD: 0 } },
      },
      1,
    ],
    [{}, null],
    [{}, 1],
  ] as const) {
    const result = decode(extra, exit);
    expect(result.outputState).toBe('provider-error');
    expect(result.output).toBeNull();
    expect(result.usageEstimate).not.toBeNull();
    expect(result.accounting).toBe('unsettled');
    expect(JSON.stringify(result)).not.toContain('private-');
  }
});

it('blocks multi-turn results, permission denials and output token overruns', () => {
  for (const [extra, reason] of [
    [{ num_turns: 0 }, 'turns'],
    [{ num_turns: 2 }, 'turns'],
    [
      {
        permission_denials: [{ tool_name: 'Read', tool_input: 'private-path' }],
      },
      'permissions',
    ],
    [
      { modelUsage: { [profile.model]: { ...usage, outputTokens: 101 } } },
      'limits',
    ],
  ] as const) {
    const result = decode(extra);
    expect(result.outputState).toBe('blocked');
    expect(result.reason).toBe(reason);
    expect(result.output).toBeNull();
    expect(result.usageEstimate).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-path');
  }
});

it('rejects unknown, fallback, missing and multiple model identities', () => {
  for (const modelUsage of [
    {},
    { fallback: usage },
    { [profile.model]: usage, fallback: usage },
  ]) {
    const result = decode({ modelUsage });
    expect(result.reason).toBe('destination');
    expect(result.output).toBeNull();
    expect(result.usageEstimate).toBeNull();
  }
});

it('rejects missing, negative, fractional, unsafe and incoherent usage instead of defaulting to zero', () => {
  for (const extra of [
    { total_cost_usd: undefined },
    { total_cost_usd: '0.000123' },
    { total_cost_usd: -1 },
    { total_cost_usd: 1e31 },
    { total_cost_usd: 0.000124 },
    ...[undefined, -1, 1.5, 2000001].map((inputTokens) => ({
      modelUsage: { [profile.model]: { ...usage, inputTokens } },
    })),
    { modelUsage: { [profile.model]: { ...usage, inputTokens: 2000000 } } },
    {
      modelUsage: {
        [profile.model]: { ...usage, cacheReadInputTokens: undefined },
      },
    },
  ]) {
    const result = decode(extra);
    expect(['response', 'usage']).toContain(result.reason);
    expect(result.usageEstimate).toBeNull();
    expect(result.output).toBeNull();
  }
});

it('rejects malformed, streamed, oversized and invalid UTF-8 native output with redacted reasons', () => {
  const valid = JSON.stringify(packet());
  for (const raw of [
    '',
    'private-error',
    `[${valid}]`,
    `${valid}\n${valid}`,
    'x'.repeat(262145),
    '🙂'.repeat(70000),
    Uint8Array.from([0xff, 0xfe]),
  ]) {
    const result = decodeClaudeSubscriptionResponse(raw, 0, profile, manifest);
    expect(result.reason).toBe('response');
    expect(result.output).toBeNull();
    expect(result.usageEstimate).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-');
  }
});

it('accepts only bounded guidance and exact supplied source identities and versions', () => {
  for (const result of [
    'not-json',
    JSON.stringify({ ...output, action: { tool: 'private-tool' } }),
    JSON.stringify({ ...output, answer: '' }),
    JSON.stringify({ ...output, answer: 'x'.repeat(16001) }),
    JSON.stringify({ ...output, answer: 'private\0text' }),
    ...[
      { kind: 'event', id, version: 2 },
      { kind: 'task', id: randomUUID(), version: 2 },
      { kind: 'task', id, version: 1 },
    ].map((source) =>
      JSON.stringify({
        ...output,
        suggestions: [{ source, note: 'private-invalid-note' }],
      }),
    ),
  ]) {
    const decoded = decode({ result });
    expect(decoded.outputState).toBe('invalid');
    expect(decoded.output).toBeNull();
    expect(decoded.usageEstimate).not.toBeNull();
    expect(JSON.stringify(decoded)).not.toContain('private-');
  }
  expect(
    decode({ result: JSON.stringify({ ...output, suggestions: [] }) })
      .outputState,
  ).toBe('validated');
});

it('does not substitute structured output or trust invalid provenance manifests', () => {
  expect(decode({ structured_output: output }).outputState).toBe('invalid');
  for (const invalid of [
    { ...manifest, boundary: 'image' },
    {
      ...manifest,
      sources: [{ ...manifest.sources[0]!, attachmentDerived: true }],
    },
  ]) {
    const result = decodeClaudeSubscriptionResponse(
      JSON.stringify(packet()),
      0,
      profile,
      invalid as typeof manifest,
    );
    expect(result.outputState).toBe('invalid');
    expect(result.output).toBeNull();
  }
});

it('requires a configured pinned Claude subscription profile and never grants dispatch', () => {
  for (const invalid of [
    { ...profile, adapter: 'openrouter' },
    { ...profile, accessMode: 'api-key' },
    { ...profile, configuration: 'unconfigured' },
    ...[
      'sonnet',
      'opus',
      'latest',
      'model-latest',
      '--model',
      'private model',
    ].map((model) => ({ ...profile, model })),
  ]) {
    const result = decodeClaudeSubscriptionResponse(
      JSON.stringify(packet()),
      0,
      invalid as typeof profile,
      manifest,
    );
    expect(result.reason).toBe('profile');
    expect(result.dispatchEnabled).toBe(false);
    expect(result.usageEstimate).toBeNull();
  }
});
