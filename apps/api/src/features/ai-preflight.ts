import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  aiPreflightWriteSchema,
  aiPreflightSchema,
  aiPreflightsQuerySchema,
  aiPreflightsResponseSchema,
  deleteItemSchema,
  evaluateAIRouting,
} from '@hub/contracts';
import type { Database, QueryExecutor } from '../db/database.js';
import type { FastifyInstance } from 'fastify';
import type { authService } from '../auth/routes.js';
import type { Config } from '../config.js';
import { publicAIRegistry } from '../ai/profiles.js';
import { assembleAITextContext } from '../ai/context.js';
import { readAIRoutingPolicy, resolveAIContext } from './ai-routing.js';
import { readAIBudget } from './ai-budget.js';
import { mutate } from '../planner/mutations.js';
import { stamp, version } from './common.js';
import { ApiError } from '../errors.js';
const columns = `id,version,metadata,${stamp('created_at', 'createdAt')},${stamp('deleted_at', 'deletedAt')}`;
const record = (row: Record<string, unknown>) =>
  aiPreflightSchema.parse({
    ...(row.metadata as object),
    id: row.id,
    version: row.version,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  });
export async function readAIPreflights(
  tx: QueryExecutor,
  owner: string,
  limit = 10001,
) {
  return (
    await tx.query(
      `SELECT ${columns} FROM ai_preflights WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,
      [owner, limit],
    )
  ).map(record);
}
export function registerAIPreflight(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
  config: Config,
) {
  const registry = publicAIRegistry(config.AI_PROVIDER_PROFILES);
  const base = '/api/v1/ai/preflights';
  app.get('/api/v1/ai/providers', async (request) => {
    await auth.requireUser(request);
    return registry;
  });
  app.post(base, async (request, reply) => {
    const user = await auth.requireUser(request);
    const input = aiPreflightWriteSchema.parse(request.body);
    const output = await mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'ai.preflight', input },
      async (tx) => {
        // Receipts need writes, but context/policy reads must all use one consistent snapshot.
        // mutate's receipt insert is already the first statement; repeatable isolation is set by its option.
        if (!(await auth.currentUser(request, tx)))
          throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
        if (input.expectedRegistryRevision !== registry.revision)
          throw new ApiError(
            409,
            'REGISTRY_CONFLICT',
            'Reload provider profiles.',
          );
        const settings = await readAIRoutingPolicy(tx, user.id);
        version(settings, input.expectedPolicyVersion);
        const budget = await readAIBudget(tx, user.id);
        version(budget, input.expectedBudgetVersion);
        const sources = [];
        for (const ref of input.sources)
          sources.push(await resolveAIContext(tx, user.id, ref));
        const route = evaluateAIRouting(
          settings.policy,
          [input.sensitivity, ...sources.flatMap((source) => source.labels)],
          sources.some((source) => source.attachmentDerived),
          registry.profiles
            .filter((profile) => profile.configuration === 'configured')
            .map((profile) => profile.alias),
        );
        const profile = registry.profiles.find(
          (candidate) => candidate.alias === route.provider,
        );
        // No content assembly for denied/forbidden/unavailable routes. No provider transport exists here.
        const assembled =
          route.status === 'selected' && profile
            ? await assembleAITextContext(
                tx,
                user.id,
                input.text,
                sources,
                profile.maxInputCharacters,
              )
            : null;
        const metadata = {
          status: 'blocked',
          reason:
            route.status === 'blocked'
              ? route.reason
              : assembled
                ? budget.policy.monthlyLimitMicros === null
                  ? 'BUDGET_UNSET'
                  : budget.policy.monthlyLimitMicros === 0 ||
                      budget.policy.perRequestLimitMicros === 0
                    ? 'BUDGET_ZERO_LIMIT'
                    : BigInt(budget.usage.spentMicros) +
                          BigInt(budget.usage.heldMicros) >=
                        BigInt(budget.policy.monthlyLimitMicros)
                      ? 'MONTHLY_BUDGET_EXCEEDED'
                      : 'DISPATCH_DISABLED'
                : 'INPUT_LIMIT',
          dispatchEnabled: false,
          policyVersion: settings.version,
          budgetVersion: budget.version,
          budget: budget.policy,
          budgetUsage: budget.usage,
          registryRevision: registry.revision,
          route,
          model: profile?.model ?? null,
          requestCharacters: input.text.length,
          contextCharacters: assembled?.contextCharacters ?? null,
          contextAssembled: assembled !== null,
          sources: sources.map((source, index) => ({
            ...source,
            characters: assembled?.counts[index] ?? null,
          })),
        };
        const [row] = await tx.query(
          `INSERT INTO ai_preflights(id,owner_id,metadata) VALUES($1,$2,$3::jsonb) RETURNING ${columns}`,
          [randomUUID(), user.id, JSON.stringify(metadata)],
        );
        return record(row!);
      },
      { isolation: 'repeatable read' },
    );
    return reply.code(201).send(output);
  });
  app.get(base, async (request) => {
    const user = await auth.requireUser(request);
    const query = aiPreflightsQuerySchema.parse(request.query);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      const [cursor] = query.before
        ? await tx.query(
            `SELECT ${stamp('created_at', 'cursorTimestamp').replace('.MS', '.US')},id FROM ai_preflights WHERE owner_id=$1 AND id=$2`,
            [user.id, query.before],
          )
        : [];
      if (query.before && !cursor)
        throw new ApiError(404, 'NOT_FOUND', 'Preflight cursor not available.');
      const rows = await tx.query(
        `SELECT ${columns} FROM ai_preflights WHERE owner_id=$1 AND deleted_at IS NULL ${cursor ? 'AND (created_at,id)<($3::timestamptz,$4::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT $2`,
        cursor
          ? [user.id, query.limit + 1, cursor.cursorTimestamp, cursor.id]
          : [user.id, query.limit + 1],
      );
      return aiPreflightsResponseSchema.parse({
        preflights: rows.slice(0, query.limit).map(record),
        nextBefore:
          rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      });
    });
  });
  app.get(`${base}/:id`, async (request) => {
    const user = await auth.requireUser(request);
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    const [row] = await database.query(
      `SELECT ${columns} FROM ai_preflights WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [user.id, id],
    );
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Preflight not available.');
    return record(row);
  });
  app.delete(`${base}/:id`, async (request) => {
    const user = await auth.requireUser(request);
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    const input = deleteItemSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'ai.preflight.delete', id, input },
      async (tx) => {
        const [row] = await tx.query(
          'SELECT version FROM ai_preflights WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
          [user.id, id],
        );
        if (!row)
          throw new ApiError(404, 'NOT_FOUND', 'Preflight not available.');
        version(row, input.expectedVersion);
        const [deleted] = await tx.query(
          `UPDATE ai_preflights SET deleted_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING ${columns}`,
          [user.id, id],
        );
        return record(deleted!);
      },
    );
  });
}
