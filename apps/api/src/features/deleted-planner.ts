import {
  deletedPlannerQuerySchema,
  deletedPlannerResponseSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { taskColumns } from '../planner/routes.js';
import { eventColumns } from './common.js';
import { ApiError } from '../errors.js';
export function registerDeletedPlanner(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.get('/api/v1/planner/deleted', async (request) => {
    const owner = await auth.requireUser(request);
    const input = deletedPlannerQuerySchema.parse(request.query);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      const table = input.kind === 'task' ? 'tasks' : 'events';
      const [cursor] = input.before
        ? await tx.query(
            `SELECT id,to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp FROM ${table} WHERE owner_id=$1 AND id=$2 AND deleted_at IS NOT NULL`,
            [owner.id, input.before],
          )
        : [];
      if (input.before && !cursor)
        throw new ApiError(
          404,
          'NOT_FOUND',
          'Deleted item cursor not available. Reload the list.',
        );
      const rows = await tx.query(
        `SELECT ${input.kind === 'task' ? taskColumns : eventColumns} FROM ${table} WHERE owner_id=$1 AND deleted_at IS NOT NULL ${cursor ? 'AND (deleted_at,id)<($3::timestamptz,$4::uuid)' : ''} ORDER BY deleted_at DESC,id DESC LIMIT $2`,
        cursor
          ? [owner.id, input.limit + 1, cursor.timestamp, cursor.id]
          : [owner.id, input.limit + 1],
      );
      return deletedPlannerResponseSchema.parse({
        kind: input.kind,
        tasks: input.kind === 'task' ? rows.slice(0, input.limit) : [],
        events: input.kind === 'calendar' ? rows.slice(0, input.limit) : [],
        nextBefore:
          rows.length > input.limit ? rows[input.limit - 1]!.id : null,
      });
    });
  });
}
