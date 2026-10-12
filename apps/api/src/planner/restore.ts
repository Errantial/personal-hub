import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';

// Only fixed server table/projection constants may be passed here.
export async function restorePlannerItem(
  tx: QueryExecutor,
  table: 'tasks' | 'events',
  columns: string,
  owner: string,
  id: string,
  expectedVersion: number,
) {
  const [old] = await tx.query(
    `SELECT version,deleted_at FROM ${table} WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
    [owner, id],
  );
  if (!old)
    throw new ApiError(404, 'NOT_FOUND', 'This item is no longer available.');
  if (old.version !== expectedVersion)
    throw new ApiError(
      409,
      'VERSION_CONFLICT',
      'This item changed elsewhere. Reload before restoring.',
    );
  if (!old.deleted_at)
    throw new ApiError(409, 'NOT_DELETED', 'This item is already active.');
  await tx.query(
    `INSERT INTO planner_restorations (owner_id,item_kind,item_id,deleted_version,deleted_at,restored_version)
     SELECT owner_id,$3,id,version,deleted_at,version+1 FROM ${table} WHERE owner_id=$1 AND id=$2`,
    [owner, id, table === 'tasks' ? 'task' : 'event'],
  );
  const [row] = await tx.query(
    `UPDATE ${table} SET deleted_at=NULL,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING ${columns}`,
    [owner, id],
  );
  // Restore only the planner record. Reminder jobs, notifications and occurrence
  // exceptions retain their current states; cancelled jobs are never requeued.
  return row;
}
