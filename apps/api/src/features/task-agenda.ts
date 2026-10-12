import {
  taskAgendaResponseSchema,
  taskDeadlineSummarySchema,
} from '@hub/contracts';
import type { TaskAgendaQuery, TaskDeadlineRange } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { taskColumns } from '../planner/routes.js';
import { ApiError } from '../errors.js';
import { version } from './common.js';

const eligible =
  'tasks.owner_id=$1 AND tasks.deleted_at IS NULL AND NOT tasks.completed';
const bucket = `CASE WHEN tasks.due_date IS NULL THEN 'undated' WHEN tasks.due_date<$2::date THEN 'overdue'
 WHEN tasks.due_date=$2::date THEN 'today' WHEN tasks.due_date<$3::date THEN 'upcoming' ELSE 'later' END`;
export async function readTaskDeadlineSummary(
  tx: QueryExecutor,
  owner: string,
  input: TaskDeadlineRange,
) {
  const [summary] = await tx.query(
    `SELECT COUNT(*)::int AS "openCount",
     COUNT(*) FILTER(WHERE tasks.due_date<$2::date)::int AS "overdueCount",
     COUNT(*) FILTER(WHERE tasks.due_date=$2::date)::int AS "todayCount",
     COUNT(*) FILTER(WHERE tasks.due_date>$2::date AND tasks.due_date<$3::date)::int AS "upcomingCount",
     COUNT(*) FILTER(WHERE tasks.due_date>=$3::date)::int AS "laterCount",
     COUNT(*) FILTER(WHERE tasks.due_date IS NULL)::int AS "undatedCount"
     FROM tasks WHERE ${eligible}`,
    [owner, input.asOf, input.to],
  );
  return taskDeadlineSummarySchema.parse(summary);
}
export async function readTaskAgenda(
  tx: QueryExecutor,
  owner: string,
  input: TaskAgendaQuery,
) {
  const values = [owner, input.asOf, input.to, input.bucket];
  const selected = `${eligible} AND ($4::text='all' OR (${bucket})=$4)`;
  const anchor = input.after
    ? (
        await tx.query<{ id: string; version: number; dueDate: string | null }>(
          `SELECT id,version,to_char(due_date,'YYYY-MM-DD') AS "dueDate" FROM tasks WHERE ${selected} AND id=$5`,
          [...values, input.after],
        )
      )[0]
    : null;
  if (input.after && !anchor)
    throw new ApiError(
      404,
      'NOT_FOUND',
      'Task agenda cursor no longer available.',
    );
  if (anchor) version(anchor, input.expectedCursorVersion);
  const summary = await readTaskDeadlineSummary(tx, owner, input);
  const rows = await tx.query(
    `SELECT ${taskColumns},(${bucket}) AS bucket FROM tasks WHERE ${selected}
     ${anchor ? "AND (COALESCE(due_date,'infinity'::date),id)>(COALESCE($6::date,'infinity'::date),$7::uuid)" : ''}
     ORDER BY due_date ASC NULLS LAST,id ASC LIMIT $5`,
    anchor
      ? [...values, input.limit + 1, anchor.dueDate, anchor.id]
      : [...values, input.limit + 1],
  );
  const last = rows[input.limit - 1];
  return taskAgendaResponseSchema.parse({
    asOf: input.asOf,
    to: input.to,
    bucket: input.bucket,
    summary,
    entries: rows
      .slice(0, input.limit)
      .map((row) => ({ bucket: row.bucket, task: row })),
    nextAfter:
      rows.length > input.limit && last
        ? { id: last.id, version: last.version }
        : null,
  });
}
