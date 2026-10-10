import { z } from 'zod';
import { dateOnly, Temporal } from './features.js';
import { sensitivitySchema } from './core.js';
export const canvasProviderDataSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(10000),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime().nullable(),
  startDate: dateOnly.nullable(),
  endDate: dateOnly.nullable(),
  allDay: z.boolean(),
  sourceUrl: z.string().url().nullable(),
});
export const canvasItemSchema = z.object({
  courseId: z.string().uuid().nullable().default(null),
  courseName: z.string().nullable().default(null),
  courseDeleted: z.boolean().default(false),
  inputKind: z.enum(['calendar-feed', 'calendar-file']),
  id: z.string().uuid(),
  uid: z.string().min(1).max(1000),
  providerData: canvasProviderDataSchema,
  availability: z.enum(['available', 'cancelled', 'missing']),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
  effectiveSensitivity: sensitivitySchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const canvasJobSchema = z.object({
  id: z.string().uuid(),
  trigger: z.enum(['manual', 'automatic', 'upload']),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  counts: z
    .object({
      added: z.number().int(),
      updated: z.number().int(),
      missing: z.number().int(),
    })
    .nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export const canvasConnectionSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  version: z.number().int().positive(),
  sensitivity: sensitivitySchema,
  lastImportedAt: z.string().datetime().nullable(),
  jobs: z.array(canvasJobSchema),
  items: z.array(canvasItemSchema),
});
export const canvasSettingsSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  enabled: z.boolean(),
  sensitivity: sensitivitySchema,
});
export const canvasItemWriteSchema = z.strictObject({
  courseId: z.string().uuid().nullable().optional(),
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
});
export const canvasUploadSchema = z.strictObject({
  operationId: z.string().uuid(),
  feed: z
    .string()
    .min(1)
    .max(1024 * 1024),
});
export const canvasJobResponseSchema = z.object({ job: canvasJobSchema });
export const canvasItemsResponseSchema = z.object({
  items: z.array(canvasItemSchema),
  lastImportedAt: z.string().datetime().nullable(),
});
// Shared agenda overlap: date-only spans remain floating; timed deadlines are points.
export function canvasItemInRange(
  item: CanvasItem,
  from: string,
  to: string,
  timeZone: string,
) {
  const data = item.providerData;
  if (data.allDay)
    return (
      data.startDate !== null &&
      data.startDate < to &&
      (data.endDate ?? data.startDate) > from
    );
  if (!data.startsAt) return false;
  const start = Temporal.Instant.from(data.startsAt);
  const end = Temporal.Instant.from(data.endsAt ?? data.startsAt);
  const lower = Temporal.PlainDate.from(from)
    .toZonedDateTime(timeZone)
    .toInstant();
  const upper = Temporal.PlainDate.from(to)
    .toZonedDateTime(timeZone)
    .toInstant();
  return (
    Temporal.Instant.compare(start, upper) < 0 &&
    (Temporal.Instant.compare(end, start) === 0
      ? Temporal.Instant.compare(start, lower) >= 0
      : Temporal.Instant.compare(end, lower) > 0)
  );
}
export type CanvasConnection = z.infer<typeof canvasConnectionSchema>;
export type CanvasItem = z.infer<typeof canvasItemSchema>;
