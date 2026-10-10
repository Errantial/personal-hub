import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { canvasSourceRefSchema, plannerSourceSchema } from './provenance.js';
export { Temporal };
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      return (
        !value.startsWith('0000') &&
        Temporal.PlainDate.from(value).toString() === value
      );
    } catch {
      return false;
    }
  });
export const zone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      Temporal.Now.zonedDateTimeISO(value);
      return true;
    } catch {
      return false;
    }
  });
export const instant = z
  .string()
  .datetime({ offset: true })
  .refine((value) => !value.startsWith('0000'))
  .transform((value) => new Date(value).toISOString());
const sensitivity = z.enum(['unlabeled', 'personal', 'restricted']);
export const recurrenceSchema = z.strictObject({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.number().int().min(1).max(52),
  count: z.number().int().min(1).max(1000).nullable(),
  until: dateOnly.nullable(),
});
export const calendarFields = {
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10000).default(''),
  startsAt: instant,
  endsAt: instant,
  timeZone: zone,
  sensitivity: sensitivity.default('unlabeled'),
  allDay: z.boolean().default(false),
  startDate: dateOnly.nullable().default(null),
  endDate: dateOnly.nullable().default(null),
  recurrence: recurrenceSchema.nullable().default(null),
  courseId: z.string().uuid().nullable().default(null),
  topicId: z.string().uuid().nullable().default(null),
  studyStatus: z.enum(['planned', 'completed', 'cancelled']).default('planned'),
};
export const calendarInputSchema = z
  .strictObject(calendarFields)
  .superRefine((value, context) => {
    // Field refinements can report issues without stopping object refinements.
    // Let those issues return a validation response before calling Temporal.
    if (
      !zone.safeParse(value.timeZone).success ||
      !instant.safeParse(value.startsAt).success ||
      !instant.safeParse(value.endsAt).success ||
      (value.startDate !== null &&
        !dateOnly.safeParse(value.startDate).success) ||
      (value.endDate !== null && !dateOnly.safeParse(value.endDate).success)
    )
      return;
    if (
      value.allDay
        ? !value.startDate ||
          !value.endDate ||
          value.endDate <= value.startDate ||
          Temporal.PlainDate.from(value.startDate).until(
            Temporal.PlainDate.from(value.endDate),
          ).days > 31
        : value.startDate !== null ||
          value.endDate !== null ||
          new Date(value.endsAt) <= new Date(value.startsAt) ||
          +new Date(value.endsAt) - +new Date(value.startsAt) > 31 * 86400000
    )
      context.addIssue({
        code: 'custom',
        message: 'Use a positive event range of at most 31 days.',
      });
    if (value.topicId && !value.courseId)
      context.addIssue({
        code: 'custom',
        message: 'Select a course for the topic.',
      });
    const anchor =
      value.startDate ??
      Temporal.Instant.from(value.startsAt)
        .toZonedDateTimeISO(value.timeZone)
        .toPlainDate()
        .toString();
    if (value.recurrence?.until && value.recurrence.until < anchor)
      context.addIssue({
        code: 'custom',
        message: 'Repeat end precedes the start.',
      });
  });
export const calendarWriteSchema = calendarInputSchema.safeExtend({
  canvasSourceRef: canvasSourceRefSchema.optional(),
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive().optional(),
});
export const calendarRecordSchema = z.object({
  ...calendarFields,
  canvasSource: plannerSourceSchema.nullable().default(null),
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: instant,
  updatedAt: instant,
  deletedAt: instant.nullable(),
});
export const calendarListSchema = z.object({
  events: z.array(calendarRecordSchema),
});
export const calendarResponseSchema = z.object({ event: calendarRecordSchema });
export const occurrenceSchema = calendarRecordSchema.extend({
  originalDate: dateOnly,
  occurrenceId: z.string(),
  overridden: z.boolean(),
});
export const occurrencesResponseSchema = z.object({
  occurrences: z.array(occurrenceSchema),
});
export type CalendarRecord = z.infer<typeof calendarRecordSchema>;
export type CalendarInput = z.infer<typeof calendarInputSchema>;
export type Occurrence = z.infer<typeof occurrenceSchema>;
export type EventException = {
  originalDate: string;
  cancelled: boolean;
  replacement: CalendarInput | null;
};
export const rangeSchema = z
  .strictObject({ from: dateOnly, to: dateOnly, timeZone: zone })
  .refine(
    (value) =>
      dateOnly.safeParse(value.from).success &&
      dateOnly.safeParse(value.to).success &&
      value.to > value.from &&
      Temporal.PlainDate.from(value.from).until(
        Temporal.PlainDate.from(value.to),
      ).days <= 93,
  );

