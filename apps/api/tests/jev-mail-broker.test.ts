import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { publicAIRegistry, readAIProfiles } from '../src/ai/profiles.js';
import { jevEndpoint } from '../src/ai/jev-policy.js';
import {
  buildJevEnvelope,
  decodeJev,
  exchangeJev,
  fitJevCandidates,
  jevEnvelopeLimit,
  jevModel,
  jevRubric,
} from '../src/ai/jev-broker-protocol.js';
import type { BrokerCandidate } from '../src/ai/mail-broker.js';
import type { BrokerAdapterQuote } from '../src/ai/broker-adapter.js';

const openRouterProfile = {
  alias: 'mail-broker',
  adapter: 'openrouter',
  upstreamProvider: 'google-vertex',
  model: 'google/gemini-2.5-flash-lite',
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
    summary: 'Synthetic TypeSafe terms.',
  },
};

const candidate = (
  id = 'message-1',
  body = 'Deadline evidence.',
): BrokerCandidate => ({
  id,
  version: 1,
  connectorId: 'connector',
  connectorVersion: 1,
  labels: ['unlabeled'],
  digest: 'digest',
  subject: 'Deadline',
  from: 'School Office',
  receivedAt: '2026-10-01T12:00:00Z',
  body,
  truncated: false,
});

const quote: BrokerAdapterQuote = {
  inputTokenLimit: 32000,
  outputTokenLimit: 1000,
  maximumChargeMicros: 1344,
  inputMicrosPerMillionTokens: 42000,
  outputMicrosPerMillionTokens: 0,
  authoritativeUsageBilling: true,
};

function response(
  candidates: BrokerCandidate[],
  change?: (value: Record<string, unknown>) => void,
) {
  const probabilities = { '0': 0, '1': 0, '2': 0.25, '3': 0.75 };
  const value: Record<string, unknown> = {
    model: jevModel,
    usage: { input_tokens: 100, output_tokens: 40 },
    answers: Object.fromEntries(
      candidates.map((_, index) => [
        `m${index + 1}`,
        {
          type: 'score',
          score: 2.75,
          confidence: 0.9,
          probabilities,
          legend: {
            '0': jevRubric[0],
            '1': jevRubric[1],
            '2': jevRubric[2],
            '3': jevRubric[3],
          },
        },
      ]),
    ),
  };
  change?.(value);
  return value;
}

it('preserves the exact legacy OpenRouter profile fingerprint and keeps credential revisions private', () => {
  const openRouterOnly = publicAIRegistry(
    readAIProfiles({
      AI_PROVIDER_PROFILES: JSON.stringify([openRouterProfile]),
      AI_SECRET_OPENROUTER: 'synthetic-secret',
    }),
  );
  const current = openRouterOnly.profiles[0]!;
  const legacyHashInput = {
    alias: openRouterProfile.alias,
    adapter: openRouterProfile.adapter,
    accessMode: 'api-key',
    upstreamProvider: openRouterProfile.upstreamProvider,
    model: openRouterProfile.model,
    configuration: 'configured',
    maxInputCharacters: openRouterProfile.maxInputCharacters,
    maxOutputTokens: openRouterProfile.maxOutputTokens,
    pricing: openRouterProfile.pricing,
    retentionDisclosure: openRouterProfile.retentionDisclosure,
  };
  expect(current.policyRevision).toBe(
    createHash('sha256').update(JSON.stringify(legacyHashInput)).digest('hex'),
  );

  const withJev = publicAIRegistry(
    readAIProfiles({
      AI_PROVIDER_PROFILES: JSON.stringify([openRouterProfile, jevProfile]),
      AI_SECRET_OPENROUTER: 'synthetic-secret',
      AI_SECRET_JEV: 'synthetic-jev-secret',
    }),
  );
  expect(withJev.revision).not.toBe(openRouterOnly.revision);
  expect(
    withJev.profiles.find((profile) => profile.alias === 'mail-broker')!
      .policyRevision,
  ).toBe(current.policyRevision);

  const first = publicAIRegistry(
    readAIProfiles({
      AI_PROVIDER_PROFILES: JSON.stringify([jevProfile]),
      AI_SECRET_JEV: 'synthetic-jev-secret',
    }),
  );
  const second = publicAIRegistry(
    readAIProfiles({
      AI_PROVIDER_PROFILES: JSON.stringify([jevProfile]),
      AI_SECRET_JEV: 'rotated-synthetic-jev-secret',
    }),
  );
  expect(first.profiles[0]!.policyRevision).toBe(
    second.profiles[0]!.policyRevision,
  );
  expect(JSON.stringify(first)).not.toContain('AI_SECRET_JEV');
});

it('accepts a Jev profile with only its API-key environment configured', () => {
  const [profile] = readAIProfiles({
    AI_PROVIDER_PROFILES: JSON.stringify([jevProfile]),
    AI_SECRET_JEV: 'synthetic-jev-secret',
  });
  expect(profile).toMatchObject({
    alias: 'jev-mail',
    model: jevModel,
    credential: 'synthetic-jev-secret',
  });
});

