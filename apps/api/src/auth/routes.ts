import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loginRequestSchema, setupRequestSchema } from '@hub/contracts';
import type { User } from '@hub/contracts';
import type { Database } from '../db/database.js';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';
import { hashPassword, verifyPassword } from './password.js';
const cookieName = 'hub_session';
const sessionDuration = 7 * 24 * 60 * 60;
const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export function authService(database: Database, config: Config) {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.NODE_ENV === 'production',
    path: '/',
  };
  async function currentUser(request: FastifyRequest): Promise<User | null> {
    const token = request.cookies[cookieName];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const [user] = await database.query<{ id: string; email: string }>(
      'SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.owner_id WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP',
      [tokenHash(token)],
    );
    return user ?? null;
  }
  async function requireUser(request: FastifyRequest) {
    const user = await currentUser(request);
    if (!user)
      throw new ApiError(
        401,
        'UNAUTHENTICATED',
        'Sign in to access your workspace.',
      );
    return user;
  }
  async function createSession(ownerId: string, reply: FastifyReply) {
    const token = randomBytes(32).toString('hex');
    await database.query(
      'DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP',
    );
    await database.query(
      'INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES ($1, $2, $3)',
      [
        tokenHash(token),
        ownerId,
        new Date(Date.now() + sessionDuration * 1000),
      ],
    );
    reply.setCookie(cookieName, token, {
      ...cookieOptions,
      maxAge: sessionDuration,
    });
  }
  function setupAllowed(token?: string) {
    if (config.NODE_ENV !== 'production') return true;
    if (!config.SETUP_TOKEN || !token) return false;
    const expected = Buffer.from(config.SETUP_TOKEN);
    const actual = Buffer.from(token);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
  return {
    currentUser,
    requireUser,
    createSession,
    setupAllowed,
    cookieOptions,
  };
}
export function registerAuth(
  app: FastifyInstance,
  database: Database,
  config: Config,
) {
  const auth = authService(database, config);
  const limit = { rateLimit: { max: 10, timeWindow: '15 minutes' } };
  app.get('/api/v1/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const [owner] = await database.query(
      'SELECT owner_id FROM owner_setup WHERE singleton = 1',
    );
    return { user: await auth.currentUser(request), setupRequired: !owner };
  });
  app.post('/api/v1/auth/setup', { config: limit }, async (request, reply) => {
    const input = setupRequestSchema.parse(request.body);
    if (!auth.setupAllowed(input.setupToken))
      throw new ApiError(
        403,
        'SETUP_DISABLED',
        'A valid setup token is required.',
      );
    const [existing] = await database.query(
      'SELECT owner_id FROM owner_setup WHERE singleton = 1',
    );
    if (existing)
      throw new ApiError(
        409,
        'OWNER_EXISTS',
        'This workspace already has an owner. Sign in instead.',
      );
    const user = { id: randomUUID(), email: input.email };
    const passwordHash = await hashPassword(input.password);
    try {
      await database.transaction(async (transaction) => {
        await transaction.query(
          'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
          [user.id, user.email, passwordHash],
        );
        await transaction.query(
          'INSERT INTO owner_setup (singleton, owner_id) VALUES (1, $1)',
          [user.id],
        );
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      )
        throw new ApiError(
          409,
          'OWNER_EXISTS',
          'This workspace already has an owner. Sign in instead.',
        );
      throw error;
    }
    await auth.createSession(user.id, reply);
    return reply.code(201).send({ user, setupRequired: false });
  });
  app.post('/api/v1/auth/login', { config: limit }, async (request, reply) => {
    const input = loginRequestSchema.parse(request.body);
    const [user] = await database.query<{
      id: string;
      email: string;
      password_hash: string;
    }>('SELECT id, email, password_hash FROM users WHERE email = $1', [
      input.email,
    ]);
    const hash =
      user?.password_hash ?? `scrypt-v1:${'0'.repeat(32)}:${'0'.repeat(128)}`;
    if (!(await verifyPassword(input.password, hash)) || !user)
      throw new ApiError(
        401,
        'INVALID_CREDENTIALS',
        'Email or password is incorrect.',
      );
    await auth.createSession(user.id, reply);
    return { user: { id: user.id, email: user.email }, setupRequired: false };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[cookieName];
    if (token)
      await database.query('DELETE FROM sessions WHERE token_hash = $1', [
        tokenHash(token),
      ]);
    reply.clearCookie(cookieName, auth.cookieOptions);
    return { ok: true };
  });
  return auth;
}
