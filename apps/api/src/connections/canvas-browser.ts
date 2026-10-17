import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  canvasBrowserAttemptFinishSchema,
  canvasBrowserAttemptStartResponseSchema,
  canvasBrowserAttemptStartSchema,
  canvasBrowserConnectionSchema,
  canvasBrowserCourseObservationSchema,
  canvasBrowserCourseSchema,
  canvasBrowserCourseWriteSchema,
  canvasBrowserCollectorStateSchema,
  canvasBrowserDiscoverySchema,
  canvasBrowserItemSchema,
  canvasBrowserItemWriteSchema,
  canvasBrowserObservationResultSchema,
  canvasBrowserRevokeSchema,
  canvasBrowserSettingsSchema,
  canvasBrowserTokenRequestSchema,
  canvasBrowserTokenResponseSchema,
} from '@hub/contracts';
import type { authService } from '../auth/routes.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { active, stamp, strongest, version } from '../features/common.js';
import { mutate } from '../planner/mutations.js';

export const canvasBrowserCollectorPathPrefix =
  '/api/v1/canvas/browser/collector/';
const base = '/api/v1/connections/canvas/browser';
const staleAfterMs = 30 * 60 * 1000;
const tokenPattern = /^Bearer (hubcb_[A-Za-z0-9_-]{20,200})$/;

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const digest = (value: unknown) => hash(stable(value));

async function ensure(tx: QueryExecutor, owner: string) {
  await tx.query(
    'INSERT INTO canvas_browser_sources(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [owner],
  );
}

function healthStatus(source: Record<string, unknown>, selectedCount: number) {
  if (source.tokenRevokedAt && !source.configured) return 'revoked';
  if (
    source.activeAttemptId &&
    source.activeAttemptProgressAt &&
    Date.now() - new Date(String(source.activeAttemptProgressAt)).getTime() <=
      staleAfterMs
  )
    return 'syncing';
  if (source.lastErrorCode === 'sign-in-required') return 'sign-in-required';
  if (!source.lastAttemptAt) return 'never-synced';
  if (source.activeAttemptId) return 'partial';
  if (source.lastAttemptOutcome === 'partial') return 'partial';
  if (source.lastErrorCode) return 'error';
  if (source.lastAttemptOutcome === 'failed') return 'error';
  if (!source.lastCompleteAt || selectedCount === 0) return 'partial';
  if (source.lastCompleteCoverageRevision !== source.coverageRevision)
    return 'partial';
  return Date.now() - new Date(String(source.lastCompleteAt)).getTime() >
    staleAfterMs
    ? 'stale'
    : 'current';
}

const sourceColumns = `s.version,s.coverage_revision AS "coverageRevision",s.last_complete_coverage_revision AS "lastCompleteCoverageRevision",s.sensitivity,(s.token_hash IS NOT NULL AND s.token_revoked_at IS NULL) AS configured,${stamp('s.token_revoked_at', 'tokenRevokedAt')},${stamp('s.last_attempt_at', 'lastAttemptAt')},${stamp('s.last_contact_at', 'lastContactAt')},${stamp('s.last_import_at', 'lastImportAt')},${stamp('s.last_complete_at', 'lastCompleteAt')},s.active_attempt_id AS "activeAttemptId",${stamp('s.active_attempt_progress_at', 'activeAttemptProgressAt')},s.last_attempt_outcome AS "lastAttemptOutcome",s.last_error_code AS "lastErrorCode"`;

