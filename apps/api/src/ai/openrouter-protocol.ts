import { z } from 'zod';
import { aiTextOutputSchema, aiContextManifestSchema } from '@hub/contracts';
import type { AIContextManifest, AIProviderRegistry } from '@hub/contracts';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';
import { publicAIRegistry } from './profiles.js';
import { buildOpenRouterTextRequest } from './openrouter-request.js';

type Profile = AIProviderRegistry['profiles'][number];
const token = z.number().int().min(0).max(2000000);
// Source lexemes preserve provider dollar numbers before binary float rounding.
class DollarLexeme {
  constructor(readonly source: string) {}
}
export function providerDollarsToMicros(source: string) {
  if (source.length > 100) throw new Error('Invalid cost');
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) throw new Error('Invalid cost');
  const fraction = match[2] ?? '',
    exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30)
    throw new Error('Invalid cost');
  const digits = BigInt(match[1]! + fraction),
    power = exponent - fraction.length + 6;
  const value =
    power >= 0
      ? digits * 10n ** BigInt(power)
      : (digits + 10n ** BigInt(-power) - 1n) / 10n ** BigInt(-power);
  if (value > 1000000000000n) throw new Error('Invalid cost');
  return Number(value);
}
const usageSchema = z.object({
  prompt_tokens: token,
  completion_tokens: token,
  total_tokens: token,
  cost: z.instanceof(DollarLexeme),
});
const generation = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const envelopeSchema = z.object({
  id: generation,
  model: z.string().min(1).max(100),
  usage: usageSchema,
  choices: z
    .array(
      z.object({
        index: z.number().int(),
        finish_reason: z.string(),
        error: z.unknown().optional(),
        message: z.object({
          role: z.literal('assistant'),
          content: z.string().max(100000).nullable(),
          refusal: z.unknown().optional(),
          tool_calls: z.unknown().optional(),
          images: z.unknown().optional(),
          audio: z.unknown().optional(),
        }),
      }),
    )
    .length(1),
  error: z.unknown().optional(),
});
export type OpenRouterProtocolResult =
  | {
      status: 'uncertain';
      reason:
        | 'transport'
        | 'timeout'
        | 'aborted'
        | 'response'
        | 'destination'
        | 'billing';
      generationId: string | null;
      output: null;
    }
  | {
      status: 'confirmed';
      generationId: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        actualMicros: number;
      };
      output: z.infer<typeof aiTextOutputSchema> | null;
      outputState: 'validated' | 'invalid' | 'provider-error' | 'blocked';
    };

export function decodeOpenRouterTextResponse(
  raw: string,
  profile: Profile,
  manifest: AIContextManifest,
): OpenRouterProtocolResult {
  let id: string | null = null;
  try {
    // Node 24 exposes the original primitive source to JSON.parse revivers.
    const parse = JSON.parse as (
      text: string,
      reviver: (
        key: string,
        value: unknown,
        context?: { source?: string },
      ) => unknown,
    ) => unknown;
    const value = parse(raw, (key, value, context) =>
      key === 'cost' && typeof value === 'number' && context?.source
        ? new DollarLexeme(context.source)
        : value,
    );
    if (value && typeof value === 'object' && 'id' in value) {
      const parsed = generation.safeParse(value.id);
      if (parsed.success) id = parsed.data;
    }
    const response = envelopeSchema.safeParse(value);
    if (!response.success)
      return {
        status: 'uncertain',
        reason: 'response',
        generationId: id,
        output: null,
      };
    const parsed = response.data;
    if (parsed.model !== profile.model)
      return {
        status: 'uncertain',
        reason: 'destination',
        generationId: id,
        output: null,
      };
    let actualMicros: number;
    try {
      actualMicros = providerDollarsToMicros(parsed.usage.cost.source);
    } catch {
      return {
        status: 'uncertain',
        reason: 'billing',
        generationId: id,
        output: null,
      };
    }
    if (
      parsed.usage.total_tokens !==
      parsed.usage.prompt_tokens + parsed.usage.completion_tokens
    )
      return {
        status: 'uncertain',
        reason: 'billing',
        generationId: id,
        output: null,
      };
    const usage = {
      inputTokens: parsed.usage.prompt_tokens,
      outputTokens: parsed.usage.completion_tokens,
      actualMicros,
    };
    const choice = parsed.choices[0]!;
    if (
      parsed.error !== undefined ||
      choice.error !== undefined ||
      choice.finish_reason === 'error'
    )
      return {
        status: 'confirmed',
        generationId: parsed.id,
        usage,
        output: null,
        outputState: 'provider-error',
      };
    if (
      choice.finish_reason !== 'stop' ||
      choice.index !== 0 ||
      choice.message.refusal != null ||
      choice.message.tool_calls != null ||
      choice.message.images != null ||
      choice.message.audio != null ||
      parsed.usage.completion_tokens > profile.maxOutputTokens ||
      !profile.pricing ||
      parsed.usage.prompt_tokens > profile.pricing.inputTokenLimit
    )
      return {
        status: 'confirmed',
        generationId: parsed.id,
        usage,
        output: null,
        outputState: 'blocked',
      };
    try {
      const result = aiTextOutputSchema.parse(
        JSON.parse(choice.message.content ?? ''),
      );
      const context = aiContextManifestSchema.parse(manifest);
      if (
        !result.suggestions.every(({ source }) =>
          context.sources.some(
            (ref) =>
              ref.kind === source.kind &&
              ref.id === source.id.toLowerCase() &&
              ref.version === source.version,
          ),
        )
      )
        throw new Error('Unmatched source');
      return {
        status: 'confirmed',
        generationId: parsed.id,
        usage,
        output: result,
        outputState: 'validated',
      };
    } catch {
      return {
        status: 'confirmed',
        generationId: parsed.id,
        usage,
        output: null,
        outputState: 'invalid',
      };
    }
  } catch {
    return {
      status: 'uncertain',
      reason: 'response',
      generationId: id,
      output: null,
    };
  }
}

