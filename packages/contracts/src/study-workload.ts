import { z } from 'zod';
import { dateOnly, instant } from './features.js';

const label = z.enum(['unlabeled', 'personal', 'restricted']);
export const studyWorkloadSnapshotSchema = z.strictObject({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  courseId: z.string().uuid(),
  courseVersion: z.number().int().positive(),
  courseSensitivity: label,
  dueDate: dateOnly.nullable(),
  estimatedMinutes: z.number().int().min(0).max(60000).nullable(),
  priority: z.number().int().min(1).max(5),
  status: z.enum(['planned', 'in_progress', 'submitted', 'cancelled']),
  sensitivity: label,
  academicLabels: z.array(z.enum(['personal', 'restricted'])).max(2),
  provenance: z.literal('owner-entered-planning-fields'),
});
export const studyWorkloadCurrentSchema = studyWorkloadSnapshotSchema.extend({
  deletedAt: instant.nullable(),
  courseArchived: z.boolean(),
});
export const studyWorkloadContextSchema = z.object({
  planId: z.string().uuid(),
  contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  sourceCount: z.number().int().min(0).max(5000),
  capturedAt: instant,
});
export const studyWorkloadSourceSchema = z.object({
  planId: z.string().uuid(),
  workId: z.string().uuid(),
  snapshot: studyWorkloadSnapshotSchema,
});
export const studyEventContextSchema = z.object({
  planId: z.string().uuid(),
  eventId: z.string().uuid(),
});
export const studyWorkloadQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: z.string().uuid().optional(),
  expectedPlanVersion: z.coerce.number().int().positive().optional(),
});
export const studyWorkloadResponseSchema = z.object({
  planId: z.string().uuid().nullable(),
  planVersion: z.number().int().positive().nullable(),
  planStatus: z.enum(['draft', 'approved', 'cancelled']).nullable(),
  planHidden: z.boolean(),
  eventId: z.string().uuid().nullable(),
  eventVersion: z.number().int().positive().nullable(),
  eventDeletedAt: instant.nullable(),
  history: z.enum(['captured', 'unavailable', 'not-linked']),
  context: studyWorkloadContextSchema.nullable(),
  sources: z
    .array(
      z.object({
        snapshot: studyWorkloadSnapshotSchema,
        current: studyWorkloadCurrentSchema,
        changed: z.boolean(),
      }),
    )
    .max(200),
  nextAfter: z.string().uuid().nullable(),
});
export type StudyWorkloadSnapshot = z.infer<typeof studyWorkloadSnapshotSchema>;
