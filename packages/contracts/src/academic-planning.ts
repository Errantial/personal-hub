import { z } from 'zod';
import { createTaskSchema, taskSchema } from './core.js';
import {
  calendarInputSchema,
  calendarRecordSchema,
  instant,
  rangeSchema,
  dateOnly,
  zone,
  Temporal,
} from './features.js';
import {
  studyWorkloadSnapshotSchema,
  studyWorkloadCurrentSchema,
} from './study-workload.js';

const change = {
  operationId: z.string().uuid(),
  expectedWorkVersion: z.number().int().positive(),
  expectedCourseVersion: z.number().int().positive(),
};
export const academicPlanningWriteSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...change,
    kind: z.literal('task'),
    task: createTaskSchema.omit({
      operationId: true,
      canvasSourceRef: true,
      clientId: true,
    }),
  }),
  z.strictObject({
    ...change,
    kind: z.literal('study'),
    event: calendarInputSchema.refine(
      (event) =>
        !event.allDay &&
        !event.recurrence &&
        event.courseId !== null &&
        event.studyStatus === 'planned' &&
        +new Date(event.endsAt) - +new Date(event.startsAt) <= 180 * 60000,
      'Use a planned, one-time timed study block of at most 180 minutes.',
    ),
  }),
]);
export const academicPlannerLinkSchema = z.object({
  id: z.string().uuid(),
  workId: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  eventId: z.string().uuid().nullable(),
  snapshot: studyWorkloadSnapshotSchema,
  labels: z.array(z.enum(['personal', 'restricted'])).max(2),
  createdAt: instant,
});
export const academicPlannerSourceResponseSchema = z.object({
  kind: z.enum(['task', 'event']),
  itemId: z.string().uuid(),
  itemVersion: z.number().int().positive(),
  itemDeletedAt: instant.nullable(),
  source: academicPlannerLinkSchema
    .extend({
      current: studyWorkloadCurrentSchema,
      changed: z.boolean(),
    })
    .nullable(),
});
export const academicPlanningResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task'),
    task: taskSchema,
    source: academicPlannerLinkSchema,
  }),
  z.object({
    kind: z.literal('study'),
    event: calendarRecordSchema,
    source: academicPlannerLinkSchema,
  }),
]);
export const academicPlannerWorkQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: z.string().uuid().optional(),
  deleted: z.enum(['true', 'false', 'all']).default('false'),
});
export const academicPlannerWorkResponseSchema = z.object({
  workId: z.string().uuid(),
  workVersion: z.number().int().positive(),
  workDeletedAt: instant.nullable(),
  entries: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('task'),
          source: academicPlannerLinkSchema,
          task: taskSchema,
        }),
        z.object({
          kind: z.literal('study'),
          source: academicPlannerLinkSchema,
          event: calendarRecordSchema,
        }),
      ]),
    )
    .max(200),
  nextAfter: z.string().uuid().nullable(),
});
export type AcademicPlanningWrite = z.infer<typeof academicPlanningWriteSchema>;
export const academicPlannerSummaryQuerySchema = rangeSchema.refine(
  (value) =>
    dateOnly.safeParse(value.from).success &&
    dateOnly.safeParse(value.to).success &&
    Temporal.PlainDate.from(value.from).until(Temporal.PlainDate.from(value.to))
      .days <= 31,
  'Use a positive range of at most 31 days.',
);
export const academicPlannerSummarySchema = z.object({
  from: dateOnly,
  to: dateOnly,
  timeZone: zone,
  currentWork: studyWorkloadCurrentSchema,
  tasks: z.object({
    openCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    deletedCount: z.number().int().nonnegative(),
  }),
  calendar: z.object({
    recordCount: z.number().int().nonnegative(),
    deletedRecordCount: z.number().int().nonnegative(),
    plannedCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    cancelledCount: z.number().int().nonnegative(),
    allDayCount: z.number().int().nonnegative(),
    plannedMinutes: z.number().nonnegative(),
    completedMinutes: z.number().nonnegative(),
    cancelledMinutes: z.number().nonnegative(),
  }),
  warnings: z.array(
    z.enum([
      'MANUAL_RECORDS_ONLY',
      'PLANNER_COMPLETION_IS_NOT_SUBMISSION',
      'STUDY_TIME_IS_NOT_MASTERY',
    ]),
  ),
});
