import { z } from 'zod';
import {
  mailCategoryFieldsSchema,
  mailRuleCaptureSchema,
} from './mail-organization.js';

/**
 * Read-only mail ingestion from a local Proton Bridge connector
 * (docs/email-ingestion.md). Headers and plain-text bodies only; attachments
 * are counted, never uploaded.
 */
const sensitivity = z.enum(['unlabeled', 'personal', 'restricted']);
const address = z.object({
  name: z.string().max(300).nullable(),
  address: z.string().max(320),
});
export const emailBodyLimit = 32000;
export const emailConnectorErrorCodeSchema = z.enum([
  'bridge-auth',
  'bridge-unavailable',
  'hub-unavailable',
  'collection-failed',
]);
export const emailConnectorHealthStatusSchema = z.enum([
  'never-synced',
  'syncing',
  'current',
  'stale',
  'partial',
  'sign-in-required',
  'revoked',
  'error',
]);

// Owner: connectors.
export const emailConnectorCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  /** Owner label applied to every message from this connector. */
  sensitivity,
  operationId: z.string().uuid(),
});
export const emailFolderStateSchema = z.object({
  path: z.string(),
  role: z.string().nullable(),
  /** Messages Bridge reported in the folder at the last sync. */
  exists: z.number().int().nonnegative(),
  /** Of those, received within the import window. */
  inWindow: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  syncedAt: z.string().datetime(),
  completeAt: z.string().datetime().nullable(),
});
export const emailConnectorSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sensitivity,
  /** First day of the import window. */
  since: z.string(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
  lastContactAt: z.string().datetime().nullable(),
  lastImportAt: z.string().datetime().nullable(),
  lastCompleteAt: z.string().datetime().nullable(),
  lastAttemptOutcome: z.enum(['complete', 'partial', 'failed']).nullable(),
  lastErrorCode: emailConnectorErrorCodeSchema.nullable(),
  healthStatus: emailConnectorHealthStatusSchema,
  revokedAt: z.string().datetime().nullable(),
  folders: z.array(emailFolderStateSchema),
});
export type EmailConnector = z.infer<typeof emailConnectorSchema>;
export const emailConnectorsResponseSchema = z.object({
  connectors: z.array(emailConnectorSchema),
});
export const emailConnectorCreatedSchema = z.object({
  connector: emailConnectorSchema,
  /** Shown once; only its hash is stored. */
  token: z.string(),
});
export const emailConnectorRevokeSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  operationId: z.string().uuid(),
});

// Owner: messages.
export const mailSummarySchema = mailCategoryFieldsSchema.extend({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  connectorId: z.string().uuid(),
  categoryRuleCapture: mailRuleCaptureSchema.nullable().default(null),
  from: address.nullable(),
  subject: z.string(),
  receivedAt: z.string().datetime(),
  folders: z.array(z.string()),
  snippet: z.string(),
  attachmentCount: z.number().int().nonnegative(),
  sensitivity,
});
export type MailSummary = z.infer<typeof mailSummarySchema>;
export const mailPageSchema = z.object({
  messages: z.array(mailSummarySchema),
  nextBefore: z.string().uuid().nullable(),
});
export const mailMessageSchema = mailSummarySchema
  .omit({ snippet: true })
  .extend({
    to: z.array(address),
    cc: z.array(address),
    sentAt: z.string().datetime().nullable(),
    body: z.string(),
    bodyTruncated: z.boolean(),
  });
export type MailMessage = z.infer<typeof mailMessageSchema>;
export const mailMessageResponseSchema = z.object({
  message: mailMessageSchema,
});

// Connector (bearer token).
export const emailConnectorStateSchema = z.object({
  since: z.string(),
  folders: z.array(
    z.object({
      path: z.string(),
      uidValidity: z.string(),
      lastUid: z.number().int().nonnegative(),
    }),
  ),
});
export const emailConnectorAttemptSchema = z.strictObject({
  attemptId: z.string().uuid(),
});
export const emailConnectorAttemptResultSchema = z.object({
  attemptId: z.string().uuid(),
});
export const emailConnectorAttemptFinishSchema = z.strictObject({
  attemptId: z.string().uuid(),
  outcome: z.enum(['complete', 'partial', 'failed']),
  errorCode: emailConnectorErrorCodeSchema.nullable().default(null),
});
export const emailUploadMessageSchema = z.strictObject({
  uid: z.number().int().positive(),
  /** Declared by the authenticated collector; legacy imports remain unknown. */
  textOrigin: z.literal('message-body-v1').optional(),
  /** Lower-case Message-ID, or a content hash when it is missing. */
  messageKey: z.string().min(3).max(1000),
  from: address.nullable(),
  to: z.array(address).max(500),
  cc: z.array(address).max(500),
  subject: z.string().max(2000),
  sentAt: z.string().datetime().nullable(),
  receivedAt: z.string().datetime(),
  body: z.string().max(emailBodyLimit),
  bodyTruncated: z.boolean(),
  attachmentCount: z.number().int().min(0).max(1000),
});
export type EmailUploadMessage = z.infer<typeof emailUploadMessageSchema>;
export const emailUploadBatchSchema = z
  .strictObject({
    path: z.string().min(1).max(1000),
    role: z.string().max(50).nullable(),
    uidValidity: z.string().regex(/^\d{1,20}$/),
    exists: z.number().int().nonnegative(),
    inWindow: z.number().int().nonnegative(),
    /** Highest UID covered after this batch; the next sync starts above it. */
    lastUid: z.number().int().nonnegative(),
    /** True only after a complete read of this folder's configured window. */
    complete: z.boolean().default(false),
    /** Complete in-window UID snapshot; required only for a complete observation. */
    windowUids: z.array(z.number().int().positive()).max(20000).optional(),
    messages: z.array(emailUploadMessageSchema).max(25),
  })
  .superRefine((value, ctx) => {
    if (value.complete && !value.windowUids)
      ctx.addIssue({
        code: 'custom',
        path: ['windowUids'],
        message: 'A complete folder observation requires window UIDs.',
      });
    if (!value.complete && value.windowUids)
      ctx.addIssue({
        code: 'custom',
        path: ['windowUids'],
        message: 'Window UIDs are only accepted for complete observations.',
      });
  });
export const emailUploadResultSchema = z.object({
  stored: z.number().int().nonnegative(),
  lastUid: z.number().int().nonnegative(),
});
