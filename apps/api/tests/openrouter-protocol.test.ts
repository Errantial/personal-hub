import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { aiContextManifestSchema } from '@hub/contracts';
import { readConfig } from '../src/config.js';
import { publicAIRegistry } from '../src/ai/profiles.js';
import {
  decodeOpenRouterTextResponse,
  exerciseOpenRouterProtocol,
  providerDollarsToMicros,
} from '../src/ai/openrouter-protocol.js';

const declaration = {
  alias: 'routine',
  adapter: 'openrouter',
  upstreamProvider: 'test-provider/test-region',
  model: 'test/model',
  credentialEnv: 'AI_SECRET_TEST',
  enabled: true,
  maxInputCharacters: 48000,
  maxOutputTokens: 2000,
  pricing: {
    revision: 'fake-v1',
    validUntil: '2050-01-01T00:00:00.000Z',
    inputTokenLimit: 10000,
    inputMicrosPerMillionTokens: 1000000,
    outputMicrosPerMillionTokens: 1000000,
  },
};
const config = readConfig({
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  AI_PROVIDER_PROFILES: JSON.stringify([declaration]),
  AI_SECRET_TEST: 'synthetic-protocol-only',
});
const profile = publicAIRegistry(config.AI_PROVIDER_PROFILES).profiles[0]!;
const id = randomUUID(),
  output = {
    answer: 'Synthetic protocol guidance',
    suggestions: [
      {
        source: { kind: 'task', id, version: 1 },
        note: 'Synthetic source-linked note',
      },
    ],
  };
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
      version: 1,
      labels: ['unlabeled'],
      attachmentDerived: false,
      memorySettingsVersion: null,
      characters: 10,
    },
  ],
  payloadCharacters: 30,
});
const packet = (extra: object = {}) => ({
  id: 'gen-test123',
  model: 'test/model',
  usage: {
    prompt_tokens: 5,
    completion_tokens: 3,
    total_tokens: 8,
    cost: 0.000123,
  },
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify(output) },
    },
  ],
  ...extra,
});
const reply = (
  value: unknown = packet(),
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json', ...headers },
  });
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

