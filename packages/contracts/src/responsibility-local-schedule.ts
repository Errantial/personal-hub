import { z } from 'zod';
import { dateOnly, zone } from './features.js';
export const responsibilityLocalRuleSchema = z.strictObject({
  startDate: dateOnly,
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timeZone: zone,
  frequency: z.enum(['daily', 'weekly']),
  interval: z.number().int().min(1).max(52).default(1),
});
export const responsibilityLocalScheduleWriteSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  rule: responsibilityLocalRuleSchema,
});
export type ResponsibilityLocalRule = z.infer<
  typeof responsibilityLocalRuleSchema
>;
