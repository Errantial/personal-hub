import { z } from 'zod';
import { canvasItemSchema } from './connections.js';
import {
  canvasLmsAssignmentSchema,
  canvasLmsCourseSchema,
} from './canvas-lms.js';
export const canvasReconciliationSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export const canvasReconciliationListSchema = z.object({
  items: z.array(canvasItemSchema),
  courses: z.array(canvasLmsCourseSchema),
  assignments: z.array(canvasLmsAssignmentSchema),
  links: z.array(canvasReconciliationSchema),
});
export const canvasReconciliationWriteSchema = z
  .strictObject({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive().nullable(),
    expectedItemVersion: z.number().int().positive(),
    assignmentId: z.string().uuid().nullable(),
    expectedAssignmentVersion: z.number().int().positive().nullable(),
    expectedCourseVersion: z.number().int().positive().nullable(),
  })
  .refine(
    (value) =>
      value.assignmentId
        ? value.expectedAssignmentVersion !== null &&
          value.expectedCourseVersion !== null
        : value.expectedAssignmentVersion === null &&
          value.expectedCourseVersion === null,
    'Include assignment/course versions only when linking.',
  );
export const canvasReconciliationResponseSchema = z.object({
  link: canvasReconciliationSchema,
});
export type CanvasReconciliation = z.infer<typeof canvasReconciliationSchema>;
export function canvasAssignmentUrl(
  courseProviderId: string,
  assignmentProviderId: string,
) {
  return `https://canvas.colorado.edu/courses/${courseProviderId}/assignments/${assignmentProviderId}`;
}
