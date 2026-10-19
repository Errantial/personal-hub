import { z } from 'zod';
import { taskSchema } from './core.js';
import { dateOnly, instant, Temporal, zone } from './features.js';

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
    dueAt: instant.nullable().optional(),
    dueTimeZone: zone.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Select a change.')
  .superRefine((value, context) => {
    const atProvided = value.dueAt !== undefined;
    const zoneProvided = value.dueTimeZone !== undefined;
    if (
      atProvided !== zoneProvided ||
      (value.dueAt === null) !== (value.dueTimeZone === null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Supply due time and timezone together.',
      });
    const clearsTime = value.dueAt === null && value.dueTimeZone === null;
    if (
      (atProvided || zoneProvided) &&
      !clearsTime &&
      value.dueDate === undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'Supply the due date when changing the due time.',
      });
    if (
      value.dueAt !== undefined &&
      value.dueAt !== null &&
      value.dueDate === null
    )
      context.addIssue({
        code: 'custom',
        message: 'A due time requires a due date.',
      });
    if (
      value.dueAt &&
      value.dueTimeZone &&
      value.dueDate &&
      Temporal.Instant.from(value.dueAt)
        .toZonedDateTimeISO(value.dueTimeZone)
        .toPlainDate()
        .toString() !== value.dueDate
    )
      context.addIssue({
        code: 'custom',
        message: 'Due time must fall on the due date in its timezone.',
      });
  });
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
