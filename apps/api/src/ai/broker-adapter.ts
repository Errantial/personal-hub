import { z } from 'zod';
import type { BrokerCandidate } from './mail-broker.js';
import type { MailBrokerAlias } from './broker-settings.js';
import { openRouterBrokerAdapter } from './broker-protocol.js';
import { jevBrokerAdapter } from './jev-broker-protocol.js';

export type BrokerAdapterProfile = {
  model: string;
  upstreamProvider: string | null;
  maxInputCharacters: number;
  maxOutputTokens: number;
  pricing: {
    inputMicrosPerMillionTokens: number;
    outputMicrosPerMillionTokens: number;
  } | null;
};

export type BrokerAdapterQuote = {
  inputTokenLimit: number;
  outputTokenLimit: number;
  maximumChargeMicros: number;
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  authoritativeUsageBilling: boolean;
};

export type BrokerPreflightPolicy = {
  profile: BrokerAdapterProfile;
  quote: BrokerAdapterQuote;
  verification: unknown;
};

export const brokerDecisionSchema = z.union([
  z.strictObject({
    method: z.literal('enum'),
    id: z.string(),
    judgment: z.enum([
      'irrelevant',
      'possibly_relevant',
      'directly_relevant',
      'insufficient_evidence',
    ]),
    selected: z.boolean(),
  }),
  z.strictObject({
    method: z.literal('score'),
    id: z.string(),
    score: z.number().finite(),
    confidence: z.number().finite().min(0).max(1),
    relevantProbability: z.number().finite().min(0).max(1),
    selected: z.boolean(),
  }),
]);
export type BrokerDecision = z.infer<typeof brokerDecisionSchema>;

const legacyOpenRouterDecisionSchema = z.strictObject({
  id: z.string(),
  judgment: z.enum([
    'irrelevant',
    'possibly_relevant',
    'directly_relevant',
    'insufficient_evidence',
  ]),
  selected: z.boolean(),
});

export function readBrokerDecision(value: unknown): BrokerDecision {
  const current = brokerDecisionSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacyOpenRouterDecisionSchema.parse(value);
  return { method: 'enum', ...legacy };
}

export type BrokerExchange =
  | {
      status: 'uncertain';
      reason: 'transport' | 'timeout' | 'response' | 'billing';
    }
  | {
      status: 'confirmed';
      reason: 'response' | null;
      usage: {
        inputTokens: number;
        outputTokens: number;
        actualMicros: number;
      };
      decisions: BrokerDecision[];
    };

export type BrokerAdapter = {
  kind: 'openrouter' | 'typesafe';
  alias: MailBrokerAlias;
  rubricRevision: string;
  boundsRevision: string;
  thresholdRevision: string;
  fitCandidates: (
    profile: BrokerAdapterProfile,
    intent: string,
    candidates: BrokerCandidate[],
  ) => BrokerCandidate[];
  buildEnvelope: (
    profile: BrokerAdapterProfile,
    intent: string,
    candidates: BrokerCandidate[],
  ) => string;
  preflight: (
    fetcher: typeof fetch,
    policy: BrokerPreflightPolicy,
  ) => Promise<void>;
  exchange: (
    fetcher: typeof fetch,
    secret: string,
    exactBytes: string,
    model: string,
    candidates: BrokerCandidate[],
    quote: BrokerAdapterQuote,
    timeoutMs?: number,
  ) => Promise<BrokerExchange>;
};

export function brokerAdapter(alias: MailBrokerAlias): BrokerAdapter {
  return alias === 'mail-broker' ? openRouterBrokerAdapter : jevBrokerAdapter;
}
