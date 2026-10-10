import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapResponseSchema, healthResponseSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appForTest() {
  const app = await buildApp(
    { logger: false },
    { config: readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' }) },
  );
  apps.push(app);
  return app;
}

describe('API boundary', () => {
  it('returns a health response matching the shared client contract', async () => {
    const response = await (
      await appForTest()
    ).inject({
      method: 'GET',
      url: '/api/health',
    });
    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json()).status).toBe('ok');
  });

  it('reports every connection as unconfigured and disables caching', async () => {
    const response = await (
      await appForTest()
    ).inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
    });
    expect(response.statusCode).toBe(200);
    const data = bootstrapResponseSchema.parse(response.json());
    expect(new Set(data.connections.map((item) => item.id)).size).toBe(4);
    expect(
      data.connections.every((item) => item.status === 'not_configured'),
    ).toBe(true);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('rejects unimplemented routes without reflecting secret query values', async () => {
    const response = await (
      await appForTest()
    ).inject({
      method: 'GET',
      url: '/api/tasks?token=synthetic-secret',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(response.body).not.toContain('synthetic-secret');
  });

  it('rejects invalid ports without exposing environment values', () => {
    expect(readConfig({}).API_HOST).toBe('127.0.0.1');
    for (const port of ['0', '65536', '1.5', 'synthetic-secret']) {
      expect(() => readConfig({ API_PORT: port })).toThrow(
        'Invalid environment configuration: API_PORT',
      );
    }
  });

  it('sanitizes unexpected errors instead of returning private exception text', async () => {
    const app = await appForTest();
    app.get('/api/test-error', () => {
      throw new Error('synthetic-private-exception');
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/test-error',
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('synthetic-private-exception');
  });
});
