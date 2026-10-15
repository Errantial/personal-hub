import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SealedEnvelope } from './live-envelope.js';
import { providerDollarsToMicros } from './provider-cost.js';

// Live OpenRouter transport for the planner assistant (docs/ai-assistant.md).
// One request per call: no retries, no redirects, bounded bodies. Callers must
// hold a budget reservation, marked uncertain, before calling exchange().

export type OpenRouterFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
export const chatUrl = 'https://openrouter.ai/api/v1/chat/completions';
export const modelsUrl = 'https://openrouter.ai/api/v1/models';
export const zdrUrl = 'https://openrouter.ai/api/v1/endpoints/zdr';

/**
 * The hosts allowed to serve each model author: the author itself, plus the
 * major clouds that host its models under their own terms (Claude on Vertex
 * and Bedrock, OpenAI on Azure). Every request still requires zero data
 * retention, so only hosts with a ZDR endpoint ever serve it. Requests never
 * leave this list; other authors are not supported.
 */
const hosts: Record<string, string[]> = {
  anthropic: ['anthropic', 'google-vertex', 'amazon-bedrock'],
  openai: ['openai', 'azure'],
  google: ['google-vertex'],
  mistralai: ['mistral'],
  'x-ai': ['xai'],
  deepseek: ['deepseek'],
};
export const hostsFor = (model: string) => hosts[model.split('/')[0]!] ?? null;

/**
 * The terms every live destination is approved under: OpenRouter as the
 * intermediary, zero data retention, no data collection, no fallbacks.
 * Changing this revision makes every approval stale.
 */
export const liveTermsRevision = 'openrouter-zdr-v1';
export const destinationRevision = (model: string, upstream: string) =>
  createHash('sha256')
    .update(JSON.stringify(['openrouter', model, upstream, liveTermsRevision]))
    .digest('hex');

/** OpenRouter routing pinned to one approved upstream: ZDR only, no fallback. */
export function pinnedRouting(upstream: string) {
  return {
    only: [upstream],
    order: [upstream],
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: 'deny',
    zdr: true,
  };
}

/** Dollars per token or per request, as OpenRouter publishes them. */
export type ModelPrice = {
  prompt: number;
  completion: number;
  request: number;
};
const price = z
  .string()
  .regex(/^\d+(\.\d+)?([eE][+-]?\d+)?$/)
  .transform(Number);
const catalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      architecture: z
        .object({
          input_modalities: z.array(z.string()).optional(),
          output_modalities: z.array(z.string()).optional(),
        })
        .optional(),
      pricing: z.object({
        prompt: z.string(),
        completion: z.string(),
        request: z.string().optional(),
      }),
    }),
  ),
});
const catalogs = new WeakMap<
  OpenRouterFetch,
  { at: number; prices: Map<string, ModelPrice> }
>();

/** Bounded read of a response body; null when it exceeds the limit. */
async function readBody(response: Response, limit: number) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.concat(chunks),
  );
}

/**
 * The published price of a text model, from OpenRouter's public catalog
 * (cached for an hour). Null when the model is missing, not text-to-text or
 * has a variable price. The catalog request carries no key and no owner data.
 */
export async function modelPrice(
  fetcher: OpenRouterFetch,
  model: string,
  now = Date.now(),
): Promise<ModelPrice | null> {
  let catalog = catalogs.get(fetcher);
  if (!catalog || now - catalog.at > 3600000) {
    const response = await fetcher(modelsUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 200) throw new Error('Catalog unavailable');
    const raw = await readBody(response, 32 * 1024 * 1024);
    if (raw === null) throw new Error('Catalog too large');
    const prices = new Map<string, ModelPrice>();
    for (const entry of catalogSchema.parse(JSON.parse(raw)).data) {
      const modalities = entry.architecture;
      if (
        (modalities?.input_modalities &&
          !modalities.input_modalities.includes('text')) ||
        (modalities?.output_modalities &&
          !modalities.output_modalities.includes('text'))
      )
        continue;
      const values = [
        price.safeParse(entry.pricing.prompt),
        price.safeParse(entry.pricing.completion),
        price.safeParse(entry.pricing.request ?? '0'),
      ];
      if (values.every((value) => value.success))
        prices.set(entry.id, {
          prompt: values[0]!.data!,
          completion: values[1]!.data!,
          request: values[2]!.data!,
        });
    }
    catalog = { at: now, prices };
    catalogs.set(fetcher, catalog);
  }
  return catalog.prices.get(model) ?? null;
}

