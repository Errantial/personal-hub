import { z } from 'zod';
import { sensitivitySchema } from './core.js';
import { dateOnly } from './features.js';

const positive = z.number().int().positive();
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes('\0'), 'Remove null characters.');
export const memoryInputSchema = z.strictObject({
  kind: z.enum(['preference', 'goal', 'fact']),
  title: text(160),
  content: text(4000),
  observedOn: dateOnly.nullable().default(null),
  enabled: z.boolean().default(true),
  sensitivity: sensitivitySchema.default('unlabeled'),
});
const metadata = {
  id: z.string().uuid(),
  version: positive,
  kind: memoryInputSchema.shape.kind,
  source: z.literal('owner-entered'),
  title: text(160).nullable(),
  observedOn: dateOnly.nullable(),
  enabled: z.boolean(),
  sensitivity: sensitivitySchema,
  labels: z.array(sensitivitySchema).min(1).max(3),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
};
function validState(
  value: {
    title: string | null;
    enabled: boolean;
    observedOn: string | null;
    deletedAt: string | null;
    sensitivity: string;
    labels: string[];
  },
  ctx: z.RefinementCtx,
) {
  if (
    value.deletedAt
      ? value.title !== null || value.enabled || value.observedOn !== null
      : value.title === null
  )
    ctx.addIssue({ code: 'custom', message: 'Invalid memory state.' });
  if (
    !value.labels.includes(value.sensitivity) ||
    new Set(value.labels).size !== value.labels.length
  )
    ctx.addIssue({ code: 'custom', message: 'Invalid memory labels.' });
}
export const memorySchema = z
  .object({ ...metadata, content: text(4000).nullable() })
  .superRefine((value, ctx) => {
    validState(value, ctx);
    if ((value.deletedAt !== null) !== (value.content === null))
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid memory content state.',
      });
  });
export const memorySummarySchema = z.object(metadata).superRefine(validState);
export const memoryResponseSchema = z.object({ memory: memorySchema });
export const memoryMutationResponseSchema = z.object({
  memory: z.object({
    id: z.string().uuid(),
    version: positive,
    deletedAt: z.string().datetime().nullable(),
  }),
});
export const createMemorySchema = memoryInputSchema.extend({
  operationId: z.string().uuid(),
});
export const updateMemorySchema = createMemorySchema.extend({
  expectedVersion: positive,
});
export const forgetMemorySchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: positive,
});
export const memorySettingsSchema = z.object({
  version: positive,
  enabled: z.boolean(),
});
export const memorySettingsWriteSchema = forgetMemorySchema.extend({
  enabled: z.boolean(),
});
export const memoryPageQuerySchema = z
  .strictObject({
    state: z.enum(['active', 'disabled', 'forgotten', 'all']).default('active'),
    kind: memoryInputSchema.shape.kind.optional(),
    sensitivity: sensitivitySchema.optional(),
    q: text(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    after: z.string().uuid().optional(),
    expectedCursorVersion: z.coerce.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.after) !== Boolean(value.expectedCursorVersion))
      ctx.addIssue({
        code: 'custom',
        message: 'Supply cursor ID and version together.',
      });
  });
export const memoryPageSchema = z.object({
  memories: z.array(memorySummarySchema).max(100),
  counts: z.object({
    active: z.number().int().nonnegative(),
    disabled: z.number().int().nonnegative(),
    forgotten: z.number().int().nonnegative(),
  }),
  settings: memorySettingsSchema,
  nextAfter: z.object({ id: z.string().uuid(), version: positive }).nullable(),
});
export type Memory = z.infer<typeof memorySchema>;
export type MemoryPage = z.infer<typeof memoryPageSchema>;
