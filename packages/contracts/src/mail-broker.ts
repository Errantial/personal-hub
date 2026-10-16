import { z } from 'zod';

const uuid = z.string().uuid();
const uniqueIds = z
  .array(uuid)
  .min(1)
  .max(24)
  .refine((v) => new Set(v).size === v.length);
export const mailBrokerScopeSchema = z
  .strictObject({
    connectorIds: uniqueIds,
    receivedAfter: z.string().datetime().nullable(),
    receivedBefore: z.string().datetime().nullable(),
  })
  .refine(
    (v) =>
      !v.receivedAfter ||
      !v.receivedBefore ||
      v.receivedAfter < v.receivedBefore,
  );
export const mailBrokerGrantWriteSchema = z.strictObject({
  operationId: uuid,
  expectedVersion: z.number().int().nonnegative(),
  enabled: z.boolean(),
  scope: mailBrokerScopeSchema,
});
export const mailBrokerGrantSchema = z.object({
  id: uuid,
  agentId: uuid.nullable(),
  version: z.number().int().positive(),
  enabled: z.boolean(),
  scope: mailBrokerScopeSchema,
});
export type MailBrokerGrant = z.infer<typeof mailBrokerGrantSchema>;
export const mailBrokerRequestSchema = z.strictObject({
  operationId: uuid,
  grantId: uuid,
  expectedGrantVersion: z.number().int().positive(),
  intent: z.string().trim().min(1).max(4000),
  maxCandidates: z.number().int().min(1).max(500).default(500),
  maxResults: z.number().int().min(1).max(50).default(50),
  continuation: uuid.optional(),
});
export type MailBrokerRequest = z.infer<typeof mailBrokerRequestSchema>;
export const mailBrokerCoverageSchema = z.object({
  scope: z.literal('imported-mail'),
  externalCompleteness: z.literal('unverified'),
  snapshotAt: z.string().datetime(),
  connectors: z
    .array(
      z.object({
        id: uuid,
        lastSeenAt: z.string().datetime().nullable(),
        importedSince: z.string().date(),
      }),
    )
    .max(24),
  inspected: z.number().int().nonnegative(),
  judged: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  selected: z.number().int().min(0).max(50),
  clipped: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  stopReason: z.enum([
    'page',
    'exhausted',
    'candidate-limit',
    'lineage-limit',
    'result-limit',
    'byte-limit',
    'blocked',
    'uncertain',
  ]),
});
export const mailBrokerReceiptSchema = z.object({
  id: uuid,
  status: z.enum(['pending', 'partial', 'completed', 'blocked', 'uncertain']),
  coverage: mailBrokerCoverageSchema,
});
export const mailBrokerResultSchema = z.object({
  receipt: mailBrokerReceiptSchema,
  messages: z
    .array(
      z.object({
        id: uuid,
        subject: z.string(),
        from: z.string().nullable(),
        receivedAt: z.string().datetime(),
        body: z.string().max(6000),
        truncated: z.boolean(),
      }),
    )
    .max(50),
});
export const mailBrokerReadinessSchema = z.object({
  status: z.enum(['ready', 'blocked']),
  blockers: z.array(z.string()),
  profileRevision: z.string().nullable(),
  approvalVersion: z.number().int().positive(),
  downstream: z.enum(['ready', 'blocked']),
  dispatchConnectedToAgents: z.boolean(),
});
export const mailBrokerGrantsResponseSchema = z.object({
  grants: z.array(mailBrokerGrantSchema),
});
export const mailBrokerGrantResponseSchema = z.object({
  grant: mailBrokerGrantSchema,
});
