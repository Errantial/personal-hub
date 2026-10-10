import { z } from 'zod';
import {
  calendarRecordSchema,
  calendarInputSchema,
  courseSchema,
  topicSchema,
  reminderSchema,
  notificationSchema,
  dateOnly,
} from './features.js';
import { taskSchema, userSchema } from './core.js';
import { canvasItemSchema } from './connections.js';

export const accountSessionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  current: z.boolean(),
});
export const accountResponseSchema = z.object({
  user: userSchema,
  version: z.number().int().positive(),
  sessions: z.array(accountSessionSchema),
});
export const changePasswordSchema = z
  .strictObject({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
    expectedVersion: z.number().int().positive(),
  })
  .refine(
    (value) => value.currentPassword !== value.newPassword,
    'Choose a different password.',
  );
export const sessionRevokeResponseSchema = z.object({ ok: z.literal(true) });
export const plannerExportSchema = z.object({
  format: z.literal('personal-hub-planner'),
  formatVersion: z.literal(1),
  exportedAt: z.string().datetime(),
  owner: userSchema,
  records: z.object({
    tasks: z.array(taskSchema),
    events: z.array(calendarRecordSchema),
    courses: z.array(courseSchema),
    topics: z.array(topicSchema),
    exceptions: z.array(
      z.object({
        eventId: z.string().uuid(),
        originalDate: dateOnly,
        cancelled: z.boolean(),
        replacement: calendarInputSchema.nullable(),
      }),
    ),
    reminders: z.array(reminderSchema),
    notifications: z.array(notificationSchema),
    canvasItems: z.array(canvasItemSchema).default([]),
    canvasSource: z
      .object({
        enabled: z.boolean(),
        sensitivity: z.enum(['unlabeled', 'personal', 'restricted']),
        version: z.number().int().positive(),
      })
      .nullable()
      .default(null),
  }),
});
export type AccountResponse = z.infer<typeof accountResponseSchema>;
