import {
  aiProviderConsentWriteSchema,
  aiProviderConsentSchema,
  aiProviderReadinessResponseSchema,
  providerAliasSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import type { Config } from '../config.js';
import { publicAIRegistry } from '../ai/profiles.js';
import {
  consentColumns,
  readAIProviderReadiness,
} from '../ai/provider-policy.js';
import { readAIBudget } from './ai-budget.js';
import { mutate } from '../planner/mutations.js';
import { ApiError } from '../errors.js';

export function registerAIProviderPolicy(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
  config: Config,
) {
  const registry = publicAIRegistry(config.AI_PROVIDER_PROFILES);
  app.get('/api/v1/ai/provider-readiness', async (request) => {
    const user = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      const budget = await readAIBudget(tx, user.id);
      const now = Date.now();
      const profiles = [];
      for (const profile of registry.profiles)
        profiles.push(
          await readAIProviderReadiness(tx, user.id, profile, budget, now),
        );
      return aiProviderReadinessResponseSchema.parse({
        registryRevision: registry.revision,
        dispatchEnabled: false,
        profiles,
      });
    });
  });
  app.put('/api/v1/ai/provider-consents/:alias', async (request) => {
    const user = await auth.requireUser(request);
    const alias = providerAliasSchema.parse(
      (request.params as { alias: string }).alias,
    );
    const input = aiProviderConsentWriteSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'ai.provider-consent', alias, input },
      async (tx) => {
        if (!(await auth.currentUser(request, tx)))
          throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
        if (input.expectedRegistryRevision !== registry.revision)
          throw new ApiError(
            409,
            'REGISTRY_CONFLICT',
            'Reload provider profiles and disclosures.',
          );
        const profile = registry.profiles.find((row) => row.alias === alias);
        if (!profile)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Provider profile not available.',
          );
        if (input.approved && !profile.retentionDisclosure)
          throw new ApiError(
            409,
            'RETENTION_UNSET',
            'A retention disclosure is required before approval.',
          );
        await tx.query(
          'INSERT INTO ai_provider_consents(owner_id,alias) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [user.id, alias],
        );
        const [row] = await tx.query(
          `UPDATE ai_provider_consents SET approved=$3,profile_revision=$4,profile_snapshot=$6::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND alias=$2 AND version=$5 RETURNING ${consentColumns}`,
          [
            user.id,
            alias,
            input.approved,
            input.approved ? profile.policyRevision : null,
            input.expectedVersion,
            input.approved ? JSON.stringify(profile) : null,
          ],
        );
        if (!row)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload provider consent.',
          );
        return aiProviderConsentSchema.parse(row);
      },
    );
  });
}
