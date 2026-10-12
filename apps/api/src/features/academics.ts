import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  courseWriteSchema,
  topicWriteSchema,
  courseResponseSchema,
  topicResponseSchema,
  coursesSchema,
  topicsSchema,
  deleteItemSchema,
} from '@hub/contracts';
import type { Database } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutateSchedule as mutate } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import {
  propagateAcademicPlannerLabels,
  extendAcademicTopicLabels,
} from './academic-provenance.js';
import {
  active,
  metadataColumns,
  strongest,
  version,
  mergeAcademicLabels,
} from './common.js';

export function registerAcademics(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  for (const table of ['courses', 'topics'] as const) {
    const fields =
      table === 'courses'
        ? [
            ['name', 'name'],
            ['term', 'term'],
            ['instructor', 'instructor'],
            ['notes', 'notes'],
            ['sensitivity', 'sensitivity'],
          ]
        : [
            ['courseId', 'course_id'],
            ['name', 'name'],
            ['notes', 'notes'],
            ['confidence', 'confidence'],
            ['progress', 'progress'],
            ['sensitivity', 'sensitivity'],
          ];
    const columns = `${metadataColumns}, ${fields.map(([key, col]) => `${col} AS "${key}"`).join(',')}${table === 'topics' ? ',academic_labels AS "academicLabels"' : ''}`;
    const key = table === 'courses' ? 'course' : 'topic';
    const writeSchema =
      table === 'courses' ? courseWriteSchema : topicWriteSchema;
    const response =
      table === 'courses' ? courseResponseSchema : topicResponseSchema;
    app.get(`/api/v1/${table}`, async (request) => {
      const user = await auth.requireUser(request);
      const rows = await database.query(
        `SELECT ${columns} FROM ${table} WHERE owner_id=$1 AND deleted_at IS NULL${table === 'topics' ? ' AND EXISTS (SELECT 1 FROM courses WHERE courses.id=topics.course_id AND courses.owner_id=topics.owner_id AND courses.deleted_at IS NULL)' : ''} ORDER BY name,id`,
        [user.id],
      );
      return (table === 'courses' ? coursesSchema : topicsSchema).parse({
        [table]: rows,
      });
    });
    for (const method of ['POST', 'PUT'] as const)
      app.route({
        method,
        url: `/api/v1/${table}${method === 'PUT' ? '/:id' : ''}`,
        handler: async (request) => {
          const user = await auth.requireUser(request);
          const input: Record<string, unknown> & {
            operationId: string;
            expectedVersion?: number | undefined;
          } = writeSchema.parse(request.body);
          const id =
            method === 'PUT'
              ? z.object({ id: z.string().uuid() }).parse(request.params).id
              : randomUUID();
          return mutate(
            database,
            user.id,
            input.operationId,
            { table, method, id: method === 'PUT' ? id : null, input },
            async (tx) => {
              // Class -> topic -> event matches label propagation and calendar edits.
              const parent =
                table === 'topics'
                  ? await active(tx, 'courses', user.id, String(input.courseId))
                  : null;
              const previous =
                method === 'PUT' ? await active(tx, table, user.id, id) : null;
              if (previous) version(previous, input.expectedVersion);
              if (
                table === 'topics' &&
                previous &&
                previous.course_id !== input.courseId
              )
                throw new ApiError(
                  400,
                  'INVALID_INPUT',
                  'A topic must remain in its original class.',
                );
              const explicit =
                request.body &&
                typeof request.body === 'object' &&
                'sensitivity' in request.body;
              const ownLabel = String(
                explicit
                  ? input.sensitivity
                  : (previous?.sensitivity ?? input.sensitivity),
              );
              input.sensitivity = strongest(
                ownLabel,
                String(parent?.sensitivity ?? 'unlabeled'),
              );
              const values = fields.map(([name]) => input[name!]);
              if (table === 'topics')
                values.push(
                  mergeAcademicLabels(
                    previous?.academic_labels,
                    [
                      ownLabel,
                      String(parent?.sensitivity ?? 'unlabeled'),
                    ].filter((label) => label !== 'unlabeled'),
                  ),
                );
              const [row] =
                method === 'POST'
                  ? await tx.query(
                      `INSERT INTO ${table} (id,owner_id,${fields.map(([, col]) => col).join(',')}${table === 'topics' ? ',academic_labels' : ''}) VALUES ($1,$2,${values.map((_, i) => `$${i + 3}`).join(',')}) RETURNING ${columns}`,
                      [id, user.id, ...values],
                    )
                  : await tx.query(
                      `UPDATE ${table} SET ${fields.map(([, col], i) => `${col}=$${i + 3}`).join(',')}${table === 'topics' ? `,academic_labels=$${fields.length + 3}::text[]` : ''},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_id=$2 RETURNING ${columns}`,
                      [id, user.id, ...values],
                    );
              // Tombstones can be restored: capture labels while deleted too.
              // Ancestor-first locking and child versions preserve conflict checks.
              if (table === 'courses' && input.sensitivity !== 'unlabeled')
                for (const child of ['topics', 'events', 'academic_work']) {
                  const academicDependent =
                    child === 'events'
                      ? "EXISTS(SELECT 1 FROM academic_planner_sources aps JOIN academic_work aw ON aw.id=aps.work_id AND aw.owner_id=aps.owner_id WHERE aps.event_id=events.id AND aps.owner_id=events.owner_id AND (aw.course_id=$2 OR events.course_id=$2 OR EXISTS(SELECT 1 FROM event_exceptions x WHERE x.event_id=events.id AND x.replacement->>'courseId'=$2::text)))"
                      : '';
                  const workloadDependent =
                    child === 'events'
                      ? 'EXISTS(SELECT 1 FROM study_event_contexts ec JOIN study_workload_sources ws ON ws.plan_id=ec.plan_id AND ws.owner_id=ec.owner_id JOIN academic_work w ON w.id=ws.work_id AND w.owner_id=ws.owner_id WHERE ec.event_id=events.id AND ec.owner_id=events.owner_id AND w.course_id=$2)'
                      : '';
                  await tx.query(
                    `UPDATE ${child} SET sensitivity=CASE WHEN sensitivity='restricted' OR $3='restricted' THEN 'restricted' ELSE 'personal' END,academic_labels=CASE WHEN academic_labels IS NULL THEN NULL ELSE ARRAY(SELECT DISTINCT label FROM unnest(academic_labels || ARRAY[$3]::text[]) AS inherited(label) ORDER BY label) END,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND (course_id=$2${child === 'events' ? ` OR EXISTS(SELECT 1 FROM event_exceptions x WHERE x.event_id=events.id AND x.replacement->>'courseId'=$2::text) OR ${workloadDependent} OR ${academicDependent}` : ''}) AND (sensitivity='unlabeled' OR (sensitivity='personal' AND $3='restricted') OR (academic_labels IS NOT NULL AND NOT($3=ANY(academic_labels)))${workloadDependent && previous?.sensitivity !== input.sensitivity ? ` OR (academic_labels IS NULL AND ${workloadDependent})` : ''}${academicDependent ? ` OR (${academicDependent} AND EXISTS(SELECT 1 FROM academic_planner_sources aps WHERE aps.event_id=events.id AND aps.owner_id=events.owner_id AND NOT($3=ANY(aps.labels))))` : ''})`,
                    [user.id, id, input.sensitivity],
                  );
                }
              if (table === 'courses' && input.sensitivity !== 'unlabeled')
                await propagateAcademicPlannerLabels(
                  tx,
                  user.id,
                  { courseId: id },
                  [String(input.sensitivity)],
                  false,
                );
              if (table === 'topics')
                for (const label of new Set(
                  [
                    String(input.sensitivity),
                    ...(Array.isArray(row?.academicLabels)
                      ? row.academicLabels.map(String)
                      : []),
                  ].filter((label) => label !== 'unlabeled'),
                )) {
                  await tx.query(
                    `UPDATE events SET sensitivity=CASE WHEN sensitivity='restricted' OR $3='restricted' THEN 'restricted' ELSE 'personal' END,academic_labels=CASE WHEN academic_labels IS NULL THEN NULL ELSE ARRAY(SELECT DISTINCT label FROM unnest(academic_labels || ARRAY[$3]::text[]) AS inherited(label) ORDER BY label) END,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND (topic_id=$2 OR EXISTS(SELECT 1 FROM event_exceptions x WHERE x.event_id=events.id AND x.replacement->>'topicId'=$2::text)) AND (sensitivity='unlabeled' OR (sensitivity='personal' AND $3='restricted') OR (academic_labels IS NOT NULL AND NOT($3=ANY(academic_labels))) OR EXISTS(SELECT 1 FROM academic_planner_sources aps WHERE aps.event_id=events.id AND aps.owner_id=events.owner_id AND NOT($3=ANY(aps.labels))))`,
                    [user.id, id, label],
                  );
                  await extendAcademicTopicLabels(tx, user.id, id, [label]);
                }
              return response.parse({ [key]: row });
            },
          );
        },
      });
    app.delete(`/api/v1/${table}/:id`, async (request) => {
      const user = await auth.requireUser(request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = deleteItemSchema.parse(request.body);
      return mutate(
        database,
        user.id,
        input.operationId,
        { table, id, input },
        async (tx) => {
          const current = await active(tx, table, user.id, id);
          version(current, input.expectedVersion);
          const [row] = await tx.query(
            `UPDATE ${table} SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1 AND owner_id=$2 RETURNING ${columns}`,
            [id, user.id],
          );
          if (table === 'courses')
            await tx.query(
              'UPDATE topics SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND course_id=$2 AND deleted_at IS NULL',
              [user.id, id],
            );
          return response.parse({ [key]: row });
        },
      );
    });
  }
}
