import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  academicPlanningWriteSchema,
  academicPlanningResponseSchema,
  academicPlannerLinkSchema,
  academicPlannerSourceResponseSchema,
  academicPlannerWorkQuerySchema,
  academicPlannerWorkResponseSchema,
  studyWorkloadSnapshotSchema,
  studyWorkloadCurrentSchema,
  createTaskSchema,
  academicPlannerSummaryQuerySchema,
  academicPlannerSummarySchema,
  calendarRecordSchema,
  expandEvent,
  Temporal,
} from '@hub/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutateSchedule } from '../planner/mutations.js';
import { taskColumns, createTaskRecord } from '../planner/routes.js';
import { createStudyEvent, readExceptions } from './calendar.js';
import {
  eventColumns,
  stamp,
  strongest,
  version,
  academicLabels,
} from './common.js';
import { ApiError } from '../errors.js';

const idOf = (params: unknown) =>
  z.object({ id: z.string().uuid() }).parse(params).id;
const linkColumns = `s.id,s.work_id AS "workId",s.task_id AS "taskId",s.event_id AS "eventId",s.snapshot,s.labels,${stamp('s.created_at', 'createdAt')}`;
const currentColumns = `w.id,w.version,w.course_id AS "courseId",c.version AS "courseVersion",c.sensitivity AS "courseSensitivity",
 to_char(w.due_date,'YYYY-MM-DD') AS "dueDate",w.estimated_minutes AS "estimatedMinutes",w.priority,w.status,
 w.sensitivity,w.academic_labels AS "academicLabels",'owner-entered-planning-fields' AS provenance,
 ${stamp('w.deleted_at', 'deletedAt')},c.deleted_at IS NOT NULL AS "courseArchived"`;
