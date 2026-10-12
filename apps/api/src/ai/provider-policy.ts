import {
  aiPriceQuoteSchema,
  aiProviderConsentSchema,
  aiProviderReadinessSchema,
} from '@hub/contracts';
import type { AIProviderRegistry, AIExecutionBlocker } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import type { readAIBudget } from '../features/ai-budget.js';
import { stamp } from '../features/common.js';

export const consentColumns = `alias,version,approved,profile_revision AS "profileRevision",profile_snapshot AS "profileSnapshot",${stamp('updated_at', 'updatedAt')}`;
export async function readAIProviderConsents(tx: QueryExecutor, owner: string) {
  return (
    await tx.query(
      `SELECT ${consentColumns} FROM ai_provider_consents WHERE owner_id=$1 ORDER BY alias LIMIT 10001`,
      [owner],
    )
  ).map((row) => aiProviderConsentSchema.parse(row));
}
export async function readAIProviderConsent(
  tx: QueryExecutor,
  owner: string,
  alias: string,
) {
  const [row] = await tx.query(
    `SELECT ${consentColumns} FROM ai_provider_consents WHERE owner_id=$1 AND alias=$2`,
    [owner, alias],
  );
  return aiProviderConsentSchema.parse(
    row ?? {
      alias,
      version: 1,
      approved: false,
      profileRevision: null,
      updatedAt: null,
    },
  );
}
export function quoteAIProfile(
  profile: AIProviderRegistry['profiles'][number],
  now = Date.now(),
) {
  const price = profile.pricing;
  if (!price || Date.parse(price.validUntil) <= now) return null;
  // Round each leg up to a whole USD millionth; never use floating point currency.
  const maximum = (tokens: number, rate: number) =>
    Number((BigInt(tokens) * BigInt(rate) + 999999n) / 1000000n);
  const inputMaximumMicros = maximum(
    price.inputTokenLimit,
    price.inputMicrosPerMillionTokens,
  );
  const outputMaximumMicros = maximum(
    profile.maxOutputTokens,
    price.outputMicrosPerMillionTokens,
  );
  return aiPriceQuoteSchema.parse({
    basis: 'configured_token_allowance',
    currency: 'USD',
    priceRevision: price.revision,
    validUntil: price.validUntil,
    inputTokenLimit: price.inputTokenLimit,
    outputTokenLimit: profile.maxOutputTokens,
    inputMaximumMicros,
    outputMaximumMicros,
    maximumChargeMicros: inputMaximumMicros + outputMaximumMicros,
  });
}
export async function readAIProviderReadiness(
  tx: QueryExecutor,
  owner: string,
  profile: AIProviderRegistry['profiles'][number],
  budget: Awaited<ReturnType<typeof readAIBudget>>,
  now = Date.now(),
) {
  const consent = await readAIProviderConsent(tx, owner, profile.alias);
  const quote = quoteAIProfile(profile, now);
  const consentCurrent =
    consent.approved && consent.profileRevision === profile.policyRevision;
  const blockers: AIExecutionBlocker[] = [
    'DISPATCH_DISABLED',
    'PROVIDER_VERIFICATION_REQUIRED',
    'TOKEN_BOUND_UNVERIFIED',
  ];
  const subscription =
    profile.adapter === 'claude-code' ||
    profile.adapter === 'codex-subscription';
  if (subscription)
    blockers.push(
      'SUBSCRIPTION_ISOLATION_REQUIRED',
      'SUBSCRIPTION_USAGE_VERIFICATION_REQUIRED',
    );
  if (profile.configuration !== 'configured')
    blockers.push('PROVIDER_UNAVAILABLE');
  if (!profile.pricing) blockers.push('PRICING_UNSET');
  else if (!quote) blockers.push('PRICING_EXPIRED');
  if (!profile.retentionDisclosure) blockers.push('RETENTION_UNSET');
  if (!consentCurrent) blockers.push('CONSENT_REQUIRED');
  if (
    budget.policy.monthlyLimitMicros === null ||
    budget.policy.perRequestLimitMicros === null
  )
    blockers.push('BUDGET_UNSET');
  else if (
    budget.policy.monthlyLimitMicros === 0 ||
    budget.policy.perRequestLimitMicros === 0
  )
    blockers.push('BUDGET_ZERO_LIMIT');
  else if (quote) {
    if (quote.maximumChargeMicros > budget.policy.perRequestLimitMicros)
      blockers.push('REQUEST_BUDGET_EXCEEDED');
    if (
      BigInt(budget.usage.spentMicros) +
        BigInt(budget.usage.heldMicros) +
        BigInt(quote.maximumChargeMicros) >
      BigInt(budget.policy.monthlyLimitMicros)
    )
      blockers.push('MONTHLY_BUDGET_EXCEEDED');
  }
  return aiProviderReadinessSchema.parse({
    alias: profile.alias,
    quote,
    consent,
    consentCurrent,
    blockers,
    subscriptionRequirements: subscription
      ? {
          status: 'unverified',
          requestPreparation:
            profile.adapter === 'claude-code'
              ? 'claude-cli-draft'
              : 'unavailable',
          checks: [
            'dedicated-account',
            'effective-configuration',
            'empty-toolset',
            'ephemeral-history',
            'text-only-disclosure',
            'model-entitlement',
            'no-paid-fallback',
            'complete-usage-bound',
            'retry-behavior',
          ],
        }
      : null,
  });
}
