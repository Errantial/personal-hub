import { mailBrokerReadinessSchema } from '@hub/contracts';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { QueryExecutor } from '../db/database.js';
import { publicAIRegistry } from './profiles.js';
import { readAIProviderConsent, quoteAIProfile } from './provider-policy.js';
import { readAIRoutingPolicy } from '../features/ai-routing.js';
import { readLiveDestination, liveAllowedLabels } from './live-destination.js';
import { readAssistantSettings } from './live-request.js';
import { ApiError } from '../errors.js';
import { readAIBudget } from '../features/ai-budget.js';

import {
  brokerModel,
  brokerUpstream,
  brokerOutputTokens,
  brokerEnvelopeLimit,
} from './broker-protocol.js';
import {
  modelPrice,
  liveTermsRevision,
  zdrUrl,
  readBody,
} from './openrouter-live.js';
import type { OpenRouterFetch } from './openrouter-live.js';

export const brokerAlias = 'mail-broker';

export async function brokerPolicy(
  tx: QueryExecutor,
  config: Config,
  owner: string,
) {
  const profile = publicAIRegistry(config.AI_PROVIDER_PROFILES).profiles.find(
    (p) => p.alias === brokerAlias,
  );
  const secret = config.AI_PROVIDER_PROFILES.find(
    (p) => p.alias === brokerAlias,
  )?.credential;
  const consent = await readAIProviderConsent(tx, owner, brokerAlias);
  const routing = await readAIRoutingPolicy(tx, owner);
  const downstream = await readLiveDestination(tx, config, owner);
  const settings = await readAssistantSettings(tx, owner);
  // Provider-specific account attestations are not used for OpenRouter. Bind the
  // locally enforced envelope/accounting contract into existing receipt columns.
  const verification = profile
    ? {
        revision: `openrouter-mail-envelope-v1-${liveTermsRevision}`,
        profileRevision: profile.policyRevision,
        envelopeByteLimit: brokerEnvelopeLimit,
        inputTokenUpperBound: brokerEnvelopeLimit + 500,
      }
    : null;
  const quote = profile ? quoteAIProfile(profile) : null;
  const blockers: string[] = [];
  if (
    !profile ||
    profile.adapter !== 'openrouter' ||
    profile.configuration !== 'configured' ||
    !secret
  )
    blockers.push('PROVIDER_UNAVAILABLE');
  if (
    !profile ||
    profile.model !== brokerModel ||
    profile.upstreamProvider !== brokerUpstream
  )
    blockers.push('PINNED_MODEL_REQUIRED');
  if (!profile?.retentionDisclosure) blockers.push('RETENTION_REQUIRED');
  if (
    !profile ||
    !consent.approved ||
    consent.profileRevision !== profile.policyRevision
  )
    blockers.push('CONSENT_REQUIRED');
  if (
    !quote ||
    quote.maximumChargeMicros < 1 ||
    profile?.maxOutputTokens !== brokerOutputTokens ||
    (verification && quote.inputTokenLimit < verification.inputTokenUpperBound)
  )
    blockers.push('QUOTE_REQUIRED');
  if (!downstream.destination) blockers.push('DOWNSTREAM_BLOCKED');
  const allowed = liveAllowedLabels(settings).filter(
    (label) =>
      label !== 'restricted' &&
      routing.policy[label].allowed.includes(brokerAlias),
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
    status: blockers.length ? 'blocked' : 'ready',
    blockers,
    profileRevision: policy.profile?.policyRevision ?? null,
    approvalVersion: policy.consent.version,
    downstream: policy.downstream ? 'ready' : 'blocked',
    dispatchConnectedToAgents: true,
    destination: profileDestination(policy.profile),
    endpointStatus: 'unchecked',
  });
}
export function requireBrokerReady(
  policy: Awaited<ReturnType<typeof brokerPolicy>>,
) {
  if (policy.blockers.length)
    throw new ApiError(409, 'MAIL_BROKER_BLOCKED', policy.blockers.join(', '));
}

