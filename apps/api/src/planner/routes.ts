import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createTaskSchema,
  createTaskRequestSchema,
  updateTaskSchema,
  deleteItemSchema,
  restoreItemSchema,
  taskResponseSchema,
  tasksResponseSchema,
  createEventSchema,
  updateEventSchema,
  eventResponseSchema,
  eventsResponseSchema,
  recurrenceSchema,
  Temporal,
} from '@hub/contracts';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { missingOrConflict, mutate } from './mutations.js';
import { ApiError } from '../errors.js';
import { restorePlannerItem } from './restore.js';
import {
  academicSourceColumns,
  academicPlannerLabels,
} from '../features/academic-provenance.js';
import { strongest } from '../features/common.js';
import {
  mailTaskSourceColumns,
  mailTaskLabels,
} from '../features/mail-provenance.js';
import {
  createRecurrenceSeries,
  deleteRecurrenceSeries,
  generateNextTaskOccurrence,
  stopRecurrenceSeriesFrom,
  syncTaskReminderOffsets,
  updateRecurrenceSeries,
} from '../features/recurrence.js';
import {
  captureCanvasSource,
  plannerSourceColumns,
} from '../connections/canvas-provenance.js';

const idSchema = z.object({ id: z.string().uuid() });
const isoDay = (value: unknown) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
// SQL aliases and to_char preserve date-only deadlines and normalize timestamps on both drivers.
export const taskColumns = `${mailTaskSourceColumns}, ${academicSourceColumns('tasks')}, ${plannerSourceColumns('tasks')}, id, title, notes, to_char(due_date, 'YYYY-MM-DD') AS "dueDate", priority, completed, sensitivity, version,
  to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dueAt", due_time_zone AS "dueTimeZone",
  recurrence, series_id AS "seriesId", to_char(occurrence_key, 'YYYY-MM-DD') AS "occurrenceKey", reminder_offsets AS "reminderOffsets",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deletedAt"`;
const eventColumns = `${academicSourceColumns('events')}, ${plannerSourceColumns('events')}, id, title, notes, time_zone AS "timeZone", sensitivity, version, all_day AS "allDay", recurrence, reminder_offsets AS "reminderOffsets", course_id AS "courseId",
  to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startsAt",
  to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endsAt",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deletedAt"`;

export async function createTaskRecord(
  transaction: QueryExecutor,
  owner: string,
  input: z.infer<typeof createTaskSchema>,
) {
  const id = input.clientId ?? randomUUID();
  const source = await captureCanvasSource(
    transaction,
    owner,
    input.canvasSourceRef,
  );
  const recurrence = input.recurrence ?? null;
  const seriesId = recurrence
    ? await createRecurrenceSeries(
        transaction,
        owner,
        'task',
        recurrence,
        input.dueDate!,
      )
    : null;
  const [task] = await transaction.query(
    `INSERT INTO tasks (id, owner_id, title, notes, due_date, due_at, due_time_zone, priority, completed, sensitivity, recurrence, series_id, occurrence_key, reminder_offsets, canvas_source_id,canvas_source_snapshot,canvas_assignment_id,canvas_assignment_snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,$11::jsonb,$12,$13,$14::jsonb,$15,$16::jsonb,$17,$18::jsonb) ON CONFLICT (id) DO NOTHING RETURNING ${taskColumns}`,
    [
      id,
      owner,
      input.title,
      input.notes,
      input.dueDate,
      input.dueAt ?? null,
      input.dueTimeZone ?? null,
      input.priority,
      input.completed,
      input.sensitivity,
      recurrence ? JSON.stringify(recurrence) : null,
      seriesId,
      recurrence ? input.dueDate : null,
      JSON.stringify(input.reminderOffsets ?? []),
      source?.inputKind !== 'assignment-api' ? (source?.itemId ?? null) : null,
      source && source.inputKind !== 'assignment-api'
        ? JSON.stringify(source)
        : null,
      source?.inputKind === 'assignment-api' ? source.itemId : null,
      source?.inputKind === 'assignment-api' ? JSON.stringify(source) : null,
    ],
  );
  if (!task)
    throw new ApiError(
      409,
      'OPERATION_CONFLICT',
      'This task identifier is already in use.',
    );
  await syncTaskReminderOffsets(transaction, owner, id);
  const [saved] = await transaction.query(
    `SELECT ${taskColumns} FROM tasks WHERE owner_id=$1 AND id=$2`,
    [owner, id],
  );
  return taskResponseSchema.parse({ task: saved });
}
/**
 * Creates, updates or deletes one task through the versioned, receipted
 * mutation. Routes and the agent worker (D57) share it.
 */
