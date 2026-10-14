import { z } from 'zod';
import { assistantModelSchema, assistantReasonSchema } from './assistant.js';
import { dateOnly, zone } from './features.js';
import { mailClassifyBlockSchema } from './mail-classify.js';

/**
 * AI task suggestions for one message (docs/mail-task-suggestions.md).
 * Each suggestion quotes the body exactly; the owner reviews it in the
 * manual capture form, and any deadline still needs explicit confirmation.
 */
export const mailTaskSuggestInputSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  /** The owner's zone, for resolving wording such as "Friday". */
  timeZone: zone,
});
export const mailTaskSuggestionSchema = z.object({
  title: z.string().min(1).max(200),
  /** Occurs literally in the stored body. */
  quote: z.string().min(1).max(2000),
  /** The model's reading of a deadline; never applied unconfirmed. */
  dueDate: dateOnly.nullable(),
  notes: z.string().max(1000),
});
export type MailTaskSuggestion = z.infer<typeof mailTaskSuggestionSchema>;
export const mailTaskSuggestResponseSchema = z.object({
  request: z
    .object({
      id: z.string().uuid(),
      status: z.enum(['uncertain', 'completed', 'failed']),
      reason: assistantReasonSchema.nullable(),
      model: assistantModelSchema,
      resultAvailable: z.boolean(),
      suggestions: z.array(mailTaskSuggestionSchema),
      /** Suggestions dropped because their quote or date did not check out. */
      dropped: z.number().int().nonnegative(),
      costMicros: z.number().int().nonnegative().nullable(),
      heldMicros: z.number().int().nonnegative(),
      createdAt: z.string().datetime(),
    })
    .nullable(),
  /** Why the message could not be sent; null when it was. */
  blocked: mailClassifyBlockSchema.shape.reason.nullable(),
});
export type MailTaskSuggestResponse = z.infer<
  typeof mailTaskSuggestResponseSchema
>;
