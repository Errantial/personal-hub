import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canvasConnectionSchema,
  canvasSettingsSchema,
  canvasItemWriteSchema,
  canvasUploadSchema,
  canvasJobResponseSchema,
  canvasItemSchema,
  canvasItemsResponseSchema,
  canvasItemInRange,
  rangeSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { Config } from '../config.js';
import type { authService } from '../auth/routes.js';
import { mutate } from '../planner/mutations.js';
import { stamp, strongest, active } from '../features/common.js';
import { ApiError } from '../errors.js';
import { FeedError, parseCanvasFeed, fetchCanvasFeed } from './canvas-feed.js';
import type { FeedEntry, FeedFetcher } from './canvas-feed.js';

export const canvasItemColumns = `id,uid,input_kind AS "inputKind",provider_data AS "providerData",availability,notes,sensitivity,version,course_id AS "courseId",
  (SELECT c.name FROM courses c WHERE c.id=canvas_items.course_id AND c.owner_id=canvas_items.owner_id) AS "courseName",
  COALESCE((SELECT c.deleted_at IS NOT NULL FROM courses c WHERE c.id=canvas_items.course_id AND c.owner_id=canvas_items.owner_id),FALSE) AS "courseDeleted",
  (SELECT c.sensitivity FROM courses c WHERE c.id=canvas_items.course_id AND c.owner_id=canvas_items.owner_id) AS "courseSensitivity",
  ${stamp('created_at', 'createdAt')},${stamp('updated_at', 'updatedAt')}`;
