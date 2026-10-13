import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createMailTaskSchema, mailTaskResultSchema } from '@hub/contracts';
import type { authService } from '../auth/routes.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import { mutateSchedule } from '../planner/mutations.js';
import { createTaskRecord } from '../planner/routes.js';
import { strongest, version } from './common.js';

export function registerMailTasks(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.post('/api/v1/email/messages/:id/tasks', async (request, reply) => {
    const owner = await auth.requireUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = createMailTaskSchema.parse(request.body);
    const result = await mutateSchedule(
      database,
      owner.id,
      input.operationId,
      { kind: 'mail.task.create', id, input },
      async (tx) => {
        const [message] = await tx.query<{
          id: string;
          version: number;
          connectorId: string;
          connectorVersion: number;
          body: string;
          textOrigin: string | null;
          sensitivity: string;
          connectorSensitivity: string;
        }>(
          `SELECT m.id,m.version,m.connector_id AS "connectorId",c.version AS "connectorVersion",m.body,m.text_origin AS "textOrigin",m.sensitivity,c.sensitivity AS "connectorSensitivity"
           FROM email_messages m JOIN email_connectors c ON c.id=m.connector_id AND c.owner_id=m.owner_id
           WHERE m.owner_id=$1 AND m.id=$2 FOR SHARE OF c,m`,
          [owner.id, id],
        );
        if (!message)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'This message is not available.',
          );
        version(message, input.expectedVersion);
        if (message.textOrigin !== 'message-body-v1')
          throw new ApiError(
            409,
            'PROVENANCE_UNAVAILABLE',
            'This import cannot establish body-only provenance.',
          );
        if (!message.body.includes(input.quote))
          throw new ApiError(
            409,
            'MAIL_QUOTE_MISMATCH',
            'Use exact supporting text from this message body.',
          );
        const labels = [
          ...new Set([message.sensitivity, message.connectorSensitivity]),
        ];
        const { task } = await createTaskRecord(tx, owner.id, {
          operationId: input.operationId,
          ...(input.clientId ? { clientId: input.clientId } : {}),
          title: input.title,
          notes: input.notes,
          dueDate: input.dueDate,
          priority: input.priority,
          completed: false,
          sensitivity: strongest(...labels),
        });
        await tx.query(
          `INSERT INTO mail_task_sources(owner_id,task_id,message_id,message_version,connector_id,connector_version,quote,labels,confirmed_due_date)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            owner.id,
            task.id,
            message.id,
            message.version,
            message.connectorId,
            message.connectorVersion,
            input.quote,
            labels,
            input.dueDate,
          ],
        );
        return mailTaskResultSchema.parse({
          taskId: task.id,
          taskVersion: task.version,
          messageId: message.id,
        });
      },
      {
        authorize: async (tx) => {
          if (!(await auth.currentUser(request, tx)))
            throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
        },
      },
    );
    reply.code(201);
    return result;
  });
}
