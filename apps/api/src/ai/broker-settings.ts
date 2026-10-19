import { z } from 'zod';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';

export const mailBrokerAliasSchema = z.enum(['mail-broker', 'jev-mail']);
export type MailBrokerAlias = z.infer<typeof mailBrokerAliasSchema>;

export const mailBrokerSettingsSchema = z.strictObject({
  version: z.number().int().positive(),
  selectedAlias: mailBrokerAliasSchema,
});

export const mailBrokerSettingsWriteSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  selectedAlias: mailBrokerAliasSchema,
});

const columns = 'version,selected_alias AS "selectedAlias"';

/** Missing persisted state deliberately preserves the deployed OpenRouter broker. */
export async function readMailBrokerSettings(tx: QueryExecutor, owner: string) {
  const [row] = await tx.query(
    `SELECT ${columns} FROM mail_broker_settings WHERE owner_id=$1`,
    [owner],
  );
  return mailBrokerSettingsSchema.parse(
    row ?? { version: 1, selectedAlias: 'mail-broker' },
  );
}

/**
 * Version one is the virtual missing-row default. The first persisted choice is
 * version two. Distinct concurrent first writes race on the owner primary key;
 * exactly one INSERT can win and the loser gets an ordinary version conflict.
 */
export async function writeMailBrokerSettings(
  tx: QueryExecutor,
  owner: string,
  expectedVersion: number,
  selectedAlias: MailBrokerAlias,
) {
  const [current] = await tx.query(
    'SELECT version FROM mail_broker_settings WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
  if (current) {
    if (Number(current.version) !== expectedVersion) throw conflict();
    const [saved] = await tx.query(
      `UPDATE mail_broker_settings
       SET version=version+1,selected_alias=$3,updated_at=CURRENT_TIMESTAMP
       WHERE owner_id=$1 AND version=$2
       RETURNING ${columns}`,
      [owner, expectedVersion, selectedAlias],
    );
    if (!saved) throw conflict();
    return mailBrokerSettingsSchema.parse(saved);
  }
  if (expectedVersion !== 1) throw conflict();
  const [saved] = await tx.query(
    `INSERT INTO mail_broker_settings(owner_id,version,selected_alias)
     VALUES($1,2,$2) ON CONFLICT DO NOTHING RETURNING ${columns}`,
    [owner, selectedAlias],
  );
  if (!saved) throw conflict();
  return mailBrokerSettingsSchema.parse(saved);
}

function conflict() {
  return new ApiError(409, 'VERSION_CONFLICT', 'Reload the mail classifier.');
}
