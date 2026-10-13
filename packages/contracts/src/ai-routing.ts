import { z } from 'zod';
import { sensitivitySchema } from './core.js';
import { academicPlannerSourceSummarySchema } from './academic-source.js';
export const providerAliasSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const routeSchema = z
  .strictObject({
    allowed: z
      .array(providerAliasSchema)
      .max(8)
      .refine(
        (value) => new Set(value).size === value.length,
        'Use unique providers.',
      ),
    preferred: providerAliasSchema.nullable(),
  })
  .refine(
    (value) =>
      value.preferred === null || value.allowed.includes(value.preferred),
    'Preferred provider must be allowed.',
  );
export const aiRoutingPolicySchema = z.strictObject({
  unlabeled: routeSchema,
  personal: routeSchema,
  restricted: routeSchema,
});
export type AIRoutingPolicy = z.infer<typeof aiRoutingPolicySchema>;
export const emptyAIRoutingPolicy: AIRoutingPolicy = {
  unlabeled: { allowed: [], preferred: null },
  personal: { allowed: [], preferred: null },
  restricted: { allowed: [], preferred: null },
};
export const aiRoutingSettingsSchema = z.object({
  version: z.number().int().positive(),
  policy: aiRoutingPolicySchema,
});
export const aiRoutingWriteSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  policy: aiRoutingPolicySchema,
  operationId: z.string().uuid(),
});
export const aiContextRefSchema = z
  .strictObject({
    kind: z.enum([
      'task',
      'event',
      'course',
      'topic',
      'canvas-item',
      'canvas-assignment',
      'memory',
      'academic-work',
      'mail-message',
    ]),
    id: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    expectedMemorySettingsVersion: z.number().int().positive().optional(),
    expectedCourseVersion: z.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.kind === 'memory') !==
      (value.expectedMemorySettingsVersion !== undefined)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Supply memory settings version only for memory context.',
      });
    if (
      (value.kind === 'academic-work') !==
      (value.expectedCourseVersion !== undefined)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Supply class version only for academic work context.',
      });
  });
export const aiRoutingPreviewSchema = z.strictObject({
  expectedPolicyVersion: z.number().int().positive(),
  text: z.string().min(1).max(12000),
  sensitivity: sensitivitySchema,
  sources: z
    .array(aiContextRefSchema)
    .max(20)
    .refine(
      (value) =>
        new Set(value.map((ref) => `${ref.kind}:${ref.id.toLowerCase()}`))
          .size === value.length,
      'Use unique context sources.',
    ),
  simulatedAvailableProviders: z
    .array(providerAliasSchema)
    .max(24)
    .refine(
      (value) => new Set(value).size === value.length,
      'Use unique providers.',
    ),
});
export const aiRoutingDecisionSchema = z.object({
  status: z.enum(['selected', 'blocked']),
  reason: z.enum([
    'POLICY_MATCH',
    'ATTACHMENT_DERIVED',
    'NO_APPROVED_PROVIDER',
    'PROVIDER_UNAVAILABLE',
  ]),
  provider: providerAliasSchema.nullable(),
  sensitivity: sensitivitySchema,
  labels: z.array(sensitivitySchema).min(1).max(3),
});
export const aiRoutingPreviewResponseSchema = aiRoutingDecisionSchema.extend({
  simulation: z.literal(true),
  dispatchEnabled: z.literal(false),
  policyVersion: z.number().int().positive(),
  sources: z.array(
    z.object({
      kind: aiContextRefSchema.shape.kind,
      id: z.string().uuid(),
      version: z.number().int().positive(),
      sensitivity: sensitivitySchema,
      attachmentDerived: z.boolean(),
      labels: z.array(sensitivitySchema).min(1).max(3),
      memorySettingsVersion: z
        .number()
        .int()
        .positive()
        .nullable()
        .default(null),
      academicCourse: z
        .object({ id: z.string().uuid(), version: z.number().int().positive() })
        .nullable()
        .optional(),
      academicPlanning: academicPlannerSourceSummarySchema.optional(),
      mailConnector: z
        .object({ id: z.string().uuid(), version: z.number().int().positive() })
        .optional(),
    }),
  ),
});
export type AIContextRef = z.infer<typeof aiContextRefSchema>;
export type AIRoutingDecision = z.infer<typeof aiRoutingDecisionSchema>;
// Callers of a future dispatch gateway must supply server-observed availability, never preview input.
export function evaluateAIRouting(
  policy: AIRoutingPolicy,
  labels: z.infer<typeof sensitivitySchema>[],
  attachmentDerived: boolean,
  availableProviders: readonly string[],
): AIRoutingDecision {
  if (!labels.length) throw new Error('Context provenance is required.');
  const levels = ['unlabeled', 'personal', 'restricted'] as const;
  if (labels.some((value) => !levels.includes(value)))
    throw new Error('Context provenance is required.');
  const used = levels.filter((value) => labels.includes(value));
  const sensitivity = used.at(-1)!;
  if (attachmentDerived)
    return {
      status: 'blocked',
      reason: 'ATTACHMENT_DERIVED',
      provider: null,
      sensitivity,
      labels: used,
    };
  const allowed = policy[sensitivity].allowed.filter((provider) =>
    used.every((label) => policy[label].allowed.includes(provider)),
  );
  const preferred = policy[sensitivity].preferred;
  const provider =
    preferred && allowed.includes(preferred) ? preferred : (allowed[0] ?? null);
  if (!provider)
    return {
      status: 'blocked',
      reason: 'NO_APPROVED_PROVIDER',
      provider: null,
      sensitivity,
      labels: used,
    };
  if (!availableProviders.includes(provider))
    return {
      status: 'blocked',
      reason: 'PROVIDER_UNAVAILABLE',
      provider,
      sensitivity,
      labels: used,
    };
  return {
    status: 'selected',
    reason: 'POLICY_MATCH',
    provider,
    sensitivity,
    labels: used,
  };
}
