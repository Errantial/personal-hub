import { z } from 'zod';
import { providerAliasSchema } from './ai-routing.js';
const amount = z.number().int().min(0).max(1_000_000_000_000).nullable();
export const aiBudgetPolicySchema = z
  .strictObject({
    monthlyLimitMicros: amount,
    perRequestLimitMicros: amount,
  })
  .refine(
    (value) =>
      (value.monthlyLimitMicros === null &&
        value.perRequestLimitMicros === null) ||
      (value.monthlyLimitMicros !== null &&
        value.perRequestLimitMicros !== null &&
        value.perRequestLimitMicros <= value.monthlyLimitMicros),
    'Set both limits and keep the request limit within the monthly limit.',
  );
export const emptyAIBudgetPolicy = {
  monthlyLimitMicros: null,
  perRequestLimitMicros: null,
};
export const aiBudgetUsageSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  spentMicros: z.string().regex(/^(0|[1-9]\d{0,29})$/),
  heldMicros: z.string().regex(/^(0|[1-9]\d{0,29})$/),
  uncertainMicros: z.string().regex(/^(0|[1-9]\d{0,29})$/),
  outstandingHeldMicros: z.string().regex(/^(0|[1-9]\d{0,29})$/),
  outstandingUncertainMicros: z.string().regex(/^(0|[1-9]\d{0,29})$/),
  overruns: z.number().int().nonnegative(),
});
export const aiBudgetSettingsSchema = z.object({
  version: z.number().int().positive(),
  policy: aiBudgetPolicySchema,
  currency: z.literal('USD'),
  monthBoundary: z.literal('UTC'),
  dispatchEnabled: z.literal(false),
  usage: aiBudgetUsageSchema.nullable().default(null),
});
export const aiBudgetLiveSettingsSchema = aiBudgetSettingsSchema.extend({
  usage: aiBudgetUsageSchema,
});
export const aiBudgetReservationSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  version: z.number().int().positive(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  provider: providerAliasSchema,
  model: z.string().min(1).max(100),
  policyVersion: z.number().int().positive(),
  reservedMicros: z.number().int().min(1).max(1_000_000_000_000),
  actualMicros: z.number().int().min(0).max(1_000_000_000_000).nullable(),
  status: z.enum(['reserved', 'uncertain', 'settled', 'released']),
  overrun: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const aiBudgetWriteSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  policy: aiBudgetPolicySchema,
});
export type AIBudgetSettings = z.infer<typeof aiBudgetSettingsSchema>;
export type AIBudgetLiveSettings = z.infer<typeof aiBudgetLiveSettingsSchema>;
export type AIBudgetReservation = z.infer<typeof aiBudgetReservationSchema>;
