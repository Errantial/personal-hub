import { z } from 'zod';
import {
  dateOnly,
  zone,
  instant,
  Temporal,
  calendarRecordSchema,
} from './features.js';
import { taskSchema } from './core.js';

const change = {
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
};
const windowSchema = z
  .strictObject({
    day: z.number().int().min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .refine((v) => v.endMinute > v.startMinute);
export const studyPreferencesInputSchema = z
  .strictObject({
    timeZone: zone,
    sessionMinutes: z.number().int().min(10).max(180),
    breakMinutes: z.number().int().min(0).max(60),
    dailyMaximumMinutes: z.number().int().min(10).max(480),
    windows: z.array(windowSchema).max(28),
  })
  .superRefine((value, ctx) => {
    if (value.sessionMinutes > value.dailyMaximumMinutes)
      ctx.addIssue({
        code: 'custom',
        message: 'Session exceeds the daily limit.',
      });
    const windows = [...value.windows].sort(
      (a, b) => a.day - b.day || a.startMinute - b.startMinute,
    );
    for (let i = 1; i < windows.length; i++)
      if (
        windows[i]!.day === windows[i - 1]!.day &&
        windows[i]!.startMinute < windows[i - 1]!.endMinute
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Availability windows overlap.',
        });
  });
export const studyPreferencesWriteSchema =
  studyPreferencesInputSchema.safeExtend(change);
export const studyPreferencesSchema = studyPreferencesInputSchema.safeExtend({
  version: z.number().int().positive(),
  updatedAt: instant.nullable(),
});
export const studyGoalWriteSchema = z.strictObject({
  ...change,
  minutesPerWeek: z.number().int().min(0).max(2400),
  priority: z.number().int().min(1).max(5),
  targetDate: dateOnly.nullable(),
});
export const studyGoalSchema = studyGoalWriteSchema
  .omit({ operationId: true, expectedVersion: true })
  .extend({
    courseId: z.string().uuid(),
    version: z.number().int().positive(),
    updatedAt: instant.nullable(),
  });
export const studyRangeSchema = z
  .strictObject({ from: dateOnly, to: dateOnly })
  .refine(
    (v) =>
      dateOnly.safeParse(v.from).success &&
      dateOnly.safeParse(v.to).success &&
      v.to > v.from &&
      Temporal.PlainDate.from(v.from).until(Temporal.PlainDate.from(v.to))
        .days <= 14,
    'Use a positive range of at most 14 days.',
  );
export const studyWorkloadSchema = z.object({
  openCount: z.number().int().nonnegative(),
  overdueCount: z.number().int().nonnegative(),
  dueSoonCount: z.number().int().nonnegative(),
  earliestDueDate: dateOnly.nullable(),
  estimatedOpenMinutes: z.number().int().nonnegative(),
  missingDeadlineCount: z.number().int().nonnegative(),
  missingEstimateCount: z.number().int().nonnegative(),
  highestPriority: z.number().int().min(1).max(5).nullable(),
});
export const studyPrioritySchema = z.object({
  courseId: z.string().uuid(),
  courseName: z.string(),
  topicId: z.string().uuid().nullable(),
  topicName: z.string().nullable(),
  score: z.number().int(),
  reasons: z.array(
    z.enum([
      'OWNER_PRIORITY',
      'TARGET_DATE',
      'LOW_CONFIDENCE',
      'UNKNOWN_CONFIDENCE',
      'INCOMPLETE_PROGRESS',
      'NO_TOPICS',
      'ACADEMIC_WORK_OVERDUE',
      'ACADEMIC_WORK_DUE_SOON',
      'WORK_IMPORTANCE',
      'ESTIMATED_WORKLOAD',
    ]),
  ),
  targetMinutes: z.number().int().nonnegative(),
  remainingMinutes: z.number().int().nonnegative(),
  // Historical drafts did not evaluate academic work; null means unknown.
  academicWork: studyWorkloadSchema.nullable().default(null),
});
export const studySlotSchema = z
  .strictObject({
    courseId: z.string().uuid(),
    topicId: z.string().uuid().nullable(),
    startsAt: instant,
    endsAt: instant,
  })
  .refine(
    (v) =>
      v.endsAt > v.startsAt &&
      +new Date(v.endsAt) - +new Date(v.startsAt) <= 180 * 60000,
    'Use a study block of at most 180 minutes.',
  );
export const studyPreviewSchema = z.object({
  from: dateOnly,
  to: dateOnly,
  timeZone: zone,
  preferencesVersion: z.number().int().positive(),
  contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  priorities: z.array(studyPrioritySchema),
  slots: z.array(studySlotSchema).max(200),
  warnings: z.array(
    z.enum([
      'NO_AVAILABILITY',
      'NO_GOALS',
      'INSUFFICIENT_TIME',
      'DST_WINDOW_SKIPPED',
      'EXTERNAL_CALENDARS_NOT_CHECKED',
      'ACADEMIC_DEADLINES_MISSING',
      'ACADEMIC_ESTIMATES_MISSING',
      'ACADEMIC_WORK_PROVENANCE_INCOMPLETE',
    ]),
  ),
});
export const studyDraftWriteSchema = studyRangeSchema.safeExtend({
  assistant: z
    .strictObject({
      turnId: z.string().uuid(),
      suggestionId: z.string().uuid(),
    })
    .optional(),
  operationId: z.string().uuid(),
  expectedContextRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const studyPreviewInputSchema = studyRangeSchema.safeExtend({
  assistant: z
    .strictObject({
      turnId: z.string().uuid(),
      suggestionId: z.string().uuid(),
    })
    .optional(),
});
export const studyDraftEditSchema = z.strictObject({
  ...change,
  expectedContextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  slots: z.array(studySlotSchema).min(1).max(200),
});
export const studyPlanSchema = z.object({
  assistant: z
    .strictObject({
      turnId: z.string().uuid(),
      suggestionId: z.string().uuid(),
    })
    .nullable()
    .optional(),
  id: z.string().uuid(),
  version: z.number().int().positive(),
  status: z.enum(['draft', 'approved', 'cancelled']),
  preview: studyPreviewSchema,
  eventLinks: z.array(
    z.object({
      eventId: z.string().uuid(),
      approvedVersion: z.number().int().positive(),
    }),
  ),
  preservedEventIds: z.array(z.string().uuid()),
  createdAt: instant,
  updatedAt: instant,
  deletedAt: instant.nullable(),
});
export const studyHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().uuid().optional(),
});
export const studyPlansResponseSchema = z.object({
  plans: z.array(studyPlanSchema),
  nextBefore: z.string().uuid().nullable(),
});
export const studyProgressSchema = z.object({
  from: dateOnly,
  to: dateOnly,
  timeZone: zone,
  courses: z.array(
    z.object({
      courseId: z.string().uuid(),
      courseName: z.string(),
      targetMinutes: z.number().int().nonnegative(),
      plannedMinutes: z.number().nonnegative(),
      completedMinutes: z.number().nonnegative(),
      cancelledMinutes: z.number().nonnegative(),
      deletedMinutes: z.number().nonnegative(),
      completionPercent: z.number().min(0).max(100).nullable(),
    }),
  ),
});
export const deletedPlannerQuerySchema = z.strictObject({
  kind: z.enum(['task', 'calendar']),
  ...studyHistoryQuerySchema.shape,
});
export const deletedPlannerResponseSchema = z.object({
  kind: z.enum(['task', 'calendar']),
  tasks: z.array(taskSchema),
  events: z.array(calendarRecordSchema),
  nextBefore: z.string().uuid().nullable(),
});
export type StudyPreferences = z.infer<typeof studyPreferencesSchema>;
export type StudyPreview = z.infer<typeof studyPreviewSchema>;
export type StudySlot = z.infer<typeof studySlotSchema>;
export type StudyPlan = z.infer<typeof studyPlanSchema>;
