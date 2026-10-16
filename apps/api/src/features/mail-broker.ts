import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  mailBrokerGrantSchema,
  mailBrokerGrantWriteSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { ApiError } from '../errors.js';
import { mutate } from '../planner/mutations.js';
import { brokerReadiness } from '../ai/broker-policy.js';
import { grantColumns, validateBrokerScope } from '../ai/mail-broker.js';

// Owner-only settings groundwork. There is deliberately no public candidate,
// arbitrary-message or execution route in J1/J2.
export function registerMailBroker(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
  config: Config,
) {
  app.get('/api/v1/mail-broker/readiness', async (request) => {
    const user = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      return brokerReadiness(tx, config, user.id);
    });
  });
  app.get('/api/v1/mail-broker/grants', async (request) => {
    const user = await auth.requireUser(request);
    return {
      grants: (
        await database.query(
          `SELECT ${grantColumns} FROM mail_broker_grants WHERE owner_id=$1 ORDER BY id LIMIT 1001`,
          [user.id],
        )
      ).map((row) => mailBrokerGrantSchema.parse(row)),
    };
  });
  app.put('/api/v1/mail-broker/grants/:target', async (request) => {
    const user = await auth.requireUser(request);
    const target = z
      .union([z.literal('owner'), z.string().uuid()])
      .parse((request.params as { target: string }).target);
    const agentId = target === 'owner' ? null : target;
    const input = mailBrokerGrantWriteSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'mail-broker.grant', agentId, input },
      async (tx) => {
        if (agentId) {
          const [agent] = await tx.query(
            'SELECT id FROM responsibilities WHERE owner_id=$1 AND id=$2 AND template IS NOT NULL AND deleted_at IS NULL',
            [user.id, agentId],
          );
          if (!agent)
            throw new ApiError(404, 'NOT_FOUND', 'Agent not available.');
        }
        if (input.enabled) await validateBrokerScope(tx, user.id, input.scope);
        const [current] = await tx.query(
          `SELECT id,version FROM mail_broker_grants WHERE owner_id=$1 AND agent_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE`,
          [user.id, agentId],
        );
        if (Number(current?.version ?? 0) !== input.expectedVersion)
          throw new ApiError(409, 'VERSION_CONFLICT', 'Reload mail access.');
        // Validate owned identities even on disable; a caller cannot retain foreign scopes.
        const owned = await tx.query(
          'SELECT id FROM email_connectors WHERE owner_id=$1 AND id=ANY($2::uuid[])',
          [user.id, input.scope.connectorIds],
        );
        if (owned.length !== input.scope.connectorIds.length)
          throw new ApiError(404, 'NOT_FOUND', 'Connector not available.');
        const id = current ? String(current.id) : randomUUID();
        const rows = current
          ? await tx.query(
              `UPDATE mail_broker_grants SET version=version+1,enabled=$3,scope=$4,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING ${grantColumns}`,
              [user.id, id, input.enabled, JSON.stringify(input.scope)],
            )
          : await tx.query(
              `INSERT INTO mail_broker_grants(id,owner_id,agent_id,enabled,scope) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING ${grantColumns}`,
              [
                id,
                user.id,
                agentId,
                input.enabled,
                JSON.stringify(input.scope),
              ],
            );
        if (!rows.length)
          throw new ApiError(409, 'VERSION_CONFLICT', 'Reload mail access.');
        return { grant: mailBrokerGrantSchema.parse(rows[0]) };
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
