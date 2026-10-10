import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildApp } from '../apps/api/src/app.ts';
import { readConfig } from '../apps/api/src/config.ts';

// An empty synthetic workspace on a dedicated loopback port. Never reads .env
// or the owner's database, never imports real providers, and never prints tokens.
const config = readConfig({
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: '3011',
  WEB_ORIGINS: 'https://localhost',
  DATABASE_URL: '',
  PGLITE_DATA_DIR: resolve('.artifacts/android-test', randomUUID()),
});
const app = await buildApp({ logger: false }, { config, runWorker: true });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
await app.listen({ host: config.API_HOST, port: config.API_PORT });
console.log(
  'Synthetic Android API: http://127.0.0.1:3011 (empty isolated workspace)',
);
