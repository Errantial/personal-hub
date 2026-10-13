import {
  calendarRecordSchema,
  calendarBatchRequestSchema,
  calendarBatchResponseSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutateSchedule } from '../planner/mutations.js';
import { academicLabels, eventColumns, version } from './common.js';
import { ApiError } from '../errors.js';

export function registerCalendarManagement(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.post('/api/v1/calendar/batch', async (request) => {
    const owner = await auth.requireUser(request);
    const input = calendarBatchRequestSchema.parse(request.body);
    return mutateSchedule(
      database,
      owner.id,
      input.operationId,
      { kind: 'calendar.batch', input },
      async (tx) => {
        const ids = input.items.map((item) => item.id.toLowerCase());
        const read = async (lock: boolean) => {
          const rows = await tx.query(
            `SELECT ${eventColumns} FROM events WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
            [owner.id, ids],
          );
          if (rows.length !== ids.length)
            throw new ApiError(
              404,
              'NOT_FOUND',
              'A selected calendar record is no longer available.',
            );
          return rows.map((row) => calendarRecordSchema.parse(row));
        };
        if (input.action.kind === 'study-status') {
          const records = await read(false);
          if (
            records.some(
              (event) => !event.courseId || event.allDay || event.recurrence,
            )
          )
            throw new ApiError(
              409,
              'CALENDAR_STUDY_SELECTION_REQUIRED',
              'Select one-time timed study blocks only.',
            );
          // Preserve the single-record rule: status changes require active
          // academic ancestors. Lock them before events in canonical order.
          for (const event of records.sort(
            (a, b) =>
              a.courseId!.localeCompare(b.courseId!) ||
              (a.topicId ?? '').localeCompare(b.topicId ?? ''),
          ))
            await academicLabels(tx, owner.id, event.courseId, event.topicId);
        }
        const records = await read(true);
        const byId = new Map(records.map((event) => [event.id, event]));
        for (const item of input.items)
          version(byId.get(item.id.toLowerCase())!, item.expectedVersion);
        const rows =
          input.action.kind === 'delete'
            ? await tx.query(
                `UPDATE events SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=ANY($2::uuid[]) RETURNING ${eventColumns}`,
                [owner.id, ids],
              )
            : await tx.query(
                `UPDATE events SET study_status=$3,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=ANY($2::uuid[]) RETURNING ${eventColumns}`,
                [owner.id, ids, input.action.status],
              );
        const changed = new Map(rows.map((row) => [row.id, row]));
        return calendarBatchResponseSchema.parse({
          events: ids.map((id) => changed.get(id)),
        });
      },
      {
        authorize: async (tx) => {
          if (!(await auth.currentUser(request, tx)))
            throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
        },
      },
    );
  });
}
