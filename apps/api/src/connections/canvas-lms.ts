import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canvasLmsConnectionSchema,
  canvasLmsRecordsSchema,
  canvasLmsCourseSchema,
  canvasLmsAssignmentSchema,
  canvasLmsCourseWriteSchema,
  canvasLmsAssignmentWriteSchema,
  canvasSettingsSchema,
  canvasJobResponseSchema,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { Config } from '../config.js';
import type { authService } from '../auth/routes.js';
import { mutate } from '../planner/mutations.js';
import { active, stamp, strongest, version } from '../features/common.js';
import { ApiError } from '../errors.js';
import { canvasJobColumns } from './canvas.js';
import {
  CanvasApiError,
  fetchCanvasApi,
  validateCanvasSnapshot,
} from './canvas-api.js';
import type { CanvasApiSnapshot, CanvasApiFetcher } from './canvas-api.js';

async function ensure(tx: QueryExecutor, owner: string) {
  await tx.query(
    'INSERT INTO canvas_lms_sources(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [owner],
  );
}
async function configured(tx: QueryExecutor, owner: string, config: Config) {
  if (!config.CANVAS_API_TOKEN) return false;
  const [setup] = await tx.query(
    'SELECT owner_id FROM owner_setup WHERE singleton=1',
  );
  return setup?.owner_id === owner;
}
const rowColumns = (table: string) =>
  `${table}.id,${table}.provider_id AS "providerId",${table}.provider_data AS "providerData",${table}.availability,${table}.notes,${table}.sensitivity,${table}.version,${stamp(`${table}.created_at`, 'createdAt')},${stamp(`${table}.updated_at`, 'updatedAt')}`;