export type OpenRouterTestIO = (
  url: string,
  request: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    redirect: 'error';
    signal: AbortSignal;
  },
) => Promise<Response>;
// Offline protocol harness only. No default fetch, production switch or HTTP
// dispatch endpoint can reach this. Real credentials are rejected before I/O.
export async function exerciseOpenRouterProtocol(
  config: Config,
  alias: string,
  payload: string,
  manifest: AIContextManifest,
  io: OpenRouterTestIO,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<OpenRouterProtocolResult> {
  const privateProfile = config.AI_PROVIDER_PROFILES.find(
    (profile) => profile.alias === alias,
  );
  if (
    config.NODE_ENV !== 'test' ||
    !privateProfile?.credential?.startsWith('synthetic-')
  )
    throw new ApiError(
      409,
      'DISPATCH_DISABLED',
      'Protocol exercises require synthetic test configuration.',
    );
  const profile = publicAIRegistry(config.AI_PROVIDER_PROFILES).profiles.find(
    (profile) => profile.alias === alias,
  )!;
  const context = aiContextManifestSchema.parse(manifest),
    prepared = buildOpenRouterTextRequest(profile, payload);
  const timeoutMs = z
    .number()
    .int()
    .min(1)
    .max(30000)
    .parse(options.timeoutMs ?? 30000);
  if (options.signal?.aborted)
    return {
      status: 'uncertain',
      reason: 'aborted',
      generationId: null,
      output: null,
    };
  const controller = new AbortController();
  let timedOut = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectStop: (reason: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  const abort = () => {
    controller.abort();
    void reader?.cancel().catch(() => {});
    rejectStop(new Error('Aborted'));
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
    const work = async (): Promise<OpenRouterProtocolResult> => {
      const response = await io(prepared.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${privateProfile.credential}`,
          'Content-Type': 'application/json',
          'X-OpenRouter-Cache': 'false',
        },
        body: JSON.stringify(prepared.body),
        redirect: 'error',
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        await response.body?.cancel();
        throw new Error('Aborted');
      }
      if (
        response.redirected ||
        (response.url !== '' && response.url !== prepared.url) ||
        response.status !== 200 ||
        response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase() !== 'application/json' ||
        !response.body
      ) {
        await response.body?.cancel();
        return {
          status: 'uncertain',
          reason: 'response',
          generationId: null,
          output: null,
        };
      }
      const length = response.headers.get('content-length');
      if (
        length !== null &&
        (length.length > 12 ||
          !/^\d+$/.test(length) ||
          BigInt(length) > 262144n)
      ) {
        await response.body.cancel();
        return {
          status: 'uncertain',
          reason: 'response',
          generationId: null,
          output: null,
        };
      }
      reader = response.body.getReader();
      let total = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        if (controller.signal.aborted) throw new Error('Aborted');
        const next = await reader.read();
        if (controller.signal.aborted) throw new Error('Aborted');
        if (next.done) break;
        total += next.value.byteLength;
        if (total > 262144) {
          await reader.cancel();
          return {
            status: 'uncertain',
            reason: 'response',
            generationId: null,
            output: null,
          };
        }
        chunks.push(next.value);
      }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      const decoded = decodeOpenRouterTextResponse(raw, profile, context);
      // A cache header contradicts the explicit no-cache request. Keep confirmed
      // usage, but do not accept or retain the returned text.
      if (
        response.headers.has('X-OpenRouter-Cache-Status') &&
        decoded.status === 'confirmed'
      )
        return { ...decoded, output: null, outputState: 'blocked' };
      return decoded;
    };
    return await Promise.race([work(), stopped]);
  } catch {
    return {
      status: 'uncertain',
      reason: timedOut
        ? 'timeout'
        : options.signal?.aborted
          ? 'aborted'
          : 'transport',
      generationId: null,
      output: null,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
