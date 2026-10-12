import { z } from 'zod';
import { sensitivitySchema } from './core.js';

const address = z.string().trim().email().max(254);
const addresses = z.array(address).max(50).default([]);
export const emailMessageSchema = z
  .strictObject({
    connection: z.enum(['proton-mail', 'outlook-mail']),
    purpose: z
      .enum([
        'email',
        'calendar-invitation',
        'calendar-attendee-update',
        'calendar-cancellation',
      ])
      .default('email'),
    sender: address,
    to: addresses,
    cc: addresses,
    bcc: addresses,
    subject: z
      .string()
      .max(200)
      .refine((value) => !/[\r\n\0]/.test(value), 'Use a single-line subject.'),
    body: z
      .string()
      .max(12000)
      .refine((value) => !value.includes('\0'), 'Remove null characters.'),
    attachments: z.array(z.never()).max(0).default([]),
    sensitivity: sensitivitySchema.default('unlabeled'),
  })
  .superRefine((message, ctx) => {
    const recipients = [...message.to, ...message.cc, ...message.bcc];
    if (!recipients.length || recipients.length > 50)
      ctx.addIssue({ code: 'custom', message: 'Use 1-50 recipients.' });
    if (
      new Set(recipients.map((value) => value.toLowerCase())).size !==
      recipients.length
    )
      ctx.addIssue({ code: 'custom', message: 'Use each recipient once.' });
  });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive();
const stamp = z.string().datetime();
export const emailApprovalSchema = z.object({
  id: z.string().uuid(),
  draftId: z.string().uuid(),
  version: positive,
  draftVersion: positive,
  contentHash: hash,
  approvedAt: stamp,
  revokedAt: stamp.nullable(),
});
const metadata = {
  id: z.string().uuid(),
  version: positive,
  contentHash: hash,
  createdAt: stamp,
  updatedAt: stamp,
  deletedAt: stamp.nullable(),
};
export const emailDraftSchema = z.object({
  ...metadata,
  message: emailMessageSchema,
  approval: emailApprovalSchema.nullable(),
  status: z.enum(['pending', 'approved', 'deleted']),
});
export const emailDraftResponseSchema = z.object({ draft: emailDraftSchema });
export const emailDraftSummarySchema = z.object({
  ...metadata,
  connection: emailMessageSchema.shape.connection,
  purpose: emailMessageSchema.shape.purpose,
  sender: address,
  subject: z.string(),
  recipientCount: positive,
  sensitivity: sensitivitySchema,
  status: z.enum(['pending', 'approved', 'deleted']),
  approval: emailApprovalSchema.nullable(),
});
export const createEmailDraftSchema = z.strictObject({
  operationId: z.string().uuid(),
  message: emailMessageSchema,
});
export const updateEmailDraftSchema = createEmailDraftSchema.extend({
  expectedVersion: positive,
});
export const emailDraftMutationSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: positive,
});
export const approveEmailDraftSchema = emailDraftMutationSchema.extend({
  reviewedContentHash: hash,
  decision: z.literal('approve-exact-message'),
});
export const emailApprovalResponseSchema = z.object({
  approval: emailApprovalSchema,
});
const pageFields = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().uuid().optional(),
  expectedCursorVersion: z.coerce.number().int().positive().optional(),
};
function paired(
  input: {
    after?: string | undefined;
    expectedCursorVersion?: number | undefined;
  },
  ctx: z.RefinementCtx,
) {
  if (Boolean(input.after) !== Boolean(input.expectedCursorVersion))
    ctx.addIssue({
      code: 'custom',
      message: 'Supply both cursor ID and version.',
    });
}
export const emailDraftPageQuerySchema = z
  .strictObject({
    ...pageFields,
    deleted: z.enum(['false', 'true', 'all']).default('false'),
  })
  .superRefine(paired);
const cursor = z
  .object({ id: z.string().uuid(), version: positive })
  .nullable();
export const emailDraftPageSchema = z.object({
  drafts: z.array(emailDraftSummarySchema).max(100),
  nextAfter: cursor,
});
export const emailApprovalPageQuerySchema = z
  .strictObject(pageFields)
  .superRefine(paired);
export const emailApprovalPageSchema = z.object({
  approvals: z.array(emailApprovalSchema).max(100),
  nextAfter: cursor,
});
export const emailRevisionSchema = z.object({
  draftId: z.string().uuid(),
  version: positive,
  message: emailMessageSchema,
  contentHash: hash,
  createdAt: stamp,
});
export const emailRevisionResponseSchema = z.object({
  revision: emailRevisionSchema,
});
export const emailRevisionPageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  afterVersion: z.coerce.number().int().positive().optional(),
});
export const emailRevisionPageSchema = z.object({
  revisions: z.array(emailRevisionSchema.omit({ message: true })).max(100),
  nextAfterVersion: positive.nullable(),
});
export const emailSendPreviewRequestSchema = z.strictObject({
  expectedVersion: positive,
  approval: z
    .strictObject({ id: z.string().uuid(), expectedVersion: positive })
    .optional(),
});
export const emailAttemptSchema = z
  .object({
    id: z.string().uuid(),
    draftId: z.string().uuid(),
    draftVersion: positive,
    contentHash: hash,
    approvalId: z.string().uuid(),
    approvalVersion: positive,
    adapter: z.literal('synthetic'),
    status: z.enum(['uncertain', 'sent', 'not-sent']),
    version: positive,
    createdAt: stamp,
    updatedAt: stamp,
    finishedAt: stamp.nullable(),
  })
  .superRefine((value, ctx) => {
    if ((value.status === 'uncertain') !== (value.finishedAt === null))
      ctx.addIssue({ code: 'custom', message: 'Invalid attempt outcome.' });
  });
export const emailAttemptResponseSchema = z.object({
  attempt: emailAttemptSchema,
});
export const emailAttemptPageQuerySchema = emailApprovalPageQuerySchema;
export const emailAttemptPageSchema = z.object({
  attempts: z.array(emailAttemptSchema).max(100),
  nextAfter: cursor,
});
export const emailSendPreviewSchema = z.object({
  draftId: z.string().uuid(),
  draftVersion: positive,
  contentHash: hash,
  approval: emailApprovalSchema.nullable(),
  attempt: emailAttemptSchema.nullable().default(null),
  approvalState: z.enum(['missing', 'current', 'revoked', 'stale', 'consumed']),
  executionEnabled: z.literal(false),
  status: z.literal('blocked'),
  blockers: z
    .array(
      z.enum([
        'EMAIL_APPROVAL_REQUIRED',
        'APPROVAL_REVOKED',
        'APPROVAL_STALE',
        'DRAFT_DELETED',
        'SENDER_UNVERIFIED',
        'SEND_CAPABILITY_UNVERIFIED',
        'EMAIL_EXECUTION_UNAVAILABLE',
        'EMAIL_ATTEMPT_EXISTS',
        'EMAIL_DELIVERY_UNCERTAIN',
      ]),
    )
    .min(1)
    .max(9),
});
export type EmailMessage = z.infer<typeof emailMessageSchema>;
export type EmailDraft = z.infer<typeof emailDraftSchema>;
export type EmailApproval = z.infer<typeof emailApprovalSchema>;
export type EmailAttempt = z.infer<typeof emailAttemptSchema>;
