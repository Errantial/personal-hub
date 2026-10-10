import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
const environmentPath = fileURLToPath(
  new URL('../../../.env', import.meta.url),
);
if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);
async function run() {
  const database = await openDatabase(readConfig(process.env));
  try {
    await migrate(database);
    console.log('Database migrations are up to date.');
  } finally {
    await database.close();
  }
}
void run().catch(() => {
  console.error(
    'Migration failed. Check environment settings, database availability and migration history.',
  );
  process.exitCode = 1;
});
