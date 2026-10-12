import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  providerAliasSchema,
  aiProviderRegistrySchema,
  aiPricePolicySchema,
  aiRetentionDisclosureSchema,
  aiProviderAdapterSchema,
} from '@hub/contracts';
const profileSchema = z
  .strictObject({
    alias: providerAliasSchema,
    adapter: aiProviderAdapterSchema,
    upstreamProvider: z
      .string()
      .regex(/^[a-z][a-z0-9/_-]{0,99}$/)
      .nullable()
      .default(null),
    model: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    credentialEnv: z.string().regex(/^AI_SECRET_[A-Z][A-Z0-9_]{0,63}$/),
    enabled: z.boolean().default(false),
    maxInputCharacters: z.number().int().min(1).max(48000),
    maxOutputTokens: z.number().int().min(1).max(32000),
    pricing: aiPricePolicySchema.nullable().default(null),
    retentionDisclosure: aiRetentionDisclosureSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if ((value.adapter === 'openrouter') !== (value.upstreamProvider !== null))
      ctx.addIssue({
        code: 'custom',
        message: 'Only OpenRouter requires a pinned upstream provider.',
      });
  });
const profilesSchema = z
  .array(profileSchema)
  .max(24)
  .refine((rows) => new Set(rows.map((row) => row.alias)).size === rows.length);
// Only server configuration can define profiles. No endpoint, credential or adapter comes from an API caller.
export function readAIProfiles(
  environment: Record<string, string | undefined>,
) {
  try {
    const encoded = environment.AI_PROVIDER_PROFILES ?? '[]';
    if (encoded.length > 24000) throw new Error();
    const profiles = profilesSchema.parse(JSON.parse(encoded));
    return profiles.map((profile) => {
      const credential = environment[profile.credentialEnv];
      if (credential && !/^[\x21-\x7e]{1,4096}$/.test(credential))
        throw new Error();
      return { ...profile, credential: credential || null };
    });
  } catch {
    // Zod/JSON errors may contain values. Startup errors expose only the setting name.
    throw new Error('Invalid environment configuration: AI_PROVIDER_PROFILES');
  }
}
export function publicAIRegistry(profiles: ReturnType<typeof readAIProfiles>) {
  const safe = profiles
    .map((profile) => ({
      alias: profile.alias,
      adapter: profile.adapter,
      accessMode:
        profile.adapter === 'claude-code' ||
        profile.adapter === 'codex-subscription'
          ? 'owner-subscription'
          : profile.adapter === 'prem-confidential'
            ? 'confidential-api'
            : 'api-key',
      upstreamProvider: profile.upstreamProvider,
      model: profile.model,
      configuration: !profile.enabled
        ? 'disabled'
        : profile.credential
          ? 'configured'
          : 'credential_missing',
      maxInputCharacters: profile.maxInputCharacters,
      maxOutputTokens: profile.maxOutputTokens,
      pricing: profile.pricing,
      retentionDisclosure: profile.retentionDisclosure,
    }))
    .map((profile) => ({
      ...profile,
      policyRevision: createHash('sha256')
        .update(JSON.stringify(profile))
        .digest('hex'),
    }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
  // Credentials and their names never enter responses or fingerprints.
  return aiProviderRegistrySchema.parse({
    revision: createHash('sha256').update(JSON.stringify(safe)).digest('hex'),
    dispatchEnabled: false,
    health: 'not_checked',
    profiles: safe,
  });
}
