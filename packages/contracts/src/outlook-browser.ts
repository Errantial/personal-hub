import { z } from 'zod';
import { sensitivitySchema } from './core.js';

/** Microsoft Outlook Web origins accepted for canonical source links. */
export const outlookBrowserOrigins = [
  'https://outlook.office.com',
  'https://outlook.office365.com',
  'https://outlook.cloud.microsoft',
  'https://outlook.live.com',
] as const;

export const outlookBrowserHealthStatusSchema = z.enum([
  'never-synced',
  'syncing',
  'current',
  'stale',
  'partial',
  'sign-in-required',
  'mfa-required',
  'revoked',
  'error',
]);

export const outlookBrowserErrorCodeSchema = z.enum([
  'sign-in-required',
  'mfa-required',
  'browser-unavailable',
  'outlook-unavailable',
  'foreign-origin',
  'traversal-failed',
  'traversal-limit',
]);

export const outlookBrowserObservationStatusSchema = z.enum([
  'complete',
  'partial',
  'inaccessible',
]);
export const outlookBrowserAttemptOutcomeSchema = z.enum([
  'complete',
  'partial',
  'failed',
]);

const folderProviderId = /^[A-Za-z0-9_-]{1,200}$/;
const messageProviderId = /^[A-Za-z0-9_-]{8,2000}$/;
const reservedFolderSegments = new Set([
  'id',
  'deeplink',
  'options',
  'settings',
]);

type OutlookIdentity = {
  origin: (typeof outlookBrowserOrigins)[number];
  folderProviderId: string | null;
  messageProviderId: string | null;
};

const outlookUrlPattern =
  /^(https:\/\/(?:outlook\.office\.com|outlook\.office365\.com|outlook\.cloud\.microsoft|outlook\.live\.com))(\/mail\/[A-Za-z0-9_/-]*)$/;

function parseOutlookUrl(value: string): {
  origin: (typeof outlookBrowserOrigins)[number];
  pathname: string;
} | null {
  const match = outlookUrlPattern.exec(value);
  if (!match) return null;
  return {
    origin: match[1] as (typeof outlookBrowserOrigins)[number],
    pathname: match[2]!,
  };
}

/** Canonical `/mail/<folder>` identity, or null when the URL is unsafe. */
export function outlookFolderIdentity(value: string) {
  const url = parseOutlookUrl(value);
  if (!url) return null;
  const match = /^\/mail\/([A-Za-z0-9_-]{1,200})$/.exec(url.pathname);
  if (!match || reservedFolderSegments.has(match[1]!)) return null;
  return {
    origin: url.origin as OutlookIdentity['origin'],
    folderProviderId: match[1]!,
  };
}

/**
 * Canonical message identity from `/mail/<folder>/id/<id>` or `/mail/id/<id>`.
 * A folder segment is optional because Outlook Web may open a message outside
 * its folder route; the collector still scopes every record to its folder.
 */
export function outlookMessageIdentity(value: string) {
  const url = parseOutlookUrl(value);
  if (!url) return null;
  const match =
    /^\/mail\/(?:([A-Za-z0-9_-]{1,200})\/)?id\/([A-Za-z0-9_-]{8,2000})$/.exec(
      url.pathname,
    );
  if (!match) return null;
  const folder = match[1] ?? null;
  if (folder && reservedFolderSegments.has(folder)) return null;
  return {
    origin: url.origin as OutlookIdentity['origin'],
    folderProviderId: folder,
    messageProviderId: match[2]!,
  };
}

const folderDataShape = {
  providerId: z.string().regex(folderProviderId),
  name: z.string().min(1).max(200),
  canonicalUrl: z.string().url().max(2000),
};

export const outlookBrowserFolderDataSchema = z
  .object(folderDataShape)
  .superRefine((value, ctx) => {
    const identity = outlookFolderIdentity(value.canonicalUrl);
    if (!identity || identity.folderProviderId !== value.providerId)
      ctx.addIssue({
        code: 'custom',
        path: ['canonicalUrl'],
        message: 'Outlook folder identity does not match its canonical URL.',
      });
  });