async function readCurrent(
  tx: QueryExecutor,
  owner: string,
  workId: string,
  lock = false,
) {
  const [row] = await tx.query(
    `SELECT ${currentColumns} FROM academic_work w JOIN courses c ON c.id=w.course_id AND c.owner_id=w.owner_id
     WHERE w.owner_id=$1 AND w.id=$2 ${lock ? 'FOR UPDATE OF w,c' : ''}`,
    [owner, workId],
  );
  if (!row)
    throw new ApiError(404, 'NOT_FOUND', 'Academic work not available.');
  return studyWorkloadCurrentSchema.parse(row);
}
async function readLink(
  tx: QueryExecutor,
  owner: string,
  kind: 'task' | 'event',
  itemId: string,
) {
  const [row] = await tx.query(
    `SELECT ${linkColumns} FROM academic_planner_sources s WHERE s.owner_id=$1 AND s.${kind === 'task' ? 'task_id' : 'event_id'}=$2`,
    [owner, itemId],
  );
  return row ? academicPlannerLinkSchema.parse(row) : null;
}
export async function exportAcademicPlanning(tx: QueryExecutor, owner: string) {
  return (
    await tx.query(
      `SELECT ${linkColumns} FROM academic_planner_sources s WHERE s.owner_id=$1 ORDER BY s.id LIMIT 10001`,
      [owner],
    )
  ).map((row) => academicPlannerLinkSchema.parse(row));
}
export function registerAcademicPlanning(
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
  const base = '/api/v1/academic-work/:id/planner-work';
  app.post(base, async (request) => {
    const owner = await auth.requireUser(request);
    const workId = idOf(request.params);
    const input = academicPlanningWriteSchema.parse(request.body);
    return mutateSchedule(
      database,
      owner.id,
      input.operationId,
      { kind: 'academic-planning.create', workId, input },
      async (tx) => {
        const current = await readCurrent(tx, owner.id, workId, true);
        version(current, input.expectedWorkVersion);
        version(
          { version: current.courseVersion },
          input.expectedCourseVersion,
        );
        if (current.deletedAt)
          throw new ApiError(
            409,
            'ACADEMIC_WORK_DELETED',
            'Restore the work before planning.',
          );
        if (current.courseArchived)
          throw new ApiError(
            409,
            'ACADEMIC_CLASS_ARCHIVED',
            'The class is archived.',
          );
        if (!['planned', 'in_progress'].includes(current.status))
          throw new ApiError(
            409,
            'ACADEMIC_WORK_CLOSED',
            'Only open work can create planner items.',
          );
        const captured = studyWorkloadSnapshotSchema.parse({
          id: current.id,
          version: current.version,
          courseId: current.courseId,
          courseVersion: current.courseVersion,
          courseSensitivity: current.courseSensitivity,
          dueDate: current.dueDate,
          estimatedMinutes: current.estimatedMinutes,
          priority: current.priority,
          status: current.status,
          sensitivity: current.sensitivity,
          academicLabels: current.academicLabels,
          provenance: current.provenance,
        });
        const labels = [
          ...new Set([
            ...captured.academicLabels,
            ...[captured.courseSensitivity].filter(
              (label) => label !== 'unlabeled',
            ),
          ]),
        ];
        // Strip current-only state explicitly; the strict snapshot never copies text/scores.
        let taskId: string | null = null,
          eventId: string | null = null;
        if (input.kind === 'task') {
          const created = await createTaskRecord(
            tx,
            owner.id,
            createTaskSchema.parse({
              ...input.task,
              sensitivity: strongest(input.task.sensitivity, ...labels),
              operationId: input.operationId,
            }),
          );
          taskId = created.task.id;
        } else {
          if (input.event.courseId !== captured.courseId)
            throw new ApiError(
              400,
              'ACADEMIC_CLASS_MISMATCH',
              'Use the source work class for this block.',
            );
          const inherited = await academicLabels(
            tx,
            owner.id,
            input.event.courseId,
            input.event.topicId,
          );
          labels.push(
            ...inherited.labels.filter((label) => !labels.includes(label)),
          );
          eventId = (await createStudyEvent(tx, owner.id, input.event, labels))
            .id;
        }
        await tx.query(
          'INSERT INTO academic_planner_sources(id,owner_id,work_id,task_id,event_id,snapshot,labels) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::text[])',
          [
            randomUUID(),
            owner.id,
            workId,
            taskId,
            eventId,
            JSON.stringify(captured),
            labels,
          ],
        );
        const source = await readLink(
          tx,
          owner.id,
          taskId ? 'task' : 'event',
          taskId ?? eventId!,
        );
        const [item] = await tx.query(
          `SELECT ${taskId ? taskColumns : eventColumns} FROM ${taskId ? 'tasks' : 'events'} WHERE owner_id=$1 AND id=$2`,
          [owner.id, taskId ?? eventId],
        );
        return academicPlanningResponseSchema.parse(
          taskId
            ? { kind: 'task', task: item, source }
            : { kind: 'study', event: item, source },
        );
      },
      { isolation: 'repeatable read' },
    );
  });
  app.get(base, (request) =>
    snapshot(request, async (tx, owner) => {
      const workId = idOf(request.params);
      const input = academicPlannerWorkQuerySchema.parse(request.query);
      const current = await readCurrent(tx, owner, workId);
      if (input.after) {
        const [cursor] = await tx.query(
          'SELECT id FROM academic_planner_sources WHERE owner_id=$1 AND work_id=$2 AND id=$3',
          [owner, workId, input.after],
        );
        if (!cursor)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Planner work cursor not available.',
          );
      }
      const rows = await tx.query<{
        source: unknown;
        task: unknown;
        event: unknown;
        id: string;
      }>(
        `SELECT s.id,jsonb_build_object('id',s.id,'workId',s.work_id,'taskId',s.task_id,'eventId',s.event_id,'snapshot',s.snapshot,'labels',s.labels,
        'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS source,
       (SELECT row_to_json(p) FROM (SELECT ${taskColumns} FROM tasks WHERE owner_id=s.owner_id AND id=s.task_id) p) AS task,
       (SELECT row_to_json(p) FROM (SELECT ${eventColumns} FROM events WHERE owner_id=s.owner_id AND id=s.event_id) p) AS event
       FROM academic_planner_sources s LEFT JOIN tasks t ON t.id=s.task_id AND t.owner_id=s.owner_id LEFT JOIN events e ON e.id=s.event_id AND e.owner_id=s.owner_id
       WHERE s.owner_id=$1 AND s.work_id=$2 AND ($4::uuid IS NULL OR s.id>$4)
       ${input.deleted === 'all' ? '' : `AND (CASE WHEN s.task_id IS NOT NULL THEN t.deleted_at ELSE e.deleted_at END) IS ${input.deleted === 'true' ? 'NOT ' : ''}NULL`}
       ORDER BY s.id LIMIT $3`,
        [owner, workId, input.limit + 1, input.after ?? null],
      );
      return academicPlannerWorkResponseSchema.parse({
        workId,
        workVersion: current.version,
        workDeletedAt: current.deletedAt,
        entries: rows
          .slice(0, input.limit)
          .map((row) =>
            row.task
              ? { kind: 'task', source: row.source, task: row.task }
              : { kind: 'study', source: row.source, event: row.event },
          ),
        nextAfter: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
      });
    }),
  );
  app.get('/api/v1/academic-work/:id/planner-work-summary', (request) =>
    snapshot(request, async (tx, owner) => {
      const workId = idOf(request.params);
      const input = academicPlannerSummaryQuerySchema.parse(request.query);
      const currentWork = await readCurrent(tx, owner, workId);
      const [tasks] = await tx.query<{
        openCount: number;
        completedCount: number;
        deletedCount: number;
      }>(
        `SELECT COUNT(*) FILTER(WHERE t.deleted_at IS NULL AND NOT t.completed)::int AS "openCount",
       COUNT(*) FILTER(WHERE t.deleted_at IS NULL AND t.completed)::int AS "completedCount",
       COUNT(*) FILTER(WHERE t.deleted_at IS NOT NULL)::int AS "deletedCount"
       FROM academic_planner_sources s JOIN tasks t ON t.id=s.task_id AND t.owner_id=s.owner_id WHERE s.owner_id=$1 AND s.work_id=$2`,
        [owner, workId],
      );
      const rows = await tx.query(
        `SELECT ${eventColumns} FROM events WHERE owner_id=$1 AND id IN
      (SELECT event_id FROM academic_planner_sources WHERE owner_id=$1 AND work_id=$2) ORDER BY id LIMIT 5001`,
        [owner, workId],
      );
      if (
        !tasks ||
        tasks.openCount + tasks.completedCount + tasks.deletedCount > 5000 ||
        rows.length > 5000
      )
        throw new ApiError(
          413,
          'ACADEMIC_WORK_TOO_LARGE',
          'Planner work summary supports at most 5000 tasks and Calendar records each.',
        );
      const bounds = {
        start: +new Date(
          Temporal.PlainDate.from(input.from)
            .toZonedDateTime(input.timeZone)
            .toInstant()
            .toString(),
        ),
        end: +new Date(
          Temporal.PlainDate.from(input.to)
            .toZonedDateTime(input.timeZone)
            .toInstant()
            .toString(),
        ),
      };
      const calendar = {
        recordCount: 0,
        deletedRecordCount: 0,
        plannedCount: 0,
        completedCount: 0,
        cancelledCount: 0,
        allDayCount: 0,
        plannedMinutes: 0,
        completedMinutes: 0,
        cancelledMinutes: 0,
      };
      let occurrenceCount = 0;
      for (const row of rows) {
        const event = calendarRecordSchema.parse(row);
        if (event.deletedAt) {
          calendar.deletedRecordCount++;
          continue;
        }
        calendar.recordCount++;
        const occurrences = expandEvent(
          event,
          input.from,
          input.to,
          input.timeZone,
          await readExceptions(tx, event.id),
        );
        occurrenceCount += occurrences.length;
        if (occurrenceCount > 20000)
          throw new ApiError(
            413,
            'ACADEMIC_WORK_TOO_LARGE',
            'Planner work summary exceeds its occurrence limit.',
          );
        for (const occurrence of occurrences) {
          if (occurrence.allDay) {
            calendar.allDayCount++;
            continue;
          }
          const minutes =
            Math.max(
              0,
              Math.min(+new Date(occurrence.endsAt), bounds.end) -
                Math.max(+new Date(occurrence.startsAt), bounds.start),
            ) / 60000;
          const status = occurrence.studyStatus;
          calendar[`${status}Count`]++;
          calendar[`${status}Minutes`] += minutes;
        }
      }
      return academicPlannerSummarySchema.parse({
        ...input,
        currentWork,
        tasks,
        calendar,
        warnings: [
          'MANUAL_RECORDS_ONLY',
          'PLANNER_COMPLETION_IS_NOT_SUBMISSION',
          'STUDY_TIME_IS_NOT_MASTERY',
        ],
      });
    }),
  );
  for (const kind of ['task', 'event'] as const)
    app.get(
      `/api/v1/${kind === 'task' ? 'tasks' : 'calendar'}/:id/academic-source`,
      (request) =>
        snapshot(request, async (tx, owner) => {
          const itemId = idOf(request.params);
          const query = z
            .strictObject({
              expectedVersion: z.coerce.number().int().positive().optional(),
            })
            .parse(request.query);
          const [item] = await tx.query(
            `SELECT version,${stamp('deleted_at', 'deletedAt')} FROM ${kind === 'task' ? 'tasks' : 'events'} WHERE owner_id=$1 AND id=$2`,
            [owner, itemId],
          );
          if (!item)
            throw new ApiError(404, 'NOT_FOUND', 'Planner item not available.');
          if (query.expectedVersion !== undefined)
            version(item, query.expectedVersion);
          const source = await readLink(tx, owner, kind, itemId);
          const current = source
            ? await readCurrent(tx, owner, source.workId)
            : null;
          return academicPlannerSourceResponseSchema.parse({
            kind,
            itemId,
            itemVersion: item.version,
            itemDeletedAt: item.deletedAt,
            source:
              source && current
                ? {
                    ...source,
                    current,
                    changed:
                      source.snapshot.version !== current.version ||
                      source.snapshot.courseVersion !== current.courseVersion,
                  }
                : null,
          });
        }),
    );
}
