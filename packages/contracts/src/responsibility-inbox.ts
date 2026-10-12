import { z } from 'zod';
import {
  responsibilityRunSchema,
  responsibilitySchema,
} from './responsibilities.js';
import { sensitivitySchema } from './core.js';
const positive = z.number().int().positive();
const uuid = z.string().uuid();
export const responsibilityInboxQuerySchema = z
  .strictObject({
    status: z.enum(['blocked', 'cancelled', 'all']).default('blocked'),
    trigger: z.enum(['manual', 'schedule', 'all']).default('all'),
    responsibilityId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    after: uuid.optional(),
    expectedCursorVersion: z.coerce.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.after) !== Boolean(value.expectedCursorVersion))
      ctx.addIssue({
        code: 'custom',
        message: 'Supply cursor ID and version together.',
      });
  });
const counts = z.object({
  blocked: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});
export const responsibilityInboxEntrySchema = z.object({
  run: responsibilityRunSchema,
  current: z.object({
    id: uuid,
    version: positive,
    title: z.string(),
    status: responsibilitySchema.shape.status,
    deletedAt: z.string().datetime().nullable(),
    labels: z.array(sensitivitySchema).min(1).max(3),
  }),
  sourceChanged: z.boolean(),
});
export const responsibilityInboxSchema = z.object({
  entries: z.array(responsibilityInboxEntrySchema).max(100),
  counts,
  nextAfter: z.object({ id: uuid, version: positive }).nullable(),
  executionEnabled: z.literal(false),
});
export const responsibilityAttentionSchema = z.object({
  asOf: z.string().datetime(),
  responsibilities: z.object({
    active: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  }),
  dueCount: z.number().int().nonnegative(),
  runs: counts,
  executionEnabled: z.literal(false),
});
export const responsibilityDismissBatchSchema = z
  .strictObject({
    operationId: uuid,
    items: z
      .array(z.strictObject({ id: uuid, expectedVersion: positive }))
      .min(1)
      .max(50),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.items.map((item) => item.id.toLowerCase())).size !==
      value.items.length
    )
      ctx.addIssue({ code: 'custom', message: 'Select each run once.' });
  });
export const responsibilityDismissBatchResponseSchema = z.object({
  runs: z.array(responsibilityRunSchema).max(50),
  executionEnabled: z.literal(false),
});
