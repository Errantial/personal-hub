import { z } from 'zod';
import { sensitivitySchema } from './core.js';

export const canvasBrowserHealthStatusSchema = z.enum([
  'never-synced',
  'syncing',
  'current',
  'stale',
  'partial',
  'sign-in-required',
  'revoked',
  'error',
]);

export const canvasBrowserErrorCodeSchema = z.enum([
  'sign-in-required',
  'browser-unavailable',
  'canvas-unavailable',
  'traversal-failed',
  'traversal-limit',
]);

export const canvasBrowserResourceKindSchema = z.enum(['assignment', 'quiz']);
export const canvasBrowserObservationStatusSchema = z.enum([
  'complete',
  'partial',
  'inaccessible',
]);
export const canvasBrowserAttemptOutcomeSchema = z.enum([
  'complete',
  'partial',
  'failed',
]);

const providerId = z.string().regex(/^[1-9]\d{0,19}$/);
const courseUrl = /^https:\/\/canvas\.colorado\.edu\/courses\/[1-9]\d*$/;
const itemUrl =
  /^https:\/\/canvas\.colorado\.edu\/courses\/([1-9]\d*)\/(assignments|quizzes)\/([1-9]\d*)$/;

const courseDataShape = {
  providerId,
  name: z.string().min(1).max(200),
  canonicalUrl: z.string().url().regex(courseUrl, 'Unsafe Canvas course URL.'),
};

export const canvasBrowserCourseDataSchema = z
  .object(courseDataShape)
  .superRefine((value, ctx) => {
    if (!value.canonicalUrl.endsWith(`/courses/${value.providerId}`))
      ctx.addIssue({
        code: 'custom',
        path: ['canonicalUrl'],
        message: 'Canvas course identity does not match its canonical URL.',
      });
  });

const itemDataShape = {
  resourceKind: canvasBrowserResourceKindSchema,
  providerId,
  canonicalUrl: z.string().url().regex(itemUrl, 'Unsafe Canvas item URL.'),
  title: z.string().min(1).max(200),
  dueAt: z.string().datetime().nullable(),
};
export const canvasBrowserItemDataSchema = z
  .object(itemDataShape)
  .superRefine((value, ctx) => {
    const match = itemUrl.exec(value.canonicalUrl);
    const expected =
      value.resourceKind === 'assignment' ? 'assignments' : 'quizzes';
    if (!match || match[2] !== expected || match[3] !== value.providerId)
      ctx.addIssue({
        code: 'custom',
        path: ['canonicalUrl'],
        message: 'Canvas item identity does not match its canonical URL.',
      });
  });

export const canvasBrowserCourseSchema = z.object({
  id: z.string().uuid(),
  ...courseDataShape,
  availability: z.enum(['available', 'missing']),
  selected: z.boolean(),
  courseId: z.string().uuid().nullable(),
  courseName: z.string().nullable(),
  courseDeleted: z.boolean(),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
  effectiveSensitivity: sensitivitySchema,
  lastContactAt: z.string().datetime().nullable(),
  lastImportAt: z.string().datetime().nullable(),
  lastCompleteAt: z.string().datetime().nullable(),
  lastObservationStatus: canvasBrowserObservationStatusSchema.nullable(),
  lastObservedCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const canvasBrowserItemSchema = z.object({
  id: z.string().uuid(),
  browserCourseId: z.string().uuid(),
  ...itemDataShape,
  capturedAt: z.string().datetime(),
  availability: z.enum(['available', 'missing']),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
  effectiveSensitivity: sensitivitySchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const canvasBrowserItemCaptureSchema = z.object({
  id: z.string().uuid(),
  attemptId: z.string().uuid(),
  browserItemId: z.string().uuid(),
  snapshot: canvasBrowserItemDataSchema,
  capturedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export const canvasBrowserAttemptSchema = z.object({
  id: z.string().uuid(),
  sourceVersion: z.number().int().positive(),
  outcome: canvasBrowserAttemptOutcomeSchema.nullable(),
  errorCode: canvasBrowserErrorCodeSchema.nullable(),
  discoveryStatus: z.enum(['complete', 'partial']).nullable(),
  selectedCount: z.number().int().nonnegative(),
  completeCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});

export const canvasBrowserConnectionSchema = z.object({
  configured: z.boolean(),
  version: z.number().int().positive(),
  sensitivity: sensitivitySchema,
  healthStatus: canvasBrowserHealthStatusSchema,
  lastAttemptAt: z.string().datetime().nullable(),
  lastContactAt: z.string().datetime().nullable(),
  lastImportAt: z.string().datetime().nullable(),
  lastCompleteAt: z.string().datetime().nullable(),
  lastAttemptOutcome: canvasBrowserAttemptOutcomeSchema.nullable(),
  lastErrorCode: canvasBrowserErrorCodeSchema.nullable(),
  courses: z.array(canvasBrowserCourseSchema),
  items: z.array(canvasBrowserItemSchema),
  attempts: z.array(canvasBrowserAttemptSchema),
});

export const canvasBrowserTokenRequestSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});

export const canvasBrowserTokenResponseSchema = z.object({
  token: z.string().regex(/^hubcb_[A-Za-z0-9_-]{20,200}$/),
  connection: canvasBrowserConnectionSchema,
});

export const canvasBrowserRevokeSchema = canvasBrowserTokenRequestSchema;

export const canvasBrowserSettingsSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  sensitivity: sensitivitySchema,
});

export const canvasBrowserCourseWriteSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  selected: z.boolean(),
  courseId: z.string().uuid().nullable(),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
});

export const canvasBrowserItemWriteSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
});

export const canvasBrowserCollectorStateSchema = z.object({
  sourceVersion: z.number().int().positive(),
  courses: z.array(
    z.object({
      id: z.string().uuid(),
      providerId,
      canonicalUrl: courseDataShape.canonicalUrl,
      version: z.number().int().positive(),
    }),
  ),
});

export const canvasBrowserAttemptStartSchema = z.strictObject({
  attemptId: z.string().uuid(),
  expectedSourceVersion: z.number().int().positive(),
});

export const canvasBrowserAttemptStartResponseSchema = z.object({
  attemptId: z.string().uuid(),
});

export const canvasBrowserDiscoverySchema = z.strictObject({
  attemptId: z.string().uuid(),
  status: z.enum(['complete', 'partial']),
  capturedAt: z.string().datetime(),
  courses: z.array(canvasBrowserCourseDataSchema).max(100),
});

export const canvasBrowserCourseObservationSchema = z
  .strictObject({
    attemptId: z.string().uuid(),
    courseId: z.string().uuid(),
    status: canvasBrowserObservationStatusSchema,
    capturedAt: z.string().datetime(),
    items: z.array(canvasBrowserItemDataSchema).max(2000),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'inaccessible' && value.items.length)
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'An inaccessible course cannot include observed items.',
      });
  });

export const canvasBrowserObservationResultSchema = z.object({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
});

export const canvasBrowserAttemptFinishSchema = z.strictObject({
  attemptId: z.string().uuid(),
  outcome: canvasBrowserAttemptOutcomeSchema,
  errorCode: canvasBrowserErrorCodeSchema.nullable().default(null),
});

export type CanvasBrowserConnection = z.infer<
  typeof canvasBrowserConnectionSchema
>;
export type CanvasBrowserCourse = z.infer<typeof canvasBrowserCourseSchema>;
export type CanvasBrowserItem = z.infer<typeof canvasBrowserItemSchema>;
export type CanvasBrowserItemCapture = z.infer<
  typeof canvasBrowserItemCaptureSchema
>;
