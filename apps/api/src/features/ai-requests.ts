import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  aiRequestWriteSchema,
  aiRequestQuerySchema,
  aiRequestsResponseSchema,
  deleteItemSchema,
  aiSavedAnswerResponseSchema,
  aiSavedAnswerForgetSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import type { Config } from '../config.js';
import type { authService } from '../auth/routes.js';
import { publicAIRegistry } from '../ai/profiles.js';
import { boundTextHash, readAIRequest } from '../ai/requests.js';
import { boundAIContextHash } from '../ai/context-binding.js';
import { readAISavedAnswer } from '../ai/saved-answers.js';
import { assessAIInput } from './ai-preflight.js';
import { mutate } from '../planner/mutations.js';
import { stamp, version } from './common.js';
import { ApiError } from '../errors.js';
const idParam = (params: unknown) =>
  z.object({ id: z.string().uuid() }).parse(params).id;
export function registerAIRequests(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
  config: Config,
) {
  const registry = publicAIRegistry(config.AI_PROVIDER_PROFILES);
  const base = '/api/v1/ai/requests';
  app.get(`${base}/:id/answer`, async (request) => {
    const user = await auth.requireUser(request),
      id = idParam(request.params);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      return aiSavedAnswerResponseSchema.parse({
        answer: await readAISavedAnswer(tx, user.id, id),
      });
    });
  });
  app.delete(`${base}/:id/answer`, async (request) => {
    const user = await auth.requireUser(request),
      id = idParam(request.params);
    const input = aiSavedAnswerForgetSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'ai.answer.forget', id, input },
      async (tx) => {
        const [row] = await tx.query(
          'SELECT version,deleted_at FROM ai_saved_answers WHERE owner_id=$1 AND request_id=$2 FOR UPDATE',
          [user.id, id],
        );
        if (!row)
          throw new ApiError(404, 'NOT_FOUND', 'Saved answer is unavailable.');
        version(row, input.expectedVersion);
        if (row.deleted_at !== null)
          throw new ApiError(
            409,
            'ANSWER_FORGOTTEN',
            'This answer is already forgotten.',
          );
        await tx.query(
          'UPDATE ai_saved_answers SET output=NULL,deleted_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND request_id=$2',
          [user.id, id],
        );
        const saved = await readAISavedAnswer(tx, user.id, id);
        return {
          answer: {
            requestId: saved.requestId,
            version: saved.version,
            deletedAt: saved.deletedAt,
          },
        };
      },
    );
  });
  app.post(base, async (request, reply) => {
    const user = await auth.requireUser(request);
    const input = aiRequestWriteSchema.parse(request.body);
    const result = await mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'ai.request.create', input },
      async (tx) => {
        if (!(await auth.currentUser(request, tx)))
          throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
        const { metadata, assembled } = await assessAIInput(
          tx,
          user.id,
          input,
          registry,
        );
        const id = randomUUID();
        const preflightId = randomUUID();
        await tx.query(
          'INSERT INTO ai_preflights(id,owner_id,metadata) VALUES($1,$2,$3::jsonb)',
          [preflightId, user.id, JSON.stringify(metadata)],
        );
        const { text, operationId, ...manifest } = input;
        void operationId;
        await tx.query(
          'INSERT INTO ai_requests(id,owner_id,preflight_id,input_manifest,text_hash,context_hash) VALUES($1,$2,$3,$4::jsonb,$5,$6)',
          [
            id,
            user.id,
            preflightId,
            JSON.stringify(manifest),
            boundTextHash(user.id, id, text),
            assembled
              ? boundAIContextHash(
                  user.id,
                  id,
                  assembled.payload,
                  assembled.manifest,
                )
              : null,
          ],
        );
        return readAIRequest(tx, user.id, id);
      },
      { isolation: 'repeatable read' },
    );
    return reply.code(201).send(result);
  });
  app.get(base, async (request) => {
    const user = await auth.requireUser(request);
    const query = aiRequestQuerySchema.parse(request.query);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      const [cursor] = query.before
        ? await tx.query(
            `SELECT id,${stamp('created_at', 'cursorTimestamp').replace('.MS', '.US')} FROM ai_requests WHERE owner_id=$1 AND id=$2`,
            [user.id, query.before],
          )
        : [];
      if (query.before && !cursor)
        throw new ApiError(
          404,
          'NOT_FOUND',
          'AI request cursor not available.',
        );
      const rows = await tx.query(
        `SELECT id FROM ai_requests WHERE owner_id=$1 AND deleted_at IS NULL ${cursor ? 'AND (created_at,id)<($3::timestamptz,$4::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT $2`,
        cursor
          ? [user.id, query.limit + 1, cursor.cursorTimestamp, cursor.id]
          : [user.id, query.limit + 1],
      );
      const requests = [];
      for (const row of rows.slice(0, query.limit))
        requests.push(await readAIRequest(tx, user.id, String(row.id)));
      return aiRequestsResponseSchema.parse({
        requests,
        nextBefore:
          rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      });
    });
  });
  app.get(`${base}/:id`, async (request) => {
    const user = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      return readAIRequest(tx, user.id, idParam(request.params));
    });
  });
  for (const action of ['cancel', 'hide'] as const)
    app.route({
      method: action === 'cancel' ? 'POST' : 'DELETE',
      url: `${base}/:id${action === 'cancel' ? '/cancel' : ''}`,
      handler: async (request) => {
        const user = await auth.requireUser(request);
        const id = idParam(request.params);
        const input = deleteItemSchema.parse(request.body);
        return mutate(
          database,
          user.id,
          input.operationId,
          { kind: `ai.request.${action}`, id, input },
          async (tx) => {
            const [row] = await tx.query(
              'SELECT version,status FROM ai_requests WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
              [user.id, id],
            );
            if (!row)
              throw new ApiError(404, 'NOT_FOUND', 'AI request not available.');
            version(row, input.expectedVersion);
            if (row.status === 'uncertain')
              throw new ApiError(
                409,
                'AI_REQUEST_UNCERTAIN',
                'Confirm provider usage before changing this request.',
              );
            if (action === 'cancel' && row.status !== 'blocked')
              throw new ApiError(
                409,
                'AI_REQUEST_STATE',
                'Only a blocked request can be cancelled.',
              );
            await tx.query(
              `UPDATE ai_requests SET ${action === 'cancel' ? "status='cancelled'" : 'deleted_at=CURRENT_TIMESTAMP'},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2`,
              [user.id, id],
            );
            return readAIRequest(tx, user.id, id, true);
          },
        );
      },
    });
}
