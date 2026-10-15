import { z } from 'zod';
import { sensitivitySchema } from './core.js';
import { responsibilityLocalRuleSchema } from './responsibility-local-schedule.js';
const positive = z.number().int().positive();
export const runOutcomeSchema = z.enum([
  'quiet',
  'applied',
  'needs-approval',
  'warning',
  'failed',
]);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
const uuid = z.string().uuid();
const stamp = z.string().datetime();
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\0'), 'Remove null characters.');
export const responsibilityInputSchema = z.strictObject({
  title: text(160),
  goal: text(4000),
  sensitivity: sensitivitySchema.default('unlabeled'),
});
export const responsibilitySchema = z
  .object({
    id: uuid,
    version: positive,
    ...responsibilityInputSchema.shape,
    source: z.literal('owner-entered'),
    labels: z.array(sensitivitySchema).min(1).max(3),
    status: z.enum(['paused', 'active', 'cancelled']),
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: stamp.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      !value.labels.includes(value.sensitivity) ||
      new Set(value.labels).size !== value.labels.length ||
      (value.deletedAt && value.status !== 'cancelled')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid responsibility state.',
      });
  });
export const responsibilitySummarySchema = z
  .object(responsibilitySchema.shape)
  .omit({ goal: true });
export const responsibilityResponseSchema = z.object({
  responsibility: responsibilitySchema,
});
export const responsibilityMutationResponseSchema = z.object({
  responsibility: z.object({
    id: uuid,
    version: positive,
    status: responsibilitySchema.shape.status,
    deletedAt: stamp.nullable(),
  }),
});
export const createResponsibilitySchema = responsibilityInputSchema.extend({
  operationId: uuid,
});
export const updateResponsibilitySchema = createResponsibilitySchema.extend({
  expectedVersion: positive,
});
export const responsibilityMutationSchema = z.strictObject({
  operationId: uuid,
  expectedVersion: positive,
});
const paging = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: uuid.optional(),
  expectedCursorVersion: z.coerce.number().int().positive().optional(),
};
function paired(
  value: {
    after?: string | undefined;
    expectedCursorVersion?: number | undefined;
  },
  ctx: z.RefinementCtx,
) {
  if (Boolean(value.after) !== Boolean(value.expectedCursorVersion))
    ctx.addIssue({
      code: 'custom',
      message: 'Supply cursor ID and version together.',
    });
}
export const responsibilityPageQuerySchema = z
  .strictObject({
    ...paging,
    status: z.enum(['paused', 'active', 'cancelled', 'all']).default('all'),
    deleted: z.enum(['false', 'true', 'all']).default('false'),
  })
  .superRefine(paired);
const cursor = z.object({ id: uuid, version: positive }).nullable();
export const responsibilityPageSchema = z.object({
  responsibilities: z.array(responsibilitySummarySchema).max(100),
  nextAfter: cursor,
});
export const responsibilityScheduleInputSchema = z.strictObject({
  startsAt: stamp,
  intervalMinutes: z.number().int().min(15).max(10080).nullable().default(null),
});
export const responsibilityScheduleSchema = z
  .object({
    responsibilityId: uuid,
    version: positive,
    ...responsibilityScheduleInputSchema.shape,
    nextDueAt: stamp.nullable(),
    updatedAt: stamp,
    deletedAt: stamp.nullable(),
    localRule: responsibilityLocalRuleSchema.nullable().default(null),
    nextLocalIndex: z.number().int().nonnegative().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (
      value.localRule === null
        ? value.nextLocalIndex !== null
        : value.intervalMinutes !== null ||
          (value.nextDueAt === null) !== (value.nextLocalIndex === null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid local schedule state.',
      });
    if (value.deletedAt !== null && value.nextDueAt !== null)
      ctx.addIssue({
        code: 'custom',
        message: 'Deleted schedule cannot be pending.',
      });
  });
export const responsibilityScheduleResponseSchema = z.object({
  schedule: responsibilityScheduleSchema.nullable(),
});
export const responsibilityScheduleWriteSchema =
  responsibilityMutationSchema.extend({
    schedule: responsibilityScheduleInputSchema.nullable(),
  });
export const responsibilityDueQuerySchema = z
  .strictObject({
    ...paging,
    expectedScheduleVersion: z.coerce.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    paired(value, ctx);
    if (Boolean(value.after) !== Boolean(value.expectedScheduleVersion))
      ctx.addIssue({
        code: 'custom',
        message: 'Supply the schedule cursor version.',
      });
  });
