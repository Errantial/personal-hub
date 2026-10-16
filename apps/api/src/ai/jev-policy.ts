import { z } from 'zod';

// Legacy environment compatibility only; no TypeSafe dispatch remains.
const verificationSchema = z.strictObject({
  revision: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
  profileRevision: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime(),
  accountTermsZeroRetention: z.literal(true),
  completeEnvelopeTokenBound: z.literal(true),
  authoritativeUsageBilling: z.literal(true),
  envelopeByteLimit: z.number().int().min(1024).max(20480),
  inputTokenUpperBound: z.number().int().min(1).max(32000),
});
// Operator evidence, not a caller-controlled approval or a claim inferred from
// vendor advertising. Missing evidence keeps even a configured key blocked.
export function readJevVerification(encoded: string | undefined) {
  if (!encoded) return null;
  try {
    return verificationSchema.parse(JSON.parse(encoded));
  } catch {
    throw new Error('Invalid environment configuration: TYPESAFE_VERIFICATION');
  }
}
