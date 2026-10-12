import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  academicWorkSchema,
  academicWorkWriteSchema,
  academicWorkUpdateSchema,
  academicWorkResponseSchema,
  academicWorkQuerySchema,
  academicWorkListSchema,
  academicWorkSummaryQuerySchema,
  academicWorkSummarySchema,
  academicAgendaQuerySchema,
  deleteItemSchema,
} from '@hub/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutateSchedule } from '../planner/mutations.js';
import {
  active,
  metadataColumns,
  strongest,
  version,
  mergeAcademicLabels,
} from './common.js';
import { ApiError } from '../errors.js';
import { propagateWorkloadLabels } from './study-workload.js';
import { readAcademicAgenda } from './academic-agenda.js';
import { propagateAcademicPlannerLabels } from './academic-provenance.js';

export const academicWorkColumns = `${metadataColumns},course_id AS "courseId",title,kind,notes,to_char(due_date,'YYYY-MM-DD') AS "dueDate",estimated_minutes AS "estimatedMinutes",priority,status,grade,sensitivity,academic_labels AS "academicLabels",'owner-entered' AS provenance`;
const idOf = (params: unknown) =>
  z.object({ id: z.string().uuid() }).parse(params).id;
async function readWork(
  tx: QueryExecutor,
  owner: string,
  id: string,
  lock = false,
) {
  const [row] = await tx.query(
    `SELECT ${academicWorkColumns} FROM academic_work WHERE owner_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
    [owner, id],
  );
  if (!row)
    throw new ApiError(404, 'NOT_FOUND', 'Academic work not available.');
  return academicWorkSchema.parse(row);
}
export function registerAcademicWork(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/academic-work';
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
  app.get(base, (request) =>
    snapshot(request, async (tx, owner) => {
      const input = academicWorkQuerySchema.parse(request.query);
      if (input.courseId) {
        const [course] = await tx.query(
          'SELECT id FROM courses WHERE owner_id=$1 AND id=$2',
          [owner, input.courseId],
        );
        if (!course)
          throw new ApiError(404, 'NOT_FOUND', 'Class not available.');
      }
      const anchor = input.before
        ? await readWork(tx, owner, input.before)
        : null;
      const [cursor] = anchor
        ? await tx.query(
            `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp FROM academic_work WHERE owner_id=$1 AND id=$2`,
            [owner, anchor.id],
          )
        : [];
      const rows = await tx.query(
        `SELECT ${academicWorkColumns} FROM academic_work WHERE owner_id=$1
       AND ($3::uuid IS NULL OR course_id=$3) AND ($4::text IS NULL OR status=$4)
       AND deleted_at IS ${input.deleted === 'true' ? 'NOT ' : ''}NULL
       ${cursor ? 'AND (created_at,id)<($5::timestamptz,$6::uuid)' : ''}
       ORDER BY created_at DESC,id DESC LIMIT $2`,
        cursor
          ? [
              owner,
              input.limit + 1,
              input.courseId ?? null,
              input.status ?? null,
              cursor.timestamp,
              anchor!.id,
            ]
          : [
              owner,
              input.limit + 1,
              input.courseId ?? null,
              input.status ?? null,
            ],
      );
      return academicWorkListSchema.parse({
        work: rows.slice(0, input.limit),
        nextBefore:
          rows.length > input.limit ? rows[input.limit - 1]!.id : null,
      });
    }),
  );
  app.get(`${base}/agenda`, (request) =>
    snapshot(request, (tx, owner) =>
      readAcademicAgenda(
        tx,
        owner,
        academicAgendaQuerySchema.parse(request.query),
      ),
    ),
  );
  app.get(`${base}/:id`, (request) =>
    snapshot(request, async (tx, owner) =>
      academicWorkResponseSchema.parse({
        work: await readWork(tx, owner, idOf(request.params)),
      }),
    ),
  );
  for (const method of ['POST', 'PUT'] as const)
    app.route({
      method,
      url: `${base}${method === 'PUT' ? '/:id' : ''}`,
      handler: async (request) => {
        const owner = await auth.requireUser(request);
        const input = (
          method === 'PUT' ? academicWorkUpdateSchema : academicWorkWriteSchema
        ).parse(request.body);
        const id = method === 'POST' ? randomUUID() : idOf(request.params);
        return mutateSchedule(
          database,
          owner.id,
          input.operationId,
          {
            kind: `academic-work.${method}`,
            id: method === 'POST' ? null : id,
            input,
          },
          async (tx) => {
            const course = await active(
              tx,
              'courses',
              owner.id,
              input.courseId,
            );
            const previous =
              method === 'PUT' ? await readWork(tx, owner.id, id, true) : null;
            if (previous) {
              version(previous, input.expectedVersion);
              if (previous.deletedAt)
                throw new ApiError(
                  409,
                  'ACADEMIC_WORK_DELETED',
                  'Restore the record before editing.',
                );
              if (previous.courseId !== input.courseId)
                throw new ApiError(
                  400,
                  'INVALID_INPUT',
                  'Keep the original class for this record.',
                );
            }
            const explicit =
              typeof request.body === 'object' &&
              request.body !== null &&
              'sensitivity' in request.body;
            const ownLabel = explicit
              ? input.sensitivity
              : (previous?.sensitivity ?? input.sensitivity);
            const labels = mergeAcademicLabels(
              previous?.academicLabels,
              [ownLabel, String(course.sensitivity)].filter(
                (label) => label !== 'unlabeled',
              ),
            );
            const values = [
              id,
              owner.id,
              input.courseId,
              input.title,
              input.kind,
              input.notes,
              input.dueDate,
              input.estimatedMinutes,
              input.priority,
              input.status,
              input.grade === null ? null : JSON.stringify(input.grade),
              strongest(ownLabel, String(course.sensitivity)),
              labels,
            ];
            const [row] =
              method === 'POST'
                ? await tx.query(
                    `INSERT INTO academic_work(id,owner_id,course_id,title,kind,notes,due_date,estimated_minutes,priority,status,grade,sensitivity,academic_labels) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::text[]) RETURNING ${academicWorkColumns}`,
                    values,
                  )
                : await tx.query(
                    `UPDATE academic_work SET course_id=$3,title=$4,kind=$5,notes=$6,due_date=$7,estimated_minutes=$8,priority=$9,status=$10,grade=$11::jsonb,sensitivity=$12,academic_labels=$13::text[],version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_id=$2 RETURNING ${academicWorkColumns}`,
                    values,
                  );
            const result = academicWorkResponseSchema.parse({ work: row });
            await propagateAcademicPlannerLabels(
              tx,
              owner.id,
              { workId: id },
              result.work.academicLabels.filter(
                (label) => !previous?.academicLabels.includes(label),
              ),
            );
            await propagateWorkloadLabels(
              tx,
              owner.id,
              { workId: id },
              result.work.academicLabels.filter(
                (label) => !previous?.academicLabels.includes(label),
              ),
            );
            return result;
          },
        );
      },
    });
  for (const action of ['delete', 'restore'] as const)
    app.route({
      method: action === 'delete' ? 'DELETE' : 'POST',
      url: `${base}/:id${action === 'restore' ? '/restore' : ''}`,
      handler: async (request) => {
        const owner = await auth.requireUser(request);
        const id = idOf(request.params);
        const input = deleteItemSchema.parse(request.body);
        return mutateSchedule(
          database,
          owner.id,
          input.operationId,
          { kind: `academic-work.${action}`, id, input },
          async (tx) => {
            const before = await readWork(tx, owner.id, id);
            // Ancestor first, including archived classes for deletion of historical work.
            const [course] = await tx.query(
              'SELECT id,deleted_at FROM courses WHERE owner_id=$1 AND id=$2 FOR UPDATE',
              [owner.id, before.courseId],
            );
            const current = await readWork(tx, owner.id, id, true);
            version(current, input.expectedVersion);
            if (action === 'restore' && course?.deleted_at)
              throw new ApiError(
                409,
                'ACADEMIC_CLASS_ARCHIVED',
                'The class is archived; this record cannot be restored.',
              );
            if (action === 'restore' ? !current.deletedAt : current.deletedAt)
              throw new ApiError(
                409,
                action === 'restore' ? 'NOT_DELETED' : 'ACADEMIC_WORK_DELETED',
                'Reload the current record.',
              );
            const [row] = await tx.query(
              `UPDATE academic_work SET deleted_at=${action === 'delete' ? 'CURRENT_TIMESTAMP' : 'NULL'},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING ${academicWorkColumns}`,
              [owner.id, id],
            );
            return academicWorkResponseSchema.parse({ work: row });
          },
        );
      },
    });
  app.get('/api/v1/courses/:id/work-summary', (request) =>
    snapshot(request, async (tx, owner) => {
      const courseId = idOf(request.params);
      const { asOf } = academicWorkSummaryQuerySchema.parse(request.query);
      const [course] = await tx.query(
        'SELECT deleted_at FROM courses WHERE owner_id=$1 AND id=$2',
        [owner, courseId],
      );
      if (!course) throw new ApiError(404, 'NOT_FOUND', 'Class not available.');
      const rows = await tx.query(
        `SELECT ${academicWorkColumns} FROM academic_work WHERE owner_id=$1 AND course_id=$2 AND deleted_at IS NULL AND status<>'cancelled' ORDER BY id LIMIT 5001`,
        [owner, courseId],
      );
      if (rows.length > 5000)
        throw new ApiError(
          413,
          'ACADEMIC_WORK_TOO_LARGE',
          'Class summary supports at most 5000 active records.',
        );
      const work = rows.map((row) => academicWorkSchema.parse(row));
      const open = work.filter((w) => w.status !== 'submitted');
      const submitted = work.filter((w) => w.status === 'submitted');
      const scores = submitted.flatMap((w) =>
        w.grade === null ? [] : [w.grade],
      );
      const earned = scores.reduce((sum, g) => sum + g.earned, 0),
        possible = scores.reduce((sum, g) => sum + g.possible, 0);
      return academicWorkSummarySchema.parse({
        courseId,
        courseArchived: Boolean(course.deleted_at),
        asOf,
        activeCount: work.length,
        submittedCount: submitted.length,
        overdueCount: open.filter((w) => w.dueDate && w.dueDate < asOf).length,
        missingDeadlineCount: open.filter((w) => w.dueDate === null).length,
        missingEstimateCount: open.filter((w) => w.estimatedMinutes === null)
          .length,
        estimatedOpenMinutes: open.reduce(
          (sum, w) => sum + (w.estimatedMinutes ?? 0),
          0,
        ),
        recordedScoreCount: scores.length,
        ungradedSubmittedCount: submitted.length - scores.length,
        recordedEarnedPoints: earned,
        recordedPossiblePoints: possible,
        recordedPointsPercent: possible ? (earned / possible) * 100 : null,
        warnings: [
          'MANUAL_RECORDS_ONLY',
          'NOT_FINAL_CLASS_GRADE',
          ...(scores.some((g) => g.earned > g.possible)
            ? ['EXTRA_CREDIT_PRESENT']
            : []),
        ],
      });
    }),
  );
}