export async function saveTask(
  database: Database,
  owner: string,
  method: 'POST' | 'PUT' | 'DELETE',
  target: string | null,
  body: unknown,
): Promise<z.infer<typeof taskResponseSchema>> {
  if (method === 'POST') {
    const input = createTaskRequestSchema.parse(body);
    return mutate(
      database,
      owner,
      input.operationId,
      { kind: 'task.create', input },
      (transaction) => createTaskRecord(transaction, owner, input),
    );
  }
  const id = z.string().uuid().parse(target);
  if (method === 'PUT') {
    const input = updateTaskSchema.parse(body);
    return mutate(
      database,
      owner,
      input.operationId,
      { kind: 'task.update', id, input },
      async (transaction) => {
        const labels = await academicPlannerLabels(
          transaction,
          owner,
          'task',
          id,
        );
        labels.push(...(await mailTaskLabels(transaction, owner, id)));
        const [current] = await transaction.query<Record<string, unknown>>(
          `SELECT id,version,title,notes,due_date,due_at,due_time_zone,
             priority,completed,sensitivity,recurrence,series_id,occurrence_key,
             reminder_offsets
           FROM tasks WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL
           FOR UPDATE`,
          [owner, id],
        );
        if (!current || Number(current.version) !== input.expectedVersion)
          return missingOrConflict(transaction, 'tasks', owner, id);
        const currentDueDate = current.due_date
          ? isoDay(current.due_date)
          : null;
        const dueDate =
          input.dueDate !== undefined ? input.dueDate : currentDueDate;
        const dateChanged =
          input.dueDate !== undefined && input.dueDate !== currentDueDate;
        const dueAt =
          input.dueAt !== undefined
            ? input.dueAt
            : dateChanged
              ? null
              : current.due_at;
        const dueTimeZone =
          input.dueTimeZone !== undefined
            ? input.dueTimeZone
            : dateChanged
              ? null
              : current.due_time_zone;
        const recurrence =
          input.recurrence !== undefined
            ? input.recurrence
            : current.recurrence
              ? recurrenceSchema.parse(current.recurrence)
              : null;
        let seriesId = current.series_id ? String(current.series_id) : null;
        let occurrenceKey = current.occurrence_key
          ? isoDay(current.occurrence_key)
          : null;
        const scope = input.scope ?? 'this';
        const currentRule = current.recurrence
          ? recurrenceSchema.parse(current.recurrence)
          : null;
        if (
          seriesId &&
          input.recurrence !== undefined &&
          JSON.stringify(recurrence) !== JSON.stringify(currentRule) &&
          scope !== 'future'
        )
          throw new ApiError(
            400,
            'SCOPE_REQUIRED',
            'Choose this and all future occurrences to change a repeat.',
          );
        if (seriesId && scope === 'future') {
          if (!recurrence) {
            await deleteRecurrenceSeries(
              transaction,
              owner,
              seriesId,
              occurrenceKey ?? undefined,
            );
            await transaction.query(
              `UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP,
                 updated_at=CURRENT_TIMESTAMP,version=version+1
               WHERE owner_id=$1 AND series_id=$2 AND deleted_at IS NULL
                 AND occurrence_key > $3`,
              [owner, seriesId, occurrenceKey],
            );
            await transaction.query(
              `UPDATE reminders SET status='cancelled',version=version+1,
                 updated_at=CURRENT_TIMESTAMP
               WHERE owner_id=$1 AND target_kind='task' AND target_id IN
                 (SELECT id FROM tasks WHERE owner_id=$1 AND series_id=$2)
                 AND status IN ('queued','running','paused')`,
              [owner, seriesId],
            );
            seriesId = null;
            occurrenceKey = null;
          } else {
            const oldKey = occurrenceKey;
            const deltaDays =
              scope === 'future' && dueDate && currentDueDate
                ? Temporal.PlainDate.from(currentDueDate).until(dueDate).days
                : 0;
            await updateRecurrenceSeries(
              transaction,
              owner,
              seriesId,
              recurrence,
              dueDate ?? occurrenceKey!,
            );
            if (scope === 'future') occurrenceKey = dueDate ?? occurrenceKey;
            const futureRows = await transaction.query<{ id: string }>(
              `UPDATE tasks SET title=$3,notes=$4,priority=$5,sensitivity=$6,
                 recurrence=$7::jsonb,reminder_offsets=$8::jsonb,
                 due_time_zone=$9,version=version+1,updated_at=CURRENT_TIMESTAMP,
                 occurrence_key=occurrence_key + $11::int,
                 due_date=CASE WHEN due_date IS NULL THEN NULL ELSE due_date + $11::int END,
                 due_at=CASE WHEN due_at IS NULL THEN NULL
                   ELSE due_at + make_interval(days => $11) END
               WHERE owner_id=$1 AND series_id=$2 AND deleted_at IS NULL
                 AND occurrence_key > $10
               RETURNING id`,
              [
                owner,
                seriesId,
                input.title,
                input.notes,
                input.priority,
                input.sensitivity === undefined
                  ? current.sensitivity
                  : strongest(input.sensitivity, ...labels),
                JSON.stringify(recurrence),
                JSON.stringify(
                  input.reminderOffsets ??
                    (Array.isArray(current.reminder_offsets)
                      ? current.reminder_offsets
                      : []),
                ),
                dueTimeZone,
                oldKey,
                deltaDays,
              ],
            );
            for (const row of futureRows)
              await syncTaskReminderOffsets(transaction, owner, row.id);
          }
        } else if (!seriesId && recurrence) {
          seriesId = await createRecurrenceSeries(
            transaction,
            owner,
            'task',
            recurrence,
            dueDate!,
          );
          occurrenceKey = dueDate!;
        }
        const [task] = await transaction.query(
          `UPDATE tasks SET title=$3,notes=$4,due_date=$5,due_at=$6,
             due_time_zone=$7,priority=$8,completed=$9,sensitivity=$10,
             recurrence=$11::jsonb,series_id=$12,occurrence_key=$13,
             reminder_offsets=$14::jsonb,version=version+1,
             updated_at=CURRENT_TIMESTAMP
           WHERE owner_id=$1 AND id=$2 AND version=$15 AND deleted_at IS NULL
           RETURNING ${taskColumns}`,
          [
            owner,
            id,
            input.title,
            input.notes,
            dueDate,
            dueAt,
            dueTimeZone,
            input.priority,
            input.completed,
            input.sensitivity === undefined
              ? current.sensitivity
              : strongest(input.sensitivity, ...labels),
            recurrence ? JSON.stringify(recurrence) : null,
            seriesId,
            occurrenceKey,
            JSON.stringify(
              input.reminderOffsets ??
                (Array.isArray(current.reminder_offsets)
                  ? current.reminder_offsets
                  : []),
            ),
            input.expectedVersion,
          ],
        );
        if (!task) return missingOrConflict(transaction, 'tasks', owner, id);
        if (input.completed && seriesId) {
          await syncTaskReminderOffsets(transaction, owner, id);
          await generateNextTaskOccurrence(transaction, owner, id);
        } else {
          await syncTaskReminderOffsets(transaction, owner, id);
        }
        return taskResponseSchema.parse({ task });
      },
    );
  }
  const input = deleteItemSchema.parse(body);
  return mutate(
    database,
    owner,
    input.operationId,
    { kind: 'task.delete', id, input },
    async (transaction) => {
      const [current] = await transaction.query<Record<string, unknown>>(
        `SELECT id,version,series_id,occurrence_key
         FROM tasks WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL
         FOR UPDATE`,
        [owner, id],
      );
      if (!current || Number(current.version) !== input.expectedVersion)
        return missingOrConflict(transaction, 'tasks', owner, id);
      const seriesId = current.series_id ? String(current.series_id) : null;
      const key = current.occurrence_key
        ? isoDay(current.occurrence_key)
        : null;
      const scope = input.scope ?? 'this';
      if (seriesId && scope !== 'this') {
        if (scope === 'series') {
          await deleteRecurrenceSeries(
            transaction,
            owner,
            seriesId,
            key ?? undefined,
          );
          await transaction.query(
            `UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP,
               updated_at=CURRENT_TIMESTAMP,version=version+1
             WHERE owner_id=$1 AND series_id=$2 AND deleted_at IS NULL`,
            [owner, seriesId],
          );
        } else {
          await stopRecurrenceSeriesFrom(transaction, owner, seriesId, key!);
          await transaction.query(
            `UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP,
               updated_at=CURRENT_TIMESTAMP,version=version+1
             WHERE owner_id=$1 AND series_id=$2 AND deleted_at IS NULL
               AND occurrence_key >= $3`,
            [owner, seriesId, key],
          );
        }
        await transaction.query(
          `UPDATE reminders SET status='cancelled',version=version+1,
             updated_at=CURRENT_TIMESTAMP
           WHERE owner_id=$1 AND target_kind='task' AND target_id IN
             (SELECT id FROM tasks WHERE owner_id=$1 AND series_id=$2)
             AND status IN ('queued','running','paused')`,
          [owner, seriesId],
        );
      } else {
        await transaction.query(
          `UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP,
             updated_at=CURRENT_TIMESTAMP,version=version+1
           WHERE owner_id=$1 AND id=$2`,
          [owner, id],
        );
        await syncTaskReminderOffsets(transaction, owner, id);
        if (seriesId) await generateNextTaskOccurrence(transaction, owner, id);
      }
      const [task] = await transaction.query(
        `SELECT ${taskColumns} FROM tasks WHERE owner_id=$1 AND id=$2`,
        [owner, id],
      );
      return taskResponseSchema.parse({ task });
    },
  );
}
export function registerPlanner(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  for (const table of ['tasks', 'events'] as const)
    app.get(`/api/v1/${table}/:id`, async (request) => {
      const user = await auth.requireUser(request);
      const { id } = idSchema.parse(request.params);
      const [row] = await database.query(
        `SELECT ${table === 'tasks' ? taskColumns : eventColumns} FROM ${table} WHERE owner_id=$1 AND id=$2`,
        [user.id, id],
      );
      if (!row)
        throw new ApiError(
          404,
          'NOT_FOUND',
          'This item is no longer available.',
        );
      return table === 'tasks'
        ? taskResponseSchema.parse({ task: row })
        : eventResponseSchema.parse({ event: row });
    });
  for (const table of ['tasks', 'events'] as const)
    app.post(`/api/v1/${table}/:id/restore`, async (request) => {
      const user = await auth.requireUser(request);
      const { id } = idSchema.parse(request.params);
      const input = restoreItemSchema.parse(request.body);
      return mutate(
        database,
        user.id,
        input.operationId,
        { kind: `${table === 'tasks' ? 'task' : 'event'}.restore`, id, input },
        async (tx) => {
          const row = await restorePlannerItem(
            tx,
            table,
            table === 'tasks' ? taskColumns : eventColumns,
            user.id,
            id,
            input.expectedVersion,
          );
          return table === 'tasks'
            ? taskResponseSchema.parse({ task: row })
            : eventResponseSchema.parse({ event: row });
        },
      );
    });
  app.get('/api/v1/tasks', async (request) => {
    const user = await auth.requireUser(request);
    return tasksResponseSchema.parse({
      tasks: await database.query(
        `SELECT ${taskColumns} FROM tasks WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY completed, due_date NULLS LAST, due_at NULLS LAST, created_at DESC`,
        [user.id],
      ),
    });
  });
  app.post('/api/v1/tasks', async (request) => {
    const user = await auth.requireUser(request);
    return saveTask(database, user.id, 'POST', null, request.body);
  });
  app.put('/api/v1/tasks/:id', async (request) => {
    const user = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    return saveTask(database, user.id, 'PUT', id, request.body);
  });
  app.delete('/api/v1/tasks/:id', async (request) => {
    const user = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    return saveTask(database, user.id, 'DELETE', id, request.body);
  });
  app.get('/api/v1/events', async (request) => {
    const user = await auth.requireUser(request);
    return eventsResponseSchema.parse({
      events: await database.query(
        `SELECT ${eventColumns} FROM events WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY starts_at`,
        [user.id],
      ),
    });
  });
  app.post('/api/v1/events', async (request) => {
    const user = await auth.requireUser(request);
    const input = createEventSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'event.create', input },
      async (transaction) => {
        const [event] = await transaction.query(
          `INSERT INTO events (id, owner_id, title, notes, starts_at, ends_at, time_zone, sensitivity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${eventColumns}`,
          [
            randomUUID(),
            user.id,
            input.title,
            input.notes,
            input.startsAt,
            input.endsAt,
            input.timeZone,
            input.sensitivity,
          ],
        );
        return eventResponseSchema.parse({ event });
      },
    );
  });
  app.put('/api/v1/events/:id', async (request) => {
    const user = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    const input = updateEventSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'event.update', id, input },
      async (transaction) => {
        const labels = await academicPlannerLabels(
          transaction,
          user.id,
          'event',
          id,
        );
        const [advanced] = await transaction.query(
          'SELECT all_day,recurrence,course_id FROM events WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
          [user.id, id],
        );
        if (
          advanced &&
          (advanced.all_day || advanced.recurrence || advanced.course_id)
        )
          throw new ApiError(
            409,
            'CALENDAR_EDITOR_REQUIRED',
            'Edit this event in Calendar to preserve its schedule and class links.',
          );
        const [event] = await transaction.query(
          `UPDATE events SET title = $3, notes = $4, starts_at = $5, ends_at = $6, time_zone = $7, sensitivity = COALESCE($8, sensitivity), version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE owner_id = $1 AND id = $2 AND version = $9 AND deleted_at IS NULL RETURNING ${eventColumns}`,
          [
            user.id,
            id,
            input.title,
            input.notes,
            input.startsAt,
            input.endsAt,
            input.timeZone,
            input.sensitivity === undefined
              ? null
              : strongest(input.sensitivity, ...labels),
            input.expectedVersion,
          ],
        );
        if (!event)
          return missingOrConflict(transaction, 'events', user.id, id);
        return eventResponseSchema.parse({ event });
      },
    );
  });
  app.delete('/api/v1/events/:id', async (request) => {
    const user = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    const input = deleteItemSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'event.delete', id, input },
      async (transaction) => {
        const [event] = await transaction.query(
          `UPDATE events SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE owner_id = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING ${eventColumns}`,
          [user.id, id, input.expectedVersion],
        );
        if (!event)
          return missingOrConflict(transaction, 'events', user.id, id);
        return eventResponseSchema.parse({ event });
      },
    );
  });
}
