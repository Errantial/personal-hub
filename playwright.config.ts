import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5180',
    browserName: 'chromium',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5180/api/ready',
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test',
      API_PORT: '3010',
      WEB_PORT: '5180',
      API_PROXY_TARGET: 'http://127.0.0.1:3010',
      WEB_ORIGINS: 'http://127.0.0.1:5180',
      PGLITE_DATA_DIR: resolve('.artifacts', 'e2e', randomUUID()),
      DATABASE_URL: '',
    },
    timeout: 60000,
  },
});
