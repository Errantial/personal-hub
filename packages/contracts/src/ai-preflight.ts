import { z } from 'zod';
import {
  aiRoutingPreviewSchema,
  aiRoutingDecisionSchema,
  aiRoutingPreviewResponseSchema,
  providerAliasSchema,
} from './ai-routing.js';
import { aiBudgetPolicySchema, aiBudgetUsageSchema } from './ai-budget.js';
import { aiContextManifestSchema } from './ai-context-manifest.js';
import {
  aiProviderAdapterSchema,
  aiProviderAccessModeSchema,
} from './ai-provider-adapters.js';
import {
  aiPricePolicySchema,
  aiRetentionDisclosureSchema,
  aiProviderReadinessSchema,
} from './ai-provider-policy.js';
export const aiProviderProfileSchema = z.object({
  alias: providerAliasSchema,
  adapter: aiProviderAdapterSchema,
  accessMode: aiProviderAccessModeSchema.default('api-key'),
  upstreamProvider: z.string().max(100).nullable().default(null),
  model: z.string().min(1).max(100),
  configuration: z.enum(['configured', 'credential_missing', 'disabled']),
  maxInputCharacters: z.number().int().min(1).max(48000),
  maxOutputTokens: z.number().int().min(1).max(32000),
  pricing: aiPricePolicySchema.nullable().default(null),
  retentionDisclosure: aiRetentionDisclosureSchema.nullable().default(null),
  policyRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const aiProviderRegistrySchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  dispatchEnabled: z.literal(false),
  health: z.literal('not_checked'),
  profiles: z.array(aiProviderProfileSchema).max(24),
});
export const aiPreflightWriteSchema = aiRoutingPreviewSchema
  .omit({ simulatedAvailableProviders: true })
  .extend({
    operationId: z.string().uuid(),
    expectedRegistryRevision: aiProviderRegistrySchema.shape.revision,
    expectedBudgetVersion: z.number().int().positive(),
  });
export const aiPreflightSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
  status: z.literal('blocked'),
  reason: z.enum([
    'ATTACHMENT_DERIVED',
    'NO_APPROVED_PROVIDER',
    'PROVIDER_UNAVAILABLE',
    'INPUT_LIMIT',
    'DISPATCH_DISABLED',
    'BUDGET_UNSET',
    'BUDGET_ZERO_LIMIT',
    'MONTHLY_BUDGET_EXCEEDED',
  ]),
  dispatchEnabled: z.literal(false),
  policyVersion: z.number().int().positive(),
  budgetVersion: z.number().int().positive().nullable().default(null),
  budget: aiBudgetPolicySchema.nullable().default(null),
  budgetUsage: aiBudgetUsageSchema.nullable().default(null),
  registryRevision: aiProviderRegistrySchema.shape.revision,
  route: aiRoutingDecisionSchema,
  model: z.string().min(1).max(100).nullable(),
  requestCharacters: z.number().int().min(1).max(12000),
  contextCharacters: z.number().int().nonnegative().max(48000).nullable(),
  contextAssembled: z.boolean(),
  contextManifest: aiContextManifestSchema.nullable().default(null),
  executionReadiness: aiProviderReadinessSchema.nullable().default(null),
  sources: z
    .array(
      aiRoutingPreviewResponseSchema.shape.sources.element.extend({
        characters: z.number().int().nonnegative().max(48000).nullable(),
      }),
    )
    .max(20),
});
export const aiPreflightsQuerySchema = z.strictObject({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const aiPreflightsResponseSchema = z.object({
  preflights: z.array(aiPreflightSchema).max(50),
  nextBefore: z.string().uuid().nullable(),
});
export type AIProviderRegistry = z.infer<typeof aiProviderRegistrySchema>;
export type AIPreflight = z.infer<typeof aiPreflightSchema>;
