import {
  taskAgendaQuerySchema,
  todaySummaryQuerySchema,
  todaySummarySchema,
} from '@hub/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { ApiError } from '../errors.js';
import { stamp } from './common.js';
import { readTaskAgenda, readTaskDeadlineSummary } from './task-agenda.js';
import { readAcademicAgendaSummary } from './academic-agenda.js';
import { notificationColumns } from './reminders.js';

export function registerToday(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
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
  app.get('/api/v1/tasks/agenda', (request) =>
    snapshot(request, (tx, owner) =>
      readTaskAgenda(tx, owner, taskAgendaQuerySchema.parse(request.query)),
    ),
  );
  app.get('/api/v1/today/summary', (request) =>
    snapshot(request, async (tx, owner) => {
      const input = todaySummaryQuerySchema.parse(request.query);
      const generatedAt = new Date().toISOString();
      const tasks = await readTaskDeadlineSummary(tx, owner, input);
      const academicWork = await readAcademicAgendaSummary(tx, owner, input);
      const [counts] = await tx.query(
        `SELECT COUNT(*) FILTER(WHERE status='queued')::int AS "queuedCount",
       COUNT(*) FILTER(WHERE status='running')::int AS "runningCount",
       COUNT(*) FILTER(WHERE status='paused')::int AS "pausedCount",
       COUNT(*) FILTER(WHERE status='failed')::int AS "failedCount",
       COUNT(*) FILTER(WHERE status IN ('queued','running') AND scheduled_at<=$2::timestamptz)::int AS "dueCount"
       FROM reminders WHERE owner_id=$1`,
        [owner, generatedAt],
      );
      const [unread] = await tx.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM notifications WHERE owner_id=$1 AND read_at IS NULL',
        [owner],
      );
      const latestUnread = await tx.query(
        `SELECT ${notificationColumns} FROM notifications WHERE owner_id=$1 AND read_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 3`,
        [owner],
      );
      const [worker] = await tx.query(
        `SELECT ${stamp('last_tick', 'lastTick')},error_code AS "errorCode" FROM worker_state WHERE name='reminders'`,
      );
      const age = worker?.lastTick
        ? Date.parse(generatedAt) - Date.parse(String(worker.lastTick))
        : Infinity;
      return todaySummarySchema.parse({
        ...input,
        generatedAt,
        tasks,
        academicWork,
        reminders: {
          ...counts,
          unreadCount: unread!.count,
          latestUnread,
          worker: {
            lastTick: worker?.lastTick ?? null,
            errorCode: worker?.errorCode ?? null,
            healthy: Boolean(
              worker?.lastTick && !worker.errorCode && age >= 0 && age < 20000,
            ),
          },
        },
        warnings: [
          'MANUAL_ACADEMIC_RECORDS_ONLY',
          'SCHEDULE_NOT_INCLUDED',
          'IMPORTED_DEADLINES_NOT_INCLUDED',
        ],
      });
    }),
  );
}
