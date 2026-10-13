import { z } from 'zod';
import { academicWorkSchema } from './academic-work.js';

const browseStatus = z.enum([
  'all',
  'open',
  'planned',
  'in_progress',
  'submitted',
  'cancelled',
]);
const browseKind = z.enum(['all', 'assignment', 'exam', 'project', 'other']);
const courseState = z.enum(['active', 'archived', 'all']);
const deadline = z.enum(['any', 'dated', 'undated']);
export const academicWorkBrowseQuerySchema = z
  .strictObject({
    courseId: z.string().uuid().optional(),
    courseState: courseState.default('active'),
    status: browseStatus.default('all'),
    kind: browseKind.default('all'),
    deadline: deadline.default('any'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().uuid().optional(),
    expectedCursorVersion: z.coerce.number().int().positive().optional(),
    expectedCourseVersion: z.coerce.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    const supplied = [
      value.after,
      value.expectedCursorVersion,
      value.expectedCourseVersion,
    ].filter((field) => field !== undefined).length;
    if (supplied !== 0 && supplied !== 3)
      ctx.addIssue({
        code: 'custom',
        message: 'Supply cursor ID, work version and class version together.',
      });
  });
export const academicWorkBrowseResponseSchema = z.object({
  courseId: z.string().uuid().nullable(),
  courseState,
  status: browseStatus,
  kind: browseKind,
  deadline,
  summary: z.object({
    totalCount: z.number().int().nonnegative(),
    openCount: z.number().int().nonnegative(),
    plannedCount: z.number().int().nonnegative(),
    inProgressCount: z.number().int().nonnegative(),
    submittedCount: z.number().int().nonnegative(),
    cancelledCount: z.number().int().nonnegative(),
    missingDeadlineCount: z.number().int().nonnegative(),
    missingEstimateCount: z.number().int().nonnegative(),
    estimatedOpenMinutes: z.number().int().nonnegative(),
  }),
  work: z
    .array(
      academicWorkSchema.extend({
        courseName: z.string(),
        courseVersion: z.number().int().positive(),
        courseArchived: z.boolean(),
      }),
    )
    .max(200),
  nextAfter: z
    .object({
      id: z.string().uuid(),
      version: z.number().int().positive(),
      courseVersion: z.number().int().positive(),
    })
    .nullable(),
});

const changes = z
  .strictObject({
    status: academicWorkSchema.shape.status.removeDefault().optional(),
    priority: academicWorkSchema.shape.priority.removeDefault().optional(),
    dueDate: academicWorkSchema.shape.dueDate.removeDefault().optional(),
    estimatedMinutes: academicWorkSchema.shape.estimatedMinutes
      .removeDefault()
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Select a change.');

export const academicWorkBatchRequestSchema = z.strictObject({
  operationId: z.string().uuid(),
  items: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        expectedCourseVersion: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(100)
    .refine(
      (items) =>
        new Set(items.map((item) => item.id.toLowerCase())).size ===
        items.length,
      'Select each academic record once.',
    ),
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('update'), changes }),
    z.strictObject({ kind: z.literal('delete') }),
  ]),
});
export const academicWorkBatchResponseSchema = z.object({
  work: z.array(academicWorkSchema).min(1).max(100),
});
export type AcademicWorkBatchRequest = z.infer<
  typeof academicWorkBatchRequestSchema
>;
export type AcademicWorkBatchResponse = z.infer<
  typeof academicWorkBatchResponseSchema
>;
export type AcademicWorkBrowseQuery = z.infer<
  typeof academicWorkBrowseQuerySchema
>;
export type AcademicWorkBrowseResponse = z.infer<
  typeof academicWorkBrowseResponseSchema
>;
