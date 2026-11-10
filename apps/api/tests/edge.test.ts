import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

const origin = 'http://127.0.0.1:5173';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Development limits (10 sign-in attempts per 15 minutes) on a fresh database. */
async function appWith(environment: Record<string, string> = {}) {
  const app = await buildApp(
    { logger: false },
    {
      config: readConfig({
        NODE_ENV: 'development',
        PGLITE_DATA_DIR: 'memory://',
        ...environment,
      }),
    },
  );
  apps.push(app);
  return app;
}
const signIn = (
  app: Awaited<ReturnType<typeof buildApp>>,
  peer: string,
  forwardedFor?: string,
) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: peer,
    headers: {
      origin,
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    payload: {
      email: 'nobody@example.test',
      password: 'synthetic-wrong-password',
    },
  });

describe('proxy trust', () => {
  it('defaults to the loopback proxy in production only and rejects other values', () => {
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://hub@localhost/hub',
      WEB_ORIGINS: 'https://hub.example.test',
    };
    expect(readConfig(production).TRUST_PROXY).toBe('loopback');
    expect(readConfig({ ...production, TRUST_PROXY: 'off' }).TRUST_PROXY).toBe(
      'off',
    );
    expect(readConfig({}).TRUST_PROXY).toBe('off');
    expect(readConfig({ NODE_ENV: 'test', TRUST_PROXY: '' }).TRUST_PROXY).toBe(
      'off',
    );
    expect(readConfig({ TRUST_PROXY: 'loopback' }).TRUST_PROXY).toBe(
      'loopback',
    );
    for (const value of ['true', '10.0.0.0/8', '1'])
      expect(() => readConfig({ TRUST_PROXY: value })).toThrow(
        'Invalid environment configuration: TRUST_PROXY',
      );
  });

  it('limits sign-in attempts per forwarded client behind a loopback proxy', async () => {
    const app = await appWith({ TRUST_PROXY: 'loopback' });
    for (let attempt = 0; attempt < 10; attempt++) {
      const reply = await signIn(app, '127.0.0.1', '203.0.113.10');
      expect(reply.statusCode).toBe(401);
      expect(reply.json().error.code).toBe('INVALID_CREDENTIALS');
    }
    const limited = await signIn(app, '127.0.0.1', '203.0.113.10');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Wait before trying again.',
      },
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['cache-control']).toBe('no-store');
    // Another client behind the same proxy keeps its own allowance, over
    // IPv4 or IPv6 loopback.
    expect((await signIn(app, '127.0.0.1', '203.0.113.20')).statusCode).toBe(
      401,
    );
    expect((await signIn(app, '::1', '2001:db8:1::5')).statusCode).toBe(401);
    // The first client stays limited whichever loopback address the proxy uses.
    expect((await signIn(app, '::1', '203.0.113.10')).statusCode).toBe(429);
  });

  it('ignores a forwarded address from a peer that is not the loopback proxy', async () => {
    const app = await appWith({ TRUST_PROXY: 'loopback' });
    // A direct client cannot buy more attempts by inventing forwarded addresses.
    for (let attempt = 0; attempt < 10; attempt++)
      expect(
        (await signIn(app, '198.51.100.7', `203.0.113.${attempt + 1}`))
          .statusCode,
      ).toBe(401);
    expect((await signIn(app, '198.51.100.7', '203.0.113.99')).statusCode).toBe(
      429,
    );
    // Nor can it spend a real client's allowance.
    expect((await signIn(app, '127.0.0.1', '203.0.113.99')).statusCode).toBe(
      401,
    );
  });

  it('keys every forwarded client on the proxy address when trust is off', async () => {
    const app = await appWith();
    for (let attempt = 0; attempt < 10; attempt++)
      expect(
        (await signIn(app, '127.0.0.1', `203.0.113.${attempt + 1}`)).statusCode,
      ).toBe(401);
    expect((await signIn(app, '127.0.0.1', '203.0.113.200')).statusCode).toBe(
      429,
    );
  });
});

describe('API response headers', () => {
  it('forbids content sniffing and caching on success, error and limit responses', async () => {
    const app = await appWith();
    for (const url of ['/api/health', '/api/v1/tasks', '/api/missing']) {
      const reply = await app.inject({ url });
      expect(reply.headers['x-content-type-options'], url).toBe('nosniff');
      expect(reply.headers['cache-control'], url).toBe('no-store');
    }
  });
});
