import { z } from 'zod';
import { zone } from './features.js';
import { runOutcomeSchema } from './responsibilities.js';
import { localTimeSchema } from './responsibility-local-schedule.js';

// Persistent agents (D57, docs/superpowers/specs/2026-10-14-persistent-agents-design.md):
// scheduled responsibilities that run through the Assistant pipeline.

const uuid = z.string().uuid();
const positive = z.number().int().positive();
const stamp = z.string().datetime();
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\0'), 'Remove null characters.');

export const agentTemplateSchema = z.enum([
  'daily-plan',
  'mail-triage',
  'deadline-watch',
  'custom',
]);
export type AgentTemplate = z.infer<typeof agentTemplateSchema>;

/** Local times are sorted and deduplicated; weekly needs a weekday (1 = Monday). */
export const agentScheduleSchema = z
  .strictObject({
    frequency: z.enum(['daily', 'weekly']),
    weekday: z.number().int().min(1).max(7).optional(),
    times: z
      .array(localTimeSchema)
      .min(1)
      .max(6)
      .transform((times) => [...new Set(times)].sort()),
  })
  .superRefine((value, ctx) => {
    if ((value.frequency === 'weekly') !== (value.weekday !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'Choose a weekday for weekly agents only.',
      });
  });
export type AgentSchedule = z.infer<typeof agentScheduleSchema>;

export const agentCapRange = { min: 100_000, max: 50_000_000 } as const;
const agentFields = {
  title: text(160),
  goal: text(2000),
  schedule: agentScheduleSchema,
  useMail: z.boolean(),
  monthlyCapMicros: z
    .number()
    .int()
    .min(agentCapRange.min)
    .max(agentCapRange.max),
  timeZone: zone,
};
export const agentWriteSchema = z.strictObject({
  operationId: uuid,
  template: agentTemplateSchema,
  ...agentFields,
});
export const agentUpdateSchema = z.strictObject({
  operationId: uuid,
  expectedVersion: positive,
  ...agentFields,
});
export const agentRunRequestSchema = z.strictObject({
  operationId: uuid,
  expectedVersion: positive,
});

export const agentSchema = z.object({
  id: uuid,
  version: positive,
  template: agentTemplateSchema,
  title: z.string(),
  goal: z.string(),
  status: z.enum(['active', 'paused']),
  pauseReason: z.literal('cap-reached').nullable(),
  schedule: agentScheduleSchema,
  useMail: z.boolean(),
  monthlyCapMicros: z.number().int().positive(),
  spentMicros: z.number().int().nonnegative(),
  timeZone: z.string(),
  conversationId: uuid,
  nextRunAt: stamp.nullable(),
  lastRun: z
    .object({
      id: uuid,
      status: z.enum([
        'blocked',
        'cancelled',
        'queued',
        'running',
        'completed',
        'failed',
      ]),
      outcome: runOutcomeSchema.nullable(),
      errorCode: z.string().nullable(),
      finishedAt: stamp.nullable(),
      turnId: uuid.nullable(),
    })
    .nullable(),
});
export type Agent = z.infer<typeof agentSchema>;
export const agentsResponseSchema = z.object({ agents: z.array(agentSchema) });
export const agentResponseSchema = z.object({ agent: agentSchema });
export const agentRunResponseSchema = z.object({
  agent: agentSchema,
  runId: uuid,
});
export const agentWorkerSchema = z.object({
  lastTick: stamp.nullable(),
  errorCode: z.string().nullable(),
  healthy: z.boolean(),
});

/** Agent fields of a responsibility in the planner export. */
export const agentExportSchema = z.object({
  id: uuid,
  template: agentTemplateSchema,
  conversationId: uuid,
  timeZone: z.string(),
  useMail: z.boolean(),
  monthlyCapMicros: z.number().int().positive(),
  pauseReason: z.literal('cap-reached').nullable(),
});

type TemplateText = {
  title: string;
  goal: string;
  /** Fixed text sent before the owner's goal. */
  instructions: string;
  schedule: AgentSchedule;
  useMail: boolean;
};
export const agentTemplates: Record<
  Exclude<AgentTemplate, 'custom'>,
  TemplateText
> = {
  'daily-plan': {
    title: 'Daily plan',
    goal: 'Help me start each day with a clear, realistic plan.',
    instructions:
      "Read today's tasks, events and deadlines (and recent mail if provided). Write a short plan for today in the reply. Propose changes only where something is clearly missing or misplaced.",
    schedule: { frequency: 'daily', times: ['07:00'] },
    useMail: true,
  },
  'mail-triage': {
    title: 'Mail triage',
    goal: 'Make sure mail that needs action does not get lost.',
    instructions:
      'Look at recent mail. In the reply, list messages that need action. Propose a task only when the mail states a deadline; quote the deadline text in the task notes.',
    schedule: {
      frequency: 'daily',
      times: ['08:00', '12:00', '16:00', '20:00'],
    },
    useMail: true,
  },
  'deadline-watch': {
    title: 'Deadline watch',
    goal: 'Leave enough time to finish work before each deadline.',
    instructions:
      'Check deadlines in the next 7 days. For each one at risk, propose a study block (event.create) before it, avoiding existing events.',
    schedule: { frequency: 'daily', times: ['18:00'] },
    useMail: false,
  },
};
export const customInstructions =
  "Work toward the owner's goal below using the tasks, events and mail provided.";
