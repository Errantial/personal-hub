import { z } from 'zod';
import { aiContextManifestSchema, aiTextOutputSchema } from '@hub/contracts';
import type {
  AIContextManifest,
  AIProviderRegistry,
  AITextOutput,
} from '@hub/contracts';
import { providerDollarsToMicros } from './provider-cost.js';

class EstimateLexeme {
  constructor(readonly source: string) {}
}
const token = z.number().int().min(0).max(2000000);
const modelUsage = z.object({
  inputTokens: token,
  outputTokens: token,
  cacheReadInputTokens: token,
  cacheCreationInputTokens: token,
  costUSD: z.instanceof(EstimateLexeme),
});
const envelope = z.object({
  type: z.literal('result'),
  subtype: z.string().min(1).max(100),
  is_error: z.boolean(),
  num_turns: z.number().int().min(0).max(10000),
  result: z.string().max(100000).optional(),
  total_cost_usd: z.instanceof(EstimateLexeme),
  modelUsage: z.record(z.string().min(1).max(100), modelUsage),
  permission_denials: z.array(z.unknown()).max(100),
  structured_output: z.unknown().optional(),
});
export interface ClaudeUsageEstimate {
  scope: 'unverified';
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalEstimatedMicros: number;
  modelEstimatedMicros: number;
}
export interface ClaudeResponseInspection {
  dispatchEnabled: false;
  billing: 'unverified';
  accounting: 'unsettled';
  outputState:
    'validated' | 'invalid' | 'blocked' | 'provider-error' | 'unavailable';
  reason:
    | null
    | 'profile'
    | 'response'
    | 'usage'
    | 'destination'
    | 'execution'
    | 'turns'
    | 'permissions'
    | 'limits'
    | 'output';
  usageEstimate: ClaudeUsageEstimate | null;
  output: AITextOutput | null;
}

// Pure inspection only. No process, network, account, persistence, settlement or
// authorization. A decoded CLI estimate must never become actualMicros or a
// zero-dollar subscription invoice. Result metadata cannot prove isolation.
export function decodeClaudeSubscriptionResponse(
  raw: string | Uint8Array,
  exitCode: number | null,
  profile: AIProviderRegistry['profiles'][number],
  manifest: AIContextManifest,
): ClaudeResponseInspection {
  const base = {
    dispatchEnabled: false,
    billing: 'unverified',
    accounting: 'unsettled',
    usageEstimate: null,
    output: null,
  } as const;
  const rejected = (
    reason: ClaudeResponseInspection['reason'],
  ): ClaudeResponseInspection => ({
    ...base,
    outputState: 'unavailable',
    reason,
  });
  if (
    profile.adapter !== 'claude-code' ||
    profile.accessMode !== 'owner-subscription' ||
    profile.configuration !== 'configured' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(profile.model) ||
    ['sonnet', 'opus', 'haiku', 'fable', 'default', 'latest'].includes(
      profile.model.toLowerCase(),
    ) ||
    profile.model.toLowerCase().endsWith('-latest')
  )
    return rejected('profile');
  try {
    if (raw.length > 262144) return rejected('response');
    const text =
      typeof raw === 'string'
        ? raw
        : new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (Buffer.byteLength(text, 'utf8') > 262144) return rejected('response');
    const parse = JSON.parse as (
      text: string,
      reviver: (
        key: string,
        value: unknown,
        context?: { source?: string },
      ) => unknown,
    ) => unknown;
    const value = parse(text, (key, value, context) =>
      ['total_cost_usd', 'costUSD'].includes(key) &&
      typeof value === 'number' &&
      context?.source
        ? new EstimateLexeme(context.source)
        : value,
    );
    const packet = envelope.safeParse(value);
    if (!packet.success) return rejected('response');
    const parsed = packet.data;
    const entries = Object.entries(parsed.modelUsage);
    if (entries.length !== 1 || entries[0]![0] !== profile.model)
      return rejected('destination');
    const usage = entries[0]![1];
    let usageEstimate: ClaudeUsageEstimate;
    try {
      usageEstimate = {
        scope: 'unverified',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        totalEstimatedMicros: providerDollarsToMicros(
          parsed.total_cost_usd.source,
        ),
        modelEstimatedMicros: providerDollarsToMicros(usage.costUSD.source),
      };
      // A single-model total must agree to the retained precision. This is only
      // a consistency check, never proof of billing or request-only scope.
      if (
        usageEstimate.totalEstimatedMicros !==
          usageEstimate.modelEstimatedMicros ||
        usage.inputTokens +
          usage.cacheReadInputTokens +
          usage.cacheCreationInputTokens >
          2000000
      )
        return rejected('usage');
    } catch {
      return rejected('usage');
    }
    const observed = { ...base, usageEstimate };
    if (exitCode !== 0 || parsed.is_error || parsed.subtype !== 'success')
      return {
        ...observed,
        outputState: 'provider-error',
        reason: 'execution',
      };
    if (parsed.num_turns !== 1)
      return { ...observed, outputState: 'blocked', reason: 'turns' };
    if (parsed.permission_denials.length !== 0)
      return { ...observed, outputState: 'blocked', reason: 'permissions' };
    if (
      !Number.isInteger(profile.maxOutputTokens) ||
      profile.maxOutputTokens < 1 ||
      usage.outputTokens > profile.maxOutputTokens
    )
      return { ...observed, outputState: 'blocked', reason: 'limits' };
    try {
      // The prepared print request uses result text, not schema/tool output.
      if (parsed.structured_output !== undefined) throw Error();
      const output = aiTextOutputSchema.parse(JSON.parse(parsed.result ?? ''));
      const context = aiContextManifestSchema.parse(manifest);
      if (
        !output.suggestions.every(({ source }) =>
          context.sources.some(
            (ref) =>
              ref.kind === source.kind &&
              ref.id.toLowerCase() === source.id.toLowerCase() &&
              ref.version === source.version,
          ),
        )
      )
        throw Error();
      return { ...observed, outputState: 'validated', reason: null, output };
    } catch {
      return { ...observed, outputState: 'invalid', reason: 'output' };
    }
  } catch {
    return rejected('response');
  }
}
