import { z } from 'zod';
import { aiContextRefSchema } from './ai-routing.js';

// Guidance only. No executable operation or tool arguments are accepted.
export const aiTextOutputSchema = z.strictObject({
  answer: z
    .string()
    .trim()
    .min(1)
    .max(16000)
    .refine((value) => !value.includes('\0')),
  suggestions: z
    .array(
      z.strictObject({
        source: z.strictObject({
          kind: aiContextRefSchema.shape.kind,
          id: z.string().uuid(),
          version: z.number().int().positive(),
        }),
        note: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .refine((value) => !value.includes('\0')),
      }),
    )
    .max(20),
});
export const aiTextResultMetadataSchema = z
  .strictObject({
    synthetic: z.literal(true),
    retained: z.boolean(),
    status: z.enum(['validated', 'invalid', 'unavailable']),
    answerCharacters: z.number().int().min(1).max(16000).nullable(),
    suggestionCount: z.number().int().min(0).max(20).nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.status === 'validated'
        ? value.answerCharacters === null || value.suggestionCount === null
        : value.answerCharacters !== null || value.suggestionCount !== null
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid result metadata state.',
      });
    if (value.status !== 'validated' && value.retained)
      ctx.addIssue({
        code: 'custom',
        message: 'Unavailable or invalid output cannot be retained.',
      });
  });
export type AITextOutput = z.infer<typeof aiTextOutputSchema>;
export type AITextResultMetadata = z.infer<typeof aiTextResultMetadataSchema>;
