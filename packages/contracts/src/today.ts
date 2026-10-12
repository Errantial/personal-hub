import { z } from 'zod';
import { dateOnly, instant, notificationSchema } from './features.js';
import {
  taskDeadlineRangeSchema,
  taskDeadlineSummarySchema,
} from './task-agenda.js';
import { academicAgendaResponseSchema } from './academic-agenda.js';

export const todaySummaryQuerySchema = taskDeadlineRangeSchema;
export const todaySummarySchema = z.object({
  asOf: dateOnly,
  to: dateOnly,
  generatedAt: instant,
  tasks: taskDeadlineSummarySchema,
  academicWork: academicAgendaResponseSchema.shape.summary,
  reminders: z.object({
    queuedCount: z.number().int().nonnegative(),
    runningCount: z.number().int().nonnegative(),
    pausedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    dueCount: z.number().int().nonnegative(),
    unreadCount: z.number().int().nonnegative(),
    latestUnread: z.array(notificationSchema).max(3),
    worker: z.object({
      lastTick: instant.nullable(),
      errorCode: z.string().nullable(),
      healthy: z.boolean(),
    }),
  }),
  warnings: z.array(
    z.enum([
      'MANUAL_ACADEMIC_RECORDS_ONLY',
      'SCHEDULE_NOT_INCLUDED',
      'IMPORTED_DEADLINES_NOT_INCLUDED',
    ]),
  ),
});
export type TodaySummary = z.infer<typeof todaySummarySchema>;