it('builds bounded Score envelopes with Unicode clipping and frozen selection identity', () => {
  const long = '😀'.repeat(1200);
  const bytes = buildJevEnvelope(jevModel, 'Find deadline evidence', [
    candidate('m1', long),
  ]);
  const parsed = JSON.parse(bytes);
  expect(
    Array.from(parsed.questions.m1.instructions.candidate.excerpt),
  ).toHaveLength(1000);
  expect(parsed.questions.m1.instructions.candidate.clipped).toBe(true);
  const many = Array.from({ length: 30 }, (_, index) =>
    candidate(`id-${index}`, 'x'.repeat(1000)),
  );
  const fitted = fitJevCandidates(
    jevModel,
    'Find deadline evidence',
    many,
    20480,
  );
  expect(fitted.length).toBeGreaterThan(0);
  expect(fitted.length).toBeLessThan(many.length);
  expect(
    Buffer.byteLength(
      buildJevEnvelope(jevModel, 'Find deadline evidence', fitted),
    ),
  ).toBeLessThanOrEqual(jevEnvelopeLimit);
});

it('strictly decodes Score answers and settles known invalid-output or overrun charges', () => {
  const candidates = [candidate()];
  expect(
    decodeJev(
      JSON.stringify(response(candidates)),
      jevModel,
      candidates,
      quote,
    ),
  ).toEqual({
    status: 'confirmed',
    reason: null,
    usage: { inputTokens: 100, outputTokens: 40, actualMicros: 5 },
    decisions: [
      {
        method: 'score',
        id: 'message-1',
        score: 2.75,
        confidence: 0.9,
        relevantProbability: 1,
        selected: true,
      },
    ],
  });

  const badLegend = response(candidates, (value) => {
    const answers = value.answers as Record<
      string,
      { legend: Record<string, string> }
    >;
    answers.m1!.legend['3'] = 'changed';
  });
  expect(
    decodeJev(JSON.stringify(badLegend), jevModel, candidates, quote),
  ).toMatchObject({
    status: 'confirmed',
    reason: 'response',
    usage: { actualMicros: 5 },
    decisions: [],
  });

  const overrun = response(candidates, (value) => {
    value.usage = { input_tokens: 40000, output_tokens: 40 };
  });
  expect(
    decodeJev(JSON.stringify(overrun), jevModel, candidates, quote),
  ).toMatchObject({
    status: 'confirmed',
    reason: 'response',
    usage: { inputTokens: 40000, actualMicros: 1680 },
    decisions: [],
  });

  const wrongModel = response(candidates, (value) => {
    value.model = 'jev-1.13.0';
  });
  expect(
    decodeJev(JSON.stringify(wrongModel), jevModel, candidates, quote),
  ).toMatchObject({
    status: 'confirmed',
    reason: 'response',
    usage: { actualMicros: 5 },
    decisions: [],
  });
});

it('keeps ambiguous billing uncertain and rejects duplicate JSON keys before interpretation', () => {
  const candidates = [candidate()];
  const missingUsage = response(candidates, (value) => delete value.usage);
  expect(
    decodeJev(JSON.stringify(missingUsage), jevModel, candidates, quote),
  ).toEqual({ status: 'uncertain', reason: 'billing' });
  expect(
    decodeJev(
      '{"model":"jev-1.14.0","usage":{"input_tokens":1,"output_tokens":0},"usage":{"input_tokens":2,"output_tokens":0},"answers":{}}',
      jevModel,
      candidates,
      quote,
    ),
  ).toEqual({ status: 'uncertain', reason: 'response' });
  expect(
    decodeJev(JSON.stringify(response(candidates)), jevModel, candidates, {
      ...quote,
      authoritativeUsageBilling: false,
    }),
  ).toEqual({ status: 'uncertain', reason: 'billing' });
});

it('uses the fixed TypeSafe endpoint once with no redirect/retry and preserves uncertainty', async () => {
  const candidates = [candidate()];
  const body = buildJevEnvelope(jevModel, 'Find deadline evidence', candidates);
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(jevEndpoint);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.body).toBe(body);
    return Response.json(response(candidates));
  });
  expect(
    await exchangeJev(
      fetcher,
      'synthetic-secret',
      body,
      jevModel,
      candidates,
      quote,
    ),
  ).toMatchObject({ status: 'confirmed', reason: null });
  expect(fetcher).toHaveBeenCalledTimes(1);

  const failed = vi.fn<typeof fetch>(async () =>
    Response.json({ error: 'synthetic' }, { status: 529 }),
  );
  expect(
    await exchangeJev(
      failed,
      'synthetic-secret',
      body,
      jevModel,
      candidates,
      quote,
    ),
  ).toEqual({ status: 'uncertain', reason: 'response' });
  expect(failed).toHaveBeenCalledTimes(1);
});
