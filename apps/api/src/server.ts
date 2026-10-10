import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { readConfig } from './config.js';

const environmentPath = fileURLToPath(
  new URL('../../../.env', import.meta.url),
);
if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);
async function start() {
  const config = readConfig(process.env);
  const app = await buildApp(
    {
      logger: {
        level: config.LOG_LEVEL,
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        serializers: {
          req: (request) => ({ method: request.method, id: request.id }),
        },
      },
    },
    { config },
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }

  try {
    await app.listen({ host: config.API_HOST, port: config.API_PORT });
  } catch {
    app.log.error('Unable to start API. Check the configured host and port.');
    process.exitCode = 1;
    await app.close();
  }
}
void start().catch(() => {
  console.error(
    'Unable to initialize API. Check environment settings, database availability and migration history.',
  );
  process.exitCode = 1;
});
