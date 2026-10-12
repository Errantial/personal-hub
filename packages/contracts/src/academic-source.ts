import { z } from 'zod';

// Independent of planner/date modules so task and calendar records can share it.
export const academicPlannerSourceSummarySchema = z.object({
  linkId: z.string().uuid(),
  workId: z.string().uuid(),
  courseId: z.string().uuid(),
  capturedWorkVersion: z.number().int().positive(),
  capturedCourseVersion: z.number().int().positive(),
  currentWorkVersion: z.number().int().positive(),
  currentCourseVersion: z.number().int().positive(),
  currentStatus: z.enum(['planned', 'in_progress', 'submitted', 'cancelled']),
  sourceDeleted: z.boolean(),
  courseArchived: z.boolean(),
  labels: z.array(z.enum(['personal', 'restricted'])).max(2),
  provenance: z.literal('owner-entered-planning-fields'),
});
