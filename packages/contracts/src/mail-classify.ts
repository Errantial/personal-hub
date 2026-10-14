import { z } from 'zod';
import { assistantModelSchema, assistantReasonSchema } from './assistant.js';
import { mailCategorySchema } from './mail-organization.js';

/**
 * AI category suggestions for selected mail (docs/mail-classification.md).
 * Suggestions are applied only by the owner, as ordinary owner categories.
 */
export const mailClassifyLimit = 20;
const reference = z.strictObject({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
export const mailClassifyInputSchema = z.strictObject({
  operationId: z.string().uuid(),
  messages: z
    .array(reference)
    .min(1)
    .max(mailClassifyLimit)
    .refine(
      (list) => new Set(list.map((item) => item.id)).size === list.length,
      'Select each message once.',
    ),
});
export const mailSuggestionSchema = z.object({
  id: z.string().uuid(),
  /** The version the model saw; applying a category uses it. */
  expectedVersion: z.number().int().positive(),
  category: mailCategorySchema,
  reason: z.string().max(300),
});
export type MailSuggestion = z.infer<typeof mailSuggestionSchema>;
export const mailClassifyBlockSchema = z.object({
  id: z.string().uuid(),
  reason: z.enum([
    /** Restricted mail is never sent to a hosted provider. */
    'restricted',
    /** Personal mail needs the owner's permission in Settings › AI. */
    'personal-not-allowed',
    /** Imported by an older connector without a body-origin declaration. */
    'provenance',
    /** Missing, or changed since it was selected. */
    'changed',
  ]),
});
export const mailClassifyResponseSchema = z.object({
  /** Null when nothing selected could be sent (no charge). */
  request: z
    .object({
      id: z.string().uuid(),
      status: z.enum(['uncertain', 'completed', 'failed']),
      reason: assistantReasonSchema.nullable(),
      model: assistantModelSchema,
      resultAvailable: z.boolean(),
      suggestions: z.array(mailSuggestionSchema),
      dropped: z.number().int().nonnegative(),
      costMicros: z.number().int().nonnegative().nullable(),
      heldMicros: z.number().int().nonnegative(),
      createdAt: z.string().datetime(),
    })
    .nullable(),
  blocked: z.array(mailClassifyBlockSchema),
});
export type MailClassifyResponse = z.infer<typeof mailClassifyResponseSchema>;
