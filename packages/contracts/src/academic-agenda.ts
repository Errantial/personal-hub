import { z } from 'zod';
import { dateOnly, Temporal } from './features.js';
import { academicWorkSchema } from './academic-work.js';

const bucket = z.enum(['overdue', 'today', 'upcoming', 'undated']);
export const academicAgendaQuerySchema = z
  .strictObject({
    asOf: dateOnly,
    to: dateOnly,
    courseId: z.string().uuid().optional(),
    bucket: z.enum(['all', ...bucket.options]).default('all'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().uuid().optional(),
    expectedCursorVersion: z.coerce.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      dateOnly.safeParse(value.asOf).success &&
      dateOnly.safeParse(value.to).success &&
      (value.to <= value.asOf ||
        Temporal.PlainDate.from(value.asOf).until(
          Temporal.PlainDate.from(value.to),
        ).days > 31)
    )
      ctx.addIssue({ code: 'custom', message: 'Use a range of 1-31 days.' });
    if (Boolean(value.after) !== Boolean(value.expectedCursorVersion))
      ctx.addIssue({
        code: 'custom',
        message: 'Supply both cursor ID and version.',
      });
  });
export const academicAgendaEntrySchema = academicWorkSchema
  .pick({
    id: true,
    version: true,
    courseId: true,
    title: true,
    kind: true,
    dueDate: true,
    estimatedMinutes: true,
    priority: true,
    sensitivity: true,
    academicLabels: true,
    provenance: true,
  })
  .extend({
    courseName: z.string(),
    courseVersion: z.number().int().positive(),
    status: z.enum(['planned', 'in_progress']),
    bucket,
  });
export const academicAgendaResponseSchema = z.object({
  asOf: dateOnly,
  to: dateOnly,
  courseId: z.string().uuid().nullable(),
  bucket: z.enum(['all', ...bucket.options]),
  summary: z.object({
    openCount: z.number().int().nonnegative(),
    overdueCount: z.number().int().nonnegative(),
    todayCount: z.number().int().nonnegative(),
    upcomingCount: z.number().int().nonnegative(),
    missingDeadlineCount: z.number().int().nonnegative(),
    missingEstimateCount: z.number().int().nonnegative(),
    estimatedOpenMinutes: z.number().int().nonnegative(),
  }),
  entries: z.array(academicAgendaEntrySchema).max(200),
  nextAfter: z
    .object({ id: z.string().uuid(), version: z.number().int().positive() })
    .nullable(),
  warnings: z.array(z.literal('MANUAL_RECORDS_ONLY')),
});
export type AcademicAgendaQuery = z.infer<typeof academicAgendaQuerySchema>;
