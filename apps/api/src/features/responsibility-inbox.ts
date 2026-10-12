import { z } from 'zod';
import {
  responsibilityInboxQuerySchema,
  responsibilityInboxSchema,
  responsibilityAttentionSchema,
  responsibilityDismissBatchSchema,
  responsibilityDismissBatchResponseSchema,
  responsibilityRunSchema,
  responsibilityInboxEntrySchema,
} from '@hub/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutate } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import { stamp, version } from './common.js';
import {
  readResponsibility,
  appendResponsibilityActivity,
  responsibilityRunColumns,
} from './responsibilities.js';

export function registerResponsibilityInbox(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/responsibilities';
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
  app.get(`${base}/attention`, (request) =>
    snapshot(request, async (tx, owner) => {
      z.strictObject({}).parse(request.query);
      const asOf = new Date().toISOString();
      const [parents] = await tx.query(
        `SELECT count(*) FILTER(WHERE deleted_at IS NULL AND status='active')::int AS active,count(*) FILTER(WHERE deleted_at IS NULL AND status='paused')::int AS paused,count(*) FILTER(WHERE deleted_at IS NULL AND status='cancelled')::int AS cancelled,count(*) FILTER(WHERE deleted_at IS NOT NULL)::int AS deleted FROM responsibilities WHERE owner_id=$1`,
        [owner],
      );
      const [runs] = await tx.query(
        `SELECT count(*) FILTER(WHERE status='blocked')::int AS blocked,count(*) FILTER(WHERE status='cancelled')::int AS cancelled FROM responsibility_runs WHERE owner_id=$1`,
        [owner],
      );
      const [due] = await tx.query(
        `SELECT count(*)::int AS count FROM responsibility_schedules s JOIN responsibilities r ON r.owner_id=s.owner_id AND r.id=s.responsibility_id WHERE r.owner_id=$1 AND r.status='active' AND r.deleted_at IS NULL AND s.deleted_at IS NULL AND s.next_due_at<=$2::timestamptz`,
        [owner, asOf],
      );
      return responsibilityAttentionSchema.parse({
        asOf,
        responsibilities: parents,
        runs,
        dueCount: due!.count,
        executionEnabled: false,
      });
    }),
  );
  app.get(`${base}/runs/inbox`, (request) =>
    snapshot(request, async (tx, owner) => {
      const input = responsibilityInboxQuerySchema.parse(request.query);
      if (input.responsibilityId) {
        const [parent] = await tx.query(
          'SELECT id FROM responsibilities WHERE owner_id=$1 AND id=$2',
          [owner, input.responsibilityId],
        );
        if (!parent)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Responsibility is unavailable.',
          );
      }
      const filter = `owner_id=$1 AND ($2::text='all' OR trigger=$2) AND ($3::uuid IS NULL OR responsibility_id=$3)`;
      const eligible = `${filter} AND ($4::text='all' OR status=$4)`;
      const values = [
        owner,
        input.trigger,
        input.responsibilityId ?? null,
        input.status,
      ];
      let cursorTime: unknown = null;
      if (input.after) {
        const [anchor] = await tx.query(
          `SELECT version,${stamp('created_at', 'cursorTime').replace('.MS', '.US')} FROM responsibility_runs WHERE ${eligible} AND id=$5`,
          [...values, input.after],
        );
        if (!anchor)
          throw new ApiError(404, 'NOT_FOUND', 'Run cursor is unavailable.');
        version(anchor, input.expectedCursorVersion);
        cursorTime = anchor.cursorTime;
      }
      const [counts] = await tx.query(
        `SELECT count(*) FILTER(WHERE status='blocked')::int AS blocked,count(*) FILTER(WHERE status='cancelled')::int AS cancelled FROM responsibility_runs WHERE ${filter}`,
        values.slice(0, 3),
      );
      const rows = await tx.query(
        `SELECT ${responsibilityRunColumns},(SELECT jsonb_build_object('id',p.id,'version',p.version,'title',p.title,'status',p.status,'labels',p.labels,'deletedAt',to_char(p.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM responsibilities p WHERE p.owner_id=responsibility_runs.owner_id AND p.id=responsibility_runs.responsibility_id) AS current FROM responsibility_runs WHERE ${eligible} AND ($5::uuid IS NULL OR (created_at,id)<($6::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $7`,
        [...values, input.after ?? null, cursorTime, input.limit + 1],
      );
      const entries = [];
      for (const row of rows.slice(0, input.limit)) {
        const run = responsibilityRunSchema.parse(row);
        if (!row.current)
          throw new ApiError(
            409,
            'SOURCE_UNAVAILABLE',
            'Run source is unavailable.',
          );
        const current = responsibilityInboxEntrySchema.shape.current.parse(
          row.current,
        );
        entries.push({
          run,
          current,
          sourceChanged: current.version !== run.responsibilityVersion,
        });
      }
      const last = rows[input.limit - 1];
      return responsibilityInboxSchema.parse({
        entries,
        counts,
        nextAfter:
          rows.length > input.limit && last
            ? { id: last.id, version: last.version }
            : null,
        executionEnabled: false,
      });
    }),
  );
  app.post(`${base}/runs/dismiss-batch`, async (request) => {
    const user = await auth.requireUser(request);
    const input = responsibilityDismissBatchSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'responsibility.runs.dismiss-batch', input },
      async (tx) => {
        const selected = [];
        for (const item of input.items) {
          const [row] = await tx.query(
            'SELECT id,responsibility_id AS "responsibilityId" FROM responsibility_runs WHERE owner_id=$1 AND id=$2',
            [user.id, item.id],
          );
          if (!row)
            throw new ApiError(
              404,
              'NOT_FOUND',
              'Selected run is unavailable.',
            );
          selected.push({
            id: String(row.id),
            parentId: String(row.responsibilityId),
            expectedVersion: item.expectedVersion,
          });
        }
        // Match the lifecycle/due-admission parent-first canonical lock order.
        // Re-read runs after locks so a concurrent pause/edit cannot be overwritten.
        const parents = new Map();
        for (const id of [
          ...new Set(selected.map((item) => item.parentId)),
        ].sort())
          parents.set(id, await readResponsibility(tx, user.id, id, true));
        const runs = [];
        for (const item of selected.sort((a, b) => a.id.localeCompare(b.id))) {
          const [before] = await tx.query(
            'SELECT version,status FROM responsibility_runs WHERE owner_id=$1 AND id=$2 FOR UPDATE',
            [user.id, item.id],
          );
          if (!before)
            throw new ApiError(
              404,
              'NOT_FOUND',
              'Selected run is unavailable.',
            );
          version(before, item.expectedVersion);
          if (before.status !== 'blocked')
            throw new ApiError(
              409,
              'RUN_STATE',
              'Selected run was already cancelled.',
            );
          const [after] = await tx.query(
            `UPDATE responsibility_runs SET status='cancelled',cancel_reason='owner-dismissed',cancelled_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING ${responsibilityRunColumns}`,
            [user.id, item.id],
          );
          const run = responsibilityRunSchema.parse(after);
          await appendResponsibilityActivity(
            tx,
            user.id,
            parents.get(item.parentId)!,
            'run-dismissed',
            run.id,
          );
          runs.push(run);
        }
        return responsibilityDismissBatchResponseSchema.parse({
          runs,
          executionEnabled: false,
        });
      },
    );
  });
}