async function readExistingConnection(tx: QueryExecutor, owner: string) {
  const [source] = await tx.query(
    `SELECT ${sourceColumns} FROM canvas_browser_sources s WHERE s.owner_id=$1`,
    [owner],
  );
  const courses = await tx.query(
    `SELECT bc.id,bc.provider_id AS "providerId",bc.name,bc.canonical_url AS "canonicalUrl",bc.availability,bc.selected,bc.course_id AS "courseId",c.name AS "courseName",COALESCE(c.deleted_at IS NOT NULL,FALSE) AS "courseDeleted",bc.notes,bc.sensitivity,c.sensitivity AS "classLabel",bc.version,${stamp('bc.last_contact_at', 'lastContactAt')},${stamp('bc.last_import_at', 'lastImportAt')},${stamp('bc.last_complete_at', 'lastCompleteAt')},bc.last_observation_status AS "lastObservationStatus",bc.last_observed_count AS "lastObservedCount",${stamp('bc.created_at', 'createdAt')},${stamp('bc.updated_at', 'updatedAt')}
     FROM canvas_browser_courses bc LEFT JOIN courses c ON c.id=bc.course_id AND c.owner_id=bc.owner_id
     WHERE bc.owner_id=$1 ORDER BY bc.name,bc.provider_id`,
    [owner],
  );
  const items = await tx.query(
    `SELECT bi.id,bi.browser_course_id AS "browserCourseId",bi.resource_kind AS "resourceKind",bi.provider_id AS "providerId",bi.canonical_url AS "canonicalUrl",bi.title,${stamp('bi.due_at', 'dueAt')},${stamp('bi.captured_at', 'capturedAt')},bi.availability,bi.notes,bi.sensitivity,bc.sensitivity AS "courseLabel",c.sensitivity AS "classLabel",bi.version,${stamp('bi.created_at', 'createdAt')},${stamp('bi.updated_at', 'updatedAt')}
     FROM canvas_browser_items bi JOIN canvas_browser_courses bc ON bc.id=bi.browser_course_id AND bc.owner_id=bi.owner_id
     LEFT JOIN courses c ON c.id=bc.course_id AND c.owner_id=bc.owner_id
     WHERE bi.owner_id=$1 ORDER BY bc.name,bi.title,bi.resource_kind,bi.provider_id`,
    [owner],
  );
  const attempts = await tx.query(
    `SELECT id,source_version AS "sourceVersion",outcome,error_code AS "errorCode",discovery_status AS "discoveryStatus",selected_count AS "selectedCount",complete_count AS "completeCount",${stamp('started_at', 'startedAt')},${stamp('finished_at', 'finishedAt')}
     FROM canvas_browser_attempts WHERE owner_id=$1 ORDER BY started_at DESC,id LIMIT 20`,
    [owner],
  );
  const selectedCount = courses.filter((course) => course.selected).length;
  if (!source)
    throw new ApiError(
      500,
      'CANVAS_BROWSER_STATE',
      'Canvas browser source is unavailable.',
    );
  return canvasBrowserConnectionSchema.parse({
    ...source,
    healthStatus: healthStatus(source, selectedCount),
    courses: courses.map((course) => ({
      ...course,
      effectiveSensitivity: strongest(
        String(source?.sensitivity ?? 'unlabeled'),
        String(course.sensitivity),
        String(course.classLabel ?? 'unlabeled'),
      ),
    })),
    items: items.map((item) => ({
      ...item,
      effectiveSensitivity: strongest(
        String(source?.sensitivity ?? 'unlabeled'),
        String(item.courseLabel ?? 'unlabeled'),
        String(item.sensitivity),
        String(item.classLabel ?? 'unlabeled'),
      ),
    })),
    attempts,
  });
}

async function readConnection(tx: QueryExecutor, owner: string) {
  await ensure(tx, owner);
  return readExistingConnection(tx, owner);
}

async function requireCollector(database: Database, request: FastifyRequest) {
  const match = tokenPattern.exec(request.headers.authorization ?? '');
  if (!match)
    throw new ApiError(
      401,
      'UNAUTHENTICATED',
      'Canvas collector token required.',
    );
  const [row] = await database.query(
    `SELECT owner_id AS owner,version FROM canvas_browser_sources
     WHERE token_hash=$1 AND token_revoked_at IS NULL`,
    [hash(match[1]!)],
  );
  if (!row)
    throw new ApiError(
      401,
      'UNAUTHENTICATED',
      'Canvas collector token revoked.',
    );
  return row as { owner: string; version: number };
}

