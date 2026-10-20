import { mailBrokerReadinessSchema } from '@hub/contracts';
import type { Config } from '../config.js';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { readAIRoutingPolicy } from '../features/ai-routing.js';
import { readAIBudget } from '../features/ai-budget.js';
import { liveAllowedLabels, readLiveDestination } from './live-destination.js';
import { readAssistantSettings } from './live-request.js';
import { publicAIRegistry } from './profiles.js';
import { quoteAIProfile, readAIProviderConsent } from './provider-policy.js';
import { liveTermsRevision } from './openrouter-live.js';
import {
  brokerEnvelopeLimit,
  brokerModel,
  brokerOutputTokens,
  brokerUpstream,
  verifyOpenRouterBrokerEndpoint,
} from './broker-protocol.js';
import { jevEnvelopeLimit, jevModel } from './jev-broker-protocol.js';
import { brokerAdapter } from './broker-adapter.js';
import type { BrokerAdapterQuote } from './broker-adapter.js';
import {
  readMailBrokerSettings,
  type MailBrokerAlias,
} from './broker-settings.js';

export const brokerAlias = 'mail-broker';

export async function brokerPolicyForAlias(
  tx: QueryExecutor,
  config: Config,
  owner: string,
  alias: MailBrokerAlias,
) {
  const adapter = brokerAdapter(alias);
  const profile = publicAIRegistry(config.AI_PROVIDER_PROFILES).profiles.find(
    (candidate) => candidate.alias === alias,
  );
  const configured = config.AI_PROVIDER_PROFILES.find(
    (candidate) => candidate.alias === alias,
  );
  const secret = configured?.credential ?? null;
  const consent = await readAIProviderConsent(tx, owner, alias);
  const routing = await readAIRoutingPolicy(tx, owner);
  const downstream = await readLiveDestination(tx, config, owner);
  const settings = await readAssistantSettings(tx, owner);
  const verification =
    alias === 'mail-broker'
      ? profile
        ? {
            revision: `openrouter-mail-envelope-v1-${liveTermsRevision}`,
            profileRevision: profile.policyRevision,
            envelopeByteLimit: brokerEnvelopeLimit,
            inputTokenUpperBound: brokerEnvelopeLimit + 500,
          }
        : null
      : profile
        ? {
            revision: 'jev-direct-api-key-v1',
            profileRevision: profile.policyRevision,
            envelopeByteLimit: jevEnvelopeLimit,
            inputTokenUpperBound: 32000,
            authoritativeUsageBilling: true,
          }
        : null;
  const quote = profile ? quoteAIProfile(profile) : null;
  const blockers: string[] = [];

  if (
    !profile ||
    profile.configuration !== 'configured' ||
    !secret ||
    profile.adapter !== adapter.kind
  )
    blockers.push('PROVIDER_UNAVAILABLE');

  if (alias === 'mail-broker') {
    if (
      !profile ||
      profile.model !== brokerModel ||
      profile.upstreamProvider !== brokerUpstream
    )
      blockers.push('PINNED_MODEL_REQUIRED');
  } else {
    if (
      !profile ||
      profile.model !== jevModel ||
      profile.upstreamProvider !== null
    )
      blockers.push('PINNED_MODEL_REQUIRED');
  }

  if (!profile?.retentionDisclosure) blockers.push('RETENTION_REQUIRED');
  if (
    !profile ||
    !consent.approved ||
    consent.profileRevision !== profile.policyRevision
  )
    blockers.push('CONSENT_REQUIRED');

  if (alias === 'mail-broker') {
    if (
      !quote ||
      quote.maximumChargeMicros < 1 ||
      profile?.maxOutputTokens !== brokerOutputTokens ||
      (verification &&
        quote.inputTokenLimit < verification.inputTokenUpperBound)
    )
      blockers.push('QUOTE_REQUIRED');
  } else if (
    !quote ||
    quote.maximumChargeMicros < 1 ||
    quote.inputTokenLimit > 32000 ||
    profile?.maxOutputTokens !== 1000 ||
    profile?.pricing?.outputMicrosPerMillionTokens !== 0 ||
    profile?.maxInputCharacters > jevEnvelopeLimit
  )
    blockers.push('QUOTE_REQUIRED');

  if (!downstream.destination) blockers.push('DOWNSTREAM_BLOCKED');
  const allowed = liveAllowedLabels(settings).filter(
    (label) =>
      label !== 'restricted' && routing.policy[label].allowed.includes(alias),
  );
  if (!allowed.length) blockers.push('ROUTE_BLOCKED');
  return {
    alias,
    adapter,
    profile,
    secret,
    credentialRevision: null,
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

export async function brokerPolicy(
  tx: QueryExecutor,
  config: Config,
  owner: string,
) {
  const selector = await readMailBrokerSettings(tx, owner);
  return {
    ...(await brokerPolicyForAlias(tx, config, owner, selector.selectedAlias)),
    selector,
  };
}

export function brokerAdapterQuote(
  policy: Awaited<ReturnType<typeof brokerPolicyForAlias>>,
): BrokerAdapterQuote | null {
  if (!policy.profile || !policy.quote || !policy.profile.pricing) return null;
  return {
    inputTokenLimit: policy.quote.inputTokenLimit,
    outputTokenLimit: policy.profile.maxOutputTokens,
    maximumChargeMicros: policy.quote.maximumChargeMicros,
    inputMicrosPerMillionTokens:
      policy.profile.pricing.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens:
      policy.profile.pricing.outputMicrosPerMillionTokens,
    authoritativeUsageBilling: true,
  };
}

export async function brokerReadiness(
  tx: QueryExecutor,
  config: Config,
  owner: string,
) {
  const policy = await brokerPolicy(tx, config, owner);
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
    selectorVersion: policy.selector.version,
    selectedAlias: policy.alias,
    status: blockers.length ? 'blocked' : 'ready',
    blockers,
    profileRevision: policy.profile?.policyRevision ?? null,
    approvalVersion: policy.consent.version,
    downstream: policy.downstream ? 'ready' : 'blocked',
    dispatchConnectedToAgents: true,
    destination: policy.profile
      ? policy.alias === brokerAlias
        ? {
            alias: brokerAlias,
            adapter: 'openrouter' as const,
            model: policy.profile.model,
            router: 'openrouter' as const,
            upstream: policy.profile.upstreamProvider ?? '',
          }
        : {
            alias: 'jev-mail' as const,
            adapter: 'typesafe' as const,
            model: policy.profile.model,
            upstream: null,
          }
      : null,
    endpointStatus: 'unchecked',
  });
}

export function requireBrokerReady(
  policy:
    | Awaited<ReturnType<typeof brokerPolicy>>
    | Awaited<ReturnType<typeof brokerPolicyForAlias>>,
) {
  if (policy.blockers.length)
    throw new ApiError(409, 'MAIL_BROKER_BLOCKED', policy.blockers.join(', '));
}

/** Provider-specific preflight after local readiness, before paid admission. */
export async function verifyBrokerCatalog(
  fetcher: typeof fetch,
  policy: Awaited<ReturnType<typeof brokerPolicy>>,
) {
  requireBrokerReady(policy);
  const quote = brokerAdapterQuote(policy);
  if (!policy.profile || !quote)
    throw new ApiError(409, 'MAIL_BROKER_BLOCKED', 'Broker quote unavailable.');
  return policy.adapter.preflight(fetcher, {
    profile: policy.profile,
    quote,
    verification: policy.verification,
  });
}

/** Kept for existing focused tests and callers of the OpenRouter capability check. */
export const verifyBrokerEndpoint = verifyOpenRouterBrokerEndpoint;
