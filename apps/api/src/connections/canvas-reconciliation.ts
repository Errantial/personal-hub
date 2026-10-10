import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canvasReconciliationListSchema,
  canvasReconciliationWriteSchema,
  canvasReconciliationResponseSchema,
  canvasAssignmentUrl,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutate } from '../planner/mutations.js';
import { stamp, version } from '../features/common.js';
import { ApiError } from '../errors.js';
import { readCanvasItems } from './canvas.js';
import { readCanvasLms } from './canvas-lms.js';
export const reconciliationColumns = `id,item_id AS "itemId",assignment_id AS "assignmentId",version,${stamp('created_at', 'createdAt')},${stamp('updated_at', 'updatedAt')},${stamp('deleted_at', 'deletedAt')}`;
export async function readReconciliations(
  tx: QueryExecutor,
  owner: string,
  limit = 2000,
) {
  const rows = await tx.query(
    `SELECT ${reconciliationColumns} FROM canvas_reconciliations WHERE owner_id=$1 ORDER BY item_id LIMIT ${limit + 1}`,
    [owner],
  );
  if (rows.length > limit)
    throw new ApiError(
      413,
      limit === 10000 ? 'EXPORT_TOO_LARGE' : 'CANVAS_ITEMS_LIMIT',
      'Too many retained reconciliation records.',
    );
  return rows;
}
export function registerCanvasReconciliation(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/connections/canvas/reconciliation';
  app.get(base, async (request) => {
    const user = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return canvasReconciliationListSchema.parse({
        ...(await readCanvasLms(tx, user.id)),
        ...(await readCanvasItems(tx, user.id)),
        links: await readReconciliations(tx, user.id),
      });
    });
  });
  app.put(`${base}/:itemId`, async (request) => {
    const user = await auth.requireUser(request);
    const { itemId } = z
      .strictObject({ itemId: z.string().uuid() })
      .parse(request.params);
    const input = canvasReconciliationWriteSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'canvas.reconcile', itemId, input },
      async (tx) => {
        await tx.query(
          'SELECT owner_id FROM canvas_sources WHERE owner_id=$1 FOR UPDATE',
          [user.id],
        );
        await tx.query(
          'SELECT owner_id FROM canvas_lms_sources WHERE owner_id=$1 FOR UPDATE',
          [user.id],
        );
        const [item] = await tx.query(
          'SELECT * FROM canvas_items WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [user.id, itemId],
        );
        if (!item)
          throw new ApiError(404, 'NOT_FOUND', 'Canvas entry not available.');
        version(item, input.expectedItemVersion);
        const [old] = await tx.query(
          'SELECT * FROM canvas_reconciliations WHERE owner_id=$1 AND item_id=$2 FOR UPDATE',
          [user.id, itemId],
        );
        if (
          old
            ? old.version !== input.expectedVersion
            : input.expectedVersion !== null
        )
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload reconciliation records.',
          );
        if (input.assignmentId) {
          const [assignment] = await tx.query(
            'SELECT * FROM canvas_lms_assignments WHERE owner_id=$1 AND id=$2 FOR UPDATE',
            [user.id, input.assignmentId],
          );
          if (!assignment)
            throw new ApiError(
              404,
              'NOT_FOUND',
              'Canvas assignment not available.',
            );
          const [course] = await tx.query(
            'SELECT * FROM canvas_lms_courses WHERE owner_id=$1 AND id=$2 FOR UPDATE',
            [user.id, assignment.canvas_course_id],
          );
          if (!course)
            throw new ApiError(
              404,
              'NOT_FOUND',
              'Canvas course not available.',
            );
          version(assignment, input.expectedAssignmentVersion!);
          version(course, input.expectedCourseVersion!);
          if (
            item.availability !== 'available' ||
            assignment.availability !== 'available' ||
            course.availability !== 'available'
          )
            throw new ApiError(
              409,
              'SOURCE_UNAVAILABLE',
              'Link available records only.',
            );
          const data = item.provider_data as { sourceUrl: string | null };
          if (
            data.sourceUrl !==
            canvasAssignmentUrl(
              String(course.provider_id),
              String(assignment.provider_id),
            )
          )
            throw new ApiError(
              409,
              'SOURCE_IDENTITY_MISMATCH',
              'The Canvas assignment URLs do not match.',
            );
        } else if (!old || old.deleted_at)
          throw new ApiError(
            409,
            'SOURCE_UNAVAILABLE',
            'No active reconciliation to remove.',
          );
        const assignmentId = input.assignmentId ?? String(old!.assignment_id);
        const [link] = await tx.query(
          `INSERT INTO canvas_reconciliations(id,owner_id,item_id,assignment_id,deleted_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,item_id) DO UPDATE SET assignment_id=EXCLUDED.assignment_id,deleted_at=EXCLUDED.deleted_at,version=canvas_reconciliations.version+1,updated_at=CURRENT_TIMESTAMP RETURNING ${reconciliationColumns}`,
          [
            old?.id ?? randomUUID(),
            user.id,
            itemId,
            assignmentId,
            input.assignmentId ? null : new Date().toISOString(),
          ],
        );
        // Association changes invalidate source drafts but leave planner versions and edits intact.
        await tx.query(
          'UPDATE canvas_items SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
          [user.id, itemId],
        );
        const affected = [
          ...new Set(
            [assignmentId, old?.assignment_id].filter(Boolean).map(String),
          ),
        ];
        await tx.query(
          'UPDATE canvas_lms_assignments SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=ANY($2::uuid[])',
          [user.id, affected],
        );
        return canvasReconciliationResponseSchema.parse({ link });
      },
    );
  });
}