export const responsibilityDueItemSchema = z.object({
  id: uuid,
  version: positive,
  title: text(160),
  scheduleVersion: positive,
  nextDueAt: stamp,
});
export const responsibilityDuePageSchema = z.object({
  asOf: stamp,
  dueCount: z.number().int().nonnegative(),
  items: z.array(responsibilityDueItemSchema).max(100),
  nextAfter: z
    .object({ id: uuid, version: positive, scheduleVersion: positive })
    .nullable(),
  executionEnabled: z.literal(false),
});
export const responsibilityDueAdmissionSchema = z
  .strictObject({
    operationId: uuid,
    items: z
      .array(
        z.strictObject({
          id: uuid,
          expectedVersion: positive,
          expectedScheduleVersion: positive,
        }),
      )
      .min(1)
      .max(25),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.items.map((item) => item.id.toLowerCase())).size !==
      value.items.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Select each responsibility once.',
      });
  });
export const responsibilityRunSchema = z
  .object({
    id: uuid,
    responsibilityId: uuid,
    responsibilityVersion: positive,
    version: positive,
    trigger: z.enum(['manual', 'schedule']),
    scheduledFor: stamp.nullable(),
    scheduleVersion: positive.nullable(),
    skippedIntervals: z.number().int().nonnegative(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    labels: z.array(sensitivitySchema).min(1).max(3),
    status: z.enum([
      'blocked',
      'cancelled',
      'queued',
      'running',
      'completed',
      'failed',
    ]),
    cancelReason: z
      .enum([
        'owner-dismissed',
        'responsibility-paused',
        'responsibility-cancelled',
        'responsibility-deleted',
        'source-changed',
        'schedule-changed',
        'cap-reached',
      ])
      .nullable(),
    createdAt: stamp,
    cancelledAt: stamp.nullable(),
    /** Agent runs (D57); null for legacy blocked reviews. */
    attempts: z.number().int().nonnegative().default(0),
    turnId: uuid.nullable().default(null),
    outcome: runOutcomeSchema.nullable().default(null),
    errorCode: z.string().nullable().default(null),
    finishedAt: stamp.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === 'cancelled') !==
        (value.cancelledAt !== null && value.cancelReason !== null) ||
      (value.status !== 'cancelled' &&
        (value.cancelledAt !== null || value.cancelReason !== null)) ||
      ['completed', 'failed'].includes(value.status) !==
        (value.finishedAt !== null && value.outcome !== null) ||
      (value.trigger === 'manual'
        ? value.scheduledFor !== null ||
          value.scheduleVersion !== null ||
          value.skippedIntervals !== 0
        : value.scheduledFor === null || value.scheduleVersion === null)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid run state.' });
  });
export const responsibilityRunResponseSchema = z.object({
  run: responsibilityRunSchema,
  executionEnabled: z.literal(false),
});
export const responsibilityDueAdmissionResponseSchema = z.object({
  runs: z.array(responsibilityRunSchema).max(25),
  executionEnabled: z.literal(false),
});
export const responsibilityHistoryQuerySchema = z
  .strictObject(paging)
  .superRefine(paired);
export const responsibilityRunPageSchema = z.object({
  runs: z.array(responsibilityRunSchema).max(100),
  nextAfter: cursor,
  executionEnabled: z.literal(false),
});
export const responsibilityActivitySchema = z.object({
  id: uuid,
  responsibilityId: uuid,
  responsibilityVersion: positive,
  kind: z.enum([
    'created',
    'updated',
    'resumed',
    'paused',
    'cancelled',
    'deleted',
    'schedule-set',
    'schedule-cleared',
    'run-created',
    'run-dismissed',
    'runs-cancelled',
    'run-started',
    'run-completed',
    'run-failed',
    'cap-reached',
  ]),
  runId: uuid.nullable(),
  createdAt: stamp,
});
export const responsibilityActivityPageQuerySchema = z.strictObject({
  limit: paging.limit,
  after: uuid.optional(),
});
export const responsibilityActivityPageSchema = z.object({
  activities: z.array(responsibilityActivitySchema).max(100),
  nextAfter: uuid.nullable(),
});
export type Responsibility = z.infer<typeof responsibilitySchema>;
export type ResponsibilityRun = z.infer<typeof responsibilityRunSchema>;