const record = {
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: instant,
  updatedAt: instant,
  deletedAt: instant.nullable(),
};
export const courseFields = {
  name: z.string().trim().min(1).max(200),
  term: z.string().max(100).default(''),
  instructor: z.string().max(200).default(''),
  notes: z.string().max(10000).default(''),
  sensitivity: sensitivity.default('unlabeled'),
};
export const topicFields = {
  courseId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  notes: z.string().max(10000).default(''),
  confidence: z.enum(['unknown', 'low', 'medium', 'high']).default('unknown'),
  progress: z.number().int().min(0).max(100).default(0),
  sensitivity: sensitivity.default('unlabeled'),
};
export const courseWriteSchema = z.strictObject({
  ...courseFields,
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive().optional(),
});
export const topicWriteSchema = z.strictObject({
  ...topicFields,
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive().optional(),
});
export const courseSchema = z.object({ ...courseFields, ...record });
export const topicSchema = z.object({ ...topicFields, ...record });
export const coursesSchema = z.object({ courses: z.array(courseSchema) });
export const topicsSchema = z.object({ topics: z.array(topicSchema) });
export const courseResponseSchema = z.object({ course: courseSchema });
export const topicResponseSchema = z.object({ topic: topicSchema });
export type Course = z.infer<typeof courseSchema>;
export type Topic = z.infer<typeof topicSchema>;
export const reminderFields = {
  title: z.string().trim().min(1).max(200),
  scheduledAt: instant,
  targetKind: z.enum(['task', 'event']).nullable().default(null),
  targetId: z.string().uuid().nullable().default(null),
  occurrenceDate: dateOnly.nullable().default(null),
};
export const reminderWriteSchema = z
  .strictObject({
    ...reminderFields,
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .refine(
    (value) =>
      (value.targetKind === null) === (value.targetId === null) &&
      (!value.occurrenceDate || value.targetKind === 'event'),
  );
export const reminderSchema = z.object({
  ...reminderFields,
  id: z.string().uuid(),
  version: z.number().int().positive(),
  status: z.enum([
    'queued',
    'running',
    'paused',
    'delivered',
    'failed',
    'cancelled',
  ]),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: instant,
  updatedAt: instant,
});
export const remindersSchema = z.object({
  reminders: z.array(reminderSchema),
  worker: z.object({
    lastTick: instant.nullable(),
    healthy: z.boolean(),
    errorCode: z.string().nullable(),
  }),
});
export const reminderResponseSchema = z.object({ reminder: reminderSchema });
export const notificationSchema = z.object({
  id: z.string().uuid(),
  reminderId: z.string().uuid(),
  title: z.string(),
  createdAt: instant,
  readAt: instant.nullable(),
});
export const notificationsSchema = z.object({
  notifications: z.array(notificationSchema),
});
export const notificationResponseSchema = z.object({
  notification: notificationSchema,
});
export type Reminder = z.infer<typeof reminderSchema>;
export type HubNotification = z.infer<typeof notificationSchema>;

export function wallTimeToInstant(
  local: string,
  timeZone: string,
  choice: 'reject' | 'earlier' | 'later' = 'reject',
) {
  const plain = Temporal.PlainDateTime.from(local);
  const earlier = plain.toZonedDateTime(timeZone, {
    disambiguation: 'earlier',
  });
  const later = plain.toZonedDateTime(timeZone, { disambiguation: 'later' });
  if (
    !earlier.toPlainDateTime().equals(plain) ||
    !later.toPlainDateTime().equals(plain)
  )
    throw new Error('This local time does not exist. Choose another time.');
  if (!earlier.equals(later) && choice === 'reject')
    throw new Error(
      'This time occurs twice. Select the earlier or later offset.',
    );
  return (choice === 'later' ? later : earlier)
    .toInstant()
    .toString({ smallestUnit: 'millisecond' });
}
export function instantToWall(value: string, timeZone: string) {
  return Temporal.Instant.from(value)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' });
}
