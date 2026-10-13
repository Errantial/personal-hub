import { z } from 'zod';
import { taskSchema } from './core.js';
import { calendarRecordSchema, dateOnly, instant, zone } from './features.js';

/**
 * Natural-language planner assistant (live OpenRouter). The model only
 * proposes changes; the owner applies them through the ordinary versioned
 * task/calendar operations. See docs/ai-assistant.md.
 */
export const defaultAssistantModel = 'anthropic/claude-haiku-5.5';
export const assistantModelSchema = z
  .string()
  .min(3)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const assistantSettingsSchema = z.object({
  model: assistantModelSchema,
  version: z.number().int().positive(),
  /** The server has an OpenRouter key. It is never returned. */
  configured: z.boolean(),
});
export const assistantSettingsResponseSchema = z.object({
  settings: assistantSettingsSchema,
});
export const assistantSettingsUpdateSchema = z.strictObject({
  model: assistantModelSchema,
  expectedVersion: z.number().int().positive(),
  /** Sent by the shared write helper; saves are already version-guarded. */
  operationId: z.string().uuid().optional(),
});

export const assistantRequestInputSchema = z.strictObject({
  operationId: z.string().uuid(),
  text: z.string().trim().min(1).max(1000),
  timeZone: zone,
});

const title = z.string().trim().min(1).max(200);
const priority = z.enum(['low', 'normal', 'high']);
export const assistantProposalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task.create'),
    task: z.object({
      title,
      notes: z.string().max(2000),
      dueDate: dateOnly.nullable(),
      priority,
    }),
  }),
  z.object({
    kind: z.literal('task.update'),
    /** The task as it was sent to the model; Apply uses its version. */
    target: taskSchema,
    changes: z.object({
      title: title.optional(),
      dueDate: dateOnly.nullable().optional(),
      priority: priority.optional(),
      completed: z.boolean().optional(),
    }),
  }),
  z.object({
    kind: z.literal('event.create'),
    event: z.object({
      title,
      startsAt: instant,
      endsAt: instant,
      timeZone: zone,
      allDay: z.boolean(),
      startDate: dateOnly.nullable(),
      endDate: dateOnly.nullable(),
    }),
  }),
  z.object({
    kind: z.literal('event.update'),
    target: calendarRecordSchema,
    changes: z.object({
      title: title.optional(),
      startsAt: instant.optional(),
      endsAt: instant.optional(),
    }),
  }),
]);
export type AssistantProposal = z.infer<typeof assistantProposalSchema>;

export const assistantReasonSchema = z.enum([
  /** The answer was not valid structured output. */
  'invalid',
  /** OpenRouter reported a provider error after charging. */
  'provider-error',
  /** Output was refused, truncated or contained non-text parts. */
  'blocked',
  /** OpenRouter rejected the key. */
  'unauthorized',
  /** The OpenRouter account has no credit. */
  'payment-required',
  /** The model has no endpoint matching the privacy and format rules. */
  'unavailable',
  'rate-limited',
  /** Rejected before processing for another reason. */
  'rejected',
  /** Outcome unknown: the hold stays until reviewed. */
  'timeout',
  'transport',
  'response',
  'billing',
]);
export const assistantRequestSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['uncertain', 'completed', 'failed']),
  reason: assistantReasonSchema.nullable(),
  model: assistantModelSchema,
  /**
   * False when this is a stored receipt (a retried operation): the reply and
   * proposals are returned once and never stored.
   */
  resultAvailable: z.boolean(),
  reply: z.string().nullable(),
  proposals: z.array(assistantProposalSchema),
  /** Model suggestions that could not be turned into valid changes. */
  dropped: z.number().int().nonnegative(),
  /** Labeled items left out of the context. */
  withheld: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative().nullable(),
  heldMicros: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
export const assistantRequestResponseSchema = z.object({
  request: assistantRequestSchema,
});