const messageDataShape = {
  providerId: z.string().regex(messageProviderId),
  conversationId: z.string().regex(messageProviderId).nullable().default(null),
  canonicalUrl: z.string().url().max(2000),
  subject: z.string().min(1).max(500),
  senderDisplay: z.string().min(1).max(200),
  senderAddress: z.string().trim().email().max(320).nullable(),
  receivedAt: z.string().datetime().nullable(),
  snippet: z.string().max(2000),
  bodyText: z.string().max(20000),
};

export const outlookBrowserMessageDataSchema = z
  .object(messageDataShape)
  .superRefine((value, ctx) => {
    const identity = outlookMessageIdentity(value.canonicalUrl);
    if (!identity || identity.messageProviderId !== value.providerId)
      ctx.addIssue({
        code: 'custom',
        path: ['canonicalUrl'],
        message: 'Outlook message identity does not match its canonical URL.',
      });
  });

/** Append-only capture snapshot: bounded metadata plus the plain-text snippet. */
export const outlookBrowserMessageCaptureDataSchema = z.object({
  providerId: messageDataShape.providerId,
  conversationId: messageDataShape.conversationId,
  canonicalUrl: messageDataShape.canonicalUrl,
  subject: messageDataShape.subject,
  senderDisplay: messageDataShape.senderDisplay,
  senderAddress: messageDataShape.senderAddress,
  receivedAt: messageDataShape.receivedAt,
  snippet: messageDataShape.snippet,
});

export const outlookBrowserFolderSchema = z.object({
  id: z.string().uuid(),
  ...folderDataShape,
  availability: z.enum(['available', 'missing']),
  selected: z.boolean(),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
  effectiveSensitivity: sensitivitySchema,
  lastContactAt: z.string().datetime().nullable(),
  lastImportAt: z.string().datetime().nullable(),
  lastCompleteAt: z.string().datetime().nullable(),
  lastObservationStatus: outlookBrowserObservationStatusSchema.nullable(),
  lastObservedCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const outlookBrowserMessageSummarySchema = z.object({
  id: z.string().uuid(),
  browserFolderId: z.string().uuid(),
  providerId: messageDataShape.providerId,
  conversationId: messageDataShape.conversationId,
  canonicalUrl: messageDataShape.canonicalUrl,
  subject: messageDataShape.subject,
  senderDisplay: messageDataShape.senderDisplay,
  senderAddress: messageDataShape.senderAddress,
  receivedAt: messageDataShape.receivedAt,
  snippet: messageDataShape.snippet,
  capturedAt: z.string().datetime(),
  availability: z.enum(['available', 'missing']),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
  effectiveSensitivity: sensitivitySchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const outlookBrowserMessageSchema =
  outlookBrowserMessageSummarySchema.extend({
    bodyText: messageDataShape.bodyText,
  });

export const outlookBrowserMessageCaptureSchema = z.object({
  id: z.string().uuid(),
  attemptId: z.string().uuid(),
  browserMessageId: z.string().uuid(),
  snapshot: outlookBrowserMessageCaptureDataSchema,
  effectiveSensitivity: sensitivitySchema,
  capturedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export const outlookBrowserAttemptSchema = z.object({
  id: z.string().uuid(),
  sourceVersion: z.number().int().positive(),
  outcome: outlookBrowserAttemptOutcomeSchema.nullable(),
  errorCode: outlookBrowserErrorCodeSchema.nullable(),
  discoveryStatus: z.enum(['complete', 'partial']).nullable(),
  selectedCount: z.number().int().nonnegative(),
  completeCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});

export const outlookBrowserConnectionSchema = z.object({
  configured: z.boolean(),
  version: z.number().int().positive(),
  sensitivity: sensitivitySchema,
  healthStatus: outlookBrowserHealthStatusSchema,
  lastAttemptAt: z.string().datetime().nullable(),
  lastContactAt: z.string().datetime().nullable(),
  lastImportAt: z.string().datetime().nullable(),
  lastCompleteAt: z.string().datetime().nullable(),
  lastAttemptOutcome: outlookBrowserAttemptOutcomeSchema.nullable(),
  lastErrorCode: outlookBrowserErrorCodeSchema.nullable(),
  folders: z.array(outlookBrowserFolderSchema),
  messages: z.array(outlookBrowserMessageSummarySchema),
  messagesTruncated: z.boolean(),
  attempts: z.array(outlookBrowserAttemptSchema),
});

export const outlookBrowserMessageDetailResponseSchema = z.object({
  message: outlookBrowserMessageSchema,
  captures: z.array(outlookBrowserMessageCaptureSchema).max(50),
});

export const outlookBrowserTokenRequestSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});

export const outlookBrowserTokenResponseSchema = z.object({
  token: z.string().regex(/^hubob_[A-Za-z0-9_-]{20,200}$/),
  connection: outlookBrowserConnectionSchema,
});

export const outlookBrowserRevokeSchema = outlookBrowserTokenRequestSchema;

export const outlookBrowserSettingsSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  sensitivity: sensitivitySchema,
});

export const outlookBrowserFolderWriteSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  selected: z.boolean(),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
});

export const outlookBrowserMessageWriteSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  notes: z.string().max(10000),
  sensitivity: sensitivitySchema,
});

export const outlookBrowserFolderWriteResponseSchema = z.object({
  folder: outlookBrowserFolderSchema,
  sourceVersion: z.number().int().positive(),
});

export const outlookBrowserMessageWriteResponseSchema = z.object({
  message: outlookBrowserMessageSummarySchema,
});

export const outlookBrowserCollectorStateSchema = z.object({
  sourceVersion: z.number().int().positive(),
  folders: z.array(
    z.object({
      id: z.string().uuid(),
      providerId: z.string().regex(folderProviderId),
      canonicalUrl: z.string().url().max(2000),
      version: z.number().int().positive(),
    }),
  ),
});

export const outlookBrowserAttemptStartSchema = z.strictObject({
  attemptId: z.string().uuid(),
  expectedSourceVersion: z.number().int().positive(),
});

export const outlookBrowserAttemptStartResponseSchema = z.object({
  attemptId: z.string().uuid(),
});

export const outlookBrowserDiscoverySchema = z.strictObject({
  attemptId: z.string().uuid(),
  status: z.enum(['complete', 'partial']),
  capturedAt: z.string().datetime(),
  folders: z.array(outlookBrowserFolderDataSchema).max(200),
});

export const outlookBrowserFolderObservationSchema = z
  .strictObject({
    attemptId: z.string().uuid(),
    folderId: z.string().uuid(),
    status: outlookBrowserObservationStatusSchema,
    capturedAt: z.string().datetime(),
    messages: z.array(outlookBrowserMessageDataSchema).max(200),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'inaccessible' && value.messages.length)
      ctx.addIssue({
        code: 'custom',
        path: ['messages'],
        message: 'An inaccessible folder cannot include observed messages.',
      });
    if (value.status === 'complete' && value.messages.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['messages'],
        message:
          'A complete observation requires an observed message window; empty folders report partial.',
      });
    const seen = new Set<string>();
    for (const message of value.messages) {
      if (seen.has(message.providerId))
        ctx.addIssue({
          code: 'custom',
          path: ['messages'],
          message: 'A folder observation cannot repeat a message identity.',
        });
      seen.add(message.providerId);
    }
  });

export const outlookBrowserObservationResultSchema = z.object({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
});

export const outlookBrowserAttemptFinishSchema = z.strictObject({
  attemptId: z.string().uuid(),
  outcome: outlookBrowserAttemptOutcomeSchema,
  errorCode: outlookBrowserErrorCodeSchema.nullable().default(null),
});

export type OutlookBrowserConnection = z.infer<
  typeof outlookBrowserConnectionSchema
>;
export type OutlookBrowserFolder = z.infer<typeof outlookBrowserFolderSchema>;
export type OutlookBrowserMessageSummary = z.infer<
  typeof outlookBrowserMessageSummarySchema
>;
export type OutlookBrowserMessage = z.infer<typeof outlookBrowserMessageSchema>;
export type OutlookBrowserMessageCapture = z.infer<
  typeof outlookBrowserMessageCaptureSchema
>;
export type OutlookBrowserMessageDetailResponse = z.infer<
  typeof outlookBrowserMessageDetailResponseSchema
>;
