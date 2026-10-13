import { z } from 'zod';
import { aiPreflightWriteSchema, aiPreflightSchema } from './ai-preflight.js';

// Transient owner review. Neither an operation receipt nor dispatch authority.
export const aiContextPreviewWriteSchema = aiPreflightWriteSchema.omit({
  operationId: true,
});
export const aiContextPreviewResponseSchema = z
  .strictObject({
    preview: z.literal(true),
    dispatchEnabled: z.literal(false),
    retained: z.literal(false),
    payload: z.string().min(1).max(48000).nullable(),
    assessment: aiPreflightSchema.omit({
      id: true,
      version: true,
      createdAt: true,
      deletedAt: true,
    }),
  })
  .superRefine((value, ctx) => {
    if (
      (value.payload !== null) !== value.assessment.contextAssembled ||
      (value.payload !== null &&
        (value.assessment.contextManifest === null ||
          value.payload.length !==
            value.assessment.contextManifest.payloadCharacters))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Context preview must match its bounded assembly.',
      });
  });
export type AIContextPreview = z.infer<typeof aiContextPreviewResponseSchema>;
