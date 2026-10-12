import { z } from 'zod';
import type { academicPlannerSourceSummarySchema } from './academic-source.js';

const label = z.enum(['unlabeled', 'personal', 'restricted']);
const timing = z.object({
  allDay: z.boolean(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime().nullable(),
});
const sourceRef = {
  itemId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
};
export const canvasSourceRefSchema = z.union([
  z.strictObject(sourceRef),
  z.strictObject({
    ...sourceRef,
    kind: z.literal('assignment-api'),
    expectedCourseVersion: z.number().int().positive(),
  }),
]);
export type CanvasSourceRef = z.infer<typeof canvasSourceRefSchema>;
export const plannerSourceSchema = z.object({
  itemId: z.string().uuid(),
  version: z.number().int().positive(),
  title: z.string(),
  sourceUrl: z.string().url().nullable(),
  inputKind: z.enum(['calendar-feed', 'calendar-file', 'assignment-api']),
  courseVersion: z.number().int().positive().optional(),
  currentCourseVersion: z.number().int().positive().optional(),
  attachmentDerived: z.boolean().optional(),
  currentAttachmentDerived: z.boolean().optional(),
  labels: z.array(label).min(1).max(3).optional(),
  currentLabels: z.array(label).min(1).max(3).optional(),
  sensitivity: label,
  timing,
  currentVersion: z.number().int().positive(),
  currentTitle: z.string(),
  currentAvailability: z.enum(['available', 'cancelled', 'missing']),
  currentInputKind: z.enum([
    'calendar-feed',
    'calendar-file',
    'assignment-api',
  ]),
  currentSensitivity: label,
  currentTiming: timing,
});
export type PlannerSource = z.infer<typeof plannerSourceSchema>;
export function plannerTextIsAttachmentDerived(record: {
  canvasSource?: PlannerSource | null;
}) {
  return (
    record.canvasSource?.attachmentDerived === true ||
    record.canvasSource?.currentAttachmentDerived === true ||
    record.canvasSource?.inputKind === 'calendar-file' ||
    record.canvasSource?.currentInputKind === 'calendar-file'
  );
}
export function plannerSensitivity(record: {
  sensitivity: z.infer<typeof label>;
  canvasSource?: PlannerSource | null;
  academicSource?: z.infer<typeof academicPlannerSourceSummarySchema> | null;
}) {
  const levels = ['unlabeled', 'personal', 'restricted'] as const;
  return levels[
    Math.max(
      levels.indexOf(record.sensitivity),
      levels.indexOf(record.canvasSource?.sensitivity ?? 'unlabeled'),
      levels.indexOf(record.canvasSource?.currentSensitivity ?? 'unlabeled'),
      ...(record.academicSource?.labels ?? []).map((value) =>
        levels.indexOf(value),
      ),
    )
  ]!;
}
