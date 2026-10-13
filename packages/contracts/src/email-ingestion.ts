import { z } from 'zod';

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
export const mailSummarySchema = z.object({
  id: z.string().uuid(),
  connectorId: z.string().uuid(),
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
export const emailUploadMessageSchema = z.strictObject({
  uid: z.number().int().positive(),
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
export const emailUploadBatchSchema = z.strictObject({
  path: z.string().min(1).max(1000),
  role: z.string().max(50).nullable(),
  uidValidity: z.string().regex(/^\d{1,20}$/),
  exists: z.number().int().nonnegative(),
  inWindow: z.number().int().nonnegative(),
  /** Highest UID covered after this batch; the next sync starts above it. */
  lastUid: z.number().int().nonnegative(),
  messages: z.array(emailUploadMessageSchema).max(25),
});
export const emailUploadResultSchema = z.object({
  stored: z.number().int().nonnegative(),
  lastUid: z.number().int().nonnegative(),
});
