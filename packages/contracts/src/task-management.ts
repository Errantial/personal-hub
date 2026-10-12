import { z } from 'zod';
import { taskSchema } from './core.js';
import { dateOnly } from './features.js';

const status = z.enum(['all', 'open', 'completed']);
const priority = z.enum(['all', 'low', 'normal', 'high']);
const due = z.enum(['any', 'dated', 'undated']);
export const taskBrowseQuerySchema = z
  .strictObject({
    status: status.default('all'),
    priority: priority.default('all'),
    due: due.default('any'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().uuid().optional(),
    expectedCursorVersion: z.coerce.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.after) !== Boolean(value.expectedCursorVersion))
      ctx.addIssue({
        code: 'custom',
        message: 'Supply both cursor ID and version.',
      });
  });
export const taskBrowseResponseSchema = z.object({
  status,
  priority,
  due,
  summary: z.object({
    totalCount: z.number().int().nonnegative(),
    openCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
  }),
  tasks: z.array(taskSchema).max(200),
  nextAfter: z
    .object({ id: z.string().uuid(), version: z.number().int().positive() })
    .nullable(),
});
const changes = z
  .strictObject({
    completed: z.boolean().optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    dueDate: dateOnly.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Select a change.');
export const taskBatchRequestSchema = z.strictObject({
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
      'Select each task once.',
    ),
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('update'), changes }),
    z.strictObject({ kind: z.literal('delete') }),
  ]),
});
export const taskBatchResponseSchema = z.object({
  tasks: z.array(taskSchema).min(1).max(100),
});
export type TaskBrowseQuery = z.infer<typeof taskBrowseQuerySchema>;
export type TaskBrowseResponse = z.infer<typeof taskBrowseResponseSchema>;
export type TaskBatchRequest = z.infer<typeof taskBatchRequestSchema>;
export type TaskBatchResponse = z.infer<typeof taskBatchResponseSchema>;
