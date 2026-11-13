import { z } from 'zod';
import {
  trackedDeadlineCompletionSchema,
  trackedDeadlineListQuerySchema,
  trackedDeadlineListSchema,
  trackedDeadlineResponseSchema,
  trackedDeadlineUpdateSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { ApiError } from '../errors.js';
import { mutate } from '../planner/mutations.js';
import {
  readTrackedDeadline,
  readTrackedDeadlines,
  trackedDeadlineLocalDate,
} from '../connections/canvas-deadlines.js';

const idParams = z.strictObject({ id: z.string().uuid() });

export type TrackedDeadlineUpdate = z.infer<typeof trackedDeadlineUpdateSchema>;

/** One owned local deadline edit; the caller owns the operation receipt. */
export async function saveTrackedDeadlineUpdate(
  tx: QueryExecutor,
  owner: string,
  id: string,
  input: TrackedDeadlineUpdate,
) {
  const dueAt =
    input.dueOverride.kind === 'timed' ? input.dueOverride.dueAt : null;
  const dueDate =
    input.dueOverride.kind === 'date' ? input.dueOverride.dueDate : null;
  const dueTimeZone =
    input.dueOverride.kind === 'timed' ? input.dueOverride.timeZone : null;
  const saved = await tx.query(
    `UPDATE tracked_deadlines
     SET title_override=$4,priority=$5,notes=$6,due_override_kind=$7,due_at_override=$8,due_date_override=$9,due_time_zone=$10,sensitivity=$11,version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$3 RETURNING id`,
    [
      owner,
      id,
      input.expectedVersion,
      input.titleOverride,
      input.priority,
      input.notes,
      input.dueOverride.kind,
      dueAt,
      dueDate,
      dueTimeZone,
      input.sensitivity,
    ],
  );
  if (!saved.length) await changedOrMissing(tx, owner, id);
  return readTrackedDeadline(tx, owner, id);
}

/** One owned local complete/reopen; Canvas is never called or changed. */
export async function changeTrackedDeadlineCompletion(
  tx: QueryExecutor,
  owner: string,
  action: 'complete' | 'reopen',
  id: string,
  expectedVersion: number,
) {
  const saved = await tx.query(
    `UPDATE tracked_deadlines
     SET completed_at=${action === 'complete' ? 'CURRENT_TIMESTAMP' : 'NULL'},version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$3 RETURNING id`,
    [owner, id, expectedVersion],
  );
  if (!saved.length) await changedOrMissing(tx, owner, id);
  return readTrackedDeadline(tx, owner, id);
}

export async function changedOrMissing(
  tx: QueryExecutor,
  owner: string,
  id: string,
) {
  const [existing] = await tx.query(
    'SELECT id FROM tracked_deadlines WHERE owner_id=$1 AND id=$2',
    [owner, id],
  );
  if (!existing)
    throw new ApiError(404, 'NOT_FOUND', 'Tracked deadline not available.');
  throw new ApiError(
    409,
    'VERSION_CONFLICT',
    'This deadline changed elsewhere. Reload it before editing.',
  );
}

export function registerTrackedDeadlines(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/deadlines';

  app.get(base, async (request) => {
    const user = await auth.requireUser(request);
    const query = trackedDeadlineListQuerySchema.parse(request.query);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      let deadlines = await readTrackedDeadlines(tx, user.id);
      deadlines = deadlines.filter((deadline) => {
        if (query.status === 'open' && deadline.completedAt) return false;
        if (query.status === 'completed' && !deadline.completedAt) return false;
        const localDate = trackedDeadlineLocalDate(deadline);
        if (query.from && (!localDate || localDate < query.from)) return false;
        if (query.to && (!localDate || localDate >= query.to)) return false;
        return true;
      });
      deadlines.sort((left, right) => {
        const leftDate = trackedDeadlineLocalDate(left) ?? '9999-12-31';
        const rightDate = trackedDeadlineLocalDate(right) ?? '9999-12-31';
        return (
          leftDate.localeCompare(rightDate) ||
          left.title.localeCompare(right.title) ||
          left.id.localeCompare(right.id)
        );
      });
      let start = 0;
      if (query.after) {
        const index = deadlines.findIndex(
          (deadline) => deadline.id === query.after,
        );
        if (index < 0)
          throw new ApiError(
            400,
            'INVALID_CURSOR',
            'Reload tracked deadlines before continuing.',
          );
        start = index + 1;
      }
      const page = deadlines.slice(start, start + query.limit);
      const more = start + query.limit < deadlines.length;
      return trackedDeadlineListSchema.parse({
        deadlines: page,
        nextAfter: more ? (page.at(-1)?.id ?? null) : null,
      });
    });
  });

  app.get(`${base}/:id`, async (request) => {
    const user = await auth.requireUser(request);
    const { id } = idParams.parse(request.params);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return trackedDeadlineResponseSchema.parse({
        deadline: await readTrackedDeadline(tx, user.id, id),
      });
    });
  });

  app.put(`${base}/:id`, async (request) => {
    const user = await auth.requireUser(request);
    const { id } = idParams.parse(request.params);
    const input = trackedDeadlineUpdateSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'deadline.update', id, input },
      async (tx) =>
        trackedDeadlineResponseSchema.parse({
          deadline: await saveTrackedDeadlineUpdate(tx, user.id, id, input),
        }),
    );
  });

  for (const action of ['complete', 'reopen'] as const)
    app.post(`${base}/:id/${action}`, async (request) => {
      const user = await auth.requireUser(request);
      const { id } = idParams.parse(request.params);
      const input = trackedDeadlineCompletionSchema.parse(request.body);
      return mutate(
        database,
        user.id,
        input.operationId,
        { kind: `deadline.${action}`, id, input },
        async (tx) =>
          trackedDeadlineResponseSchema.parse({
            deadline: await changeTrackedDeadlineCompletion(
              tx,
              user.id,
              action,
              id,
              input.expectedVersion,
            ),
          }),
      );
    });
}
