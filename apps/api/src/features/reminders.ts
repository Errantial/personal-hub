import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  reminderWriteSchema,
  reminderResponseSchema,
  remindersSchema,
  notificationsSchema,
  notificationResponseSchema,
  deleteItemSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutateSchedule as mutate } from '../planner/mutations.js';
import { lockSchedule } from '../planner/schedule-lock.js';
import { active, stamp, version } from './common.js';
import { readEvent, readExceptions, occurrenceExists } from './calendar.js';
import { expandEvent, Temporal } from '@hub/contracts';
import { ApiError } from '../errors.js';

export const reminderColumns = `id,title,snoozed_from_id AS "snoozedFromId",${stamp('scheduled_at', 'scheduledAt')},target_kind AS "targetKind",target_id AS "targetId",to_char(occurrence_date,'YYYY-MM-DD') AS "occurrenceDate",status,attempts,last_error AS "lastError",version,${stamp('created_at', 'createdAt')},${stamp('updated_at', 'updatedAt')}`;
export const notificationColumns = `id,reminder_id AS "reminderId",run_id AS "runId",conversation_id AS "conversationId",title,${stamp('created_at', 'createdAt')},${stamp('read_at', 'readAt')}`;
export async function targetAvailable(
  tx: QueryExecutor,
  job: Record<string, unknown>,
): Promise<boolean> {
  if (!job.target_kind) return true;
  if (job.target_kind === 'academic-work') {
    const [work] = await tx.query(
      `SELECT w.id FROM academic_work w JOIN courses c ON c.id=w.course_id AND c.owner_id=w.owner_id
       WHERE w.id=$1 AND w.owner_id=$2 AND w.deleted_at IS NULL AND c.deleted_at IS NULL AND w.status IN ('planned','in_progress')`,
      [job.target_id, job.owner_id],
    );
    return Boolean(work);
  }
  if (!['task', 'event'].includes(String(job.target_kind))) return false;
  const table = job.target_kind === 'task' ? 'tasks' : 'events';
  const [target] = await tx.query(
    `SELECT * FROM ${table} WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL`,
    [job.target_id, job.owner_id],
  );
  if (
    !target ||
    target.completed ||
    ['cancelled', 'completed'].includes(String(target.study_status))
  )
    return false;
  if (job.occurrence_date && table === 'events') {
    const date =
      job.occurrence_date instanceof Date
        ? job.occurrence_date.toISOString().slice(0, 10)
        : String(job.occurrence_date).slice(0, 10);
    const event = await readEvent(
      tx,
      String(job.owner_id),
      String(job.target_id),
    );
    const exceptions = await readExceptions(tx, event.id);
    const exception = exceptions.find((value) => value.originalDate === date);
    if (
      exception?.cancelled ||
      ['cancelled', 'completed'].includes(
        String(exception?.replacement?.studyStatus),
      )
    )
      return false;
    return (
      occurrenceExists(event, date) &&
      expandEvent(
        event,
        date,
        Temporal.PlainDate.from(date).add({ days: 1 }).toString(),
        event.timeZone,
      ).length > 0
    );
  }
  return true;
}

