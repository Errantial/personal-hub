import { z } from 'zod';
import { aiContextRefSchema } from './ai-routing.js';
import { sensitivitySchema } from './core.js';
import { academicPlannerSourceSummarySchema } from './academic-source.js';

export const aiContextManifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  boundary: z.literal('text-only'),
  projection: z.literal('owned-text-v1'),
  request: z.strictObject({
    provenance: z.literal('owner-entered'),
    sensitivity: sensitivitySchema,
    characters: z.number().int().min(1).max(12000),
  }),
  sources: z
    .array(
      z
        .strictObject({
          kind: aiContextRefSchema.shape.kind,
          id: z.string().uuid(),
          version: z.number().int().positive(),
          labels: z.array(sensitivitySchema).min(1).max(3),
          attachmentDerived: z.literal(false),
          memorySettingsVersion: z.number().int().positive().nullable(),
          // Omit for old/non-academic manifests to preserve existing integrity bindings.
          academicCourse: z
            .strictObject({
              id: z.string().uuid(),
              version: z.number().int().positive(),
            })
            .optional(),
          academicPlanning: academicPlannerSourceSummarySchema
            .strict()
            .optional(),
          characters: z.number().int().nonnegative().max(48000),
        })
        .superRefine((source, ctx) => {
          if (
            (source.kind === 'academic-work') !==
            (source.academicCourse !== undefined)
          )
            ctx.addIssue({
              code: 'custom',
              message: 'Bind the class only for academic work context.',
            });
          if (
            source.academicPlanning &&
            !['task', 'event'].includes(source.kind)
          )
            ctx.addIssue({
              code: 'custom',
              message: 'Planning provenance belongs to planner context only.',
            });
        }),
    )
    .max(20),
  payloadCharacters: z.number().int().positive().max(48000),
});
export type AIContextManifest = z.infer<typeof aiContextManifestSchema>;
