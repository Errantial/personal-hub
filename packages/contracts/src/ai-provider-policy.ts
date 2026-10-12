import { z } from 'zod';
import {
  aiProviderAdapterSchema,
  aiProviderAccessModeSchema,
} from './ai-provider-adapters.js';
import { providerAliasSchema } from './ai-routing.js';

export const aiPricePolicySchema = z.strictObject({
  revision: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9._-]+$/),
  validUntil: z.string().datetime(),
  inputTokenLimit: z.number().int().min(1).max(2000000),
  inputMicrosPerMillionTokens: z.number().int().min(0).max(1000000000),
  outputMicrosPerMillionTokens: z.number().int().min(0).max(1000000000),
});
export const aiRetentionDisclosureSchema = z.strictObject({
  revision: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9._-]+$/),
  summary: z.string().trim().min(1).max(2000),
});
export const aiPriceQuoteSchema = z.object({
  basis: z.literal('configured_token_allowance'),
  currency: z.literal('USD'),
  priceRevision: z.string(),
  validUntil: z.string().datetime(),
  inputTokenLimit: z.number().int().positive(),
  outputTokenLimit: z.number().int().positive(),
  inputMaximumMicros: z.number().int().nonnegative(),
  outputMaximumMicros: z.number().int().nonnegative(),
  maximumChargeMicros: z.number().int().nonnegative(),
});
export const aiProviderConsentSchema = z.object({
  alias: providerAliasSchema,
  version: z.number().int().positive(),
  approved: z.boolean(),
  profileRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  updatedAt: z.string().datetime().nullable(),
  profileSnapshot: z
    .object({
      alias: providerAliasSchema,
      adapter: aiProviderAdapterSchema,
      accessMode: aiProviderAccessModeSchema.default('api-key'),
      upstreamProvider: z.string().max(100).nullable().default(null),
      model: z.string().min(1).max(100),
      configuration: z.enum(['configured', 'credential_missing', 'disabled']),
      maxInputCharacters: z.number().int().positive(),
      maxOutputTokens: z.number().int().positive(),
      pricing: aiPricePolicySchema.nullable(),
      retentionDisclosure: aiRetentionDisclosureSchema.nullable(),
      policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable()
    .default(null),
});
export const aiProviderConsentWriteSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  expectedRegistryRevision: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().uuid(),
  approved: z.boolean(),
});
export const aiExecutionBlockerSchema = z.enum([
  'DISPATCH_DISABLED',
  'PROVIDER_VERIFICATION_REQUIRED',
  'TOKEN_BOUND_UNVERIFIED',
  'SUBSCRIPTION_ISOLATION_REQUIRED',
  'SUBSCRIPTION_USAGE_VERIFICATION_REQUIRED',
  'PROVIDER_UNAVAILABLE',
  'PRICING_UNSET',
  'PRICING_EXPIRED',
  'RETENTION_UNSET',
  'CONSENT_REQUIRED',
  'BUDGET_UNSET',
  'BUDGET_ZERO_LIMIT',
  'REQUEST_BUDGET_EXCEEDED',
  'MONTHLY_BUDGET_EXCEEDED',
]);
export const aiProviderReadinessSchema = z.object({
  alias: providerAliasSchema,
  quote: aiPriceQuoteSchema.nullable(),
  consent: aiProviderConsentSchema,
  consentCurrent: z.boolean(),
  blockers: z.array(aiExecutionBlockerSchema),
  subscriptionRequirements: z
    .strictObject({
      status: z.literal('unverified'),
      requestPreparation: z.enum(['claude-cli-draft', 'unavailable']),
      checks: z
        .array(
          z.enum([
            'dedicated-account',
            'effective-configuration',
            'empty-toolset',
            'ephemeral-history',
            'text-only-disclosure',
            'model-entitlement',
            'no-paid-fallback',
            'complete-usage-bound',
            'retry-behavior',
          ]),
        )
        .max(9),
    })
    .nullable()
    .default(null),
});
export const aiProviderReadinessResponseSchema = z.object({
  registryRevision: z.string().regex(/^[a-f0-9]{64}$/),
  dispatchEnabled: z.literal(false),
  profiles: z.array(aiProviderReadinessSchema).max(24),
});
export type AIProviderConsent = z.infer<typeof aiProviderConsentSchema>;
export type AIPriceQuote = z.infer<typeof aiPriceQuoteSchema>;
export type AIExecutionBlocker = z.infer<typeof aiExecutionBlockerSchema>;
