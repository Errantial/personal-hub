import { z } from 'zod';
import { canvasItemSchema } from './connections.js';
import { canvasBrowserItemSchema } from './canvas-browser.js';
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
  browserItems: z.array(canvasBrowserItemSchema).default([]),
  browserLinks: z
    .array(
      z.object({
        id: z.string().uuid(),
        browserItemId: z.string().uuid(),
        itemId: z.string().uuid(),
        version: z.number().int().positive(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
        deletedAt: z.string().datetime().nullable(),
      }),
    )
    .default([]),
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
export const canvasBrowserReconciliationSchema = z.object({
  id: z.string().uuid(),
  browserItemId: z.string().uuid(),
  itemId: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export const canvasBrowserReconciliationWriteSchema = z
  .strictObject({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive().nullable(),
    expectedBrowserItemVersion: z.number().int().positive(),
    itemId: z.string().uuid().nullable(),
    expectedItemVersion: z.number().int().positive().nullable(),
  })
  .refine(
    (value) =>
      value.itemId
        ? value.expectedItemVersion !== null
        : value.expectedItemVersion === null,
    'Include the calendar item version only when linking.',
  );
export const canvasBrowserReconciliationResponseSchema = z.object({
  link: canvasBrowserReconciliationSchema,
});
export type CanvasReconciliation = z.infer<typeof canvasReconciliationSchema>;
export function canvasAssignmentUrl(
  courseProviderId: string,
  assignmentProviderId: string,
) {
  return `https://canvas.colorado.edu/courses/${courseProviderId}/assignments/${assignmentProviderId}`;
}
