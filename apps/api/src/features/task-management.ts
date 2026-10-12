import {
  taskBrowseQuerySchema,
  taskBrowseResponseSchema,
  taskBatchRequestSchema,
  taskBatchResponseSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { taskColumns } from '../planner/routes.js';
import { mutate } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import { version } from './common.js';

export function registerTaskManagement(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.get('/api/v1/tasks/browse', async (request) => {
    const user = await auth.requireUser(request);
    const input = taskBrowseQuerySchema.parse(request.query);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      const values = [user.id, input.priority, input.due, input.status];
      const filtered = `owner_id=$1 AND deleted_at IS NULL
        AND ($2::text='all' OR priority=$2)
        AND ($3::text='any' OR ($3='undated' AND due_date IS NULL) OR ($3='dated' AND due_date IS NOT NULL))`;
      const selected = `${filtered} AND ($4::text='all' OR completed=($4='completed'))`;
      const anchor = input.after
        ? (
            await tx.query<{
              id: string;
              version: number;
              dueDate: string | null;
              completed: boolean;
            }>(
              `SELECT id,version,completed,to_char(due_date,'YYYY-MM-DD') AS "dueDate" FROM tasks WHERE ${selected} AND id=$5`,
              [...values, input.after],
            )
          )[0]
        : null;
      if (input.after && !anchor)
        throw new ApiError(
          404,
          'NOT_FOUND',
          'Task cursor no longer available.',
        );
      if (anchor) version(anchor, input.expectedCursorVersion);
      const [summary] = await tx.query(
        `SELECT COUNT(*)::int AS "totalCount", COUNT(*) FILTER(WHERE NOT completed)::int AS "openCount",
          COUNT(*) FILTER(WHERE completed)::int AS "completedCount" FROM tasks WHERE ${filtered}`,
        values.slice(0, 3),
      );
      const rows = await tx.query(
        `SELECT ${taskColumns} FROM tasks WHERE ${selected}
          ${anchor ? "AND (completed,COALESCE(due_date,'infinity'::date),id)>($6::boolean,COALESCE($7::date,'infinity'::date),$8::uuid)" : ''}
          ORDER BY completed ASC,due_date ASC NULLS LAST,id ASC LIMIT $5`,
        anchor
          ? [
              ...values,
              input.limit + 1,
              anchor.completed,
              anchor.dueDate,
              anchor.id,
            ]
          : [...values, input.limit + 1],
      );
      const last = rows[input.limit - 1];
      return taskBrowseResponseSchema.parse({
        status: input.status,
        priority: input.priority,
        due: input.due,
        summary,
        tasks: rows.slice(0, input.limit),
        nextAfter:
          rows.length > input.limit && last
            ? { id: last.id, version: last.version }
            : null,
      });
    });
  });
  app.post('/api/v1/tasks/batch', async (request) => {
    const user = await auth.requireUser(request);
    const input = taskBatchRequestSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'task.batch', input },
      async (tx) => {
        const ids = input.items.map((item) => item.id.toLowerCase());
        // The shared owner schedule lock precedes row locks, matching single-task,
        // source-label, reminder-delivery and study approval operations.
        const selected = await tx.query<{ id: string; version: number }>(
          'SELECT id,version FROM tasks WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE',
          [user.id, ids],
        );
        if (selected.length !== ids.length)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'A selected task is no longer available.',
          );
        const versions = new Map(selected.map((row) => [row.id, row]));
        for (const item of input.items)
          version(versions.get(item.id.toLowerCase())!, item.expectedVersion);
        const rows =
          input.action.kind === 'delete'
            ? await tx.query(
                `UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=ANY($2::uuid[]) RETURNING ${taskColumns}`,
                [user.id, ids],
              )
            : await tx.query(
                `UPDATE tasks SET completed=COALESCE($3::boolean,completed),priority=COALESCE($4::text,priority),
              due_date=CASE WHEN $5::boolean THEN $6::date ELSE due_date END,
              updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=ANY($2::uuid[]) RETURNING ${taskColumns}`,
                [
                  user.id,
                  ids,
                  input.action.changes.completed ?? null,
                  input.action.changes.priority ?? null,
                  input.action.changes.dueDate !== undefined,
                  input.action.changes.dueDate ?? null,
                ],
              );
        const byId = new Map(rows.map((row) => [row.id, row]));
        return taskBatchResponseSchema.parse({
          tasks: ids.map((id) => byId.get(id)),
        });
      },
    );
  });
}