it('prepares one bounded credential-isolated exchange with pinned routing and response caching disabled', async () => {
  const io = vi.fn(async (url, request) => {
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(request.redirect).toBe('error');
    expect(request.headers['X-OpenRouter-Cache']).toBe('false');
    expect(request.headers.Authorization).toBe(
      'Bearer synthetic-protocol-only',
    );
    const body = JSON.parse(request.body);
    expect(body.provider.only).toEqual(['test-provider/test-region']);
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body).not.toHaveProperty('tools');
    return reply();
  });
  const result = await exerciseOpenRouterProtocol(
    config,
    'routine',
    'Synthetic request envelope',
    manifest,
    io,
  );
  expect(result).toMatchObject({
    status: 'confirmed',
    usage: { inputTokens: 5, outputTokens: 3, actualMicros: 123 },
    outputState: 'validated',
    output,
  });
  expect(io).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('synthetic-protocol-only');
});
it('preserves decimal dollar lexemes and rounds only at the final micro-dollar boundary', () => {
  for (const [input, expected] of [
    ['0', 0],
    ['0.0000001', 1],
    ['1e-7', 1],
    ['0.0100000000000000001', 10001],
    ['0.0099999999999999999', 10000],
    ['50', 50000000],
  ] as const)
    expect(providerDollarsToMicros(input)).toBe(expected);
  const raw = JSON.stringify(packet()).replace(
    '0.000123',
    '0.0100000000000000001',
  );
  expect(decodeOpenRouterTextResponse(raw, profile, manifest)).toMatchObject({
    status: 'confirmed',
    usage: { actualMicros: 10001 },
  });
  for (const invalid of [
    '-1',
    'NaN',
    'Infinity',
    '1e100',
    '1000001',
    '0.'.padEnd(102, '1'),
  ])
    expect(() => providerDollarsToMicros(invalid)).toThrow();
});
it('keeps unknown billing uncertain and preserves only a bounded generation identity', () => {
  for (const usage of [
    undefined,
    { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    { prompt_tokens: 5, completion_tokens: 3, total_tokens: 99, cost: 0.1 },
    { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: -1 },
  ]) {
    const result = decodeOpenRouterTextResponse(
      JSON.stringify(packet({ usage })),
      profile,
      manifest,
    );
    expect(result.status).toBe('uncertain');
    expect(result.output).toBeNull();
    expect(result.generationId).toBe('gen-test123');
  }
  expect(
    decodeOpenRouterTextResponse(
      JSON.stringify(packet({ id: 'private prompt text / forbidden' })),
      profile,
      manifest,
    ).generationId,
  ).toBeNull();
});
it('checks HTTP-200 top-level and choice errors without losing confirmed cost or exposing error content', () => {
  for (const value of [
    packet({ error: { message: 'Private provider failure' } }),
    packet({
      choices: [
        {
          index: 0,
          finish_reason: 'error',
          error: { message: 'Private provider failure' },
          message: { role: 'assistant', content: 'Partial private output' },
        },
      ],
    }),
  ]) {
    const result = decodeOpenRouterTextResponse(
      JSON.stringify(value),
      profile,
      manifest,
    );
    expect(result).toMatchObject({
      status: 'confirmed',
      usage: { actualMicros: 123 },
      outputState: 'provider-error',
      output: null,
    });
    expect(JSON.stringify(result)).not.toContain('Private provider failure');
  }
  expect(
    decodeOpenRouterTextResponse(
      JSON.stringify({ id: 'gen-failed', error: { message: 'Private error' } }),
      profile,
      manifest,
    ),
  ).toMatchObject({
    status: 'uncertain',
    output: null,
    generationId: 'gen-failed',
  });
});
it('rejects changed models, tool/multimodal/refusal results and incomplete or over-limit generations', () => {
  expect(
    decodeOpenRouterTextResponse(
      JSON.stringify(packet({ model: 'other/model' })),
      profile,
      manifest,
    ),
  ).toMatchObject({ status: 'uncertain', reason: 'destination', output: null });
  for (const extra of [
    { tool_calls: [] },
    { images: [] },
    { audio: {} },
    { refusal: 'Private refusal' },
  ]) {
    const result = decodeOpenRouterTextResponse(
      JSON.stringify(
        packet({
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify(output),
                ...extra,
              },
            },
          ],
        }),
      ),
      profile,
      manifest,
    );
    expect(result).toMatchObject({
      status: 'confirmed',
      outputState: 'blocked',
      output: null,
    });
  }
  expect(
    decodeOpenRouterTextResponse(
      JSON.stringify(
        packet({
          choices: [
            {
              index: 0,
              finish_reason: 'length',
              message: { role: 'assistant', content: JSON.stringify(output) },
            },
          ],
        }),
      ),
      profile,
      manifest,
    ),
  ).toMatchObject({
    status: 'confirmed',
    outputState: 'blocked',
    output: null,
  });
  expect(
    decodeOpenRouterTextResponse(
      JSON.stringify(
        packet({
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2001,
            total_tokens: 2006,
            cost: 0.3,
          },
        }),
      ),
      profile,
      manifest,
    ),
  ).toMatchObject({
    status: 'confirmed',
    outputState: 'blocked',
    usage: { actualMicros: 300000 },
  });
});
it('grounds guidance in admitted source versions and discards invalid structured output', () => {
  for (const content of [
    'not JSON',
    JSON.stringify({
      ...output,
      suggestions: [
        {
          source: { kind: 'task', id: randomUUID(), version: 1 },
          note: 'Unknown',
        },
      ],
    }),
    JSON.stringify({ ...output, action: { kind: 'send-email' } }),
  ])
    expect(
      decodeOpenRouterTextResponse(
        JSON.stringify(
          packet({
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content },
              },
            ],
          }),
        ),
        profile,
        manifest,
      ),
    ).toMatchObject({
      status: 'confirmed',
      outputState: 'invalid',
      output: null,
    });
});
it('rejects redirects, foreign response destinations, unsupported MIME and oversized bodies without retrying', async () => {
  for (const response of [
    new Response('moved', { status: 302 }),
    new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json-bad' } }),
    reply(packet(), { 'Content-Length': '9999999999999999999999999' }),
    new Response('x'.repeat(262145), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ]) {
    const io = vi.fn(async () => response);
    expect(
      (
        await exerciseOpenRouterProtocol(
          config,
          'routine',
          'Synthetic',
          manifest,
          io,
        )
      ).status,
    ).toBe('uncertain');
    expect(io).toHaveBeenCalledTimes(1);
  }
  const redirected = reply();
  Object.defineProperty(redirected, 'url', {
    value: 'https://foreign.example.test',
  });
  expect(
    (
      await exerciseOpenRouterProtocol(
        config,
        'routine',
        'Synthetic',
        manifest,
        async () => redirected,
      )
    ).status,
  ).toBe('uncertain');
});
it('blocks cached output while retaining valid reported usage metadata', async () => {
  const result = await exerciseOpenRouterProtocol(
    config,
    'routine',
    'Synthetic',
    manifest,
    async () => reply(packet(), { 'X-OpenRouter-Cache-Status': 'HIT' }),
  );
  expect(result).toMatchObject({
    status: 'confirmed',
    outputState: 'blocked',
    output: null,
    usage: { actualMicros: 123 },
  });
});
it('rejects non-test execution, real credentials and unavailable profiles before calling I/O', async () => {
  const io = vi.fn(async () => reply());
  for (const candidate of [
    { ...config, NODE_ENV: 'development' as const },
    {
      ...config,
      AI_PROVIDER_PROFILES: config.AI_PROVIDER_PROFILES.map((profile) => ({
        ...profile,
        credential: 'real-looking-key',
      })),
    },
  ])
    await expect(
      exerciseOpenRouterProtocol(
        candidate,
        'routine',
        'Synthetic',
        manifest,
        io,
      ),
    ).rejects.toMatchObject({ code: 'DISPATCH_DISABLED' });
  await expect(
    exerciseOpenRouterProtocol(
      {
        ...config,
        AI_PROVIDER_PROFILES: config.AI_PROVIDER_PROFILES.map((profile) => ({
          ...profile,
          enabled: false,
        })),
      },
      'routine',
      'Synthetic',
      manifest,
      io,
    ),
  ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  expect(io).not.toHaveBeenCalled();
});
it('bounds stalled headers/body reads, aborts once and never processes late responses or retries', async () => {
  let signal: AbortSignal | undefined,
    finish: ((response: Response) => void) | undefined;
  const io = vi.fn(async (_url, request) => {
    signal = request.signal;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  expect(
    await exerciseOpenRouterProtocol(
      config,
      'routine',
      'Synthetic',
      manifest,
      io,
      { timeoutMs: 10 },
    ),
  ).toMatchObject({ status: 'uncertain', reason: 'timeout' });
  expect(signal!.aborted).toBe(true);
  expect(io).toHaveBeenCalledTimes(1);
  const cancel = vi.fn();
  const late = new Response(new ReadableStream({ cancel }), {
    headers: { 'Content-Type': 'application/json' },
  });
  finish!(late);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(cancel).toHaveBeenCalledTimes(1);
  const bodyCancel = vi.fn();
  const stalled = new Response(
    new ReadableStream<Uint8Array>({ cancel: bodyCancel }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  expect(
    await exerciseOpenRouterProtocol(
      config,
      'routine',
      'Synthetic',
      manifest,
      async () => stalled,
      { timeoutMs: 10 },
    ),
  ).toMatchObject({ status: 'uncertain', reason: 'timeout' });
  expect(bodyCancel).toHaveBeenCalledTimes(1);
});
it('honors owner cancellation before and during the exchange without sending another request', async () => {
  const controller = new AbortController(),
    io = vi.fn(async () => reply());
  controller.abort();
  expect(
    await exerciseOpenRouterProtocol(
      config,
      'routine',
      'Synthetic',
      manifest,
      io,
      { signal: controller.signal },
    ),
  ).toMatchObject({ status: 'uncertain', reason: 'aborted' });
  expect(io).not.toHaveBeenCalled();
  const live = new AbortController();
  const ongoing = vi.fn(async () => {
    live.abort();
    return reply();
  });
  expect(
    await exerciseOpenRouterProtocol(
      config,
      'routine',
      'Synthetic',
      manifest,
      ongoing,
      { signal: live.signal },
    ),
  ).toMatchObject({ status: 'uncertain', reason: 'aborted' });
  expect(ongoing).toHaveBeenCalledTimes(1);
});
