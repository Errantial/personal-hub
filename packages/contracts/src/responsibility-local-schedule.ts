import { z } from 'zod';
import { dateOnly, zone } from './features.js';
export const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const responsibilityLocalRuleSchema = z
  .strictObject({
    startDate: dateOnly,
    localTime: localTimeSchema,
    timeZone: zone,
    frequency: z.enum(['daily', 'weekly']),
    interval: z.number().int().min(1).max(52).default(1),
    /** Several slots per day (D57): ascending, first equals localTime. */
    times: z.array(localTimeSchema).min(1).max(6).optional(),
  })
  .superRefine((value, ctx) => {
    const times = value.times;
    if (
      times &&
      (times[0] !== value.localTime ||
        times.some((time, index) => index > 0 && time <= times[index - 1]!))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'List distinct times in order, starting with localTime.',
      });
  });
export const responsibilityLocalScheduleWriteSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  rule: responsibilityLocalRuleSchema,
});
export type ResponsibilityLocalRule = z.infer<
  typeof responsibilityLocalRuleSchema
>;
