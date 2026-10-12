import { academicAgendaResponseSchema } from '@hub/contracts';
import type { AcademicAgendaQuery } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { version } from './common.js';

// Read planning fields only: scores and notes are not agenda inputs.
const columns = `w.id,w.version,w.course_id AS "courseId",c.name AS "courseName",c.version AS "courseVersion",
 w.title,w.kind,to_char(w.due_date,'YYYY-MM-DD') AS "dueDate",w.estimated_minutes AS "estimatedMinutes",
 w.priority,w.status,w.sensitivity,w.academic_labels AS "academicLabels",'owner-entered' AS provenance`;
const eligible = `w.owner_id=$1 AND c.owner_id=w.owner_id AND c.deleted_at IS NULL
 AND w.deleted_at IS NULL AND w.status IN ('planned','in_progress')
 AND ($4::uuid IS NULL OR w.course_id=$4) AND (w.due_date<$3::date OR w.due_date IS NULL)`;
const bucket = `CASE WHEN w.due_date IS NULL THEN 'undated' WHEN w.due_date<$2::date THEN 'overdue'
 WHEN w.due_date=$2::date THEN 'today' ELSE 'upcoming' END`;

export async function readAcademicAgendaSummary(
  tx: QueryExecutor,
  owner: string,
  input: Pick<AcademicAgendaQuery, 'asOf' | 'to' | 'courseId'>,
) {
  const values = [owner, input.asOf, input.to, input.courseId ?? null];
  if (input.courseId) {
    const [course] = await tx.query(
      'SELECT id FROM courses WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL',
      [owner, input.courseId],
    );
    if (!course) throw new ApiError(404, 'NOT_FOUND', 'Class not available.');
  }
  const [summary] = await tx.query<{ openCount: number }>(
    `SELECT COUNT(*)::int AS "openCount",
     COUNT(*) FILTER(WHERE w.due_date<$2::date)::int AS "overdueCount",
     COUNT(*) FILTER(WHERE w.due_date=$2::date)::int AS "todayCount",
     COUNT(*) FILTER(WHERE w.due_date>$2::date)::int AS "upcomingCount",
     COUNT(*) FILTER(WHERE w.due_date IS NULL)::int AS "missingDeadlineCount",
     COUNT(*) FILTER(WHERE w.estimated_minutes IS NULL)::int AS "missingEstimateCount",
     COALESCE(SUM(w.estimated_minutes),0)::float8 AS "estimatedOpenMinutes"
     FROM academic_work w JOIN courses c ON c.id=w.course_id WHERE ${eligible}`,
    values,
  );
  if (!summary || summary.openCount > 5000)
    throw new ApiError(
      413,
      'ACADEMIC_WORK_TOO_LARGE',
      'Deadline agenda supports at most 5000 relevant open records.',
    );
  return academicAgendaResponseSchema.shape.summary.parse(summary);
}

export async function readAcademicAgenda(
  tx: QueryExecutor,
  owner: string,
  input: AcademicAgendaQuery,
) {
  const values = [owner, input.asOf, input.to, input.courseId ?? null];
  const summary = await readAcademicAgendaSummary(tx, owner, input);
  const selected = `${eligible} AND ($5::text='all' OR (${bucket})=$5)`;
  const anchor = input.after
    ? (
        await tx.query<{ id: string; version: number; dueDate: string | null }>(
          `SELECT w.id,w.version,to_char(w.due_date,'YYYY-MM-DD') AS "dueDate"
           FROM academic_work w JOIN courses c ON c.id=w.course_id
           WHERE ${selected} AND w.id=$6`,
          [...values, input.bucket, input.after],
        )
      )[0]
    : null;
  if (input.after && !anchor)
    throw new ApiError(404, 'NOT_FOUND', 'Agenda cursor no longer available.');
  if (anchor) version(anchor, input.expectedCursorVersion);
  const rows = await tx.query(
    `SELECT ${columns},(${bucket}) AS bucket FROM academic_work w JOIN courses c ON c.id=w.course_id
     WHERE ${selected}
     ${anchor ? "AND (COALESCE(w.due_date,'infinity'::date),w.id)>(COALESCE($7::date,'infinity'::date),$8::uuid)" : ''}
     ORDER BY w.due_date ASC NULLS LAST,w.id ASC LIMIT $6`,
    anchor
      ? [...values, input.bucket, input.limit + 1, anchor.dueDate, anchor.id]
      : [...values, input.bucket, input.limit + 1],
  );
  const last = rows[input.limit - 1];
  return academicAgendaResponseSchema.parse({
    asOf: input.asOf,
    to: input.to,
    courseId: input.courseId ?? null,
    bucket: input.bucket,
    summary,
    entries: rows.slice(0, input.limit),
    nextAfter:
      rows.length > input.limit && last
        ? { id: last.id, version: last.version }
        : null,
    warnings: ['MANUAL_RECORDS_ONLY'],
  });
}
