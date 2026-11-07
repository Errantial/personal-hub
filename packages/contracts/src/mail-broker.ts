import { z } from 'zod';
import { emailConnectorHealthStatusSchema } from './email-ingestion.js';

const uuid = z.string().uuid();
export const mailBrokerAliasSchema = z.enum(['mail-broker', 'jev-mail']);
export const mailBrokerSettingsSchema = z.strictObject({
  version: z.number().int().positive(),
  selectedAlias: mailBrokerAliasSchema,
});
export const mailBrokerSettingsWriteSchema = z.strictObject({
  operationId: uuid,
  expectedVersion: z.number().int().positive(),
  selectedAlias: mailBrokerAliasSchema,
});
export const mailBrokerSettingsResponseSchema = z.strictObject({
  settings: mailBrokerSettingsSchema,
});
export type MailBrokerAlias = z.infer<typeof mailBrokerAliasSchema>;
export type MailBrokerSettings = z.infer<typeof mailBrokerSettingsSchema>;
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
        healthStatus: emailConnectorHealthStatusSchema,
        lastContactAt: z.string().datetime().nullable(),
        lastCompleteAt: z.string().datetime().nullable(),
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
export const mailBrokerDestinationSchema = z.discriminatedUnion('alias', [
  z.object({
    alias: z.literal('mail-broker'),
    adapter: z.literal('openrouter').default('openrouter'),
    model: z.string(),
    // Kept for compatibility with the deployed OpenRouter readiness response.
    router: z.literal('openrouter').default('openrouter'),
    upstream: z.string().min(1),
  }),
  z.object({
    alias: z.literal('jev-mail'),
    adapter: z.literal('typesafe'),
    model: z.string(),
    upstream: z.null(),
  }),
]);
export const mailBrokerReadinessSchema = z
  .object({
    selectorVersion: z.number().int().positive().default(1),
    selectedAlias: mailBrokerAliasSchema.default('mail-broker'),
    destination: mailBrokerDestinationSchema.nullable().default(null),
    endpointStatus: z.literal('unchecked').default('unchecked'),
    status: z.enum(['ready', 'blocked']),
    blockers: z.array(z.string()),
    profileRevision: z.string().nullable(),
    approvalVersion: z.number().int().positive(),
    downstream: z.enum(['ready', 'blocked']),
    dispatchConnectedToAgents: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.destination && value.destination.alias !== value.selectedAlias)
      ctx.addIssue({
        code: 'custom',
        path: ['destination', 'alias'],
        message: 'Broker destination must match the selected classifier.',
      });
  });
export const mailBrokerGrantsResponseSchema = z.object({
  grants: z.array(mailBrokerGrantSchema),
});
export const mailBrokerGrantResponseSchema = z.object({
  grant: mailBrokerGrantSchema,
});
