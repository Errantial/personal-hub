import { z } from 'zod';
import { dateOnly, instant } from './features.js';

const grade = z.strictObject({
  earned: z.number().min(0).max(1000000).multipleOf(0.0001),
  possible: z.number().min(0.0001).max(1000000).multipleOf(0.0001),
});
const workStatus = z.enum(['planned', 'in_progress', 'submitted', 'cancelled']);
const fields = {
  courseId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  kind: z
    .enum(['assignment', 'exam', 'project', 'other'])
    .default('assignment'),
  notes: z.string().max(10000).default(''),
  dueDate: dateOnly.nullable().default(null),
  estimatedMinutes: z.number().int().min(0).max(60000).nullable().default(null),
  priority: z.number().int().min(1).max(5).default(3),
  status: workStatus.default('planned'),
  grade: grade.nullable().default(null),
  sensitivity: z
    .enum(['unlabeled', 'personal', 'restricted'])
    .default('unlabeled'),
};
export const academicWorkInputSchema = z
  .strictObject(fields)
  .refine(
    (value) => value.grade === null || value.status === 'submitted',
    'A recorded score requires submitted work.',
  );
export const academicWorkWriteSchema = academicWorkInputSchema.safeExtend({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive().optional(),
});
export const academicWorkUpdateSchema = academicWorkWriteSchema.safeExtend({
  expectedVersion: z.number().int().positive(),
  status: workStatus,
  grade: grade.nullable(),
});
export const academicWorkSchema = z.object({
  ...fields,
  id: z.string().uuid(),
  version: z.number().int().positive(),
  provenance: z.literal('owner-entered'),
  academicLabels: z.array(z.enum(['personal', 'restricted'])).max(2),
  createdAt: instant,
  updatedAt: instant,
  deletedAt: instant.nullable(),
});
export const academicWorkResponseSchema = z.object({
  work: academicWorkSchema,
});
export const academicWorkQuerySchema = z.strictObject({
  courseId: z.string().uuid().optional(),
  status: workStatus.optional(),
  deleted: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().uuid().optional(),
});
export const academicWorkListSchema = z.object({
  work: z.array(academicWorkSchema),
  nextBefore: z.string().uuid().nullable(),
});
export const academicWorkSummaryQuerySchema = z.strictObject({
  asOf: dateOnly,
});
export const academicWorkSummarySchema = z.object({
  courseId: z.string().uuid(),
  courseArchived: z.boolean(),
  asOf: dateOnly,
  activeCount: z.number().int().nonnegative(),
  submittedCount: z.number().int().nonnegative(),
  overdueCount: z.number().int().nonnegative(),
  missingDeadlineCount: z.number().int().nonnegative(),
  missingEstimateCount: z.number().int().nonnegative(),
  estimatedOpenMinutes: z.number().int().nonnegative(),
  recordedScoreCount: z.number().int().nonnegative(),
  ungradedSubmittedCount: z.number().int().nonnegative(),
  recordedEarnedPoints: z.number().nonnegative(),
  recordedPossiblePoints: z.number().nonnegative(),
  recordedPointsPercent: z.number().nonnegative().nullable(),
  warnings: z.array(
    z.enum([
      'MANUAL_RECORDS_ONLY',
      'NOT_FINAL_CLASS_GRADE',
      'EXTRA_CREDIT_PRESENT',
    ]),
  ),
});
export type AcademicWork = z.infer<typeof academicWorkSchema>;
