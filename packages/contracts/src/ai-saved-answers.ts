import { z } from 'zod';
import { aiTextOutputSchema } from './ai-text-results.js';
import { aiContextManifestSchema } from './ai-context-manifest.js';
import { sensitivitySchema } from './core.js';

export const aiSavedAnswerSchema = z
  .object({
    requestId: z.string().uuid(),
    attemptId: z.string().uuid(),
    version: z.number().int().positive(),
    synthetic: z.literal(true),
    labels: z.array(sensitivitySchema).min(1).max(3),
    contextManifest: aiContextManifestSchema,
    output: aiTextOutputSchema.nullable(),
    createdAt: z.string().datetime(),
    deletedAt: z.string().datetime().nullable(),
  })
  .superRefine((value, ctx) => {
    if ((value.output === null) !== (value.deletedAt !== null))
      ctx.addIssue({ code: 'custom', message: 'Invalid saved answer state.' });
  });
export const aiSavedAnswerResponseSchema = z.object({
  answer: aiSavedAnswerSchema,
});
export const aiSavedAnswerForgetSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
export type AISavedAnswer = z.infer<typeof aiSavedAnswerSchema>;
