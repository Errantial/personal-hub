import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  responsibilitySchema,
  responsibilityResponseSchema,
  responsibilityMutationResponseSchema,
  createResponsibilitySchema,
  updateResponsibilitySchema,
  responsibilityMutationSchema,
  responsibilityPageQuerySchema,
  responsibilityPageSchema,
  responsibilityScheduleSchema,
  responsibilityScheduleResponseSchema,
  responsibilityScheduleWriteSchema,
  responsibilityDueQuerySchema,
  responsibilityDuePageSchema,
  responsibilityDueAdmissionSchema,
  responsibilityDueAdmissionResponseSchema,
  responsibilityRunSchema,
  responsibilityRunResponseSchema,
  responsibilityHistoryQuerySchema,
  responsibilityRunPageSchema,
  responsibilityActivitySchema,
  responsibilityActivityPageQuerySchema,
  responsibilityActivityPageSchema,
  responsibilityLocalScheduleWriteSchema,
} from '@hub/contracts';
import type { Responsibility, ResponsibilityRun } from '@hub/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutate } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import { stamp, version } from './common.js';
import {
  localReviewSlot,
  advanceLocalReview,
} from './responsibility-local-cadence.js';

const ids = z.object({ id: z.string().uuid() });
const runIds = ids.extend({ runId: z.string().uuid() });
export const responsibilityColumns = `id,version,title,goal,source,sensitivity,labels,status,${stamp('created_at', 'createdAt')},${stamp('updated_at', 'updatedAt')},${stamp('deleted_at', 'deletedAt')}`;
const scheduleColumns = `responsibility_id AS "responsibilityId",version,${stamp('starts_at', 'startsAt')},interval_minutes AS "intervalMinutes",${stamp('next_due_at', 'nextDueAt')},${stamp('updated_at', 'updatedAt')},${stamp('deleted_at', 'deletedAt')},local_rule AS "localRule",next_local_index AS "nextLocalIndex"`;
const runColumns = `id,responsibility_id AS "responsibilityId",responsibility_version AS "responsibilityVersion",version,trigger,${stamp('scheduled_for', 'scheduledFor')},schedule_version AS "scheduleVersion",skipped_intervals AS "skippedIntervals",input_hash AS "inputHash",labels,status,cancel_reason AS "cancelReason",${stamp('created_at', 'createdAt')},${stamp('cancelled_at', 'cancelledAt')}`;
const activityColumns = `id,responsibility_id AS "responsibilityId",responsibility_version AS "responsibilityVersion",kind,run_id AS "runId",${stamp('created_at', 'createdAt')}`;
export {
  read as readResponsibility,
  activity as appendResponsibilityActivity,
  runColumns as responsibilityRunColumns,
};
async function read(
  tx: QueryExecutor,
  owner: string,
  id: string,
  lock = false,
) {
  const [row] = await tx.query(
    `SELECT ${responsibilityColumns} FROM responsibilities WHERE owner_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
    [owner, id],
  );
  if (!row)
    throw new ApiError(404, 'NOT_FOUND', 'Responsibility is unavailable.');
  return responsibilitySchema.parse(row);
}
function available(value: Responsibility) {
  if (value.deletedAt || value.status === 'cancelled')
    throw new ApiError(
      409,
      'RESPONSIBILITY_STATE',
      'This responsibility is closed.',
    );
}
function active(value: Responsibility) {
  available(value);
  if (value.status !== 'active')
    throw new ApiError(
      409,
      'RESPONSIBILITY_PAUSED',
      'Resume before requesting a run.',
    );
}
function receipt(value: Responsibility) {
  return responsibilityMutationResponseSchema.parse({ responsibility: value });
}
async function schedule(tx: QueryExecutor, owner: string, id: string) {
  const [row] = await tx.query(
    `SELECT ${scheduleColumns} FROM responsibility_schedules WHERE owner_id=$1 AND responsibility_id=$2`,
    [owner, id],
  );
  return row ? responsibilityScheduleSchema.parse(row) : null;
}
async function activity(
  tx: QueryExecutor,
  owner: string,
  value: Responsibility,
  kind: z.infer<typeof responsibilityActivitySchema>['kind'],
  runId: string | null = null,
) {
  await tx.query(
    'INSERT INTO responsibility_activities(id,owner_id,responsibility_id,responsibility_version,kind,run_id) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), owner, value.id, value.version, kind, runId],
  );
}
async function cancelRuns(
  tx: QueryExecutor,
  owner: string,
  value: Responsibility,
  reason: ResponsibilityRun['cancelReason'],
) {
  const rows = await tx.query(
    "UPDATE responsibility_runs SET status='cancelled',cancel_reason=$3,cancelled_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND responsibility_id=$2 AND status='blocked' RETURNING id",
    [owner, value.id, reason],
  );
  if (rows.length) await activity(tx, owner, value, 'runs-cancelled');
}
async function newRun(
  tx: QueryExecutor,
  owner: string,
  value: Responsibility,
  planned: {
    scheduledFor: string;
    scheduleVersion: number;
    skippedIntervals: number;
  } | null,
) {
  if (planned) {
    const [existing] = await tx.query(
      'SELECT id FROM responsibility_runs WHERE owner_id=$1 AND responsibility_id=$2 AND scheduled_for=$3::timestamptz',
      [owner, value.id, planned.scheduledFor],
    );
    if (existing)
      throw new ApiError(
        409,
        'DUE_ALREADY_ADMITTED',
        'This schedule slot already has a run. Choose a new start time.',
      );
  }
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        id: value.id,
        version: value.version,
        title: value.title,
        goal: value.goal,
        labels: value.labels,
        sensitivity: value.sensitivity,
      }),
    )
    .digest('hex');
  const [row] = await tx.query(
    `INSERT INTO responsibility_runs(id,owner_id,responsibility_id,responsibility_version,trigger,scheduled_for,schedule_version,skipped_intervals,input_hash,labels) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${runColumns}`,
    [
      randomUUID(),
      owner,
      value.id,
      value.version,
      planned ? 'schedule' : 'manual',
      planned?.scheduledFor ?? null,
      planned?.scheduleVersion ?? null,
      planned?.skippedIntervals ?? 0,
      hash,
      value.labels,
    ],
  );
  const run = responsibilityRunSchema.parse(row);
  await activity(tx, owner, value, 'run-created', run.id);
  return run;
}
export async function exportResponsibilities(tx: QueryExecutor, owner: string) {
  const rows = (table: string, columns: string) =>
    tx.query(
      `SELECT ${columns} FROM ${table} WHERE owner_id=$1 ORDER BY ${table === 'responsibility_schedules' ? 'responsibility_id' : 'id'} LIMIT 10001`,
      [owner],
    );
  return {
    responsibilities: (
      await rows('responsibilities', responsibilityColumns)
    ).map((row) => responsibilitySchema.parse(row)),
    responsibilitySchedules: (
      await rows('responsibility_schedules', scheduleColumns)
    ).map((row) => responsibilityScheduleSchema.parse(row)),
    responsibilityRuns: (await rows('responsibility_runs', runColumns)).map(
      (row) => responsibilityRunSchema.parse(row),
    ),
    responsibilityActivities: (
      await rows('responsibility_activities', activityColumns)
    ).map((row) => responsibilityActivitySchema.parse(row)),
  };
}
export function registerResponsibilities(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/responsibilities';
  async function snapshot<T>(
    request: FastifyRequest,
    work: (tx: QueryExecutor, owner: string) => Promise<T>,
  ) {
    const user = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      return work(tx, user.id);
    });
  }
  app.get(base, (request) =>
    snapshot(request, async (tx, owner) => {
      const input = responsibilityPageQuerySchema.parse(request.query);
      const eligible = `owner_id=$1 AND ($2::text='all' OR status=$2) AND ($3::text='all' OR (deleted_at IS NOT NULL)=($3='true'))`;
      if (input.after) {
        const [anchor] = await tx.query(
          `SELECT version FROM responsibilities WHERE ${eligible} AND id=$4`,
          [owner, input.status, input.deleted, input.after],
        );
        if (!anchor)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Responsibility cursor is unavailable.',
          );
        version(anchor, input.expectedCursorVersion);
      }
      const rows = await tx.query(
        `SELECT ${responsibilityColumns} FROM responsibilities WHERE ${eligible} AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`,
        [
          owner,
          input.status,
          input.deleted,
          input.after ?? null,
          input.limit + 1,
        ],
      );
      const last = rows[input.limit - 1];
      return responsibilityPageSchema.parse({
        responsibilities: rows
          .slice(0, input.limit)
          .map((row) => responsibilitySchema.parse(row)),
        nextAfter:
          rows.length > input.limit && last
            ? { id: last.id, version: last.version }
            : null,
      });
    }),
  );
  app.get(`${base}/due`, (request) =>
    snapshot(request, async (tx, owner) => {
      const input = responsibilityDueQuerySchema.parse(request.query);
      const now = new Date().toISOString();
      const eligible = `r.owner_id=$1 AND r.status='active' AND r.deleted_at IS NULL AND s.deleted_at IS NULL AND s.next_due_at<=$2::timestamptz`;
      const joined =
        'responsibilities r JOIN responsibility_schedules s ON s.owner_id=r.owner_id AND s.responsibility_id=r.id';
      if (input.after) {
        const [anchor] = await tx.query(
          `SELECT r.version,s.version AS "scheduleVersion" FROM ${joined} WHERE ${eligible} AND r.id=$3`,
          [owner, now, input.after],
        );
        if (!anchor)
          throw new ApiError(404, 'NOT_FOUND', 'Due cursor is unavailable.');
        version(anchor, input.expectedCursorVersion);
        if (anchor.scheduleVersion !== input.expectedScheduleVersion)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload the due schedule.',
          );
      }
      const [count] = await tx.query(
        `SELECT count(*)::int AS count FROM ${joined} WHERE ${eligible}`,
        [owner, now],
      );
      const rows = await tx.query(
        `SELECT r.id,r.version,r.title,s.version AS "scheduleVersion",${stamp('s.next_due_at', 'nextDueAt')} FROM ${joined} WHERE ${eligible} AND ($3::uuid IS NULL OR r.id>$3) ORDER BY r.id LIMIT $4`,
        [owner, now, input.after ?? null, input.limit + 1],
      );
      const last = rows[input.limit - 1];
      return responsibilityDuePageSchema.parse({
        asOf: now,
        dueCount: count!.count,
        items: rows.slice(0, input.limit),
        nextAfter:
          rows.length > input.limit && last
            ? {
                id: last.id,
                version: last.version,
                scheduleVersion: last.scheduleVersion,
              }
            : null,
        executionEnabled: false,
      });
    }),
  );
  app.get(`${base}/:id`, (request) =>
    snapshot(request, async (tx, owner) =>
      responsibilityResponseSchema.parse({
        responsibility: await read(tx, owner, ids.parse(request.params).id),
      }),
    ),
  );
  app.post(base, async (request) => {
    const user = await auth.requireUser(request);
    const input = createResponsibilitySchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'responsibility.create', input },
      async (tx) => {
        const [row] = await tx.query(
          `INSERT INTO responsibilities(id,owner_id,title,goal,sensitivity,labels) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${responsibilityColumns}`,
          [
            randomUUID(),
            user.id,
            input.title,
            input.goal,
            input.sensitivity,
            [input.sensitivity],
          ],
        );
        const value = responsibilitySchema.parse(row);
        await activity(tx, user.id, value, 'created');
        return receipt(value);
      },
    );
  });
  app.put(`${base}/:id`, async (request) => {
    const user = await auth.requireUser(request);
    const { id } = ids.parse(request.params);
    const input = updateResponsibilitySchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'responsibility.update', id, input },
      async (tx) => {
        const before = await read(tx, user.id, id, true);
        version(before, input.expectedVersion);
        available(before);
        const [row] = await tx.query(
          `UPDATE responsibilities SET title=$3,goal=$4,sensitivity=$5,labels=$6,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING ${responsibilityColumns}`,
          [
            user.id,
            id,
            input.title,
            input.goal,
            input.sensitivity,
            [...new Set([...before.labels, input.sensitivity])],
          ],
        );
        const value = responsibilitySchema.parse(row);
        await cancelRuns(tx, user.id, value, 'source-changed');
        await activity(tx, user.id, value, 'updated');
        return receipt(value);
      },
    );
  });
  for (const action of ['resume', 'pause', 'cancel', 'delete'] as const) {
    app.route({
      method: action === 'delete' ? 'DELETE' : 'POST',
      url: `${base}/:id${action === 'delete' ? '' : `/${action}`}`,
      handler: async (request) => {
        const user = await auth.requireUser(request);
        const { id } = ids.parse(request.params);
        const input = responsibilityMutationSchema.parse(request.body);
        return mutate(
          database,
          user.id,
          input.operationId,
          { kind: `responsibility.${action}`, id, input },
          async (tx) => {
            const before = await read(tx, user.id, id, true);
            version(before, input.expectedVersion);
            if (
              before.deletedAt ||
              (action !== 'delete' && before.status === 'cancelled') ||
              (action === 'resume' && before.status !== 'paused') ||
              (action === 'pause' && before.status !== 'active')
            )
              throw new ApiError(
                409,
                'RESPONSIBILITY_STATE',
                'Reload before changing responsibility state.',
              );
            const status =
              action === 'resume'
                ? 'active'
                : action === 'pause'
                  ? 'paused'
                  : 'cancelled';
            const [row] = await tx.query(
              `UPDATE responsibilities SET status=$3,deleted_at=${action === 'delete' ? 'CURRENT_TIMESTAMP' : 'deleted_at'},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING ${responsibilityColumns}`,
              [user.id, id, status],
            );
            const value = responsibilitySchema.parse(row);
            if (action !== 'resume')
              await cancelRuns(
                tx,
                user.id,
                value,
                action === 'pause'
                  ? 'responsibility-paused'
                  : action === 'delete'
                    ? 'responsibility-deleted'
                    : 'responsibility-cancelled',
              );
            await activity(
              tx,
              user.id,
              value,
              action === 'resume'
                ? 'resumed'
                : action === 'pause'
                  ? 'paused'
                  : action === 'cancel'
                    ? 'cancelled'
                    : 'deleted',
            );
            return receipt(value);
          },
        );
      },
    });
  }
  app.get(`${base}/:id/schedule`, (request) =>
    snapshot(request, async (tx, owner) => {
      const { id } = ids.parse(request.params);
      await read(tx, owner, id);
      return responsibilityScheduleResponseSchema.parse({
        schedule: await schedule(tx, owner, id),
      });
    }),
  );
  app.put(`${base}/:id/schedule`, async (request) => {
    const user = await auth.requireUser(request);
    const { id } = ids.parse(request.params);
    const input = responsibilityScheduleWriteSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'responsibility.schedule', id, input },
      async (tx) => {
        const before = await read(tx, user.id, id, true);
        version(before, input.expectedVersion);
        available(before);
        if (input.schedule) {
          await tx.query(
            `INSERT INTO responsibility_schedules(owner_id,responsibility_id,starts_at,interval_minutes,next_due_at) VALUES($1,$2,$3,$4,$3) ON CONFLICT(owner_id,responsibility_id) DO UPDATE SET starts_at=$3,interval_minutes=$4,next_due_at=$3,local_rule=NULL,next_local_index=NULL,deleted_at=NULL,version=responsibility_schedules.version+1,updated_at=CURRENT_TIMESTAMP`,
            [
              user.id,
              id,
              input.schedule.startsAt,
              input.schedule.intervalMinutes,
            ],
          );
        } else {
          const existing = await schedule(tx, user.id, id);
          if (!existing || existing.deletedAt)
            throw new ApiError(
              409,
              'SCHEDULE_STATE',
              'There is no active schedule to clear.',
            );
          await tx.query(
            'UPDATE responsibility_schedules SET next_due_at=NULL,next_local_index=NULL,deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND responsibility_id=$2',
            [user.id, id],
          );
        }
        const [row] = await tx.query(
          `UPDATE responsibilities SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING ${responsibilityColumns}`,
          [user.id, id],
        );
        const value = responsibilitySchema.parse(row);
        await cancelRuns(tx, user.id, value, 'schedule-changed');
        await activity(
          tx,
          user.id,
          value,
          input.schedule ? 'schedule-set' : 'schedule-cleared',
        );
        return { ...receipt(value), schedule: await schedule(tx, user.id, id) };
      },
    );
  });
  app.put(`${base}/:id/local-schedule`, async (request) => {
    const user = await auth.requireUser(request);
    const { id } = ids.parse(request.params);
    const input = responsibilityLocalScheduleWriteSchema.parse(request.body);
    const first = localReviewSlot(input.rule, 0);
    if (first === null)
      throw new ApiError(
        400,
        'LOCAL_SCHEDULE_RANGE',
        'Choose a supported local start date.',
      );
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'responsibility.local-schedule', id, input },
      async (tx) => {
        const before = await read(tx, user.id, id, true);
        version(before, input.expectedVersion);
        available(before);
        await tx.query(
          `INSERT INTO responsibility_schedules(owner_id,responsibility_id,starts_at,interval_minutes,next_due_at,local_rule,next_local_index) VALUES($1,$2,$3,NULL,$3,$4::jsonb,0) ON CONFLICT(owner_id,responsibility_id) DO UPDATE SET starts_at=$3,interval_minutes=NULL,next_due_at=$3,local_rule=$4::jsonb,next_local_index=0,deleted_at=NULL,version=responsibility_schedules.version+1,updated_at=CURRENT_TIMESTAMP`,
          [user.id, id, first, JSON.stringify(input.rule)],
        );
        const [row] = await tx.query(
          `UPDATE responsibilities SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING ${responsibilityColumns}`,
          [user.id, id],
        );
        const value = responsibilitySchema.parse(row);
        await cancelRuns(tx, user.id, value, 'schedule-changed');
        await activity(tx, user.id, value, 'schedule-set');
        return { ...receipt(value), schedule: await schedule(tx, user.id, id) };
      },
    );
  });
  app.post(`${base}/admit-due`, async (request) => {
    const user = await auth.requireUser(request);
    const input = responsibilityDueAdmissionSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'responsibility.admit-due', input },
      async (tx) => {
        const runs: ResponsibilityRun[] = [];
        // UUID lock order prevents selected batches from deadlocking each other.
        // Capture server time after locks; client clocks never authorize admission.
        const selected = [];
        for (const item of [...input.items].sort((a, b) =>
          a.id.toLowerCase().localeCompare(b.id.toLowerCase()),
        )) {
          const value = await read(tx, user.id, item.id, true);
          version(value, item.expectedVersion);
          active(value);
          selected.push({ item, value });
        }
        const now = Date.now();
        for (const { item, value } of selected) {
          const saved = await schedule(tx, user.id, value.id);
          if (!saved || saved.deletedAt || !saved.nextDueAt)
            throw new ApiError(409, 'SCHEDULE_STATE', 'No pending schedule.');
          version(saved, item.expectedScheduleVersion);
          const due = Date.parse(saved.nextDueAt);
          if (due > now)
            throw new ApiError(409, 'NOT_DUE', 'This review is not due.');
          const interval =
            saved.intervalMinutes === null
              ? null
              : saved.intervalMinutes * 60000;
          let skipped =
            interval === null ? 0 : Math.floor((now - due) / interval);
          if (skipped > 2147483647)
            throw new ApiError(
              409,
              'SCHEDULE_RANGE',
              'Choose a more recent schedule start.',
            );
          let next =
            interval === null
              ? null
              : new Date(due + (skipped + 1) * interval).toISOString();
          let nextLocalIndex: number | null = null;
          if (saved.localRule !== null) {
            if (saved.nextLocalIndex === null)
              throw new ApiError(
                409,
                'LOCAL_SCHEDULE_UNAVAILABLE',
                'Local schedule position is unavailable.',
              );
            const advanced = advanceLocalReview(
              saved.localRule,
              saved.nextLocalIndex,
              saved.nextDueAt,
              now,
            );
            next = advanced.next;
            nextLocalIndex = advanced.nextLocalIndex;
            skipped = advanced.skippedIntervals;
          }
          runs.push(
            await newRun(tx, user.id, value, {
              scheduledFor: saved.nextDueAt,
              scheduleVersion: saved.version,
              skippedIntervals: skipped,
            }),
          );
          await tx.query(
            'UPDATE responsibility_schedules SET next_due_at=$3,next_local_index=$4,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND responsibility_id=$2',
            [user.id, value.id, next, nextLocalIndex],
          );
        }
        return responsibilityDueAdmissionResponseSchema.parse({
          runs,
          executionEnabled: false,
        });
      },
    );
  });
  app.post(`${base}/:id/runs`, async (request) => {
    const user = await auth.requireUser(request);
    const { id } = ids.parse(request.params);
    const input = responsibilityMutationSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'responsibility.run.manual', id, input },
      async (tx) => {
        const value = await read(tx, user.id, id, true);
        version(value, input.expectedVersion);
        active(value);
        return responsibilityRunResponseSchema.parse({
          run: await newRun(tx, user.id, value, null),
          executionEnabled: false,
        });
      },
    );
  });
  app.get(`${base}/:id/runs`, (request) =>
    snapshot(request, async (tx, owner) => {
      const { id } = ids.parse(request.params);
      await read(tx, owner, id);
      const input = responsibilityHistoryQuerySchema.parse(request.query);
      if (input.after) {
        const [anchor] = await tx.query(
          'SELECT version FROM responsibility_runs WHERE owner_id=$1 AND responsibility_id=$2 AND id=$3',
          [owner, id, input.after],
        );
        if (!anchor)
          throw new ApiError(404, 'NOT_FOUND', 'Run cursor is unavailable.');
        version(anchor, input.expectedCursorVersion);
      }
      const rows = await tx.query(
        `SELECT ${runColumns} FROM responsibility_runs WHERE owner_id=$1 AND responsibility_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
        [owner, id, input.after ?? null, input.limit + 1],
      );
      const last = rows[input.limit - 1];
      return responsibilityRunPageSchema.parse({
        runs: rows.slice(0, input.limit),
        nextAfter:
          rows.length > input.limit && last
            ? { id: last.id, version: last.version }
            : null,
        executionEnabled: false,
      });
    }),
  );
  app.get(`${base}/:id/runs/:runId`, (request) =>
    snapshot(request, async (tx, owner) => {
      const { id, runId } = runIds.parse(request.params);
      const [row] = await tx.query(
        `SELECT ${runColumns} FROM responsibility_runs WHERE owner_id=$1 AND responsibility_id=$2 AND id=$3`,
        [owner, id, runId],
      );
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Run is unavailable.');
      return responsibilityRunResponseSchema.parse({
        run: row,
        executionEnabled: false,
      });
    }),
  );
  app.post(`${base}/:id/runs/:runId/dismiss`, async (request) => {
    const user = await auth.requireUser(request);
    const { id, runId } = runIds.parse(request.params);
    const input = responsibilityMutationSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'responsibility.run.dismiss', id, runId, input },
      async (tx) => {
        const value = await read(tx, user.id, id, true);
        const [row] = await tx.query(
          'SELECT version,status FROM responsibility_runs WHERE owner_id=$1 AND responsibility_id=$2 AND id=$3 FOR UPDATE',
          [user.id, id, runId],
        );
        if (!row) throw new ApiError(404, 'NOT_FOUND', 'Run is unavailable.');
        version(row, input.expectedVersion);
        if (row.status !== 'blocked')
          throw new ApiError(
            409,
            'RUN_STATE',
            'This run was already cancelled.',
          );
        const [after] = await tx.query(
          `UPDATE responsibility_runs SET status='cancelled',cancel_reason='owner-dismissed',cancelled_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING ${runColumns}`,
          [user.id, runId],
        );
        await activity(tx, user.id, value, 'run-dismissed', runId);
        return responsibilityRunResponseSchema.parse({
          run: after,
          executionEnabled: false,
        });
      },
    );
  });
  app.get(`${base}/:id/activity`, (request) =>
    snapshot(request, async (tx, owner) => {
      const { id } = ids.parse(request.params);
      await read(tx, owner, id);
      const input = responsibilityActivityPageQuerySchema.parse(request.query);
      if (input.after) {
        const [anchor] = await tx.query(
          'SELECT id FROM responsibility_activities WHERE owner_id=$1 AND responsibility_id=$2 AND id=$3',
          [owner, id, input.after],
        );
        if (!anchor)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Activity cursor is unavailable.',
          );
      }
      const rows = await tx.query(
        `SELECT ${activityColumns} FROM responsibility_activities WHERE owner_id=$1 AND responsibility_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
        [owner, id, input.after ?? null, input.limit + 1],
      );
      return responsibilityActivityPageSchema.parse({
        activities: rows.slice(0, input.limit),
        nextAfter: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
      });
    }),
  );
}
