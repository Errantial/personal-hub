import { z } from 'zod';
import { recurrenceSchema } from './features.js';
import { academicPlannerSourceSummarySchema } from './academic-source.js';
import { canvasSourceRefSchema, plannerSourceSchema } from './provenance.js';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('productivity-hub-api'),
  contractVersion: z.literal(1),
});

export const bootstrapResponseSchema = z.object({
  mode: z.literal('development'),
  connections: z.array(
    z.object({
      id: z.enum(['canvas', 'outlook', 'proton-mail', 'proton-calendar']),
      name: z.string(),
      description: z.string(),
      status: z.literal('not_configured'),
    }),
  ),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
});
export const sessionResponseSchema = z.object({
  user: userSchema.nullable(),
  setupRequired: z.boolean(),
  expiresAt: z.string().datetime().nullable().default(null),
});
const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(256),
});
export const setupRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(12).max(256),
  setupToken: z.string().max(256).optional(),
});
export const sensitivitySchema = z.enum([
  'unlabeled',
  'personal',
  'restricted',
]);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((date) => {
    const parsed = new Date(`${date}T00:00:00Z`);
    return (
      !date.startsWith('0000-') &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === date
    );
  }, 'Use a valid calendar date.');
const taskFields = {
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10000).default(''),
  dueDate: dateSchema.nullable().default(null),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  completed: z.boolean().default(false),
  sensitivity: sensitivitySchema.default('unlabeled'),
};
const metadata = {
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
};
export const taskSchema = z.object({
  ...taskFields,
  ...metadata,
  canvasSource: plannerSourceSchema.nullable().default(null),
  academicSource: academicPlannerSourceSummarySchema.nullable().default(null),
});
export const createTaskSchema = z.strictObject({
  ...taskFields,
  canvasSourceRef: canvasSourceRefSchema.optional(),
  clientId: z.string().uuid().optional(),
  operationId: z.string().uuid(),
});
export const updateTaskSchema = z.strictObject({
  ...taskFields,
  sensitivity: sensitivitySchema.optional(),
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
export const deleteItemSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
export const restoreItemSchema = deleteItemSchema;
export const plannerRestorationSchema = z.object({
  itemKind: z.enum(['task', 'event']),
  itemId: z.string().uuid(),
  deletedVersion: z.number().int().positive(),
  deletedAt: z.string().datetime(),
  restoredVersion: z.number().int().positive(),
  restoredAt: z.string().datetime(),
});
export const taskResponseSchema = z.object({ task: taskSchema });
export const tasksResponseSchema = z.object({ tasks: z.array(taskSchema) });
const timeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Use a supported IANA time zone.');
const eventFields = {
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10000).default(''),
  startsAt: z
    .string()
    .datetime({ offset: true })
    .refine((value) => !value.startsWith('0000-'))
    .transform((value) => new Date(value).toISOString()),
  endsAt: z
    .string()
    .datetime({ offset: true })
    .refine((value) => !value.startsWith('0000-'))
    .transform((value) => new Date(value).toISOString()),
  timeZone: timeZoneSchema,
  sensitivity: sensitivitySchema.default('unlabeled'),
};
const validEventRange = (event: { startsAt: string; endsAt: string }) =>
  new Date(event.endsAt) > new Date(event.startsAt);
export const eventSchema = z
  .object({
    ...eventFields,
    ...metadata,
    allDay: z.boolean().default(false),
    recurrence: recurrenceSchema.nullable().default(null),
    courseId: z.string().uuid().nullable().default(null),
    canvasSource: plannerSourceSchema.nullable().default(null),
    academicSource: academicPlannerSourceSummarySchema.nullable().default(null),
  })
  .refine(validEventRange, 'Event end must follow its start.');
export const createEventSchema = z
  .strictObject({ ...eventFields, operationId: z.string().uuid() })
  .refine(validEventRange, 'Event end must follow its start.');
export const updateEventSchema = z
  .strictObject({
    ...eventFields,
    sensitivity: sensitivitySchema.optional(),
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .refine(validEventRange, 'Event end must follow its start.');
export const eventResponseSchema = z.object({ event: eventSchema });
export const eventsResponseSchema = z.object({ events: z.array(eventSchema) });
export type User = z.infer<typeof userSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskInput = z.infer<typeof createTaskSchema>;
export type CalendarEvent = z.infer<typeof eventSchema>;
export type EventInput = z.infer<typeof createEventSchema>;
