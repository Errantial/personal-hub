import { z } from 'zod';
import {
  accountResponseSchema,
  changePasswordSchema,
  deleteItemSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import type { authService } from './routes.js';
import { hashPassword, verifyPassword } from './password.js';
import { ApiError } from '../errors.js';
import { mutate } from '../planner/mutations.js';
import { stamp } from '../features/common.js';

export function registerAccount(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.get('/api/v1/auth/account', async (request) => {
    const user = await auth.requireUser(request);
    const [account] = await database.query<{ version: number }>(
      'SELECT credential_version AS version FROM users WHERE id=$1',
      [user.id],
    );
    const sessions = await database.query(
      `SELECT id,version,${stamp('created_at', 'createdAt')},${stamp('expires_at', 'expiresAt')},token_hash=$2 AS current FROM sessions WHERE owner_id=$1 AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP ORDER BY created_at DESC,id`,
      [user.id, auth.sessionHash(request)],
    );
    return accountResponseSchema.parse({
      user,
      version: account!.version,
      sessions,
    });
  });
  app.post('/api/v1/auth/sessions/:id/revoke', async (request) => {
    const user = await auth.requireUser(request);
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    const input = deleteItemSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'session-revoke', id, ...input },
      async (tx) => {
        if (!(await auth.currentUser(request, tx)))
          throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
        const [session] = await tx.query<{ version: number; current: boolean }>(
          'SELECT version,token_hash=$3 AS current FROM sessions WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP FOR UPDATE',
          [user.id, id, auth.sessionHash(request)],
        );
        if (!session)
          throw new ApiError(404, 'NOT_FOUND', 'Session no longer active.');
        if (session.current)
          throw new ApiError(
            400,
            'CURRENT_SESSION',
            'Use Sign out for this session.',
          );
        if (session.version !== input.expectedVersion)
          throw new ApiError(409, 'VERSION_CONFLICT', 'Reload sessions first.');
        await tx.query(
          'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1 AND owner_id=$2',
          [id, user.id],
        );
        return { ok: true as const };
      },
    );
  });
  // Credential changes are online-only, reauthenticated, version guarded and
  // intentionally excluded from planner receipts/outboxes (no password payloads).
  app.post(
    '/api/v1/auth/password',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const user = await auth.requireUser(request);
      const input = changePasswordSchema.parse(request.body);
      const [initial] = await database.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id=$1',
        [user.id],
      );
      if (
        !initial ||
        !(await verifyPassword(input.currentPassword, initial.password_hash))
      )
        throw new ApiError(
          400,
          'PASSWORD_MISMATCH',
          'Current password is incorrect.',
        );
      const newHash = await hashPassword(input.newPassword);
      const session = await database.transaction(async (tx) => {
        const [account] = await tx.query<{
          password_hash: string;
          version: number;
        }>(
          'SELECT password_hash,credential_version AS version FROM users WHERE id=$1 FOR UPDATE',
          [user.id],
        );
        if (!(await auth.currentUser(request, tx)))
          throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
        if (
          !account ||
          account.version !== input.expectedVersion ||
          account.password_hash !== initial.password_hash
        )
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload account settings first.',
          );
        await tx.query(
          'UPDATE users SET password_hash=$2,credential_version=credential_version+1 WHERE id=$1',
          [user.id, newHash],
        );
        await tx.query(
          'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND revoked_at IS NULL',
          [user.id],
        );
        return auth.issueSession(tx, user.id);
      });
      const expiresAt = auth.setSession(reply, session);
      return { user, setupRequired: false, expiresAt };
    },
  );
}
