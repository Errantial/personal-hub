import type { QueryExecutor } from '../db/database.js';
export async function lockSchedule(tx: QueryExecutor, owner: string) {
  await tx.query(
    'INSERT INTO planner_schedule_locks(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [owner],
  );
  // Advancing a row version also invalidates a waiting repeatable-read snapshot;
  // a lock alone would let a competing plan approve against stale calendar rows.
  await tx.query(
    'UPDATE planner_schedule_locks SET revision=revision+1 WHERE owner_id=$1 RETURNING revision',
    [owner],
  );
}
