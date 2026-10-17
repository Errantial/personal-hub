import {
  outlookAccessGateSchema,
  outlookAccessGateWriteSchema,
  type OutlookAccessGate,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutate } from '../planner/mutations.js';
import { stamp } from '../features/common.js';
import { ApiError } from '../errors.js';

const columns = `backend,tenant,mailbox_scope AS "mailboxScope",app_registration AS "appRegistration",consent,version,${stamp('checked_at', 'checkedAt')}`;

function statusOf(row: {
  backend: string;
  tenant: string;
  mailboxScope: string;
  appRegistration: string;
  consent: string;
}): OutlookAccessGate['status'] {
  if (
    row.backend === 'other' ||
    row.tenant === 'other' ||
    row.appRegistration === 'registration-blocked' ||
    row.consent === 'consent-blocked'
  )
    return 'blocked';
  if (row.mailboxScope === 'shared-required') return 'scope-review-required';
  if (
    row.appRegistration === 'admin-must-register' ||
    row.consent === 'admin-consent-required'
  )
    return 'admin-action-required';
  if (
    row.backend === 'exchange-online' &&
    row.tenant === 'school-managed' &&
    row.mailboxScope === 'primary-only' &&
    row.appRegistration === 'owner-can-register' &&
    row.consent === 'user-can-consent'
  )
    return 'ready-for-adapter';
  return 'unknown';
}

async function ensure(tx: QueryExecutor, owner: string) {
  await tx.query(
    'INSERT INTO outlook_access_gate(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [owner],
  );
}

export async function readOutlookAccessGate(
  tx: QueryExecutor,
  owner: string,
): Promise<OutlookAccessGate | null> {
  const [row] = await tx.query(
    `SELECT ${columns} FROM outlook_access_gate WHERE owner_id=$1`,
    [owner],
  );
  return row
    ? outlookAccessGateSchema.parse({ ...row, status: statusOf(row as never) })
    : null;
}

export function registerOutlook(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/connections/outlook/access';
  app.get(base, async (request) => {
    const user = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await ensure(tx, user.id);
      return readOutlookAccessGate(tx, user.id);
    });
  });
  app.put(base, async (request) => {
    const user = await auth.requireUser(request);
    const input = outlookAccessGateWriteSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'outlook.access-gate', input },
      async (tx) => {
        await ensure(tx, user.id);
        const [saved] = await tx.query(
          `UPDATE outlook_access_gate SET backend=$3,tenant=$4,mailbox_scope=$5,app_registration=$6,consent=$7,version=version+1,checked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND version=$2 RETURNING ${columns}`,
          [
            user.id,
            input.expectedVersion,
            input.backend,
            input.tenant,
            input.mailboxScope,
            input.appRegistration,
            input.consent,
          ],
        );
        if (!saved)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload Outlook access findings.',
          );
        return outlookAccessGateSchema.parse({
          ...saved,
          status: statusOf(saved as never),
        });
      },
    );
  });
}
