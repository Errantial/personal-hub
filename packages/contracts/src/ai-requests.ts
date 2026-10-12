import { z } from 'zod';
import { aiPreflightSchema, aiPreflightWriteSchema } from './ai-preflight.js';
import { aiRoutingDecisionSchema } from './ai-routing.js';
import { aiProviderReadinessSchema } from './ai-provider-policy.js';
import { aiContextManifestSchema } from './ai-context-manifest.js';
import { aiTextResultMetadataSchema } from './ai-text-results.js';
export const aiRequestWriteSchema = aiPreflightWriteSchema.extend({
  saveAnswer: z.boolean().optional(),
});
export const aiProtocolMetadataSchema = z.strictObject({
  synthetic: z.literal(true),
  protocol: z.literal('openrouter'),
  generationId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  outputState: z.enum(['validated', 'invalid', 'provider-error', 'blocked']),
});
const protocolObservationBase = {
  synthetic: z.literal(true),
  protocol: z.literal('openrouter'),
};
export const aiProtocolObservationSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...protocolObservationBase,
    state: z.literal('uncertain'),
    generationId: aiProtocolMetadataSchema.shape.generationId.nullable(),
    reason: z.enum([
      'transport',
      'timeout',
      'aborted',
      'response',
      'destination',
      'billing',
    ]),
  }),
  z.strictObject({
    ...protocolObservationBase,
    state: z.literal('reported'),
    generationId: aiProtocolMetadataSchema.shape.generationId,
    usage: z.strictObject({
      inputTokens: z.number().int().min(0).max(2000000),
      outputTokens: z.number().int().min(0).max(2000000),
      actualMicros: z.number().int().min(0).max(1000000000000),
    }),
    outputState: aiProtocolMetadataSchema.shape.outputState,
  }),
]);
export const aiAttemptSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  requestId: z.string().uuid(),
  reservationId: z.string().uuid(),
  status: z.enum(['uncertain', 'completed', 'failed']),
  adapter: z.literal('synthetic'),
  admission: z.object({
    policyVersion: z.number().int().positive(),
    budgetVersion: z.number().int().positive(),
    registryRevision: z.string().regex(/^[a-f0-9]{64}$/),
    route: aiRoutingDecisionSchema,
    model: z.string(),
    sources: aiPreflightSchema.shape.sources,
    readiness: aiProviderReadinessSchema,
    contextManifest: aiContextManifestSchema.nullable().default(null),
  }),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  actualMicros: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  resultMetadata: aiTextResultMetadataSchema.nullable().default(null),
  protocolMetadata: aiProtocolMetadataSchema.nullable().default(null),
  protocolObservation: aiProtocolObservationSchema.nullable().default(null),
});
export const aiRequestSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  status: z.enum(['blocked', 'cancelled', 'uncertain', 'completed', 'failed']),
  dispatchEnabled: z.literal(false),
  requiresTextResupply: z.boolean(),
  textRetained: z.literal(false),
  saveAnswer: z.boolean().default(false),
  assessment: aiPreflightSchema,
  attempt: aiAttemptSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export const aiRequestQuerySchema = z.strictObject({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const aiRequestsResponseSchema = z.object({
  requests: z.array(aiRequestSchema).max(50),
  nextBefore: z.string().uuid().nullable(),
});
export type AIRequest = z.infer<typeof aiRequestSchema>;
export type AIAttempt = z.infer<typeof aiAttemptSchema>;
