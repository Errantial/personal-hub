import {
  aiBudgetLiveSettingsSchema,
  aiBudgetWriteSchema,
  emptyAIBudgetPolicy,
  AI_MONTHLY_HARD_LIMIT_MICROS,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutate } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import { readBudgetUsage } from '../ai/budget.js';
export async function readAIBudget(tx: QueryExecutor, owner: string) {
  const [row] = await tx.query(
    'SELECT version,monthly_limit_micros,per_request_limit_micros FROM ai_budget_policies WHERE owner_id=$1',
    [owner],
  );
  return aiBudgetLiveSettingsSchema.parse({
    version: row?.version ?? 1,
    policy: row
      ? {
          monthlyLimitMicros:
            row.monthly_limit_micros === null
              ? null
              : Number(row.monthly_limit_micros),
          perRequestLimitMicros:
            row.per_request_limit_micros === null
              ? null
              : Number(row.per_request_limit_micros),
        }
      : emptyAIBudgetPolicy,
    currency: 'USD',
    monthBoundary: 'UTC',
    dispatchEnabled: false,
    usage: await readBudgetUsage(tx, owner),
  });
}
export function registerAIBudget(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/ai/budget';
  app.get(base, async (request) => {
    const user = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return readAIBudget(tx, user.id);
    });
  });
  app.put(base, async (request) => {
    const user = await auth.requireUser(request);
    const input = aiBudgetWriteSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'ai.budget', input },
      async (tx) => {
        // Check after the historical receipt gate: a retry of an older setting
        // returns its old receipt without re-enabling an above-ceiling policy.
        if (
          input.policy.monthlyLimitMicros !== null &&
          input.policy.monthlyLimitMicros > AI_MONTHLY_HARD_LIMIT_MICROS
        )
          throw new ApiError(
            400,
            'BUDGET_HARD_LIMIT',
            'Monthly spending cannot exceed $50.',
          );
        await tx.query(
          'INSERT INTO ai_budget_policies(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
          [user.id],
        );
        const [row] = await tx.query(
          'UPDATE ai_budget_policies SET monthly_limit_micros=$3,per_request_limit_micros=$4,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND version=$2 RETURNING version',
          [
            user.id,
            input.expectedVersion,
            input.policy.monthlyLimitMicros,
            input.policy.perRequestLimitMicros,
          ],
        );
        if (!row)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload spending limits.',
          );
        return readAIBudget(tx, user.id);
      },
    );
  });
}
