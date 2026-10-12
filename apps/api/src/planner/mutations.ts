import { createHash } from 'node:crypto';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { lockSchedule } from './schedule-lock.js';

export function mutateSchedule<T>(
  database: Database,
  owner: string,
  operationId: string,
  payload: unknown,
  work: (tx: QueryExecutor) => Promise<T>,
  options: { isolation?: 'repeatable read' } = {},
) {
  return mutate(
    database,
    owner,
    operationId,
    payload,
    async (tx) => {
      await lockSchedule(tx, owner);
      return work(tx);
    },
    options,
  );
}

export async function mutate<T>(
  database: Database,
  ownerId: string,
  operationId: string,
  payload: unknown,
  work: (transaction: QueryExecutor) => Promise<T>,
  options: { isolation?: 'repeatable read' } = {},
): Promise<T> {
  const hash = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  const attempt = () =>
    database.transaction(async (transaction) => {
      if (options.isolation)
        await transaction.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
        );
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
      if (
        payload &&
        typeof payload === 'object' &&
        'kind' in payload &&
        typeof payload.kind === 'string' &&
        (payload.kind.startsWith('event.') || payload.kind.startsWith('task.'))
      )
        await lockSchedule(transaction, ownerId);
      const result = await work(transaction);
      await transaction.query(
        'UPDATE mutation_receipts SET result = $3::jsonb WHERE owner_id = $1 AND operation_id = $2',
        [ownerId, operationId, JSON.stringify(result)],
      );
      return result;
    });
  // Repeatable snapshots can lose a concurrent receipt-insert race on PostgreSQL.
  // Retry only rolled-back snapshot transactions; work must have no external side effects.
  for (let remaining = 3; ; remaining--) {
    try {
      return await attempt();
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error ? error.code : null;
      if (!options.isolation || !['40001', '40P01'].includes(String(code)))
        throw error;
      if (!remaining)
        throw new ApiError(
          409,
          'RETRY_REQUIRED',
          'Retry this operation with the same operation ID.',
        );
    }
  }
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
