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
  /**
   * Owner permission to send Personal-labeled mail to OpenRouter for
   * category suggestions. Restricted mail is never sent.
   */
  allowPersonalMail: z.boolean().default(false),
  /** The last state of the composer's "Use mail" box, on every device. */
  useMail: z.boolean().default(false),
});
export const assistantSettingsResponseSchema = z.object({
  settings: assistantSettingsSchema,
});
export const assistantSettingsUpdateSchema = z.strictObject({
  model: assistantModelSchema,
  expectedVersion: z.number().int().positive(),
  allowPersonalMail: z.boolean().optional(),
  useMail: z.boolean().optional(),
  /** Sent by the shared write helper; saves are already version-guarded. */
  operationId: z.string().uuid().optional(),
});

export const assistantRequestInputSchema = z.strictObject({
  operationId: z.string().uuid(),
  text: z.string().trim().min(1).max(1000),
  timeZone: zone,
  /**
   * The conversation to continue, or a new client-made ID to start one.
   * Omitted: a new conversation with a server-made ID.
   */
  conversationId: z.string().uuid().optional(),
  /**
   * Allow searching eligible mail (D56): up to three model calls, at most
   * five bodies read. Off: mail is never touched.
   */
  useMail: z.boolean().default(false),
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
  /** False when the request produced no usable answer. */
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

/** What happened to one proposal; stored so every device sees it. */
export const assistantItemSchema = z.object({
  state: z.enum(['proposed', 'applied', 'failed', 'undone']),
  /** The written record, for Undo. */
  applied: z
    .object({ id: z.string().uuid(), version: z.number().int().positive() })
    .nullable(),
  error: z.string().max(300).nullable(),
  /** Stable per write so a retry from any device is not doubled. */
  applyId: z.string().uuid(),
  undoId: z.string().uuid(),
});
export type AssistantItem = z.infer<typeof assistantItemSchema>;

/** A message whose subject and sender (and body, if read) were sent. */
export const assistantMailSentSchema = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  from: z.string().nullable(),
  receivedAt: z.string().datetime(),
  /** The body was sent too, not only subject and sender. */
  read: z.boolean(),
});
export type AssistantMailSent = z.infer<typeof assistantMailSentSchema>;

export const assistantTurnSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  ask: z.string(),
  /**
   * Totals across every model call of this ask; status and reason come from
   * the last call.
   */
  request: assistantRequestSchema,
  items: z.array(assistantItemSchema),
  version: z.number().int().positive(),
  useMail: z.boolean().default(false),
  mail: z.array(assistantMailSentSchema).default([]),
  /** Matching messages the owner's labels kept out. */
  mailWithheld: z.number().int().nonnegative().default(0),
  /** Why mail reading stopped early, if it did. */
  mailNote: z.string().nullable().default(null),
});
export type AssistantTurn = z.infer<typeof assistantTurnSchema>;

export const assistantRequestResponseSchema = z.object({
  request: assistantRequestSchema,
  turn: assistantTurnSchema,
});

export const assistantConversationSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  turnCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AssistantConversation = z.infer<typeof assistantConversationSchema>;
export const assistantConversationListSchema = z.object({
  conversations: z.array(assistantConversationSchema),
});
export const assistantConversationResponseSchema = z.object({
  conversation: assistantConversationSchema,
  turns: z.array(assistantTurnSchema),
});
export const assistantConversationDeleteSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  operationId: z.string().uuid().optional(),
});
export const assistantConversationDeletedSchema = z.object({
  deleted: z.literal(true),
});
export const assistantItemsUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  items: z.array(assistantItemSchema).max(10),
  operationId: z.string().uuid().optional(),
});
export const assistantTurnResponseSchema = z.object({
  turn: assistantTurnSchema,
});
