import { z } from 'zod';
import { dateOnly, Temporal } from './features.js';
import { taskSchema } from './core.js';

const range = { asOf: dateOnly, to: dateOnly };
function checkRange(value: { asOf: string; to: string }, ctx: z.RefinementCtx) {
  if (
    dateOnly.safeParse(value.asOf).success &&
    dateOnly.safeParse(value.to).success &&
    (value.to <= value.asOf ||
      Temporal.PlainDate.from(value.asOf).until(
        Temporal.PlainDate.from(value.to),
      ).days > 31)
  )
    ctx.addIssue({ code: 'custom', message: 'Use a range of 1-31 days.' });
}
export const taskDeadlineRangeSchema = z
  .strictObject(range)
  .superRefine(checkRange);
export const taskAgendaBucketSchema = z.enum([
  'overdue',
  'today',
  'upcoming',
  'later',
  'undated',
]);
const selection = z.enum(['all', ...taskAgendaBucketSchema.options]);
export const taskAgendaQuerySchema = z
  .strictObject({
    ...range,
    bucket: selection.default('all'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().uuid().optional(),
    expectedCursorVersion: z.coerce.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    checkRange(value, ctx);
    if (Boolean(value.after) !== Boolean(value.expectedCursorVersion))
      ctx.addIssue({
        code: 'custom',
        message: 'Supply both cursor ID and version.',
      });
  });
export const taskDeadlineSummarySchema = z.object({
  openCount: z.number().int().nonnegative(),
  overdueCount: z.number().int().nonnegative(),
  todayCount: z.number().int().nonnegative(),
  upcomingCount: z.number().int().nonnegative(),
  laterCount: z.number().int().nonnegative(),
  undatedCount: z.number().int().nonnegative(),
});
export const taskAgendaResponseSchema = z.object({
  ...range,
  bucket: selection,
  summary: taskDeadlineSummarySchema,
  entries: z
    .array(z.object({ bucket: taskAgendaBucketSchema, task: taskSchema }))
    .max(200),
  nextAfter: z
    .object({ id: z.string().uuid(), version: z.number().int().positive() })
    .nullable(),
});
export type TaskAgendaQuery = z.infer<typeof taskAgendaQuerySchema>;
export type TaskDeadlineRange = z.infer<typeof taskDeadlineRangeSchema>;
export type TaskDeadlineSummary = z.infer<typeof taskDeadlineSummarySchema>;
export type TaskAgendaResponse = z.infer<typeof taskAgendaResponseSchema>;
