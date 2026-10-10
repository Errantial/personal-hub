import { z } from 'zod';
import { sensitivitySchema } from './core.js';
import { canvasJobSchema } from './connections.js';
const metadata = {
  id: z.string().uuid(),
  providerId: z.string().regex(/^[1-9]\d*$/),
  availability: z.enum(['available', 'missing']),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
  effectiveSensitivity: sensitivitySchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};
export const canvasLmsCourseDataSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(200),
  term: z.string().max(200),
  timeZone: z.string().nullable(),
});
export const canvasLmsAssignmentDataSchema = z.object({
  title: z.string().min(1).max(200),
  dueAt: z.string().datetime().nullable(),
  pointsPossible: z.number().finite().nonnegative().nullable(),
  published: z.boolean().nullable(),
  locked: z.boolean().nullable(),
});
export const canvasLmsCourseSchema = z.object({
  ...metadata,
  providerData: canvasLmsCourseDataSchema,
  courseId: z.string().uuid().nullable(),
  courseName: z.string().nullable(),
  courseDeleted: z.boolean(),
});
export const canvasLmsAssignmentSchema = z.object({
  ...metadata,
  canvasCourseId: z.string().uuid(),
  providerData: canvasLmsAssignmentDataSchema,
});
export const canvasLmsRecordsSchema = z.object({
  courses: z.array(canvasLmsCourseSchema),
  assignments: z.array(canvasLmsAssignmentSchema),
  lastImportedAt: z.string().datetime().nullable(),
});
export const canvasLmsConnectionSchema = canvasLmsRecordsSchema.extend({
  configured: z.boolean(),
  enabled: z.boolean(),
  version: z.number().int().positive(),
  sensitivity: sensitivitySchema,
  jobs: z.array(canvasJobSchema),
});
export const canvasLmsCourseWriteSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
  courseId: z.string().uuid().nullable(),
});
export const canvasLmsAssignmentWriteSchema = canvasLmsCourseWriteSchema.omit({
  courseId: true,
});
export type CanvasLmsCourse = z.infer<typeof canvasLmsCourseSchema>;
export type CanvasLmsAssignment = z.infer<typeof canvasLmsAssignmentSchema>;
export type CanvasLmsConnection = z.infer<typeof canvasLmsConnectionSchema>;
