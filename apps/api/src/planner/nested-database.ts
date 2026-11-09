import type { Database, QueryExecutor } from '../db/database.js';

const sequences = new WeakMap<QueryExecutor, number>();
const wrapped = new WeakMap<QueryExecutor, Database>();

/** Nested planner receipts and effects share the caller's transaction via savepoints. */
export function transactionDatabase(tx: QueryExecutor): Database {
  const existing = wrapped.get(tx);
  if (existing) return existing;
  const db: Database = {
    ...tx,
    async transaction(work) {
      const next = (sequences.get(tx) ?? 0) + 1;
      sequences.set(tx, next);
      const savepoint = `nested_action_${next}`;
      await tx.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = await work(tx);
        await tx.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await tx.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await tx.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    },
    async close() {
      throw new Error('Cannot close an active transaction.');
    },
  };
  wrapped.set(tx, db);
  wrapped.set(db, db);
  return db;
}
