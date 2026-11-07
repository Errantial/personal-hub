import { z } from 'zod';
import { Temporal, dateOnly } from './features.js';
import { sensitivitySchema } from './core.js';

const deadlineTimeZoneSchema = z
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
  }, 'Use a supported IANA time zone.');

export const trackedDeadlinePrioritySchema = z.enum(['low', 'normal', 'high']);
export const trackedDeadlineSourceKindSchema = z.enum([
  'calendar-feed',
  'calendar-file',
  'assignment-api',
  'browser',
]);
export const trackedDeadlineAvailabilitySchema = z.enum([
  'available',
  'cancelled',
  'missing',
]);
export const trackedDeadlineTimedDueSchema = z.object({
  kind: z.literal('timed'),
  dueAt: z.string().datetime(),
  timeZone: deadlineTimeZoneSchema.nullable(),
});
export const trackedDeadlineDateDueSchema = z.object({
  kind: z.literal('date'),
  dueDate: dateOnly,
});
export const trackedDeadlineUnknownDueSchema = z.object({
  kind: z.literal('unknown'),
});
export const trackedDeadlineDueSchema = z.discriminatedUnion('kind', [
  trackedDeadlineTimedDueSchema,
  trackedDeadlineDateDueSchema,
  trackedDeadlineUnknownDueSchema,
]);
export const trackedDeadlineDueOverrideSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('provider') }),
  trackedDeadlineTimedDueSchema.extend({ timeZone: deadlineTimeZoneSchema }),
  trackedDeadlineDateDueSchema,
  trackedDeadlineUnknownDueSchema,
]);

export const trackedDeadlineSourceSchema = z.object({
  sourceId: z.string().uuid(),
  kind: trackedDeadlineSourceKindSchema,
  primary: z.boolean(),
  identityMatches: z.boolean(),
  capturedVersion: z.number().int().positive(),
  currentVersion: z.number().int().positive(),
  title: z.string().min(1).max(200),
  due: trackedDeadlineDueSchema,
  availability: trackedDeadlineAvailabilitySchema,
  sourceUrl: z.string().url().nullable(),
  sensitivity: sensitivitySchema,
  labels: z.array(sensitivitySchema).min(1).max(3),
});

export const trackedDeadlineSchema = z.object({
  id: z.string().uuid(),
  providerKind: z.literal('canvas'),
  canonicalKey: z.string().min(1).max(1200),
  version: z.number().int().positive(),
  completedAt: z.string().datetime().nullable(),
  priority: trackedDeadlinePrioritySchema,
  notes: z.string().max(10000),
  titleOverride: z.string().trim().min(1).max(200).nullable(),
  dueOverride: trackedDeadlineDueOverrideSchema,
  sensitivity: sensitivitySchema,
  sourceLabels: z.array(sensitivitySchema).min(1).max(3),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  title: z.string().min(1).max(200),
  due: trackedDeadlineDueSchema,
  providerDue: trackedDeadlineDueSchema,
  sourceUrl: z.string().url().nullable(),
  sourceAvailability: trackedDeadlineAvailabilitySchema,
  sourceCoverage: z.array(trackedDeadlineSourceKindSchema).min(1).max(4),
  sourceConflict: z.boolean(),
  alternateTimedDue: trackedDeadlineTimedDueSchema.nullable(),
  labels: z.array(sensitivitySchema).min(1).max(3),
  effectiveSensitivity: sensitivitySchema,
  sources: z.array(trackedDeadlineSourceSchema).min(1),
});

export const trackedDeadlineUpdateSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  titleOverride: z.string().trim().min(1).max(200).nullable(),
  priority: trackedDeadlinePrioritySchema,
  notes: z.string().max(10000),
  dueOverride: trackedDeadlineDueOverrideSchema,
  sensitivity: sensitivitySchema,
});
export const trackedDeadlineCompletionSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
export const trackedDeadlineResponseSchema = z.object({
  deadline: trackedDeadlineSchema,
});
export const trackedDeadlineListQuerySchema = z
  .object({
    status: z.enum(['open', 'completed', 'all']).default('open'),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    after: z.string().uuid().optional(),
  })
  .refine((value) => !value.from || !value.to || value.from < value.to, {
    message: 'The deadline range end must be after its start.',
  });
export const trackedDeadlineListSchema = z.object({
  deadlines: z.array(trackedDeadlineSchema),
  nextAfter: z.string().uuid().nullable(),
});

export type TrackedDeadline = z.infer<typeof trackedDeadlineSchema>;
export type TrackedDeadlineDue = z.infer<typeof trackedDeadlineDueSchema>;
export type TrackedDeadlineDueOverride = z.infer<
  typeof trackedDeadlineDueOverrideSchema
>;