// Claim and delivery are separate transactions. Expired leases can be reclaimed;
// delivery receipt + terminal status commit together, with no external side effect.
export async function runReminderBatch(
  database: Database,
  now = new Date(),
  beforeDelivery?: () => Promise<void>,
) {
  let processed = 0;
  for (let i = 0; i < 20; i++) {
    const token = randomUUID();
    const job = await database.transaction(async (tx) => {
      const [row] = await tx.query<
        Record<string, unknown> & {
          id: string;
          owner_id: string;
          title: string;
          attempts: number;
        }
      >(
        `SELECT * FROM reminders WHERE scheduled_at <= $1 AND next_attempt_at <= $1 AND (status='queued' OR (status='running' AND lease_until <= $1)) ORDER BY scheduled_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [now],
      );
      if (!row) return null;
      if (Number(row.attempts) >= 3) {
        await tx.query(
          "UPDATE reminders SET status='failed',last_error='LEASE_EXPIRED',lease_token=NULL,lease_until=NULL,version=version+1,updated_at=$2 WHERE id=$1",
          [row.id, now],
        );
        return { ...row, exhausted: true };
      }
      await tx.query(
        "UPDATE reminders SET status='running',attempts=attempts+1,lease_token=$2,lease_until=$3,version=version+1,updated_at=$4 WHERE id=$1",
        [row.id, token, new Date(now.getTime() + 30000), now],
      );
      return { ...row, attempts: Number(row.attempts) + 1, exhausted: false };
    });
    if (!job) break;
    processed++;
    if (job.exhausted) continue;
    try {
      await beforeDelivery?.();
      await database.transaction(async (tx) => {
        await lockSchedule(tx, job.owner_id);
        const [current] = await tx.query(
          "SELECT * FROM reminders WHERE id=$1 AND lease_token=$2 AND status='running' FOR UPDATE",
          [job.id, token],
        );
        if (!current) return;
        if (!(await targetAvailable(tx, current))) {
          await tx.query(
            "UPDATE reminders SET status='cancelled',lease_token=NULL,lease_until=NULL,version=version+1,updated_at=$2 WHERE id=$1",
            [job.id, now],
          );
          return;
        }
        await tx.query(
          'INSERT INTO notifications (id,reminder_id,owner_id,title,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (reminder_id) DO NOTHING',
          [randomUUID(), job.id, job.owner_id, job.title, now],
        );
        await tx.query(
          "UPDATE reminders SET status='delivered',last_error=NULL,lease_token=NULL,lease_until=NULL,version=version+1,updated_at=$2 WHERE id=$1",
          [job.id, now],
        );
      });
    } catch {
      await database.query(
        "UPDATE reminders SET status=$3,last_error='DELIVERY_FAILED',lease_token=NULL,lease_until=NULL,next_attempt_at=$4,version=version+1,updated_at=$5 WHERE id=$1 AND lease_token=$2 AND status='running'",
        [
          job.id,
          token,
          job.attempts >= 3 ? 'failed' : 'queued',
          new Date(now.getTime() + 5000 * 2 ** job.attempts),
          now,
        ],
      );
    }
  }
  await database.query(
    "INSERT INTO worker_state (name,last_tick,error_code) VALUES ('reminders',$1,NULL) ON CONFLICT (name) DO UPDATE SET last_tick=EXCLUDED.last_tick,error_code=NULL",
    [now],
  );
  return processed;
}
export function startReminderWorker(database: Database) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  async function tick() {
    try {
      await runReminderBatch(database);
    } catch {
      await database
        .query(
          "INSERT INTO worker_state (name,last_tick,error_code) VALUES ('reminders',CURRENT_TIMESTAMP,'WORKER_FAILED') ON CONFLICT (name) DO UPDATE SET error_code='WORKER_FAILED'",
        )
        .catch(() => undefined);
    }
    if (!stopped)
      timer = setTimeout(() => {
        running = tick();
      }, 5000);
  }
  running = tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
export function registerReminders(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.get('/api/v1/reminders', async (request) => {
    const user = await auth.requireUser(request);
    const [worker] = await database.query(
      `SELECT ${stamp('last_tick', 'lastTick')},error_code AS "errorCode" FROM worker_state WHERE name='reminders'`,
    );
    return remindersSchema.parse({
      reminders: await database.query(
        `SELECT ${reminderColumns} FROM reminders WHERE owner_id=$1 ORDER BY scheduled_at DESC,id`,
        [user.id],
      ),
      worker: {
        lastTick: worker?.lastTick ?? null,
        errorCode: worker?.errorCode ?? null,
        healthy: Boolean(
          worker?.lastTick &&
          !worker.errorCode &&
          Date.now() - Date.parse(String(worker.lastTick)) < 20000,
        ),
      },
    });
  });
  for (const method of ['POST', 'PUT'] as const)
    app.route({
      method,
      url: `/api/v1/reminders${method === 'PUT' ? '/:id' : ''}`,
      handler: async (request) => {
        const user = await auth.requireUser(request);
        const input = reminderWriteSchema.parse(request.body);
        const id =
          method === 'PUT'
            ? z.object({ id: z.string().uuid() }).parse(request.params).id
            : randomUUID();
        return mutate(
          database,
          user.id,
          input.operationId,
          { method, id: method === 'PUT' ? id : null, input },
          async (tx) => {
            if (method === 'PUT') {
              const current = await active(tx, 'reminders', user.id, id);
              version(current, input.expectedVersion);
              if (
                !['queued', 'paused', 'failed'].includes(String(current.status))
              )
                throw new ApiError(
                  409,
                  'REMINDER_STATE',
                  'This reminder cannot be rescheduled.',
                );
            }
            if (input.targetId && input.targetKind) {
              if (input.targetKind === 'academic-work') {
                const [work] = await tx.query(
                  'SELECT id FROM academic_work WHERE owner_id=$1 AND id=$2',
                  [user.id, input.targetId],
                );
                if (!work)
                  throw new ApiError(
                    404,
                    'NOT_FOUND',
                    'Academic work not available.',
                  );
                if (
                  !(await targetAvailable(tx, {
                    owner_id: user.id,
                    target_kind: input.targetKind,
                    target_id: input.targetId,
                  }))
                )
                  throw new ApiError(
                    409,
                    'TARGET_UNAVAILABLE',
                    'The academic work is closed, deleted or its class is archived.',
                  );
              } else {
                await active(
                  tx,
                  input.targetKind === 'task' ? 'tasks' : 'events',
                  user.id,
                  input.targetId,
                );
              }
              if (
                input.occurrenceDate &&
                !occurrenceExists(
                  await readEvent(tx, user.id, input.targetId),
                  input.occurrenceDate,
                )
              )
                throw new ApiError(
                  400,
                  'INVALID_INPUT',
                  'Select an existing occurrence.',
                );
            }
            const values = [
              id,
              user.id,
              input.title,
              input.scheduledAt,
              input.targetKind,
              input.targetId,
              input.occurrenceDate,
            ];
            const [row] =
              method === 'POST'
                ? await tx.query(
                    `INSERT INTO reminders (id,owner_id,title,scheduled_at,target_kind,target_id,occurrence_date) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${reminderColumns}`,
                    values,
                  )
                : await tx.query(
                    `UPDATE reminders SET title=$3,scheduled_at=$4,target_kind=$5,target_id=$6,occurrence_date=$7,status='queued',attempts=0,last_error=NULL,next_attempt_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_id=$2 RETURNING ${reminderColumns}`,
                    values,
                  );
            return reminderResponseSchema.parse({ reminder: row });
          },
        );
      },
    });
  app.post('/api/v1/reminders/:id/control', async (request) => {
    const user = await auth.requireUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = deleteItemSchema
      .extend({ action: z.enum(['pause', 'resume', 'retry', 'cancel']) })
      .parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { id, input },
      async (tx) => {
        const row = await active(tx, 'reminders', user.id, id);
        version(row, input.expectedVersion);
        const allowed: Record<string, string[]> = {
          pause: ['queued', 'running'],
          resume: ['paused'],
          retry: ['failed'],
          cancel: ['queued', 'running', 'paused', 'failed'],
        };
        if (!allowed[input.action]!.includes(String(row.status)))
          throw new ApiError(
            409,
            'REMINDER_STATE',
            'This control is not available for the current status.',
          );
        if (
          row.target_kind === 'academic-work' &&
          ['resume', 'retry'].includes(input.action) &&
          !(await targetAvailable(tx, row))
        )
          throw new ApiError(
            409,
            'TARGET_UNAVAILABLE',
            'The academic work is closed, deleted or its class is archived.',
          );
        const status =
          input.action === 'pause'
            ? 'paused'
            : input.action === 'cancel'
              ? 'cancelled'
              : 'queued';
        const [saved] = await tx.query(
          `UPDATE reminders SET status=$3,attempts=CASE WHEN $4 THEN 0 ELSE attempts END,last_error=NULL,lease_token=NULL,lease_until=NULL,next_attempt_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_id=$2 RETURNING ${reminderColumns}`,
          [id, user.id, status, input.action === 'retry'],
        );
        return reminderResponseSchema.parse({ reminder: saved });
      },
    );
  });
  app.get('/api/v1/notifications', async (request) => {
    const user = await auth.requireUser(request);
    return notificationsSchema.parse({
      notifications: await database.query(
        `SELECT ${notificationColumns} FROM notifications WHERE owner_id=$1 ORDER BY created_at DESC,id LIMIT 200`,
        [user.id],
      ),
    });
  });
  app.post('/api/v1/notifications/:id/read', async (request) => {
    const user = await auth.requireUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z
      .strictObject({ operationId: z.string().uuid() })
      .parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'notification.read', id },
      async (tx) => {
        const [row] = await tx.query(
          `UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE owner_id=$1 AND id=$2 RETURNING ${notificationColumns}`,
          [user.id, id],
        );
        if (!row)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'This notification is no longer available.',
          );
        return notificationResponseSchema.parse({ notification: row });
      },
    );
  });
}