const zdrSchema = z.object({
  data: z.array(
    z.object({
      model_id: z.string(),
      tag: z.string(),
      supported_parameters: z.array(z.string()).optional(),
    }),
  ),
});
const zdrLists = new WeakMap<
  OpenRouterFetch,
  { at: number; models: Map<string, Set<string>> }
>();

/**
 * The allowed hosts serving each model with zero data retention and strict
 * JSON output, from OpenRouter's public ZDR endpoint list (cached for an
 * hour). The request carries no key and no owner data.
 */
async function privateHosts(
  fetcher: OpenRouterFetch,
  model: string,
  now: number,
) {
  let list = zdrLists.get(fetcher);
  if (!list || now - list.at > 3600000) {
    const response = await fetcher(zdrUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 200) throw new Error('ZDR list unavailable');
    const raw = await readBody(response, 32 * 1024 * 1024);
    if (raw === null) throw new Error('ZDR list too large');
    const models = new Map<string, Set<string>>();
    for (const endpoint of zdrSchema.parse(JSON.parse(raw)).data) {
      const host = endpoint.tag.split('/')[0]!;
      if (
        hostsFor(endpoint.model_id)?.includes(host) &&
        endpoint.supported_parameters?.includes('structured_outputs')
      )
        models.set(
          endpoint.model_id,
          (models.get(endpoint.model_id) ?? new Set()).add(host),
        );
    }
    list = { at: now, models };
    zdrLists.set(fetcher, list);
  }
  return list.models.get(model) ?? new Set<string>();
}

/** Whether the pinned upstream serves the model privately. */
export async function hasPrivateHost(
  fetcher: OpenRouterFetch,
  model: string,
  upstream: string,
  now = Date.now(),
) {
  return (await privateHosts(fetcher, model, now)).has(upstream);
}

/**
 * An upper bound on the charge, in microdollars. Every UTF-8 byte of the
 * request counts as a prompt token (tokens are never smaller than a byte),
 * plus template overhead, the full output allowance and a 25% margin.
 */
export function worstCaseMicros(
  cost: ModelPrice,
  requestBytes: number,
  maxOutputTokens: number,
) {
  const dollars =
    ((requestBytes + 500) * cost.prompt +
      maxOutputTokens * cost.completion +
      cost.request) *
    1.25;
  return Math.max(1, Math.ceil(dollars * 1e6));
}

export type ExchangeResult =
  | {
      /** Refused before processing: nothing was charged. */
      status: 'rejected';
      reason:
        | 'unauthorized'
        | 'payment-required'
        | 'unavailable'
        | 'rate-limited'
        | 'rejected';
    }
  | {
      /** The charge is unknown; the hold must stay. Never resend. */
      status: 'uncertain';
      reason: 'timeout' | 'transport' | 'response' | 'billing';
      generationId: string | null;
    }
  | {
      status: 'confirmed';
      generationId: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        actualMicros: number;
      };
      /** The text answer, or null when the output can't be used. */
      content: string | null;
      outputState: 'validated' | 'provider-error' | 'blocked';
    };

