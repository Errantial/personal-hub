import { z } from 'zod';
import { mailBrokerReadinessSchema } from '@hub/contracts';
import type { Config } from '../config.js';
import type { QueryExecutor } from '../db/database.js';
import { publicAIRegistry } from './profiles.js';
import { readAIProviderConsent, quoteAIProfile } from './provider-policy.js';
import { readAIRoutingPolicy } from '../features/ai-routing.js';
import { readLiveDestination, liveAllowedLabels } from './live-destination.js';
import { readAssistantSettings } from './live-request.js';
import { ApiError } from '../errors.js';
import { readAIBudget } from '../features/ai-budget.js';

export const jevAlias = 'jev-mail';
export const jevEndpoint = 'https://api.typesafe.ai/v1/systemone';
const verificationSchema = z.strictObject({
  revision: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
  profileRevision: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime(),
  accountTermsZeroRetention: z.literal(true),
  completeEnvelopeTokenBound: z.literal(true),
  authoritativeUsageBilling: z.literal(true),
  envelopeByteLimit: z.number().int().min(1024).max(20480),
  inputTokenUpperBound: z.number().int().min(1).max(32000),
});
// Operator evidence, not a caller-controlled approval or a claim inferred from
// vendor advertising. Missing evidence keeps even a configured key blocked.
export function readJevVerification(encoded: string | undefined) {
  if (!encoded) return null;
  try {
    return verificationSchema.parse(JSON.parse(encoded));
  } catch {
    throw new Error('Invalid environment configuration: TYPESAFE_VERIFICATION');
  }
}

export async function jevPolicy(
  tx: QueryExecutor,
  config: Config,
  owner: string,
) {
  const profile = publicAIRegistry(config.AI_PROVIDER_PROFILES).profiles.find(
    (p) => p.alias === jevAlias,
  );
  const secret = config.AI_PROVIDER_PROFILES.find(
    (p) => p.alias === jevAlias,
  )?.credential;
  const consent = await readAIProviderConsent(tx, owner, jevAlias);
  const routing = await readAIRoutingPolicy(tx, owner);
  const downstream = await readLiveDestination(tx, config, owner);
  const settings = await readAssistantSettings(tx, owner);
  const verification = config.TYPESAFE_VERIFICATION;
  const quote = profile ? quoteAIProfile(profile) : null;
  const blockers: string[] = [];
  if (
    !profile ||
    profile.adapter !== 'typesafe' ||
    profile.configuration !== 'configured' ||
    !secret
  )
    blockers.push('PROVIDER_UNAVAILABLE');
  if (!profile || !/^jev-\d+\.\d+\.\d+$/.test(profile.model))
    blockers.push('PINNED_MODEL_REQUIRED');
  if (
    !profile?.retentionDisclosure ||
    !verification ||
    verification.profileRevision !== profile.policyRevision ||
    Date.parse(verification.expiresAt) <= Date.now()
  )
    blockers.push('ACCOUNT_VERIFICATION_REQUIRED');
  if (
    !profile ||
    !consent.approved ||
    consent.profileRevision !== profile.policyRevision
  )
    blockers.push('CONSENT_REQUIRED');
  if (
    !quote ||
    quote.maximumChargeMicros < 1 ||
    quote.inputTokenLimit > 32000 ||
    profile?.pricing?.outputMicrosPerMillionTokens !== 0 ||
    (verification && quote.inputTokenLimit < verification.inputTokenUpperBound)
  )
    blockers.push('QUOTE_REQUIRED');
  if (!downstream.destination) blockers.push('DOWNSTREAM_BLOCKED');
  const allowed = liveAllowedLabels(settings).filter(
    (label) =>
      label !== 'restricted' &&
      routing.policy[label].allowed.includes(jevAlias),
  );
  if (!allowed.length) blockers.push('ROUTE_BLOCKED');
  return {
    profile,
    secret,
    consent,
    routing,
    downstream: downstream.destination,
    settingsVersion: settings.version,
    allowed,
    verification,
    quote,
    blockers,
  };
}
export async function jevReadiness(
  tx: QueryExecutor,
  config: Config,
  owner: string,
) {
  const policy = await jevPolicy(tx, config, owner);
  const budget = await readAIBudget(tx, owner);
  const blockers = [...policy.blockers];
  if (
    budget.policy.monthlyLimitMicros === null ||
    budget.policy.perRequestLimitMicros === null
  )
    blockers.push('BUDGET_UNSET');
  else if (
    policy.quote &&
    (policy.quote.maximumChargeMicros >= budget.policy.perRequestLimitMicros ||
      BigInt(budget.usage.spentMicros) +
        BigInt(budget.usage.heldMicros) +
        BigInt(policy.quote.maximumChargeMicros) >=
        BigInt(budget.policy.monthlyLimitMicros))
  )
    blockers.push('BUDGET_EXHAUSTED');
  return mailBrokerReadinessSchema.parse({
    status: blockers.length ? 'blocked' : 'ready',
    blockers,
    profileRevision: policy.profile?.policyRevision ?? null,
    approvalVersion: policy.consent.version,
    downstream: policy.downstream ? 'ready' : 'blocked',
    dispatchConnectedToAgents: true,
  });
}
export function requireJevReady(policy: Awaited<ReturnType<typeof jevPolicy>>) {
  if (policy.blockers.length)
    throw new ApiError(409, 'MAIL_BROKER_BLOCKED', policy.blockers.join(', '));
}