function profileDestination(
  profile: Awaited<ReturnType<typeof brokerPolicy>>['profile'],
) {
  return profile
    ? {
        alias: brokerAlias,
        model: profile.model,
        router: 'openrouter' as const,
        upstream: profile.upstreamProvider ?? '',
      }
    : null;
}

/** Public catalog requests only, outside DB transactions; never disclose owner data. */
export async function verifyBrokerCatalog(
  fetcher: OpenRouterFetch,
  policy: Awaited<ReturnType<typeof brokerPolicy>>,
) {
  requireBrokerReady(policy);
  return verifyBrokerEndpoint(fetcher, {
    model: policy.profile!.model,
    inputTokenLimit: policy.quote!.inputTokenLimit,
    inputMicrosPerMillionTokens:
      policy.profile!.pricing!.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens:
      policy.profile!.pricing!.outputMicrosPerMillionTokens,
  });
}

/** Capability checks only: this grants no owner disclosure or spending authority. */
export async function verifyBrokerEndpoint(
  fetcher: OpenRouterFetch,
  bounds: {
    model: string;
    inputTokenLimit: number;
    inputMicrosPerMillionTokens: number;
    outputMicrosPerMillionTokens: number;
  },
) {
  try {
    // A model-wide catalog price can be lower than the pinned host's price.
    // Verify every eligible endpoint under that host before reserving money.
    const response = await fetcher(zdrUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 200) throw new Error();
    const raw = await readBody(response, 32 * 1024 * 1024);
    if (raw === null) throw new Error();
    const endpoints = z
      .object({
        data: z.array(
          z.object({
            model_id: z.string(),
            tag: z.string(),
            supported_parameters: z.array(z.string()),
            context_length: z.number().int().nonnegative().optional(),
            max_prompt_tokens: z
              .number()
              .int()
              .nonnegative()
              .nullable()
              .optional(),
            max_completion_tokens: z
              .number()
              .int()
              .nonnegative()
              .nullable()
              .optional(),
            pricing: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      })
      .parse(JSON.parse(raw))
      .data.filter(
        (e) =>
          e.model_id === bounds.model &&
          e.tag.split('/')[0] === brokerUpstream &&
          e.supported_parameters.includes('structured_outputs'),
      );
    const rate = (value: unknown) => {
      if (
        typeof value !== 'string' ||
        !/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)
      )
        throw new Error();
      const amount = Number(value) * 1e12;
      if (!Number.isFinite(amount)) throw new Error();
      return amount;
    };
    if (
      !endpoints.length ||
      endpoints.some(
        (e) =>
          !e.pricing ||
          !e.supported_parameters.includes('max_tokens') ||
          !e.supported_parameters.includes('response_format') ||
          (e.max_prompt_tokens ?? e.context_length ?? 0) <
            bounds.inputTokenLimit ||
          (e.context_length ?? 0) <
            bounds.inputTokenLimit + brokerOutputTokens ||
          (e.max_completion_tokens ?? 0) < brokerOutputTokens ||
          rate(e.pricing.prompt) > bounds.inputMicrosPerMillionTokens ||
          rate(e.pricing.completion) > bounds.outputMicrosPerMillionTokens ||
          rate(e.pricing.request ?? '0') !== 0 ||
          (e.pricing.internal_reasoning !== undefined &&
            rate(e.pricing.internal_reasoning) >
              bounds.outputMicrosPerMillionTokens),
      )
    )
      throw new Error();
    const price = await modelPrice(fetcher, bounds.model);
    if (
      !price ||
      !Number.isFinite(price.prompt) ||
      !Number.isFinite(price.completion) ||
      price.request !== 0 ||
      price.prompt * 1e12 > bounds.inputMicrosPerMillionTokens ||
      price.completion * 1e12 > bounds.outputMicrosPerMillionTokens
    )
      throw new Error();
  } catch {
    throw new ApiError(
      409,
      'MAIL_BROKER_BLOCKED',
      'The approved broker endpoint, structured outputs, ZDR or price could not be verified.',
    );
  }
}