// Cost lexemes keep the provider's decimal text before float rounding.
class DollarLexeme {
  constructor(readonly source: string) {}
}
const tokens = z.number().int().min(0).max(2000000);
const generation = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const envelopeSchema = z.object({
  id: generation,
  model: z.string().min(1).max(200),
  usage: z.object({
    prompt_tokens: tokens,
    completion_tokens: tokens,
    total_tokens: tokens,
    cost: z.instanceof(DollarLexeme),
  }),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        error: z.unknown().optional(),
        message: z.object({
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

/** Decodes a 200 chat-completions body. Exported for tests. */
export function decodeCompletion(
  raw: string,
  model: string,
  maxOutputTokens: number,
): ExchangeResult {
  let id: string | null = null;
  try {
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
    const result = envelopeSchema.safeParse(value);
    if (!result.success)
      return { status: 'uncertain', reason: 'billing', generationId: id };
    const body = result.data;
    if (
      body.usage.total_tokens !==
      body.usage.prompt_tokens + body.usage.completion_tokens
    )
      return { status: 'uncertain', reason: 'billing', generationId: id };
    let actualMicros: number;
    try {
      actualMicros = providerDollarsToMicros(body.usage.cost.source);
    } catch {
      return { status: 'uncertain', reason: 'billing', generationId: id };
    }
    const usage = {
      inputTokens: body.usage.prompt_tokens,
      outputTokens: body.usage.completion_tokens,
      actualMicros,
    };
    const choice = body.choices[0]!;
    if (body.error !== undefined || choice.error !== undefined)
      return {
        status: 'confirmed',
        generationId: body.id,
        usage,
        content: null,
        outputState: 'provider-error',
      };
    // A different model means the no-fallback rule was broken: keep the
    // charge, discard the output.
    const sameModel = body.model === model;
    if (
      !sameModel ||
      choice.finish_reason !== 'stop' ||
      choice.message.refusal != null ||
      choice.message.tool_calls != null ||
      choice.message.images != null ||
      choice.message.audio != null ||
      body.usage.completion_tokens > maxOutputTokens ||
      !choice.message.content
    )
      return {
        status: 'confirmed',
        generationId: body.id,
        usage,
        content: null,
        outputState: 'blocked',
      };
    return {
      status: 'confirmed',
      generationId: body.id,
      usage,
      content: choice.message.content,
      outputState: 'validated',
    };
  } catch {
    return { status: 'uncertain', reason: 'response', generationId: id };
  }
}

const rejections: Record<number, ExchangeResult & { status: 'rejected' }> = {
  400: { status: 'rejected', reason: 'rejected' },
  401: { status: 'rejected', reason: 'unauthorized' },
  402: { status: 'rejected', reason: 'payment-required' },
  403: { status: 'rejected', reason: 'rejected' },
  404: { status: 'rejected', reason: 'unavailable' },
  413: { status: 'rejected', reason: 'rejected' },
  422: { status: 'rejected', reason: 'rejected' },
  429: { status: 'rejected', reason: 'rate-limited' },
};

/**
 * Sends one sealed chat-completions request: exactly the bytes bound at
 * admission. The key is never logged or returned.
 */
export function exchange(
  fetcher: OpenRouterFetch,
  key: string,
  sealed: SealedEnvelope,
  timeoutMs = 45000,
) {
  return send(
    fetcher,
    key,
    sealed.bytes,
    sealed.model,
    sealed.maxTokens,
    timeoutMs,
  );
}

async function send(
  fetcher: OpenRouterFetch,
  key: string,
  bytes: string,
  model: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<ExchangeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(chatUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Cache': 'false',
        'X-Title': 'Personal Hub',
      },
      body: bytes,
      redirect: 'error',
      signal: controller.signal,
    });
    const rejected = rejections[response.status];
    if (rejected) {
      await response.body?.cancel();
      return rejected;
    }
    if (
      response.status !== 200 ||
      response.headers.get('content-type')?.split(';')[0]?.trim() !==
        'application/json'
    ) {
      await response.body?.cancel();
      return { status: 'uncertain', reason: 'response', generationId: null };
    }
    const raw = await readBody(response, 262144);
    if (raw === null)
      return { status: 'uncertain', reason: 'response', generationId: null };
    const decoded = decodeCompletion(raw, model, maxTokens);
    // A cache hit contradicts the no-cache request: keep the charge only.
    return response.headers.has('X-OpenRouter-Cache-Status') &&
      decoded.status === 'confirmed'
      ? { ...decoded, content: null, outputState: 'blocked' }
      : decoded;
  } catch {
    return {
      status: 'uncertain',
      reason: controller.signal.aborted ? 'timeout' : 'transport',
      generationId: null,
    };
  } finally {
    clearTimeout(timer);
  }
}
