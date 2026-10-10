import { createHash } from 'node:crypto';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';

export async function mutate<T>(
  database: Database,
  ownerId: string,
  operationId: string,
  payload: unknown,
  work: (transaction: QueryExecutor) => Promise<T>,
): Promise<T> {
  const hash = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  return database.transaction(async (transaction) => {
    const [inserted] = await transaction.query(
      'INSERT INTO mutation_receipts (owner_id, operation_id, payload_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING operation_id',
      [ownerId, operationId, hash],
    );
    if (!inserted) {
      const [receipt] = await transaction.query<{
        payload_hash: string;
        result: T;
      }>(
        'SELECT payload_hash, result FROM mutation_receipts WHERE owner_id = $1 AND operation_id = $2',
        [ownerId, operationId],
      );
      if (!receipt || receipt.payload_hash !== hash)
        throw new ApiError(
          409,
          'OPERATION_CONFLICT',
          'This operation ID was already used for a different change.',
        );
      return receipt.result;
    }
    const result = await work(transaction);
    await transaction.query(
      'UPDATE mutation_receipts SET result = $3::jsonb WHERE owner_id = $1 AND operation_id = $2',
      [ownerId, operationId, JSON.stringify(result)],
    );
    return result;
  });
}

export async function missingOrConflict(
  transaction: QueryExecutor,
  table: 'tasks' | 'events',
  ownerId: string,
  id: string,
): Promise<never> {
  const [existing] = await transaction.query(
    `SELECT id FROM ${table} WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [ownerId, id],
  );
  if (!existing)
    throw new ApiError(404, 'NOT_FOUND', 'This item is no longer available.');
  throw new ApiError(
    409,
    'VERSION_CONFLICT',
    'This item changed elsewhere. Reload it before editing; your changes have not been saved.',
  );
}
