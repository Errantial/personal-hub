import {
  academicWorkSchema,
  academicWorkBatchRequestSchema,
  academicWorkBatchResponseSchema,
  academicWorkBrowseQuerySchema,
  academicWorkBrowseResponseSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutateSchedule } from '../planner/mutations.js';
import { academicWorkColumns } from './academic-work.js';
import { version } from './common.js';
import { ApiError } from '../errors.js';

export function registerAcademicManagement(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.get('/api/v1/academic-work/browse', async (request) => {
    const owner = await auth.requireUser(request);
    const input = academicWorkBrowseQuerySchema.parse(request.query);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      if (input.courseId) {
        const [course] = await tx.query(
          'SELECT id FROM courses WHERE owner_id=$1 AND id=$2',
          [owner.id, input.courseId],
        );
        if (!course)
          throw new ApiError(404, 'NOT_FOUND', 'Class not available.');
      }
      const values = [
        owner.id,
        input.courseId ?? null,
        input.courseState,
        input.kind,
        input.deadline,
        input.status,
      ];
      // The projection is shared with ordinary owned work reads. Class metadata
      // comes from the same snapshot and supplies batch/cursor ancestor guards.
      const scope = `(SELECT ${academicWorkColumns} FROM academic_work WHERE owner_id=$1 AND deleted_at IS NULL) w
        JOIN courses c ON c.id=w."courseId" AND c.owner_id=$1`;
      const filtered = `($2::uuid IS NULL OR c.id=$2)
        AND ($3::text='all' OR (c.deleted_at IS NULL)=($3='active'))
        AND ($4::text='all' OR w.kind=$4)
        AND ($5::text='any' OR (w."dueDate" IS NULL)=($5='undated'))`;
      const selected = `${filtered} AND ($6::text='all' OR w.status=$6 OR ($6='open' AND w.status IN ('planned','in_progress')))`;
      const [anchor] = input.after
        ? await tx.query<{
            id: string;
            version: number;
            courseVersion: number;
            closed: boolean;
            dueDate: string | null;
          }>(
            `SELECT w.id,w.version,c.version AS "courseVersion",w.status IN ('submitted','cancelled') AS closed,w."dueDate"
         FROM ${scope} WHERE ${selected} AND w.id=$7`,
            [...values, input.after],
          )
        : [];
      if (input.after && !anchor)
        throw new ApiError(
          404,
          'NOT_FOUND',
          'Academic cursor no longer available.',
        );
      if (anchor) {
        version(anchor, input.expectedCursorVersion);
        version({ version: anchor.courseVersion }, input.expectedCourseVersion);
      }
      const [summary] = await tx.query(
        `SELECT count(*)::int AS "totalCount",
         count(*) FILTER(WHERE w.status IN ('planned','in_progress'))::int AS "openCount",
         count(*) FILTER(WHERE w.status='planned')::int AS "plannedCount",
         count(*) FILTER(WHERE w.status='in_progress')::int AS "inProgressCount",
         count(*) FILTER(WHERE w.status='submitted')::int AS "submittedCount",
         count(*) FILTER(WHERE w.status='cancelled')::int AS "cancelledCount",
         count(*) FILTER(WHERE w.status IN ('planned','in_progress') AND w."dueDate" IS NULL)::int AS "missingDeadlineCount",
         count(*) FILTER(WHERE w.status IN ('planned','in_progress') AND w."estimatedMinutes" IS NULL)::int AS "missingEstimateCount",
         COALESCE(sum(w."estimatedMinutes") FILTER(WHERE w.status IN ('planned','in_progress')),0)::float8 AS "estimatedOpenMinutes"
         FROM ${scope} WHERE ${filtered}`,
        values.slice(0, 5),
      );
      const rows = await tx.query(
        `SELECT w.*,c.name AS "courseName",c.version AS "courseVersion",c.deleted_at IS NOT NULL AS "courseArchived"
         FROM ${scope} WHERE ${selected}
         ${anchor ? "AND (w.status IN ('submitted','cancelled'),COALESCE(w.\"dueDate\"::date,'infinity'::date),w.id)>($8::boolean,COALESCE($9::date,'infinity'::date),$10::uuid)" : ''}
         ORDER BY (w.status IN ('submitted','cancelled')),w."dueDate" ASC NULLS LAST,w.id LIMIT $7`,
        anchor
          ? [
              ...values,
              input.limit + 1,
              anchor.closed,
              anchor.dueDate,
              anchor.id,
            ]
          : [...values, input.limit + 1],
      );
      const last = rows[input.limit - 1];
      return academicWorkBrowseResponseSchema.parse({
        courseId: input.courseId ?? null,
        courseState: input.courseState,
        status: input.status,
        kind: input.kind,
        deadline: input.deadline,
        summary,
        work: rows.slice(0, input.limit),
        nextAfter:
          rows.length > input.limit && last
            ? {
                id: last.id,
                version: last.version,
                courseVersion: last.courseVersion,
              }
            : null,
      });
    });
  });
  app.post('/api/v1/academic-work/batch', async (request) => {
    const owner = await auth.requireUser(request);
    const input = academicWorkBatchRequestSchema.parse(request.body);
    return mutateSchedule(
      database,
      owner.id,
      input.operationId,
      { kind: 'academic-work.batch', input },
      async (tx) => {
        const ids = input.items.map((item) => item.id.toLowerCase());
        // Discover owned ancestors without locking children. All academic
        // writes hold the owner schedule lock, then classes, then work rows.
        const parents = await tx.query<{ id: string; courseId: string }>(
          'SELECT id,course_id AS "courseId" FROM academic_work WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL',
          [owner.id, ids],
        );
        if (parents.length !== ids.length)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'A selected academic record is no longer available.',
          );
        const courses = await tx.query<{
          id: string;
          version: number;
          deleted_at: unknown;
        }>(
          'SELECT id,version,deleted_at FROM courses WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
          [owner.id, [...new Set(parents.map((row) => row.courseId))]],
        );
        const selected = await tx.query(
          `SELECT ${academicWorkColumns} FROM academic_work WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
          [owner.id, ids],
        );
        if (selected.length !== ids.length)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'A selected academic record is no longer available.',
          );
        const workById = new Map(
          selected.map((row) => {
            const work = academicWorkSchema.parse(row);
            return [work.id, work] as const;
          }),
        );
        const courseById = new Map(courses.map((row) => [row.id, row]));
        // Validate every selection before updating any of them. Never erase a
        // recorded score implicitly to make a status change pass SQL checks.
        for (const item of input.items) {
          const work = workById.get(item.id.toLowerCase())!;
          const course = courseById.get(work.courseId);
          if (!course)
            throw new ApiError(404, 'NOT_FOUND', 'Class not available.');
          version(work, item.expectedVersion);
          version(course, item.expectedCourseVersion);
          if (input.action.kind === 'update') {
            if (course.deleted_at)
              throw new ApiError(
                409,
                'ACADEMIC_CLASS_ARCHIVED',
                'This class is archived. Its work cannot be edited.',
              );
            if (
              work.grade !== null &&
              input.action.changes.status !== undefined &&
              input.action.changes.status !== 'submitted'
            )
              throw new ApiError(
                409,
                'ACADEMIC_SCORE_REVIEW_REQUIRED',
                'Review and clear the recorded score individually before changing its submission status.',
              );
          }
        }
        const rows =
          input.action.kind === 'delete'
            ? await tx.query(
                `UPDATE academic_work SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=ANY($2::uuid[]) RETURNING ${academicWorkColumns}`,
                [owner.id, ids],
              )
            : await tx.query(
                `UPDATE academic_work SET status=COALESCE($3::text,status),priority=COALESCE($4::int,priority),
                 due_date=CASE WHEN $5::boolean THEN $6::date ELSE due_date END,
                 estimated_minutes=CASE WHEN $7::boolean THEN $8::int ELSE estimated_minutes END,
                 updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=ANY($2::uuid[]) RETURNING ${academicWorkColumns}`,
                [
                  owner.id,
                  ids,
                  input.action.changes.status ?? null,
                  input.action.changes.priority ?? null,
                  input.action.changes.dueDate !== undefined,
                  input.action.changes.dueDate ?? null,
                  input.action.changes.estimatedMinutes !== undefined,
                  input.action.changes.estimatedMinutes ?? null,
                ],
              );
        const changed = new Map(rows.map((row) => [row.id, row]));
        return academicWorkBatchResponseSchema.parse({
          work: ids.map((id) => changed.get(id)),
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
