import { z } from 'zod';
import {
  responsibilitySchema,
  responsibilityScheduleSchema,
  responsibilityRunSchema,
  responsibilityActivitySchema,
} from './responsibilities.js';
import { memorySchema, memorySettingsSchema } from './memory.js';
import { aiProviderConsentSchema } from './ai-provider-policy.js';
import { aiRequestSchema } from './ai-requests.js';
import { aiSavedAnswerSchema } from './ai-saved-answers.js';
import { academicWorkSchema } from './academic-work.js';
import { academicPlannerLinkSchema } from './academic-planning.js';
import {
  studyWorkloadContextSchema,
  studyWorkloadSourceSchema,
  studyEventContextSchema,
} from './study-workload.js';
import {
  studyPreferencesSchema,
  studyGoalSchema,
  studyPlanSchema,
} from './study.js';
import { canvasReconciliationSchema } from './canvas-reconciliation.js';
import { aiRoutingSettingsSchema } from './ai-routing.js';
import { aiActionSettingsSchema } from './ai-actions.js';
import {
  emailDraftSchema,
  emailRevisionSchema,
  emailApprovalSchema,
  emailAttemptSchema,
} from './email-drafts.js';
import { aiPreflightSchema } from './ai-preflight.js';
import {
  aiBudgetSettingsSchema,
  aiBudgetReservationSchema,
} from './ai-budget.js';
import {
  calendarRecordSchema,
  calendarInputSchema,
  courseSchema,
  topicSchema,
  reminderSchema,
  notificationSchema,
  dateOnly,
} from './features.js';
import { taskSchema, userSchema, plannerRestorationSchema } from './core.js';
import { canvasItemSchema } from './connections.js';
import {
  canvasLmsCourseSchema,
  canvasLmsAssignmentSchema,
} from './canvas-lms.js';

export const accountSessionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  current: z.boolean(),
});
export const accountResponseSchema = z.object({
  user: userSchema,
  version: z.number().int().positive(),
  sessions: z.array(accountSessionSchema),
});
export const changePasswordSchema = z
  .strictObject({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
    expectedVersion: z.number().int().positive(),
  })
  .refine(
    (value) => value.currentPassword !== value.newPassword,
    'Choose a different password.',
  );
export const sessionRevokeResponseSchema = z.object({ ok: z.literal(true) });
export const plannerExportSchema = z.object({
  format: z.literal('personal-hub-planner'),
  formatVersion: z.literal(1),
  exportedAt: z.string().datetime(),
  owner: userSchema,
  records: z.object({
    tasks: z.array(taskSchema),
    plannerRestorations: z.array(plannerRestorationSchema).default([]),
    events: z.array(calendarRecordSchema),
    courses: z.array(courseSchema),
    topics: z.array(topicSchema),
    academicWork: z.array(academicWorkSchema).default([]),
    academicPlannerSources: z.array(academicPlannerLinkSchema).default([]),
    exceptions: z.array(
      z.object({
        eventId: z.string().uuid(),
        originalDate: dateOnly,
        cancelled: z.boolean(),
        replacement: calendarInputSchema.nullable(),
      }),
    ),
    reminders: z.array(reminderSchema),
    notifications: z.array(notificationSchema),
    canvasItems: z.array(canvasItemSchema).default([]),
    aiRouting: aiRoutingSettingsSchema.nullable().default(null),
    aiActions: aiActionSettingsSchema.nullable().default(null),
    emailDrafts: z.array(emailDraftSchema).default([]),
    emailDraftRevisions: z.array(emailRevisionSchema).default([]),
    emailApprovals: z.array(emailApprovalSchema).default([]),
    emailAttempts: z.array(emailAttemptSchema).default([]),
    memories: z.array(memorySchema).default([]),
    memorySettings: memorySettingsSchema.nullable().default(null),
    responsibilities: z.array(responsibilitySchema).default([]),
    responsibilitySchedules: z.array(responsibilityScheduleSchema).default([]),
    responsibilityRuns: z.array(responsibilityRunSchema).default([]),
    responsibilityActivities: z.array(responsibilityActivitySchema).default([]),
    aiPreflights: z.array(aiPreflightSchema).default([]),
    aiBudget: aiBudgetSettingsSchema.nullable().default(null),
    aiBudgetReservations: z.array(aiBudgetReservationSchema).default([]),
    aiProviderConsents: z.array(aiProviderConsentSchema).default([]),
    aiRequests: z.array(aiRequestSchema).default([]),
    aiSavedAnswers: z.array(aiSavedAnswerSchema).default([]),
    studyPreferences: studyPreferencesSchema.nullable().default(null),
    studyGoals: z.array(studyGoalSchema).default([]),
    studyPlans: z.array(studyPlanSchema).default([]),
    studyWorkloadContexts: z.array(studyWorkloadContextSchema).default([]),
    studyWorkloadSources: z.array(studyWorkloadSourceSchema).default([]),
    studyEventContexts: z.array(studyEventContextSchema).default([]),
    canvasReconciliations: z.array(canvasReconciliationSchema).default([]),
    canvasLmsCourses: z.array(canvasLmsCourseSchema).default([]),
    canvasLmsAssignments: z.array(canvasLmsAssignmentSchema).default([]),
    canvasLmsSource: z
      .object({
        accountProviderId: z
          .string()
          .regex(/^[1-9]\d{0,19}$/)
          .nullable()
          .default(null),
        enabled: z.boolean(),
        sensitivity: z.enum(['unlabeled', 'personal', 'restricted']),
        version: z.number().int().positive(),
      })
      .nullable()
      .default(null),
    canvasSource: z
      .object({
        enabled: z.boolean(),
        sensitivity: z.enum(['unlabeled', 'personal', 'restricted']),
        version: z.number().int().positive(),
      })
      .nullable()
      .default(null),
  }),
});
export type AccountResponse = z.infer<typeof accountResponseSchema>;
