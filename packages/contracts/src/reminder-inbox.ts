import { z } from 'zod';
import { instant, reminderSchema, notificationSchema } from './features.js';

export const reminderSnoozeSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  scheduledAt: instant,
});
export const reminderSnoozeResponseSchema = z.object({
  sourceReminder: reminderSchema,
  reminder: reminderSchema,
  notification: notificationSchema,
});
export const reminderHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().uuid().optional(),
  status: reminderSchema.shape.status.optional(),
});
export const notificationHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().uuid().optional(),
  unreadOnly: z.enum(['true', 'false']).default('false'),
});
export const reminderHistorySchema = z.object({
  reminders: z.array(reminderSchema),
  nextBefore: z.string().uuid().nullable(),
});
export const notificationHistorySchema = z.object({
  notifications: z.array(notificationSchema),
  nextBefore: z.string().uuid().nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export const notificationSummarySchema = z.object({
  unreadCount: z.number().int().nonnegative(),
});
export const notificationsReadSchema = z.strictObject({
  operationId: z.string().uuid(),
  notificationIds: z
    .array(z.string().uuid())
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const notificationsReadResponseSchema = z.object({
  notifications: z.array(notificationSchema),
});