async function invalidateAttempt(tx: QueryExecutor, owner: string) {
  const [source] = await tx.query(
    'SELECT active_attempt_id AS "activeAttemptId" FROM canvas_browser_sources WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
  if (!source?.activeAttemptId) return;
  await tx.query(
    `UPDATE canvas_browser_attempts SET outcome='partial',finished_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND outcome IS NULL`,
    [owner, source.activeAttemptId],
  );
  await tx.query(
    `UPDATE canvas_browser_sources SET active_attempt_id=NULL,active_attempt_progress_at=NULL,last_attempt_outcome='partial',last_error_code=NULL
     WHERE owner_id=$1`,
    [owner],
  );
}

async function activeAttempt(
  tx: QueryExecutor,
  owner: string,
  attemptId: string,
) {
  const [source] = await tx.query(
    `SELECT version,active_attempt_id AS "activeAttemptId" FROM canvas_browser_sources WHERE owner_id=$1 FOR UPDATE`,
    [owner],
  );
  const [attempt] = await tx.query(
    `SELECT source_version AS "sourceVersion",coverage_revision AS "coverageRevision",discovery_status AS "discoveryStatus",discovery_hash AS "discoveryHash",discovery_counts AS "discoveryCounts",selected_count AS "selectedCount"
     FROM canvas_browser_attempts WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
    [owner, attemptId],
  );
  if (!source || !attempt || source.activeAttemptId !== attemptId)
    throw new ApiError(
      409,
      'ATTEMPT_CHANGED',
      'The Canvas collection attempt changed.',
    );
  if (source.version !== attempt.sourceVersion)
    throw new ApiError(
      409,
      'SOURCE_CHANGED',
      'Canvas browser settings changed.',
    );
  return { source, attempt };
}

function assertCourseUrl(providerId: string, canonicalUrl: string) {
  if (new URL(canonicalUrl).pathname !== `/courses/${providerId}`)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Canvas course identity is invalid.',
    );
}

function assertItemUrl(
  courseProviderId: string,
  resourceKind: 'assignment' | 'quiz',
  providerId: string,
  canonicalUrl: string,
) {
  const segment = resourceKind === 'assignment' ? 'assignments' : 'quizzes';
  if (
    new URL(canonicalUrl).pathname !==
    `/courses/${courseProviderId}/${segment}/${providerId}`
  )
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Canvas item identity is invalid.',
    );
}

export function registerCanvasBrowser(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.get(base, async (request) => {
    const owner = await auth.requireUser(request);
    return readConnection(database, owner.id);
  });

  app.put(base, async (request) => {
    const owner = await auth.requireUser(request);
    const input = canvasBrowserSettingsSchema.parse(request.body);
    await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'canvas.browser.settings', input },
      async (tx) => {
        await ensure(tx, owner.id);
        await invalidateAttempt(tx, owner.id);
        const [row] = await tx.query(
          `UPDATE canvas_browser_sources SET sensitivity=$3,version=version+1
           WHERE owner_id=$1 AND version=$2 RETURNING version`,
          [owner.id, input.expectedVersion, input.sensitivity],
        );
        if (!row)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload Canvas browser settings.',
          );
        return { version: row.version };
      },
    );
    return readConnection(database, owner.id);
  });

  app.post(`${base}/token`, async (request) => {
    const owner = await auth.requireUser(request);
    const input = canvasBrowserTokenRequestSchema.parse(request.body);
    const token = `hubcb_${randomBytes(32).toString('base64url')}`;
    let fresh = false;
    await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'canvas.browser.token', expectedVersion: input.expectedVersion },
      async (tx) => {
        await ensure(tx, owner.id);
        await invalidateAttempt(tx, owner.id);
        const [row] = await tx.query(
          `UPDATE canvas_browser_sources SET token_hash=$3,token_issued_at=CURRENT_TIMESTAMP,token_revoked_at=NULL,version=version+1
           WHERE owner_id=$1 AND version=$2 RETURNING version`,
          [owner.id, input.expectedVersion, hash(token)],
        );
        if (!row)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload Canvas browser settings.',
          );
        fresh = true;
        return { version: row.version };
      },
    );
    if (!fresh)
      throw new ApiError(
        409,
        'TOKEN_ALREADY_ISSUED',
        'This Canvas browser token was already issued and cannot be shown again. Create a replacement token if it was lost.',
      );
    return canvasBrowserTokenResponseSchema.parse({
      token,
      connection: await readConnection(database, owner.id),
    });
  });

  app.post(`${base}/revoke`, async (request) => {
    const owner = await auth.requireUser(request);
    const input = canvasBrowserRevokeSchema.parse(request.body);
    await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'canvas.browser.revoke', expectedVersion: input.expectedVersion },
      async (tx) => {
        await ensure(tx, owner.id);
        await invalidateAttempt(tx, owner.id);
        const [row] = await tx.query(
          `UPDATE canvas_browser_sources SET token_hash=NULL,token_revoked_at=CURRENT_TIMESTAMP,version=version+1
           WHERE owner_id=$1 AND version=$2 RETURNING version`,
          [owner.id, input.expectedVersion],
        );
        if (!row)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload Canvas browser settings.',
          );
        return { version: row.version };
      },
    );
    return readConnection(database, owner.id);
  });

  app.put(`${base}/courses/:id`, async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = canvasBrowserCourseSchema
      .pick({ id: true })
      .parse(request.params);
    const input = canvasBrowserCourseWriteSchema.parse(request.body);
    await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'canvas.browser.course.edit', id, input },
      async (tx) => {
        await ensure(tx, owner.id);
        await tx.query(
          'SELECT owner_id FROM canvas_browser_sources WHERE owner_id=$1 FOR UPDATE',
          [owner.id],
        );
        const [old] = await tx.query(
          'SELECT selected,course_id,version FROM canvas_browser_courses WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [owner.id, id],
        );
        if (!old)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Canvas browser course not available.',
          );
        version(old, input.expectedVersion);
        if (input.courseId && input.courseId !== old.course_id)
          await active(tx, 'courses', owner.id, input.courseId);
        if (old.selected !== input.selected) {
          await invalidateAttempt(tx, owner.id);
          await tx.query(
            'UPDATE canvas_browser_sources SET version=version+1,coverage_revision=coverage_revision+1 WHERE owner_id=$1',
            [owner.id],
          );
        }
        await tx.query(
          `UPDATE canvas_browser_courses SET selected=$3,course_id=$4,notes=$5,sensitivity=$6,version=version+1,updated_at=CURRENT_TIMESTAMP
           WHERE owner_id=$1 AND id=$2`,
          [
            owner.id,
            id,
            input.selected,
            input.courseId,
            input.notes,
            input.sensitivity,
          ],
        );
        return { id };
      },
    );
    const connection = await readConnection(database, owner.id);
    return {
      course: canvasBrowserCourseSchema.parse(
        connection.courses.find((course) => course.id === id),
      ),
      sourceVersion: connection.version,
    };
  });

  app.put(`${base}/items/:id`, async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = canvasBrowserItemSchema
      .pick({ id: true })
      .parse(request.params);
    const input = canvasBrowserItemWriteSchema.parse(request.body);
    await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'canvas.browser.item.edit', id, input },
      async (tx) => {
        const [old] = await tx.query(
          'SELECT version FROM canvas_browser_items WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [owner.id, id],
        );
        if (!old)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Canvas browser item not available.',
          );
        version(old, input.expectedVersion);
        await tx.query(
          `UPDATE canvas_browser_items SET notes=$3,sensitivity=$4,version=version+1,updated_at=CURRENT_TIMESTAMP
           WHERE owner_id=$1 AND id=$2`,
          [owner.id, id, input.notes, input.sensitivity],
        );
        return { id };
      },
    );
    const connection = await readConnection(database, owner.id);
    return {
      item: canvasBrowserItemSchema.parse(
        connection.items.find((item) => item.id === id),
      ),
    };
  });

  app.get(`${canvasBrowserCollectorPathPrefix}state`, async (request) => {
    const collector = await requireCollector(database, request);
    const [source] = await database.query(
      'SELECT version FROM canvas_browser_sources WHERE owner_id=$1',
      [collector.owner],
    );
    const courses = await database.query(
      `SELECT id,provider_id AS "providerId",canonical_url AS "canonicalUrl",version
       FROM canvas_browser_courses WHERE owner_id=$1 AND selected=TRUE ORDER BY provider_id`,
      [collector.owner],
    );
    return canvasBrowserCollectorStateSchema.parse({
      sourceVersion: source!.version,
      courses,
    });
  });

  app.post(`${canvasBrowserCollectorPathPrefix}attempt`, async (request) => {
    const collector = await requireCollector(database, request);
    const input = canvasBrowserAttemptStartSchema.parse(request.body);
    return database.transaction(async (tx) => {
      const [source] = await tx.query(
        `SELECT version,coverage_revision AS "coverageRevision",active_attempt_id AS "activeAttemptId",active_attempt_progress_at AS "activeAttemptProgressRaw"
         FROM canvas_browser_sources WHERE owner_id=$1 FOR UPDATE`,
        [collector.owner],
      );
      if (!source || source.version !== input.expectedSourceVersion)
        throw new ApiError(
          409,
          'SOURCE_CHANGED',
          'Canvas browser settings changed.',
        );
      const [existing] = await tx.query(
        `SELECT source_version AS "sourceVersion" FROM canvas_browser_attempts WHERE owner_id=$1 AND id=$2`,
        [collector.owner, input.attemptId],
      );
      if (existing) {
        if (existing.sourceVersion !== input.expectedSourceVersion)
          throw new ApiError(
            409,
            'ATTEMPT_CHANGED',
            'The Canvas collection attempt changed.',
          );
        return canvasBrowserAttemptStartResponseSchema.parse({
          attemptId: input.attemptId,
        });
      }
      if (source.activeAttemptId) {
        const stale =
          source.activeAttemptProgressRaw &&
          Date.now() -
            new Date(String(source.activeAttemptProgressRaw)).getTime() >
            staleAfterMs;
        if (!stale)
          throw new ApiError(
            409,
            'ATTEMPT_ACTIVE',
            'A Canvas collection is already running.',
          );
        await invalidateAttempt(tx, collector.owner);
      }
      const [selected] = await tx.query<{ count: number }>(
        'SELECT COUNT(*)::integer AS count FROM canvas_browser_courses WHERE owner_id=$1 AND selected=TRUE',
        [collector.owner],
      );
      const count = selected?.count ?? 0;
      await tx.query(
        `INSERT INTO canvas_browser_attempts(id,owner_id,source_version,coverage_revision,selected_count)
         VALUES($1,$2,$3,$4,$5)`,
        [
          input.attemptId,
          collector.owner,
          input.expectedSourceVersion,
          source.coverageRevision,
          count,
        ],
      );
      await tx.query(
        `UPDATE canvas_browser_sources SET last_attempt_at=CURRENT_TIMESTAMP,active_attempt_id=$2,active_attempt_progress_at=CURRENT_TIMESTAMP,last_attempt_outcome=NULL,last_error_code=NULL
         WHERE owner_id=$1`,
        [collector.owner, input.attemptId],
      );
      return canvasBrowserAttemptStartResponseSchema.parse({
        attemptId: input.attemptId,
      });
    });
  });

  app.post(`${canvasBrowserCollectorPathPrefix}discovery`, async (request) => {
    const collector = await requireCollector(database, request);
    const input = canvasBrowserDiscoverySchema.parse(request.body);
    for (const course of input.courses)
      assertCourseUrl(course.providerId, course.canonicalUrl);
    const payloadHash = digest(input);
    return database.transaction(async (tx) => {
      const { attempt } = await activeAttempt(
        tx,
        collector.owner,
        input.attemptId,
      );
      if (attempt.discoveryHash) {
        if (attempt.discoveryHash !== payloadHash)
          throw new ApiError(
            409,
            'ATTEMPT_CHANGED',
            'Canvas discovery retry does not match the first observation.',
          );
        await tx.query(
          'UPDATE canvas_browser_sources SET active_attempt_progress_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND active_attempt_id=$2',
          [collector.owner, input.attemptId],
        );
        return canvasBrowserObservationResultSchema.parse(
          attempt.discoveryCounts,
        );
      }
      let added = 0;
      let updated = 0;
      for (const course of input.courses) {
        const inserted = await tx.query(
          `INSERT INTO canvas_browser_courses(id,owner_id,provider_id,name,canonical_url,availability)
           VALUES($1,$2,$3,$4,$5,'available') ON CONFLICT(owner_id,provider_id) DO NOTHING RETURNING id`,
          [
            randomUUID(),
            collector.owner,
            course.providerId,
            course.name,
            course.canonicalUrl,
          ],
        );
        if (inserted.length) {
          added++;
          continue;
        }
        updated += (
          await tx.query(
            `UPDATE canvas_browser_courses SET name=$3,canonical_url=$4,availability='available',version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE owner_id=$1 AND provider_id=$2 AND (name IS DISTINCT FROM $3 OR canonical_url IS DISTINCT FROM $4 OR availability<>'available') RETURNING id`,
            [
              collector.owner,
              course.providerId,
              course.name,
              course.canonicalUrl,
            ],
          )
        ).length;
      }
      let missing = 0;
      if (input.status === 'complete')
        missing = (
          await tx.query(
            `UPDATE canvas_browser_courses SET availability='missing',version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE owner_id=$1 AND availability='available' AND NOT(provider_id=ANY($2::text[])) RETURNING id`,
            [collector.owner, input.courses.map((course) => course.providerId)],
          )
        ).length;
      const counts = { added, updated, missing };
      const changed = added + updated + missing;
      await tx.query(
        `UPDATE canvas_browser_attempts SET discovery_status=$3,discovery_hash=$4,discovery_counts=$5::jsonb WHERE owner_id=$1 AND id=$2`,
        [
          collector.owner,
          input.attemptId,
          input.status,
          payloadHash,
          JSON.stringify(counts),
        ],
      );
      await tx.query(
        `UPDATE canvas_browser_sources SET last_contact_at=CURRENT_TIMESTAMP,
           active_attempt_progress_at=CURRENT_TIMESTAMP,
           last_import_at=CASE WHEN $2::integer>0 THEN CURRENT_TIMESTAMP ELSE last_import_at END
         WHERE owner_id=$1`,
        [collector.owner, changed],
      );
      return canvasBrowserObservationResultSchema.parse(counts);
    });
  });

  app.post(
    `${canvasBrowserCollectorPathPrefix}course`,
    { bodyLimit: 2 * 1024 * 1024 },
    async (request) => {
      const collector = await requireCollector(database, request);
      const input = canvasBrowserCourseObservationSchema.parse(request.body);
      const payloadHash = digest(input);
      return database.transaction(async (tx) => {
        await activeAttempt(tx, collector.owner, input.attemptId);
        const [course] = await tx.query(
          `SELECT id,provider_id AS "providerId",selected FROM canvas_browser_courses
           WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
          [collector.owner, input.courseId],
        );
        if (!course || !course.selected)
          throw new ApiError(
            409,
            'COURSE_CHANGED',
            'Canvas browser course selection changed.',
          );
        for (const item of input.items)
          assertItemUrl(
            String(course.providerId),
            item.resourceKind,
            item.providerId,
            item.canonicalUrl,
          );
        const [prior] = await tx.query(
          `SELECT payload_hash AS "payloadHash",counts FROM canvas_browser_course_observations
           WHERE owner_id=$1 AND attempt_id=$2 AND browser_course_id=$3`,
          [collector.owner, input.attemptId, input.courseId],
        );
        if (prior) {
          if (prior.payloadHash !== payloadHash)
            throw new ApiError(
              409,
              'ATTEMPT_CHANGED',
              'Canvas course retry does not match the first observation.',
            );
          await tx.query(
            'UPDATE canvas_browser_sources SET active_attempt_progress_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND active_attempt_id=$2',
            [collector.owner, input.attemptId],
          );
          return canvasBrowserObservationResultSchema.parse(prior.counts);
        }
        let added = 0;
        let updated = 0;
        for (const item of input.items) {
          const inserted = await tx.query(
            `INSERT INTO canvas_browser_items(id,owner_id,browser_course_id,resource_kind,provider_id,canonical_url,title,due_at,captured_at,availability)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'available')
             ON CONFLICT(owner_id,browser_course_id,resource_kind,provider_id) DO NOTHING RETURNING id`,
            [
              randomUUID(),
              collector.owner,
              input.courseId,
              item.resourceKind,
              item.providerId,
              item.canonicalUrl,
              item.title,
              item.dueAt,
              input.capturedAt,
            ],
          );
          let itemId: string;
          if (inserted.length) {
            added++;
            itemId = String(inserted[0]!.id);
          } else {
            const changed = await tx.query(
              `UPDATE canvas_browser_items SET canonical_url=$5,title=$6,due_at=$7,captured_at=$8,availability='available',version=version+1,updated_at=CURRENT_TIMESTAMP
               WHERE owner_id=$1 AND browser_course_id=$2 AND resource_kind=$3 AND provider_id=$4
                 AND (canonical_url IS DISTINCT FROM $5 OR title IS DISTINCT FROM $6 OR due_at IS DISTINCT FROM $7::timestamptz OR availability<>'available') RETURNING id`,
              [
                collector.owner,
                input.courseId,
                item.resourceKind,
                item.providerId,
                item.canonicalUrl,
                item.title,
                item.dueAt,
                input.capturedAt,
              ],
            );
            if (changed.length) {
              updated++;
              itemId = String(changed[0]!.id);
            } else {
              const [unchanged] = await tx.query(
                `UPDATE canvas_browser_items SET captured_at=$5 WHERE owner_id=$1 AND browser_course_id=$2 AND resource_kind=$3 AND provider_id=$4 RETURNING id`,
                [
                  collector.owner,
                  input.courseId,
                  item.resourceKind,
                  item.providerId,
                  input.capturedAt,
                ],
              );
              if (!unchanged)
                throw new ApiError(
                  409,
                  'ATTEMPT_CHANGED',
                  'Canvas browser item changed during collection.',
                );
              itemId = String(unchanged.id);
            }
          }
          await tx.query(
            `INSERT INTO canvas_browser_item_captures(id,owner_id,attempt_id,browser_item_id,snapshot,captured_at)
             VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
            [
              randomUUID(),
              collector.owner,
              input.attemptId,
              itemId,
              JSON.stringify(item),
              input.capturedAt,
            ],
          );
        }
        let missing = 0;
        if (input.status === 'complete') {
          const identities = input.items.map(
            (item) => `${item.resourceKind}:${item.providerId}`,
          );
          missing = (
            await tx.query(
              `UPDATE canvas_browser_items SET availability='missing',version=version+1,updated_at=CURRENT_TIMESTAMP
               WHERE owner_id=$1 AND browser_course_id=$2 AND availability='available'
                 AND NOT((resource_kind || ':' || provider_id)=ANY($3::text[])) RETURNING id`,
              [collector.owner, input.courseId, identities],
            )
          ).length;
        }
        const counts = { added, updated, missing };
        const changed = added + updated + missing;
        await tx.query(
          `INSERT INTO canvas_browser_course_observations(attempt_id,owner_id,browser_course_id,status,payload_hash,observed_count,counts,captured_at)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [
            input.attemptId,
            collector.owner,
            input.courseId,
            input.status,
            payloadHash,
            input.items.length,
            JSON.stringify(counts),
            input.capturedAt,
          ],
        );
        await tx.query(
          `UPDATE canvas_browser_courses SET last_contact_at=CURRENT_TIMESTAMP,
             last_import_at=CASE WHEN $3::integer>0 THEN CURRENT_TIMESTAMP ELSE last_import_at END,
             last_complete_at=CASE WHEN $4='complete' THEN CURRENT_TIMESTAMP ELSE last_complete_at END,
             last_observation_status=$4,last_observed_count=$5
           WHERE owner_id=$1 AND id=$2`,
          [
            collector.owner,
            input.courseId,
            changed,
            input.status,
            input.items.length,
          ],
        );
        await tx.query(
          `UPDATE canvas_browser_sources SET last_contact_at=CURRENT_TIMESTAMP,
             active_attempt_progress_at=CURRENT_TIMESTAMP,
             last_import_at=CASE WHEN $2::integer>0 THEN CURRENT_TIMESTAMP ELSE last_import_at END
           WHERE owner_id=$1`,
          [collector.owner, changed],
        );
        return canvasBrowserObservationResultSchema.parse(counts);
      });
    },
  );

  app.post(
    `${canvasBrowserCollectorPathPrefix}attempt/finish`,
    async (request) => {
      const collector = await requireCollector(database, request);
      const input = canvasBrowserAttemptFinishSchema.parse(request.body);
      if (input.outcome === 'complete' && input.errorCode)
        throw new ApiError(
          400,
          'INVALID_INPUT',
          'A complete Canvas collection cannot have an error.',
        );
      return database.transaction(async (tx) => {
        const [source] = await tx.query(
          `SELECT version,active_attempt_id AS "activeAttemptId" FROM canvas_browser_sources WHERE owner_id=$1 FOR UPDATE`,
          [collector.owner],
        );
        const [attempt] = await tx.query(
          `SELECT source_version AS "sourceVersion",coverage_revision AS "coverageRevision",outcome,error_code AS "errorCode",discovery_status AS "discoveryStatus",selected_count AS "selectedCount"
           FROM canvas_browser_attempts WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
          [collector.owner, input.attemptId],
        );
        if (!source || !attempt)
          throw new ApiError(
            409,
            'ATTEMPT_CHANGED',
            'The Canvas collection attempt changed.',
          );
        if (attempt.outcome) {
          if (
            attempt.outcome === input.outcome &&
            (attempt.errorCode ?? null) === (input.errorCode ?? null)
          )
            return { ok: true };
          throw new ApiError(
            409,
            'ATTEMPT_CHANGED',
            'The Canvas collection attempt changed.',
          );
        }
        if (
          source.activeAttemptId !== input.attemptId ||
          source.version !== attempt.sourceVersion
        )
          throw new ApiError(
            409,
            'ATTEMPT_CHANGED',
            'The Canvas collection attempt changed.',
          );
        const [completed] = await tx.query<{ count: number }>(
          `SELECT COUNT(*)::integer AS count FROM canvas_browser_course_observations
         WHERE owner_id=$1 AND attempt_id=$2 AND status='complete'`,
          [collector.owner, input.attemptId],
        );
        const completeCount = completed?.count ?? 0;
        if (input.outcome === 'complete') {
          if (
            attempt.discoveryStatus !== 'complete' ||
            attempt.selectedCount === 0
          )
            throw new ApiError(
              409,
              'COVERAGE_INCOMPLETE',
              'Canvas discovery or course selection is incomplete.',
            );
          if (completeCount !== attempt.selectedCount)
            throw new ApiError(
              409,
              'COVERAGE_INCOMPLETE',
              'Not every selected Canvas course was completely collected.',
            );
        }
        await tx.query(
          `UPDATE canvas_browser_attempts SET outcome=$3,error_code=CASE WHEN $3='complete' THEN NULL ELSE $4 END,complete_count=$5,finished_at=CURRENT_TIMESTAMP
         WHERE owner_id=$1 AND id=$2`,
          [
            collector.owner,
            input.attemptId,
            input.outcome,
            input.errorCode,
            completeCount,
          ],
        );
        await tx.query(
          `UPDATE canvas_browser_sources SET active_attempt_id=NULL,active_attempt_progress_at=NULL,last_attempt_outcome=$3,
           last_error_code=CASE WHEN $3='complete' THEN NULL ELSE $4 END,
           last_complete_at=CASE WHEN $3='complete' THEN CURRENT_TIMESTAMP ELSE last_complete_at END,
           last_complete_coverage_revision=CASE WHEN $3='complete' THEN $5 ELSE last_complete_coverage_revision END
         WHERE owner_id=$1 AND active_attempt_id=$2`,
          [
            collector.owner,
            input.attemptId,
            input.outcome,
            input.errorCode,
            attempt.coverageRevision,
          ],
        );
        return { ok: true };
      });
    },
  );
}

export async function exportCanvasBrowser(tx: QueryExecutor, owner: string) {
  const [source] = await tx.query(
    'SELECT owner_id FROM canvas_browser_sources WHERE owner_id=$1',
    [owner],
  );
  if (!source)
    return {
      canvasBrowserSource: null,
      canvasBrowserCourses: [],
      canvasBrowserItems: [],
      canvasBrowserItemCaptures: [],
    };
  const connection = await readExistingConnection(tx, owner);
  const captures = await tx.query(
    `SELECT id,attempt_id AS "attemptId",browser_item_id AS "browserItemId",snapshot,${stamp('captured_at', 'capturedAt')},${stamp('created_at', 'createdAt')}
     FROM canvas_browser_item_captures WHERE owner_id=$1 ORDER BY captured_at,id LIMIT 10001`,
    [owner],
  );
  return {
    canvasBrowserSource: {
      sensitivity: connection.sensitivity,
      version: connection.version,
    },
    canvasBrowserCourses: connection.courses,
    canvasBrowserItems: connection.items,
    canvasBrowserItemCaptures: captures,
  };
}
