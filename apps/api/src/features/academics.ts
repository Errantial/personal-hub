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
import { mutate } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import { active, metadataColumns, strongest, version } from './common.js';

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
    const columns = `${metadataColumns}, ${fields.map(([key, col]) => `${col} AS "${key}"`).join(',')}`;
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
              const parent =
                table === 'topics'
                  ? await active(tx, 'courses', user.id, String(input.courseId))
                  : null;
              const explicit =
                request.body &&
                typeof request.body === 'object' &&
                'sensitivity' in request.body;
              input.sensitivity = strongest(
                String(
                  explicit
                    ? input.sensitivity
                    : (previous?.sensitivity ?? input.sensitivity),
                ),
                String(parent?.sensitivity ?? 'unlabeled'),
              );
              const values = fields.map(([name]) => input[name!]);
              const [row] =
                method === 'POST'
                  ? await tx.query(
                      `INSERT INTO ${table} (id,owner_id,${fields.map(([, col]) => col).join(',')}) VALUES ($1,$2,${fields.map((_, i) => `$${i + 3}`).join(',')}) RETURNING ${columns}`,
                      [id, user.id, ...values],
                    )
                  : await tx.query(
                      `UPDATE ${table} SET ${fields.map(([, col], i) => `${col}=$${i + 3}`).join(',')},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_id=$2 RETURNING ${columns}`,
                      [id, user.id, ...values],
                    );
              // An upgraded source label also upgrades existing derived records.
              if (table === 'courses' && input.sensitivity !== 'unlabeled')
                for (const child of ['topics', 'events'])
                  await tx.query(
                    `UPDATE ${child} SET sensitivity=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND course_id=$2 AND deleted_at IS NULL AND (sensitivity='unlabeled' OR (sensitivity='personal' AND $3='restricted'))`,
                    [user.id, id, input.sensitivity],
                  );
              if (table === 'topics' && input.sensitivity !== 'unlabeled')
                await tx.query(
                  `UPDATE events SET sensitivity=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND topic_id=$2 AND deleted_at IS NULL AND (sensitivity='unlabeled' OR (sensitivity='personal' AND $3='restricted'))`,
                  [user.id, id, input.sensitivity],
                );
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
