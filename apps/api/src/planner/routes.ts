import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createTaskSchema,
  updateTaskSchema,
  deleteItemSchema,
  taskResponseSchema,
  tasksResponseSchema,
  createEventSchema,
  updateEventSchema,
  eventResponseSchema,
  eventsResponseSchema,
} from '@hub/contracts';
import type { Database } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { missingOrConflict, mutate } from './mutations.js';
import { ApiError } from '../errors.js';
import {
  captureCanvasSource,
  plannerSourceColumns,
} from '../connections/canvas-provenance.js';

const idSchema = z.object({ id: z.string().uuid() });
// SQL aliases and to_char preserve date-only deadlines and normalize timestamps on both drivers.
export const taskColumns = `${plannerSourceColumns('tasks')}, id, title, notes, to_char(due_date, 'YYYY-MM-DD') AS "dueDate", priority, completed, sensitivity, version,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deletedAt"`;
const eventColumns = `${plannerSourceColumns('events')}, id, title, notes, time_zone AS "timeZone", sensitivity, version, all_day AS "allDay", recurrence, course_id AS "courseId",
  to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startsAt",
  to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endsAt",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deletedAt"`;

export function registerPlanner(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.get('/api/v1/tasks', async (request) => {
    const user = await auth.requireUser(request);
    return tasksResponseSchema.parse({
      tasks: await database.query(
        `SELECT ${taskColumns} FROM tasks WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY completed, due_date NULLS LAST, created_at DESC`,
        [user.id],
      ),
    });
  });
  app.post('/api/v1/tasks', async (request) => {
    const user = await auth.requireUser(request);
    const input = createTaskSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'task.create', input },
      async (transaction) => {
        const id = input.clientId ?? randomUUID();
        const source = await captureCanvasSource(
          transaction,
          user.id,
          input.canvasSourceRef,
        );
        const [task] = await transaction.query(
          `INSERT INTO tasks (id, owner_id, title, notes, due_date, priority, completed, sensitivity,canvas_source_id,canvas_source_snapshot,canvas_assignment_id,canvas_assignment_snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,$9,$10::jsonb,$11,$12::jsonb) ON CONFLICT (id) DO NOTHING RETURNING ${taskColumns}`,
          [
            id,
            user.id,
            input.title,
            input.notes,
            input.dueDate,
            input.priority,
            input.completed,
            input.sensitivity,
            source?.inputKind !== 'assignment-api'
              ? (source?.itemId ?? null)
              : null,
            source && source.inputKind !== 'assignment-api'
              ? JSON.stringify(source)
              : null,
            source?.inputKind === 'assignment-api' ? source.itemId : null,
            source?.inputKind === 'assignment-api'
              ? JSON.stringify(source)
              : null,
          ],
        );
        if (!task)
          throw new ApiError(
            409,
            'OPERATION_CONFLICT',
            'This task identifier is already in use.',
          );
        return taskResponseSchema.parse({ task });
      },
    );
  });
  app.put('/api/v1/tasks/:id', async (request) => {
    const user = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    const input = updateTaskSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'task.update', id, input },
      async (transaction) => {
        const [task] = await transaction.query(
          `UPDATE tasks SET title = $3, notes = $4, due_date = $5, priority = $6, completed = $7, sensitivity = COALESCE($8, sensitivity), version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE owner_id = $1 AND id = $2 AND version = $9 AND deleted_at IS NULL RETURNING ${taskColumns}`,
          [
            user.id,
            id,
            input.title,
            input.notes,
            input.dueDate,
            input.priority,
            input.completed,
            input.sensitivity ?? null,
            input.expectedVersion,
          ],
        );
        if (!task) return missingOrConflict(transaction, 'tasks', user.id, id);
        return taskResponseSchema.parse({ task });
      },
    );
  });
  app.delete('/api/v1/tasks/:id', async (request) => {
    const user = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    const input = deleteItemSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'task.delete', id, input },
      async (transaction) => {
        const [task] = await transaction.query(
          `UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, version = version + 1 WHERE owner_id = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL RETURNING ${taskColumns}`,
          [user.id, id, input.expectedVersion],
        );
        if (!task) return missingOrConflict(transaction, 'tasks', user.id, id);
        return taskResponseSchema.parse({ task });
      },
    );
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
            input.sensitivity ?? null,
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
