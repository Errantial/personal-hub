import { plannerExportSchema } from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { ApiError } from '../errors.js';
import { taskColumns } from '../planner/routes.js';
import { eventColumns, metadataColumns } from './common.js';
import { reminderColumns, notificationColumns } from './reminders.js';
import {
  canvasItemColumns,
  canvasEffectiveSensitivity,
} from '../connections/canvas.js';

export function registerExport(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.get('/api/v1/planner/export', async (request, reply) => {
    const owner = await auth.requireUser(request);
    const records = await database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      const read = async (table: string, columns: string) =>
        tx.query(
          `SELECT ${columns} FROM ${table} WHERE owner_id=$1 ORDER BY id LIMIT 10001`,
          [owner.id],
        );
      // Explicit projections exclude credentials, receipts and worker lease tokens.
      const tasks = await read('tasks', taskColumns);
      const events = await read('events', eventColumns);
      const courses = await read(
        'courses',
        `${metadataColumns},name,term,instructor,notes,sensitivity`,
      );
      const topics = await read(
        'topics',
        `${metadataColumns},course_id AS "courseId",name,notes,confidence,progress,sensitivity`,
      );
      const exceptions = await tx.query(
        `SELECT x.event_id AS "eventId",to_char(x.original_date,'YYYY-MM-DD') AS "originalDate",x.cancelled,x.replacement FROM event_exceptions x JOIN events e ON e.id=x.event_id WHERE e.owner_id=$1 ORDER BY x.event_id,x.original_date LIMIT 10001`,
        [owner.id],
      );
      const reminders = await read('reminders', reminderColumns);
      const notifications = await read('notifications', notificationColumns);
      const [canvasSource] = await tx.query(
        'SELECT enabled,sensitivity,version FROM canvas_sources WHERE owner_id=$1',
        [owner.id],
      );
      const canvasItems = (await read('canvas_items', canvasItemColumns)).map(
        (item) => ({
          ...item,
          effectiveSensitivity: canvasEffectiveSensitivity(
            canvasSource?.sensitivity,
            item,
          ),
        }),
      );
      return {
        tasks,
        events,
        courses,
        topics,
        exceptions,
        reminders,
        notifications,
        canvasItems,
        canvasSource: canvasSource ?? null,
      };
    });
    const tooLarge = () =>
      new ApiError(
        413,
        'EXPORT_TOO_LARGE',
        'Export exceeds the supported download size.',
      );
    if (
      Object.values(records).some(
        (rows) => Array.isArray(rows) && rows.length > 10000,
      )
    )
      throw tooLarge();
    const exportedAt = new Date().toISOString();
    const output = plannerExportSchema.parse({
      format: 'personal-hub-planner',
      formatVersion: 1,
      exportedAt,
      owner,
      records,
    });
    if (Buffer.byteLength(JSON.stringify(output)) > 16 * 1024 * 1024)
      throw tooLarge();
    reply.header(
      'Content-Disposition',
      `attachment; filename="personal-hub-${exportedAt.slice(0, 10)}.json"`,
    );
    return output;
  });
}
