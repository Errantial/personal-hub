import { z } from 'zod';
import { taskSchema } from './core.js';
import { calendarRecordSchema, dateOnly, instant, zone } from './features.js';
import { runOutcomeSchema } from './responsibilities.js';

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

/**
 * The owner's approved live destination: one OpenRouter model pinned to one
 * server-declared host. Every live request blocks unless it is ready.
 */
export const liveUpstreamSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const liveDestinationStatusSchema = z
  .object({
    status: z.enum(['ready', 'blocked']),
    reason: z
      .enum([
        'key-missing',
        'approval-required',
        'approval-stale',
        'model-unsupported',
      ])
      .nullable(),
    approved: z
      .object({ model: assistantModelSchema, upstream: liveUpstreamSchema })
      .nullable(),
    /** The current Assistant model setting. */
    model: assistantModelSchema,
    /** Hosts the server declares for that model. */
    hosts: z.array(liveUpstreamSchema),
    /** Personal mail may also be sent (the existing owner switch). */
    personalMail: z.boolean(),
    /** 0 until the first approval. */
    version: z.number().int().nonnegative(),
  })
  .refine((value) => (value.reason === null) === (value.status === 'ready'), {
    message: 'A blocked destination needs a reason.',
  });
export type LiveDestinationStatus = z.infer<typeof liveDestinationStatusSchema>;
export const liveDestinationResponseSchema = z.object({
  destination: liveDestinationStatusSchema,
});
export const liveDestinationApproveSchema = z.strictObject({
  model: assistantModelSchema,
  upstream: liveUpstreamSchema,
  expectedVersion: z.number().int().nonnegative(),
  /** Sent by the shared write helper; approvals are already version-guarded. */
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
  /** A source, setting or session changed before sending; nothing was sent. */
  'context-changed',
  /** The approved destination changed before sending; nothing was sent. */
  'route-blocked',
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
  /** The body was cut to the length limit before sending. */
  truncated: z.boolean().default(false),
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
  /** Who started the turn: the owner, or a scheduled/Run now agent run. */
  trigger: z.enum(['owner', 'agent']).default('owner'),
  /** Proposals dropped because action settings turn that kind off. */
  notAllowed: z.number().int().nonnegative().default(0),
  mail: z.array(assistantMailSentSchema).default([]),
  /** Matching messages the owner's labels kept out. */
  mailWithheld: z.number().int().nonnegative().default(0),
  /** Why mail reading stopped early, if it did. */
  mailNote: z.string().nullable().default(null),
  /**
   * bound: this ask and reply may be sent again as history while their
   * sources stay eligible. unbound: readable only (legacy or ineligible).
   */
  inferenceHistory: z.enum(['unbound', 'bound']).default('unbound'),
  /** read-only: the proposals came from mail and cannot be applied yet. */
  proposalAccess: z.enum(['applicable', 'read-only']).default('applicable'),
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
  /** Present when this is an agent's pinned thread. */
  agent: z
    .object({
      id: z.string().uuid(),
      title: z.string(),
      status: z.enum(['active', 'paused']),
      pauseReason: z.literal('cap-reached').nullable(),
      nextRunAt: z.string().datetime().nullable(),
      lastOutcome: runOutcomeSchema.nullable(),
      lastRunAt: z.string().datetime().nullable(),
    })
    .nullable()
    .default(null),
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
