import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  reminderSnoozeSchema,
  reminderResponseSchema,
  reminderSnoozeResponseSchema,
  reminderHistoryQuerySchema,
  reminderHistorySchema,
  notificationHistoryQuerySchema,
  notificationHistorySchema,
  notificationSummarySchema,
  notificationsReadSchema,
  notificationsReadResponseSchema,
} from '@hub/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutate, mutateSchedule } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import { active, version } from './common.js';
import {
  reminderColumns,
  notificationColumns,
  targetAvailable,
} from './reminders.js';

const idOf = (params: unknown) =>
  z.object({ id: z.string().uuid() }).parse(params).id;
async function unreadCount(tx: QueryExecutor, owner: string) {
  const [row] = await tx.query(
    'SELECT count(*)::integer AS count FROM notifications WHERE owner_id=$1 AND read_at IS NULL',
    [owner],
  );
  return Number(row!.count);
}
async function cursor(
  tx: QueryExecutor,
  table: 'reminders' | 'notifications',
  owner: string,
  before?: string,
) {
  if (!before) return null;
  const [row] = await tx.query(
    `SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp FROM ${table} WHERE owner_id=$1 AND id=$2`,
    [owner, before],
  );
  if (!row)
    throw new ApiError(404, 'NOT_FOUND', 'History cursor not available.');
  return row;
}
export function registerReminderInbox(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  async function snapshot<T>(
    request: FastifyRequest,
    work: (tx: QueryExecutor, owner: string) => Promise<T>,
  ) {
    const owner = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      return work(tx, owner.id);
    });
  }
  app.get('/api/v1/reminders/history', (request) =>
    snapshot(request, async (tx, owner) => {
      const input = reminderHistoryQuerySchema.parse(request.query);
      const anchor = await cursor(tx, 'reminders', owner, input.before);
      const rows = await tx.query(
        `SELECT ${reminderColumns} FROM reminders WHERE owner_id=$1
       AND ($3::text IS NULL OR status=$3)
       ${anchor ? 'AND (created_at,id)<($4::timestamptz,$5::uuid)' : ''}
       ORDER BY created_at DESC,id DESC LIMIT $2`,
        anchor
          ? [
              owner,
              input.limit + 1,
              input.status ?? null,
              anchor.timestamp,
              anchor.id,
            ]
          : [owner, input.limit + 1, input.status ?? null],
      );
      return reminderHistorySchema.parse({
        reminders: rows.slice(0, input.limit),
        nextBefore:
          rows.length > input.limit ? rows[input.limit - 1]!.id : null,
      });
    }),
  );
  app.get('/api/v1/reminders/:id', (request) =>
    snapshot(request, async (tx, owner) => {
      const [row] = await tx.query(
        `SELECT ${reminderColumns} FROM reminders WHERE owner_id=$1 AND id=$2`,
        [owner, idOf(request.params)],
      );
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Reminder not available.');
      return reminderResponseSchema.parse({ reminder: row });
    }),
  );
  app.get('/api/v1/notifications/summary', (request) =>
    snapshot(request, async (tx, owner) =>
      notificationSummarySchema.parse({
        unreadCount: await unreadCount(tx, owner),
      }),
    ),
  );
  app.get('/api/v1/notifications/history', (request) =>
    snapshot(request, async (tx, owner) => {
      const input = notificationHistoryQuerySchema.parse(request.query);
      const anchor = await cursor(tx, 'notifications', owner, input.before);
      const rows = await tx.query(
        `SELECT ${notificationColumns} FROM notifications WHERE owner_id=$1
       ${input.unreadOnly === 'true' ? 'AND read_at IS NULL' : ''}
       ${anchor ? 'AND (created_at,id)<($3::timestamptz,$4::uuid)' : ''}
       ORDER BY created_at DESC,id DESC LIMIT $2`,
        anchor
          ? [owner, input.limit + 1, anchor.timestamp, anchor.id]
          : [owner, input.limit + 1],
      );
      return notificationHistorySchema.parse({
        notifications: rows.slice(0, input.limit),
        nextBefore:
          rows.length > input.limit ? rows[input.limit - 1]!.id : null,
        unreadCount: await unreadCount(tx, owner),
      });
    }),
  );
  app.post('/api/v1/notifications/read', async (request) => {
    const owner = await auth.requireUser(request);
    const input = notificationsReadSchema.parse(request.body);
    return mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'notifications.read', input },
      async (tx) => {
        // Stable lock order; all requested IDs must belong to this owner before any write.
        const rows = await tx.query(
          'SELECT id FROM notifications WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
          [owner.id, input.notificationIds],
        );
        if (rows.length !== input.notificationIds.length)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'A notification is not available.',
          );
        const saved = await tx.query(
          `UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE owner_id=$1 AND id=ANY($2::uuid[]) RETURNING ${notificationColumns}`,
          [owner.id, input.notificationIds],
        );
        return notificationsReadResponseSchema.parse({
          notifications: input.notificationIds.map((id) =>
            saved.find((row) => row.id === id),
          ),
        });
      },
    );
  });
  app.post('/api/v1/reminders/:id/snooze', async (request) => {
    const owner = await auth.requireUser(request);
    const id = idOf(request.params);
    const input = reminderSnoozeSchema.parse(request.body);
    return mutateSchedule(
      database,
      owner.id,
      input.operationId,
      { kind: 'reminder.snooze', id, input },
      async (tx) => {
        const source = await active(tx, 'reminders', owner.id, id);
        version(source, input.expectedVersion);
        const scheduled = Date.parse(input.scheduledAt);
        const now = Date.now();
        if (scheduled <= now || scheduled > now + 365 * 86400000)
          throw new ApiError(
            400,
            'SNOOZE_TIME',
            'Choose a future time within 365 days.',
          );
        if (source.status !== 'delivered')
          throw new ApiError(
            409,
            'REMINDER_STATE',
            'Only delivered reminders can be snoozed.',
          );
        const [child] = await tx.query(
          'SELECT id FROM reminders WHERE owner_id=$1 AND snoozed_from_id=$2',
          [owner.id, id],
        );
        if (child)
          throw new ApiError(
            409,
            'REMINDER_ALREADY_SNOOZED',
            'This reminder has already been snoozed.',
          );
        if (!(await targetAvailable(tx, source)))
          throw new ApiError(
            409,
            'REMINDER_TARGET_UNAVAILABLE',
            'The reminder target is no longer active.',
          );
        const [notification] = await tx.query(
          `UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE owner_id=$1 AND reminder_id=$2 RETURNING ${notificationColumns}`,
          [owner.id, id],
        );
        if (!notification)
          throw new ApiError(
            409,
            'REMINDER_STATE',
            'The delivered notification is unavailable.',
          );
        const [reminder] = await tx.query(
          `INSERT INTO reminders(id,owner_id,title,scheduled_at,target_kind,target_id,occurrence_date,snoozed_from_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${reminderColumns}`,
          [
            randomUUID(),
            owner.id,
            source.title,
            input.scheduledAt,
            source.target_kind,
            source.target_id,
            source.occurrence_date,
            id,
          ],
        );
        const [sourceReminder] = await tx.query(
          `UPDATE reminders SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING ${reminderColumns}`,
          [owner.id, id],
        );
        return reminderSnoozeResponseSchema.parse({
          sourceReminder,
          reminder,
          notification,
        });
      },
    );
  });
}