export function canvasEffectiveSensitivity(
  source: unknown,
  item: Record<string, unknown>,
) {
  return strongest(
    String(source ?? 'unlabeled'),
    String(item.sensitivity),
    String(item.courseSensitivity ?? 'unlabeled'),
  );
}
export async function readCanvasItems(
  tx: QueryExecutor,
  owner: string,
  courseId?: string,
) {
  const [source] = await tx.query(
    `SELECT sensitivity,${stamp('last_imported_at', 'lastImportedAt')} FROM canvas_sources WHERE owner_id=$1`,
    [owner],
  );
  const rows = await tx.query(
    `SELECT ${canvasItemColumns} FROM canvas_items WHERE owner_id=$1${courseId ? ' AND course_id=$2' : ''} ORDER BY (provider_data->>'startDate') NULLS LAST,(provider_data->>'startsAt') NULLS LAST,id LIMIT 2001`,
    courseId ? [owner, courseId] : [owner],
  );
  if (rows.length > 2000)
    throw new ApiError(
      413,
      'CANVAS_ITEMS_LIMIT',
      'Too many retained Canvas entries.',
    );
  return {
    lastImportedAt: source?.lastImportedAt ?? null,
    items: rows.map((row) =>
      canvasItemSchema.parse({
        ...row,
        effectiveSensitivity: canvasEffectiveSensitivity(
          source?.sensitivity,
          row,
        ),
      }),
    ),
  };
}
export const canvasJobColumns = `id,trigger,status,attempts,error_code AS "errorCode",counts,${stamp('created_at', 'createdAt')},${stamp('updated_at', 'updatedAt')}`;
async function ensure(tx: QueryExecutor, owner: string) {
  await tx.query(
    'INSERT INTO canvas_sources(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [owner],
  );
}
async function feedConfigured(
  tx: QueryExecutor,
  owner: string,
  config: Config,
) {
  if (!config.CANVAS_CALENDAR_FEED_URL) return false;
  const [setup] = await tx.query(
    'SELECT owner_id FROM owner_setup WHERE singleton=1',
  );
  return setup?.owner_id === owner;
}
export async function applyCanvasSnapshot(
  tx: QueryExecutor,
  owner: string,
  entries: FeedEntry[],
  inputKind: 'calendar-feed' | 'calendar-file' = 'calendar-feed',
) {
  const counts = { added: 0, updated: 0, missing: 0 };
  for (const entry of entries) {
    const [old] = await tx.query(
      'SELECT provider_data,availability,input_kind FROM canvas_items WHERE owner_id=$1 AND uid=$2 FOR UPDATE',
      [owner, entry.uid],
    );
    // Minimal cancellation notices retain the last known title/time and description.
    const data =
      entry.cancelled && !entry.data.startsAt && !entry.data.startDate && old
        ? old.provider_data
        : entry.data;
    const availability = entry.cancelled ? 'cancelled' : 'available';
    const kind = old && data === old.provider_data ? old.input_kind : inputKind;
    if (!old) {
      await tx.query(
        'INSERT INTO canvas_items(id,owner_id,uid,provider_data,availability,input_kind) VALUES($1,$2,$3,$4::jsonb,$5,$6)',
        [
          randomUUID(),
          owner,
          entry.uid,
          JSON.stringify(data),
          availability,
          kind,
        ],
      );
      counts.added++;
    } else {
      const updated = await tx.query(
        'UPDATE canvas_items SET provider_data=$3::jsonb,availability=$4,input_kind=$5,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND uid=$2 AND (provider_data IS DISTINCT FROM $3::jsonb OR availability<>$4 OR input_kind<>$5) RETURNING id',
        [owner, entry.uid, JSON.stringify(data), availability, kind],
      );
      counts.updated += updated.length;
    }
  }
  counts.missing = (
    await tx.query(
      "UPDATE canvas_items SET availability='missing',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND availability='available' AND NOT(uid=ANY($2::text[])) RETURNING id",
      [owner, entries.map((entry) => entry.uid)],
    )
  ).length;
  await tx.query(
    'UPDATE canvas_sources SET last_imported_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
    [owner],
  );
  return counts;
}
export async function runCanvasSync(
  database: Database,
  config: Config,
  fetcher: FeedFetcher = fetchCanvasFeed,
) {
  if (!config.CANVAS_CALENDAR_FEED_URL) return;
  const claim = await database.transaction(async (tx) => {
    const [source] = await tx.query<{ owner_id: string; due: boolean }>(
      "SELECT owner_id,(enabled AND next_sync_at<=CURRENT_TIMESTAMP) AS due FROM canvas_sources s WHERE s.owner_id=(SELECT owner_id FROM owner_setup WHERE singleton=1) AND ((enabled AND next_sync_at<=CURRENT_TIMESTAMP) OR EXISTS(SELECT 1 FROM canvas_sync_jobs j WHERE j.owner_id=s.owner_id AND (j.status='queued' OR (j.status='running' AND j.lease_until<=CURRENT_TIMESTAMP)))) ORDER BY next_sync_at FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    if (!source) return null;
    // Expired leases survive restart; three interrupted attempts become a visible failure.
    await tx.query(
      "UPDATE canvas_sync_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error_code=CASE WHEN attempts>=3 THEN 'LEASE_EXPIRED' ELSE NULL END,lease_token=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND status='running' AND lease_until<=CURRENT_TIMESTAMP",
      [source.owner_id],
    );
    if (source.due) {
      await tx.query(
        "INSERT INTO canvas_sync_jobs(id,owner_id,trigger,status) VALUES($1,$2,'automatic','queued') ON CONFLICT DO NOTHING",
        [randomUUID(), source.owner_id],
      );
      await tx.query(
        "UPDATE canvas_sources SET next_sync_at=CURRENT_TIMESTAMP+INTERVAL '15 minutes' WHERE owner_id=$1",
        [source.owner_id],
      );
    }
    const [job] = await tx.query<{ id: string; owner_id: string }>(
      "SELECT id,owner_id FROM canvas_sync_jobs WHERE owner_id=$1 AND status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
      [source.owner_id],
    );
    if (!job) return null;
    const token = randomUUID();
    await tx.query(
      "UPDATE canvas_sync_jobs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=CURRENT_TIMESTAMP+INTERVAL '30 seconds',updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [job.id, token],
    );
    return { ...job, token };
  });
  if (!claim) return;
  try {
    const entries = parseCanvasFeed(
      await fetcher(config.CANVAS_CALENDAR_FEED_URL),
    );
    await database.transaction(async (tx) => {
      // Source lock also serializes settings/upload and prevents late completion after pause.
      await tx.query(
        'SELECT owner_id FROM canvas_sources WHERE owner_id=$1 FOR UPDATE',
        [claim.owner_id],
      );
      const [active] = await tx.query(
        "SELECT id FROM canvas_sync_jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>CURRENT_TIMESTAMP FOR UPDATE",
        [claim.id, claim.token],
      );
      if (!active) return;
      const counts = await applyCanvasSnapshot(tx, claim.owner_id, entries);
      await tx.query(
        "UPDATE canvas_sync_jobs SET status='succeeded',counts=$2::jsonb,error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
        [claim.id, JSON.stringify(counts)],
      );
    });
  } catch (error) {
    const code = error instanceof FeedError ? error.code : 'SYNC_FAILED';
    await database.query(
      "UPDATE canvas_sync_jobs SET status='failed',error_code=$3,lease_token=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND lease_token=$2 AND status='running'",
      [claim.id, claim.token, code],
    );
  }
}
export function startCanvasWorker(
  database: Database,
  config: Config,
  fetcher?: FeedFetcher,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;
  async function tick() {
    await runCanvasSync(database, config, fetcher).catch(() => undefined);
    if (!stopped)
      timer = setTimeout(() => {
        running = tick();
      }, 5000);
  }
  running = tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
export function registerCanvas(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
  config: Config,
) {
  const base = '/api/v1/connections/canvas';
  app.get(`${base}/calendar`, async (request) => {
    const user = await auth.requireUser(request);
    const range = rangeSchema.parse(request.query);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const result = await readCanvasItems(tx, user.id);
      return canvasItemsResponseSchema.parse({
        ...result,
        items: result.items.filter((item) =>
          canvasItemInRange(item, range.from, range.to, range.timeZone),
        ),
      });
    });
  });
  app.get(`${base}/items`, async (request) => {
    const user = await auth.requireUser(request);
    const { courseId } = z
      .strictObject({ courseId: z.string().uuid() })
      .parse(request.query);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const [owned] = await tx.query(
        'SELECT id FROM courses WHERE owner_id=$1 AND id=$2',
        [user.id, courseId],
      );
      if (!owned) throw new ApiError(404, 'NOT_FOUND', 'Class not available.');
      return canvasItemsResponseSchema.parse(
        await readCanvasItems(tx, user.id, courseId),
      );
    });
  });
  app.get(base, async (request) => {
    const user = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await ensure(tx, user.id);
      const [source] = await tx.query(
        `SELECT version,enabled,sensitivity,${stamp('last_imported_at', 'lastImportedAt')} FROM canvas_sources WHERE owner_id=$1`,
        [user.id],
      );
      const items = await tx.query(
        `SELECT ${canvasItemColumns} FROM canvas_items WHERE owner_id=$1 ORDER BY availability,(provider_data->>'startDate') NULLS LAST,(provider_data->>'startsAt') NULLS LAST,id LIMIT 2001`,
        [user.id],
      );
      if (items.length > 2000)
        throw new ApiError(
          413,
          'CANVAS_ITEMS_LIMIT',
          'Too many retained Canvas entries.',
        );
      return canvasConnectionSchema.parse({
        ...source,
        configured: await feedConfigured(tx, user.id, config),
        jobs: await tx.query(
          `SELECT ${canvasJobColumns} FROM canvas_sync_jobs WHERE owner_id=$1 ORDER BY created_at DESC,id LIMIT 20`,
          [user.id],
        ),
        items: items.map((item) => ({
          ...item,
          effectiveSensitivity: canvasEffectiveSensitivity(
            source!.sensitivity,
            item,
          ),
        })),
      });
    });
  });
  app.put(base, async (request) => {
    const user = await auth.requireUser(request);
    const input = canvasSettingsSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'canvas.settings', input },
      async (tx) => {
        await ensure(tx, user.id);
        if (input.enabled && !(await feedConfigured(tx, user.id, config)))
          throw new ApiError(
            409,
            'CANVAS_NOT_CONFIGURED',
            'Configure the server feed first.',
          );
        const saved = await tx.query(
          'UPDATE canvas_sources SET enabled=$3,sensitivity=$4,version=version+1,next_sync_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND version=$2 RETURNING version',
          [user.id, input.expectedVersion, input.enabled, input.sensitivity],
        );
        if (!saved.length)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload connection settings.',
          );
        if (!input.enabled)
          await tx.query(
            "UPDATE canvas_sync_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND status IN ('queued','running')",
            [user.id],
          );
        return { ok: true };
      },
    );
  });
  app.post(`${base}/sync`, async (request) => {
    const user = await auth.requireUser(request);
    const input = z
      .strictObject({ operationId: z.string().uuid() })
      .parse(request.body);
    if (!config.CANVAS_CALENDAR_FEED_URL)
      throw new ApiError(
        409,
        'CANVAS_NOT_CONFIGURED',
        'Configure the server feed first.',
      );
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'canvas.sync' },
      async (tx) => {
        if (!(await feedConfigured(tx, user.id, config)))
          throw new ApiError(
            409,
            'CANVAS_NOT_CONFIGURED',
            'Configure the server feed first.',
          );
        await ensure(tx, user.id);
        await tx.query(
          'SELECT owner_id FROM canvas_sources WHERE owner_id=$1 FOR UPDATE',
          [user.id],
        );
        const id = randomUUID();
        await tx.query(
          "INSERT INTO canvas_sync_jobs(id,owner_id,trigger,status) VALUES($1,$2,'manual','queued') ON CONFLICT DO NOTHING",
          [id, user.id],
        );
        const [job] = await tx.query(
          `SELECT ${canvasJobColumns} FROM canvas_sync_jobs WHERE owner_id=$1 AND status IN ('queued','running')`,
          [user.id],
        );
        return canvasJobResponseSchema.parse({ job });
      },
    );
  });
  app.post(
    `${base}/import`,
    { bodyLimit: 2 * 1024 * 1024 },
    async (request) => {
      const user = await auth.requireUser(request);
      const input = canvasUploadSchema.parse(request.body);
      const entries = parseCanvasFeed(input.feed);
      return mutate(
        database,
        user.id,
        input.operationId,
        { kind: 'canvas.upload', feed: input.feed },
        async (tx) => {
          await ensure(tx, user.id);
          await tx.query(
            'SELECT owner_id FROM canvas_sources WHERE owner_id=$1 FOR UPDATE',
            [user.id],
          );
          const active = await tx.query(
            "SELECT id FROM canvas_sync_jobs WHERE owner_id=$1 AND status IN ('queued','running')",
            [user.id],
          );
          if (active.length)
            throw new ApiError(
              409,
              'CANVAS_SYNC_ACTIVE',
              'Wait for the active refresh or pause it.',
            );
          const counts = await applyCanvasSnapshot(
            tx,
            user.id,
            entries,
            'calendar-file',
          );
          const [job] = await tx.query(
            `INSERT INTO canvas_sync_jobs(id,owner_id,trigger,status,counts) VALUES($1,$2,'upload','succeeded',$3::jsonb) RETURNING ${canvasJobColumns}`,
            [randomUUID(), user.id, JSON.stringify(counts)],
          );
          return canvasJobResponseSchema.parse({ job });
        },
      );
    },
  );
  app.put(`${base}/items/:id`, async (request) => {
    const user = await auth.requireUser(request);
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    const input = canvasItemWriteSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'canvas.annotate', id, input },
      async (tx) => {
        await tx.query(
          'SELECT owner_id FROM canvas_sources WHERE owner_id=$1 FOR UPDATE',
          [user.id],
        );
        const [old] = await tx.query(
          'SELECT course_id FROM canvas_items WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [user.id, id],
        );
        if (input.courseId && input.courseId !== old?.course_id)
          await active(tx, 'courses', user.id, input.courseId);
        const [saved] = await tx.query(
          `UPDATE canvas_items SET notes=$3,sensitivity=$4,course_id=CASE WHEN $6::boolean THEN $7::uuid ELSE course_id END,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 AND version=$5 RETURNING ${canvasItemColumns}`,
          [
            user.id,
            id,
            input.notes,
            input.sensitivity,
            input.expectedVersion,
            input.courseId !== undefined,
            input.courseId ?? null,
          ],
        );
        if (!saved) {
          const exists = await tx.query(
            'SELECT id FROM canvas_items WHERE owner_id=$1 AND id=$2',
            [user.id, id],
          );
          throw new ApiError(
            exists.length ? 409 : 404,
            exists.length ? 'VERSION_CONFLICT' : 'NOT_FOUND',
            'Reload imported entries.',
          );
        }
        const [source] = await tx.query(
          'SELECT sensitivity FROM canvas_sources WHERE owner_id=$1',
          [user.id],
        );
        return {
          item: canvasItemSchema.parse({
            ...saved,
            effectiveSensitivity: canvasEffectiveSensitivity(
              source!.sensitivity,
              saved,
            ),
          }),
        };
      },
    );
  });
}