export async function readCanvasLms(
  tx: QueryExecutor,
  owner: string,
  courseId?: string,
  limit = 2000,
) {
  const [source] = await tx.query(
    `SELECT sensitivity,${stamp('last_imported_at', 'lastImportedAt')} FROM canvas_lms_sources WHERE owner_id=$1`,
    [owner],
  );
  const courses = await tx.query(
    `SELECT ${rowColumns('lc')},lc.course_id AS "courseId",c.name AS "courseName",COALESCE(c.deleted_at IS NOT NULL,FALSE) AS "courseDeleted",c.sensitivity AS "classLabel" FROM canvas_lms_courses lc LEFT JOIN courses c ON c.id=lc.course_id AND c.owner_id=lc.owner_id WHERE lc.owner_id=$1${courseId ? ' AND lc.course_id=$2' : ''} ORDER BY lc.provider_id,lc.id LIMIT ${limit + 1}`,
    courseId ? [owner, courseId] : [owner],
  );
  const assignments = await tx.query(
    `SELECT ${rowColumns('a')},a.canvas_course_id AS "canvasCourseId",lc.sensitivity AS "courseLabel",c.sensitivity AS "classLabel",x.sensitivity AS "reconciledSensitivity",x.attachment_derived AS "attachmentDerived" FROM canvas_lms_assignments a JOIN canvas_lms_courses lc ON lc.id=a.canvas_course_id AND lc.owner_id=a.owner_id JOIN canvas_assignment_context x ON x.id=a.id AND x.owner_id=a.owner_id LEFT JOIN courses c ON c.id=lc.course_id AND c.owner_id=lc.owner_id WHERE a.owner_id=$1${courseId ? ' AND lc.course_id=$2' : ''} ORDER BY (a.provider_data->>'dueAt') NULLS LAST,a.id LIMIT ${limit + 1}`,
    courseId ? [owner, courseId] : [owner],
  );
  if (courses.length > limit || assignments.length > limit)
    throw new ApiError(
      413,
      limit === 10000 ? 'EXPORT_TOO_LARGE' : 'CANVAS_ITEMS_LIMIT',
      'Too many retained Canvas records.',
    );
  const label = (row: Record<string, unknown>) =>
    strongest(
      String(source?.sensitivity ?? 'unlabeled'),
      String(row.sensitivity),
      String(row.courseLabel ?? 'unlabeled'),
      String(row.classLabel ?? 'unlabeled'),
      String(row.reconciledSensitivity ?? 'unlabeled'),
    );
  return canvasLmsRecordsSchema.parse({
    lastImportedAt: source?.lastImportedAt ?? null,
    courses: courses.map((row) => ({
      ...row,
      effectiveSensitivity: label(row),
    })),
    assignments: assignments.map((row) => ({
      ...row,
      effectiveSensitivity: label(row),
    })),
  });
}
export async function applyCanvasLmsSnapshot(
  tx: QueryExecutor,
  owner: string,
  input: CanvasApiSnapshot,
) {
  const snapshot = validateCanvasSnapshot(input);
  const [source] = await tx.query(
    'SELECT account_provider_id FROM canvas_lms_sources WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
  if (!source) throw new CanvasApiError('API_SYNC_FAILED');
  if (
    source.account_provider_id &&
    source.account_provider_id !== snapshot.accountProviderId
  )
    throw new CanvasApiError('API_ACCOUNT_MISMATCH');
  const counts = { added: 0, updated: 0, missing: 0 };
  const assignmentIds: string[] = [];
  for (const course of snapshot.courses) {
    const inserted = await tx.query(
      "INSERT INTO canvas_lms_courses(id,owner_id,provider_id,provider_data,availability) VALUES($1,$2,$3,$4::jsonb,'available') ON CONFLICT(owner_id,provider_id) DO NOTHING RETURNING id",
      [randomUUID(), owner, course.providerId, JSON.stringify(course.data)],
    );
    counts.added += inserted.length;
    if (!inserted.length)
      counts.updated += (
        await tx.query(
          "UPDATE canvas_lms_courses SET provider_data=$3::jsonb,availability='available',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND provider_id=$2 AND (provider_data IS DISTINCT FROM $3::jsonb OR availability<>'available') RETURNING id",
          [owner, course.providerId, JSON.stringify(course.data)],
        )
      ).length;
    const [saved] = await tx.query(
      'SELECT id FROM canvas_lms_courses WHERE owner_id=$1 AND provider_id=$2',
      [owner, course.providerId],
    );
    for (const item of snapshot.assignments.filter(
      (item) => item.courseProviderId === course.providerId,
    )) {
      const added = await tx.query(
        "INSERT INTO canvas_lms_assignments(id,owner_id,canvas_course_id,provider_id,provider_data,availability) VALUES($1,$2,$3,$4,$5::jsonb,'available') ON CONFLICT(owner_id,canvas_course_id,provider_id) DO NOTHING RETURNING id",
        [
          randomUUID(),
          owner,
          saved!.id,
          item.providerId,
          JSON.stringify(item.data),
        ],
      );
      counts.added += added.length;
      if (!added.length)
        counts.updated += (
          await tx.query(
            "UPDATE canvas_lms_assignments SET provider_data=$4::jsonb,availability='available',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND canvas_course_id=$2 AND provider_id=$3 AND (provider_data IS DISTINCT FROM $4::jsonb OR availability<>'available') RETURNING id",
            [owner, saved!.id, item.providerId, JSON.stringify(item.data)],
          )
        ).length;
      const [record] = await tx.query(
        'SELECT id FROM canvas_lms_assignments WHERE owner_id=$1 AND canvas_course_id=$2 AND provider_id=$3',
        [owner, saved!.id, item.providerId],
      );
      assignmentIds.push(String(record!.id));
    }
  }
  counts.missing += (
    await tx.query(
      "UPDATE canvas_lms_courses SET availability='missing',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND availability='available' AND NOT(provider_id=ANY($2::text[])) RETURNING id",
      [owner, snapshot.courses.map((course) => course.providerId)],
    )
  ).length;
  counts.missing += (
    await tx.query(
      "UPDATE canvas_lms_assignments SET availability='missing',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND availability='available' AND NOT(id=ANY($2::uuid[])) RETURNING id",
      [owner, assignmentIds],
    )
  ).length;
  await tx.query(
    'UPDATE canvas_lms_sources SET last_imported_at=CURRENT_TIMESTAMP,account_provider_id=COALESCE(account_provider_id,$2) WHERE owner_id=$1',
    [owner, snapshot.accountProviderId],
  );
  return counts;
}
export async function runCanvasLmsSync(
  database: Database,
  config: Config,
  fetcher: CanvasApiFetcher = (token, account) =>
    fetchCanvasApi(token, fetch, account),
) {
  if (!config.CANVAS_API_TOKEN) return;
  const claim = await database.transaction(async (tx) => {
    const [source] = await tx.query<{
      owner_id: string;
      due: boolean;
      account_provider_id: string | null;
    }>(
      "SELECT owner_id,account_provider_id,(enabled AND next_sync_at<=CURRENT_TIMESTAMP) AS due FROM canvas_lms_sources s WHERE s.owner_id=(SELECT owner_id FROM owner_setup WHERE singleton=1) AND ((enabled AND next_sync_at<=CURRENT_TIMESTAMP) OR EXISTS(SELECT 1 FROM canvas_lms_jobs j WHERE j.owner_id=s.owner_id AND (j.status='queued' OR (j.status='running' AND j.lease_until<=CURRENT_TIMESTAMP)))) ORDER BY next_sync_at FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    if (!source) return null;
    await tx.query(
      "UPDATE canvas_lms_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error_code=CASE WHEN attempts>=3 THEN 'LEASE_EXPIRED' ELSE NULL END,lease_token=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND status='running' AND lease_until<=CURRENT_TIMESTAMP",
      [source.owner_id],
    );
    if (source.due) {
      await tx.query(
        "INSERT INTO canvas_lms_jobs(id,owner_id,trigger,status) VALUES($1,$2,'automatic','queued') ON CONFLICT DO NOTHING",
        [randomUUID(), source.owner_id],
      );
      await tx.query(
        "UPDATE canvas_lms_sources SET next_sync_at=CURRENT_TIMESTAMP+INTERVAL '15 minutes' WHERE owner_id=$1",
        [source.owner_id],
      );
    }
    const [job] = await tx.query<{ id: string; owner_id: string }>(
      "SELECT id,owner_id FROM canvas_lms_jobs WHERE owner_id=$1 AND status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
      [source.owner_id],
    );
    if (!job) return null;
    const token = randomUUID();
    await tx.query(
      "UPDATE canvas_lms_jobs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=CURRENT_TIMESTAMP+INTERVAL '120 seconds',updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [job.id, token],
    );
    return { ...job, token, accountProviderId: source.account_provider_id };
  });
  if (!claim) return;
  try {
    const snapshot = validateCanvasSnapshot(
      await fetcher(config.CANVAS_API_TOKEN, claim.accountProviderId),
    );
    await database.transaction(async (tx) => {
      await tx.query(
        'SELECT owner_id FROM canvas_lms_sources WHERE owner_id=$1 FOR UPDATE',
        [claim.owner_id],
      );
      const [job] = await tx.query(
        "SELECT id FROM canvas_lms_jobs WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>CURRENT_TIMESTAMP FOR UPDATE",
        [claim.id, claim.token],
      );
      if (!job) return;
      const counts = await applyCanvasLmsSnapshot(tx, claim.owner_id, snapshot);
      await tx.query(
        "UPDATE canvas_lms_jobs SET status='succeeded',counts=$2::jsonb,error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
        [claim.id, JSON.stringify(counts)],
      );
    });
  } catch (error) {
    await database.query(
      "UPDATE canvas_lms_jobs SET status='failed',error_code=$3,lease_token=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND lease_token=$2 AND status='running'",
      [
        claim.id,
        claim.token,
        error instanceof CanvasApiError ? error.code : 'API_SYNC_FAILED',
      ],
    );
  }
}
export function startCanvasLmsWorker(
  database: Database,
  config: Config,
  fetcher?: CanvasApiFetcher,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;
  async function tick() {
    await runCanvasLmsSync(database, config, fetcher).catch(() => undefined);
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
export function registerCanvasLms(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
  config: Config,
) {
  const base = '/api/v1/connections/canvas/lms';
  app.get(base, async (request) => {
    const user = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await ensure(tx, user.id);
      await tx.query(
        'SELECT owner_id FROM canvas_lms_sources WHERE owner_id=$1 FOR UPDATE',
        [user.id],
      );
      const [source] = await tx.query(
        'SELECT enabled,version,sensitivity,account_provider_id AS "accountProviderId" FROM canvas_lms_sources WHERE owner_id=$1',
        [user.id],
      );
      return canvasLmsConnectionSchema.parse({
        ...source,
        ...(await readCanvasLms(tx, user.id)),
        configured: await configured(tx, user.id, config),
        jobs: await tx.query(
          `SELECT ${canvasJobColumns} FROM canvas_lms_jobs WHERE owner_id=$1 ORDER BY created_at DESC,id LIMIT 20`,
          [user.id],
        ),
      });
    });
  });
  app.get(`${base}/records`, async (request) => {
    const user = await auth.requireUser(request);
    const { courseId } = z
      .strictObject({ courseId: z.string().uuid() })
      .parse(request.query);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (
        !(
          await tx.query('SELECT id FROM courses WHERE owner_id=$1 AND id=$2', [
            user.id,
            courseId,
          ])
        ).length
      )
        throw new ApiError(404, 'NOT_FOUND', 'Class not available.');
      return readCanvasLms(tx, user.id, courseId);
    });
  });
  app.put(base, async (request) => {
    const user = await auth.requireUser(request);
    const input = canvasSettingsSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'canvas.lms.settings', input },
      async (tx) => {
        await ensure(tx, user.id);
        if (input.enabled && !(await configured(tx, user.id, config)))
          throw new ApiError(
            409,
            'CANVAS_API_NOT_CONFIGURED',
            'Configure the server API token first.',
          );
        if (
          !(
            await tx.query(
              'UPDATE canvas_lms_sources SET enabled=$3,sensitivity=$4,version=version+1,next_sync_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND version=$2 RETURNING version',
              [
                user.id,
                input.expectedVersion,
                input.enabled,
                input.sensitivity,
              ],
            )
          ).length
        )
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload Canvas API settings.',
          );
        if (!input.enabled)
          await tx.query(
            "UPDATE canvas_lms_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND status IN ('queued','running')",
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
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'canvas.lms.sync' },
      async (tx) => {
        if (!(await configured(tx, user.id, config)))
          throw new ApiError(
            409,
            'CANVAS_API_NOT_CONFIGURED',
            'Configure the server API token first.',
          );
        await ensure(tx, user.id);
        await tx.query(
          'SELECT owner_id FROM canvas_lms_sources WHERE owner_id=$1 FOR UPDATE',
          [user.id],
        );
        await tx.query(
          "INSERT INTO canvas_lms_jobs(id,owner_id,trigger,status) VALUES($1,$2,'manual','queued') ON CONFLICT DO NOTHING",
          [randomUUID(), user.id],
        );
        const [job] = await tx.query(
          `SELECT ${canvasJobColumns} FROM canvas_lms_jobs WHERE owner_id=$1 AND status IN ('queued','running')`,
          [user.id],
        );
        return canvasJobResponseSchema.parse({ job });
      },
    );
  });
  for (const kind of ['courses', 'assignments'] as const)
    app.put(`${base}/${kind}/:id`, async (request) => {
      const user = await auth.requireUser(request);
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const courseInput =
        kind === 'courses'
          ? canvasLmsCourseWriteSchema.parse(request.body)
          : null;
      const input =
        courseInput ?? canvasLmsAssignmentWriteSchema.parse(request.body);
      return mutate(
        database,
        user.id,
        input.operationId,
        { kind: `canvas.lms.${kind}.edit`, id, input },
        async (tx) => {
          await tx.query(
            'SELECT owner_id FROM canvas_lms_sources WHERE owner_id=$1 FOR UPDATE',
            [user.id],
          );
          const [old] = await tx.query(
            `SELECT * FROM canvas_lms_${kind} WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
            [user.id, id],
          );
          if (!old)
            throw new ApiError(
              404,
              'NOT_FOUND',
              'Canvas record not available.',
            );
          version(old, input.expectedVersion);
          if (courseInput?.courseId && courseInput.courseId !== old.course_id)
            await active(tx, 'courses', user.id, courseInput.courseId);
          await tx.query(
            `UPDATE canvas_lms_${kind} SET notes=$3,sensitivity=$4,version=version+1,updated_at=CURRENT_TIMESTAMP${courseInput ? ',course_id=$5' : ''} WHERE owner_id=$1 AND id=$2`,
            courseInput
              ? [
                  user.id,
                  id,
                  input.notes,
                  input.sensitivity,
                  courseInput.courseId,
                ]
              : [user.id, id, input.notes, input.sensitivity],
          );
          const records = await readCanvasLms(tx, user.id);
          return kind === 'courses'
            ? {
                course: canvasLmsCourseSchema.parse(
                  records.courses.find((row) => row.id === id),
                ),
              }
            : {
                assignment: canvasLmsAssignmentSchema.parse(
                  records.assignments.find((row) => row.id === id),
                ),
              };
        },
      );
    });
}
