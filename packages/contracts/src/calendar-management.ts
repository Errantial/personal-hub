import { z } from 'zod';
import { calendarRecordSchema } from './features.js';

export const calendarBatchRequestSchema = z.strictObject({
  operationId: z.string().uuid(),
  items: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(100)
    .refine(
      (items) =>
        new Set(items.map((item) => item.id.toLowerCase())).size ===
        items.length,
      'Select each calendar record once.',
    ),
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('delete') }),
    z.strictObject({
      kind: z.literal('study-status'),
      status: z.enum(['planned', 'completed', 'cancelled']),
    }),
  ]),
});
export const calendarBatchResponseSchema = z.object({
  events: z.array(calendarRecordSchema).min(1).max(100),
});
export type CalendarBatchRequest = z.infer<typeof calendarBatchRequestSchema>;
export type CalendarBatchResponse = z.infer<typeof calendarBatchResponseSchema>;
