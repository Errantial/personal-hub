import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  memorySchema,
  memoryResponseSchema,
  memoryMutationResponseSchema,
  createMemorySchema,
  updateMemorySchema,
  forgetMemorySchema,
  memorySettingsSchema,
  memorySettingsWriteSchema,
  memoryPageQuerySchema,
  memoryPageSchema,
} from '@hub/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutate } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import { stamp, version } from './common.js';

const ids = z.object({ id: z.string().uuid() });
export const memorySummaryColumns = `id,version,kind,source,title,to_char(observed_on,'YYYY-MM-DD') AS "observedOn",enabled,sensitivity,labels,${stamp('created_at', 'createdAt')},${stamp('updated_at', 'updatedAt')},${stamp('deleted_at', 'deletedAt')}`;
export const memoryColumns = `${memorySummaryColumns},content`;
export async function readMemorySettings(tx: QueryExecutor, owner: string) {
  const [row] = await tx.query(
    'SELECT version,enabled FROM memory_settings WHERE owner_id=$1',
    [owner],
  );
  return memorySettingsSchema.parse(row ?? { version: 1, enabled: false });
}
async function readMemory(
  tx: QueryExecutor,
  owner: string,
  id: string,
  lock = false,
) {
  const [row] = await tx.query(
    `SELECT ${memoryColumns} FROM memories WHERE owner_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
    [owner, id],
  );
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Memory is unavailable.');
  return memorySchema.parse(row);
}
// Never put title/content in a mutation receipt: forgetting must not leave a
// second logical copy in historical retry responses. Clients refresh detail.
function receipt(row: Record<string, unknown>) {
  return memoryMutationResponseSchema.parse({ memory: row });
}
export async function exportMemory(tx: QueryExecutor, owner: string) {
  return {
    memorySettings: await readMemorySettings(tx, owner),
    memories: (
      await tx.query(
        `SELECT ${memoryColumns} FROM memories WHERE owner_id=$1 ORDER BY id LIMIT 10001`,
        [owner],
      )
    ).map((row) => memorySchema.parse(row)),
  };
}
export function registerMemory(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/memory';
  async function snapshot<T>(
    request: FastifyRequest,
    work: (tx: QueryExecutor, owner: string) => Promise<T>,
  ) {
    const user = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      return work(tx, user.id);
    });
  }
  app.get(`${base}/settings`, (request) =>
    snapshot(request, readMemorySettings),
  );
  app.put(`${base}/settings`, async (request) => {
    const user = await auth.requireUser(request);
    const input = memorySettingsWriteSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'memory.settings', input },
      async (tx) => {
        await tx.query(
          'INSERT INTO memory_settings(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
          [user.id],
        );
        const [row] = await tx.query(
          'UPDATE memory_settings SET enabled=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND version=$2 RETURNING version,enabled',
          [user.id, input.expectedVersion, input.enabled],
        );
        if (!row)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload memory settings.',
          );
        return memorySettingsSchema.parse(row);
      },
    );
  });
  app.get(base, (request) =>
    snapshot(request, async (tx, owner) => {
      const input = memoryPageQuerySchema.parse(request.query);
      const filters = `owner_id=$1 AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR sensitivity=$3)
      AND ($4::text IS NULL OR strpos(lower(coalesce(title,'') || E'\\n' || coalesce(content,'')),lower($4))>0)`;
      const state = `($5::text='all' OR ($5='forgotten' AND deleted_at IS NOT NULL) OR ($5='active' AND deleted_at IS NULL AND enabled) OR ($5='disabled' AND deleted_at IS NULL AND NOT enabled))`;
      const values = [
        owner,
        input.kind ?? null,
        input.sensitivity ?? null,
        input.q ?? null,
        input.state,
      ];
      if (input.after) {
        const [anchor] = await tx.query(
          `SELECT version FROM memories WHERE ${filters} AND ${state} AND id=$6`,
          [...values, input.after],
        );
        if (!anchor)
          throw new ApiError(404, 'NOT_FOUND', 'Memory cursor is unavailable.');
        version(anchor, input.expectedCursorVersion);
      }
      const [counts] = await tx.query(
        `SELECT count(*) FILTER (WHERE deleted_at IS NULL AND enabled)::int AS active,count(*) FILTER (WHERE deleted_at IS NULL AND NOT enabled)::int AS disabled,count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS forgotten FROM memories WHERE ${filters}`,
        values.slice(0, 4),
      );
      const rows = await tx.query(
        `SELECT ${memorySummaryColumns} FROM memories WHERE ${filters} AND ${state} AND ($6::uuid IS NULL OR id>$6) ORDER BY id LIMIT $7`,
        [...values, input.after ?? null, input.limit + 1],
      );
      const last = rows[input.limit - 1];
      return memoryPageSchema.parse({
        memories: rows.slice(0, input.limit),
        counts,
        settings: await readMemorySettings(tx, owner),
        nextAfter:
          rows.length > input.limit && last
            ? { id: last.id, version: last.version }
            : null,
      });
    }),
  );
  app.get(`${base}/:id`, (request) =>
    snapshot(request, async (tx, owner) =>
      memoryResponseSchema.parse({
        memory: await readMemory(tx, owner, ids.parse(request.params).id),
      }),
    ),
  );
  app.post(base, async (request) => {
    const user = await auth.requireUser(request);
    const input = createMemorySchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'memory.create', input },
      async (tx) => {
        const [row] = await tx.query(
          `INSERT INTO memories(id,owner_id,kind,title,content,observed_on,enabled,sensitivity,labels) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,version,${stamp('deleted_at', 'deletedAt')}`,
          [
            randomUUID(),
            user.id,
            input.kind,
            input.title,
            input.content,
            input.observedOn,
            input.enabled,
            input.sensitivity,
            [input.sensitivity],
          ],
        );
        return receipt(row!);
      },
    );
  });
  app.put(`${base}/:id`, async (request) => {
    const user = await auth.requireUser(request);
    const { id } = ids.parse(request.params);
    const input = updateMemorySchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'memory.update', id, input },
      async (tx) => {
        const before = await readMemory(tx, user.id, id, true);
        version(before, input.expectedVersion);
        if (before.deletedAt)
          throw new ApiError(
            409,
            'MEMORY_FORGOTTEN',
            'This memory was forgotten.',
          );
        const labels = [...new Set([...before.labels, input.sensitivity])];
        const [row] = await tx.query(
          `UPDATE memories SET kind=$3,title=$4,content=$5,observed_on=$6,enabled=$7,sensitivity=$8,labels=$9,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING id,version,${stamp('deleted_at', 'deletedAt')}`,
          [
            user.id,
            id,
            input.kind,
            input.title,
            input.content,
            input.observedOn,
            input.enabled,
            input.sensitivity,
            labels,
          ],
        );
        return receipt(row!);
      },
    );
  });
  app.delete(`${base}/:id`, async (request) => {
    const user = await auth.requireUser(request);
    const { id } = ids.parse(request.params);
    const input = forgetMemorySchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'memory.forget', id, input },
      async (tx) => {
        const before = await readMemory(tx, user.id, id, true);
        version(before, input.expectedVersion);
        if (before.deletedAt)
          throw new ApiError(
            409,
            'MEMORY_FORGOTTEN',
            'This memory was forgotten.',
          );
        const [row] = await tx.query(
          `UPDATE memories SET title=NULL,content=NULL,observed_on=NULL,enabled=false,deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING id,version,${stamp('deleted_at', 'deletedAt')}`,
          [user.id, id],
        );
        return receipt(row!);
      },
    );
  });
}
