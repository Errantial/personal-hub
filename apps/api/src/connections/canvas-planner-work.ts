import {
  canvasPlannerWorkQuerySchema,
  canvasPlannerWorkSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { ApiError } from '../errors.js';
import { taskColumns } from '../planner/routes.js';
import { eventColumns } from '../features/common.js';
export function registerCanvasPlannerWork(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.get('/api/v1/connections/canvas/planner-work', async (request) => {
    const user = await auth.requireUser(request);
    const { kind, itemId } = canvasPlannerWorkQuerySchema.parse(request.query);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const table =
        kind === 'calendar' ? 'canvas_items' : 'canvas_lms_assignments';
      if (
        !(
          await tx.query(
            `SELECT id FROM ${table} WHERE owner_id=$1 AND id=$2`,
            [user.id, itemId],
          )
        ).length
      )
        throw new ApiError(404, 'NOT_FOUND', 'Canvas source not available.');
      const links = await tx.query(
        `SELECT item_id,assignment_id FROM canvas_reconciliations WHERE owner_id=$1 AND deleted_at IS NULL AND ${kind === 'calendar' ? 'item_id' : 'assignment_id'}=$2 LIMIT 2001`,
        [user.id, itemId],
      );
      const assignments = [
        ...new Set([
          ...(kind === 'assignment-api' ? [itemId] : []),
          ...links.map((row) => String(row.assignment_id)),
        ]),
      ];
      // Include every feed entry associated with the same assignment, without URL/name heuristics.
      const related = assignments.length
        ? await tx.query(
            'SELECT item_id FROM canvas_reconciliations WHERE owner_id=$1 AND deleted_at IS NULL AND assignment_id=ANY($2::uuid[]) LIMIT 2001',
            [user.id, assignments],
          )
        : [];
      if (links.length > 2000 || related.length > 2000)
        throw new ApiError(
          413,
          'CANVAS_WORK_LIMIT',
          'Too many linked Canvas sources.',
        );
      const items = [
        ...new Set([
          ...(kind === 'calendar' ? [itemId] : []),
          ...links.map((row) => String(row.item_id)),
          ...related.map((row) => String(row.item_id)),
        ]),
      ];
      const predicate =
        'owner_id=$1 AND deleted_at IS NULL AND (canvas_source_id=ANY($2::uuid[]) OR canvas_assignment_id=ANY($3::uuid[]))';
      const params = [user.id, items, assignments];
      const tasks = await tx.query(
        `SELECT ${taskColumns} FROM tasks WHERE ${predicate} ORDER BY completed,due_date NULLS LAST,id LIMIT 1001`,
        params,
      );
      const studies = await tx.query(
        `SELECT ${eventColumns} FROM events WHERE ${predicate} ORDER BY starts_at,id LIMIT 1001`,
        params,
      );
      if (tasks.length > 1000 || studies.length > 1000)
        throw new ApiError(
          413,
          'CANVAS_WORK_LIMIT',
          'Too many linked planner records.',
        );
      return canvasPlannerWorkSchema.parse({ tasks, studies });
    });
  });
}
