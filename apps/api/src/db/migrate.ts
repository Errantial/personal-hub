import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Database } from './database.js';
const directory = fileURLToPath(new URL('../../migrations/', import.meta.url));
export async function migrate(database: Database) {
  await database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  );
  const names = (await readdir(directory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  await database.transaction(async (transaction) => {
    await transaction.exec('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
    for (const name of names) {
      const sql = await readFile(`${directory}/${name}`, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const [applied] = await transaction.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [name],
      );
      if (applied) {
        if (applied.checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await transaction.exec(sql);
      await transaction.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [name, checksum],
      );
    }
  });
}
