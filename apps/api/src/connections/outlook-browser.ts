import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  outlookBrowserAttemptFinishSchema,
  outlookBrowserAttemptStartResponseSchema,
  outlookBrowserAttemptStartSchema,
  outlookBrowserConnectionSchema,
  outlookBrowserCollectorStateSchema,
  outlookBrowserDiscoverySchema,
  outlookBrowserFolderObservationSchema,
  outlookBrowserFolderSchema,
  outlookBrowserFolderWriteSchema,
  outlookBrowserFolderWriteResponseSchema,
  outlookBrowserMessageCaptureDataSchema,
  outlookBrowserMessageCaptureSchema,
  outlookBrowserMessageDetailResponseSchema,
  outlookBrowserMessageSchema,
  outlookBrowserMessageWriteSchema,
  outlookBrowserMessageWriteResponseSchema,
  outlookBrowserObservationResultSchema,
  outlookBrowserRevokeSchema,
  outlookBrowserSettingsSchema,
  outlookBrowserTokenRequestSchema,
  outlookBrowserTokenResponseSchema,
  outlookFolderIdentity,
  outlookMessageIdentity,
} from '@hub/contracts';
import type { authService } from '../auth/routes.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { stamp, strongest, version } from '../features/common.js';
import { mutate } from '../planner/mutations.js';

export const outlookBrowserCollectorPathPrefix =
  '/api/v1/outlook/browser/collector/';
const base = '/api/v1/connections/outlook/browser';
const staleAfterMs = 6 * 60 * 60 * 1000;
const messagePageSize = 200;
const tokenPattern = /^Bearer (hubob_[A-Za-z0-9_-]{20,200})$/;

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
    'INSERT INTO outlook_browser_sources(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
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
  if (source.lastErrorCode === 'mfa-required') return 'mfa-required';
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

const folderColumns = `bf.id,bf.provider_id AS "providerId",bf.name,bf.canonical_url AS "canonicalUrl",bf.availability,bf.selected,bf.notes,bf.sensitivity,bf.version,${stamp('bf.last_contact_at', 'lastContactAt')},${stamp('bf.last_import_at', 'lastImportAt')},${stamp('bf.last_complete_at', 'lastCompleteAt')},bf.last_observation_status AS "lastObservationStatus",bf.last_observed_count AS "lastObservedCount",${stamp('bf.created_at', 'createdAt')},${stamp('bf.updated_at', 'updatedAt')}`;

const messageColumns = `bm.id,bm.browser_folder_id AS "browserFolderId",bm.provider_id AS "providerId",bm.conversation_id AS "conversationId",bm.canonical_url AS "canonicalUrl",bm.subject,bm.sender_display AS "senderDisplay",bm.sender_address AS "senderAddress",${stamp('bm.received_at', 'receivedAt')},bm.snippet,${stamp('bm.captured_at', 'capturedAt')},bm.availability,bm.notes,bm.sensitivity,bm.version,${stamp('bm.created_at', 'createdAt')},${stamp('bm.updated_at', 'updatedAt')}`;

async function readExistingConnection(tx: QueryExecutor, owner: string) {
  const [source] = await tx.query(
    `SELECT ${sourceColumns} FROM outlook_browser_sources s WHERE s.owner_id=$1`,
    [owner],
  );
  if (!source)
    throw new ApiError(
      500,
      'OUTLOOK_BROWSER_STATE',
      'Outlook browser source is unavailable.',
    );
  const folders = await tx.query(
    `SELECT ${folderColumns} FROM outlook_browser_folders bf
     WHERE bf.owner_id=$1 ORDER BY bf.name,bf.provider_id`,
    [owner],
  );
  const recent = await tx.query(
    `SELECT ${messageColumns} FROM outlook_browser_messages bm
     WHERE bm.owner_id=$1
     ORDER BY bm.received_at DESC NULLS LAST,bm.captured_at DESC,bm.id
     LIMIT ${messagePageSize + 1}`,
    [owner],
  );
  const attempts = await tx.query(
    `SELECT id,source_version AS "sourceVersion",outcome,error_code AS "errorCode",discovery_status AS "discoveryStatus",selected_count AS "selectedCount",complete_count AS "completeCount",${stamp('started_at', 'startedAt')},${stamp('finished_at', 'finishedAt')}
     FROM outlook_browser_attempts WHERE owner_id=$1 ORDER BY started_at DESC,id LIMIT 20`,
    [owner],
  );
  const selectedCount = folders.filter((folder) => folder.selected).length;
  return outlookBrowserConnectionSchema.parse({
    ...source,
    healthStatus: healthStatus(source, selectedCount),
    folders: folders.map((folder) => ({
      ...folder,
      effectiveSensitivity: strongest(
        String(source.sensitivity),
        String(folder.sensitivity),
      ),
    })),
    messages: recent.slice(0, messagePageSize).map((message) => ({
      ...message,
      effectiveSensitivity: strongest(
        String(source.sensitivity),
        String(
          folders.find((folder) => folder.id === message.browserFolderId)
            ?.sensitivity ?? 'unlabeled',
        ),
        String(message.sensitivity),
      ),
    })),
    messagesTruncated: recent.length > messagePageSize,
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
      'Outlook browser collector token required.',
    );
  const [row] = await database.query(
    `SELECT owner_id AS owner,version FROM outlook_browser_sources
     WHERE token_hash=$1 AND token_revoked_at IS NULL`,
    [hash(match[1]!)],
  );
  if (!row)
    throw new ApiError(
      401,
      'UNAUTHENTICATED',
      'Outlook browser collector token revoked.',
    );
  return row as { owner: string; version: number };
}

async function invalidateAttempt(tx: QueryExecutor, owner: string) {
  const [source] = await tx.query(
    'SELECT active_attempt_id AS "activeAttemptId" FROM outlook_browser_sources WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
  if (!source?.activeAttemptId) return;
  await tx.query(
    `UPDATE outlook_browser_attempts SET outcome='partial',finished_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND outcome IS NULL`,
    [owner, source.activeAttemptId],
  );
  await tx.query(
    `UPDATE outlook_browser_sources SET active_attempt_id=NULL,active_attempt_progress_at=NULL,last_attempt_outcome='partial',last_error_code=NULL
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
    `SELECT version,active_attempt_id AS "activeAttemptId" FROM outlook_browser_sources WHERE owner_id=$1 FOR UPDATE`,
    [owner],
  );
  const [attempt] = await tx.query(
    `SELECT source_version AS "sourceVersion",coverage_revision AS "coverageRevision",discovery_status AS "discoveryStatus",discovery_hash AS "discoveryHash",discovery_counts AS "discoveryCounts",selected_count AS "selectedCount"
     FROM outlook_browser_attempts WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
    [owner, attemptId],
  );
  if (!source || !attempt || source.activeAttemptId !== attemptId)
    throw new ApiError(
      409,
      'ATTEMPT_CHANGED',
      'The Outlook browser collection attempt changed.',
    );
  if (source.version !== attempt.sourceVersion)
    throw new ApiError(
      409,
      'SOURCE_CHANGED',
      'Outlook browser settings changed.',
    );
  return { source, attempt };
}

function assertFolderUrl(providerId: string, canonicalUrl: string) {
  const identity = outlookFolderIdentity(canonicalUrl);
  if (!identity || identity.folderProviderId !== providerId)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Outlook folder identity is invalid.',
    );
}

function assertMessageUrl(
  folderProviderId: string,
  providerId: string,
  canonicalUrl: string,
) {
  const identity = outlookMessageIdentity(canonicalUrl);
  if (
    !identity ||
    identity.messageProviderId !== providerId ||
    (identity.folderProviderId !== null &&
      identity.folderProviderId !== folderProviderId)
  )
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Outlook message identity is invalid.',
    );
}

async function readMessage(
  tx: QueryExecutor,
  owner: string,
  id: string,
): Promise<{
  message: Record<string, unknown>;
  captures: Record<string, unknown>[];
}> {
  const [source] = await tx.query(
    'SELECT sensitivity FROM outlook_browser_sources WHERE owner_id=$1',
    [owner],
  );
  const [message] = await tx.query(
    `SELECT ${messageColumns},bm.body_text AS "bodyText",bf.sensitivity AS "folderLabel"
     FROM outlook_browser_messages bm
     JOIN outlook_browser_folders bf ON bf.id=bm.browser_folder_id AND bf.owner_id=bm.owner_id
     WHERE bm.owner_id=$1 AND bm.id=$2`,
    [owner, id],
  );
  if (!message)
    throw new ApiError(
      404,
      'NOT_FOUND',
      'Outlook browser message not available.',
    );
  const { folderLabel, ...stored } = message;
  const captures = await tx.query(
    `SELECT id,attempt_id AS "attemptId",browser_message_id AS "browserMessageId",snapshot,${stamp('captured_at', 'capturedAt')},${stamp('created_at', 'createdAt')}
     FROM outlook_browser_message_captures WHERE owner_id=$1 AND browser_message_id=$2
     ORDER BY captured_at DESC,id LIMIT 50`,
    [owner, id],
  );
  return {
    message: {
      ...stored,
      effectiveSensitivity: strongest(
        String(source?.sensitivity ?? 'unlabeled'),
        String(folderLabel ?? 'unlabeled'),
        String(message.sensitivity),
      ),
    },
    captures,
  };
}

export function registerOutlookBrowser(
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
    const input = outlookBrowserSettingsSchema.parse(request.body);
    await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'outlook.browser.settings', input },
      async (tx) => {
        await ensure(tx, owner.id);
        await invalidateAttempt(tx, owner.id);
        const [row] = await tx.query(
          `UPDATE outlook_browser_sources SET sensitivity=$3,version=version+1
           WHERE owner_id=$1 AND version=$2 RETURNING version`,
          [owner.id, input.expectedVersion, input.sensitivity],
        );
        if (!row)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload Outlook browser settings.',
          );
        return { version: row.version };
      },
    );
    return readConnection(database, owner.id);
  });

  app.post(`${base}/token`, async (request) => {
    const owner = await auth.requireUser(request);
    const input = outlookBrowserTokenRequestSchema.parse(request.body);
    const token = `hubob_${randomBytes(32).toString('base64url')}`;
    let fresh = false;
    await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'outlook.browser.token', expectedVersion: input.expectedVersion },
      async (tx) => {
        await ensure(tx, owner.id);
        await invalidateAttempt(tx, owner.id);
        const [row] = await tx.query(
          `UPDATE outlook_browser_sources SET token_hash=$3,token_issued_at=CURRENT_TIMESTAMP,token_revoked_at=NULL,version=version+1
           WHERE owner_id=$1 AND version=$2 RETURNING version`,
          [owner.id, input.expectedVersion, hash(token)],
        );
        if (!row)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload Outlook browser settings.',
          );
        fresh = true;
        return { version: row.version };
      },
    );
    if (!fresh)
      throw new ApiError(
        409,
        'TOKEN_ALREADY_ISSUED',
        'This Outlook browser token was already issued and cannot be shown again. Create a replacement token if it was lost.',
      );
    return outlookBrowserTokenResponseSchema.parse({
      token,
      connection: await readConnection(database, owner.id),
    });
  });

  app.post(`${base}/revoke`, async (request) => {
    const owner = await auth.requireUser(request);
    const input = outlookBrowserRevokeSchema.parse(request.body);
    await mutate(
      database,
      owner.id,
      input.operationId,
      {
        kind: 'outlook.browser.revoke',
        expectedVersion: input.expectedVersion,
      },
      async (tx) => {
        await ensure(tx, owner.id);
        await invalidateAttempt(tx, owner.id);
        const [row] = await tx.query(
          `UPDATE outlook_browser_sources SET token_hash=NULL,token_revoked_at=CURRENT_TIMESTAMP,version=version+1
           WHERE owner_id=$1 AND version=$2 RETURNING version`,
          [owner.id, input.expectedVersion],
        );
        if (!row)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload Outlook browser settings.',
          );
        return { version: row.version };
      },
    );
    return readConnection(database, owner.id);
  });

  app.put(`${base}/folders/:id`, async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = outlookBrowserFolderSchema
      .pick({ id: true })
      .parse(request.params);
    const input = outlookBrowserFolderWriteSchema.parse(request.body);
    await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'outlook.browser.folder.edit', id, input },
      async (tx) => {
        await ensure(tx, owner.id);
        await tx.query(
          'SELECT owner_id FROM outlook_browser_sources WHERE owner_id=$1 FOR UPDATE',
          [owner.id],
        );
        const [old] = await tx.query(
          'SELECT selected,version FROM outlook_browser_folders WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [owner.id, id],
        );
        if (!old)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Outlook browser folder not available.',
          );
        version(old, input.expectedVersion);
        if (old.selected !== input.selected) {
          await invalidateAttempt(tx, owner.id);
          await tx.query(
            'UPDATE outlook_browser_sources SET version=version+1,coverage_revision=coverage_revision+1 WHERE owner_id=$1',
            [owner.id],
          );
        }
        await tx.query(
          `UPDATE outlook_browser_folders SET selected=$3,notes=$4,sensitivity=$5,version=version+1,updated_at=CURRENT_TIMESTAMP
           WHERE owner_id=$1 AND id=$2`,
          [owner.id, id, input.selected, input.notes, input.sensitivity],
        );
        return { id };
      },
    );
    const connection = await readConnection(database, owner.id);
    return outlookBrowserFolderWriteResponseSchema.parse({
      folder: connection.folders.find((folder) => folder.id === id),
      sourceVersion: connection.version,
    });
  });

  app.put(`${base}/messages/:id`, async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = outlookBrowserMessageSchema
      .pick({ id: true })
      .parse(request.params);
    const input = outlookBrowserMessageWriteSchema.parse(request.body);
    await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'outlook.browser.message.edit', id, input },
      async (tx) => {
        const [old] = await tx.query(
          'SELECT version FROM outlook_browser_messages WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [owner.id, id],
        );
        if (!old)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Outlook browser message not available.',
          );
        version(old, input.expectedVersion);
        await tx.query(
          `UPDATE outlook_browser_messages SET notes=$3,sensitivity=$4,version=version+1,updated_at=CURRENT_TIMESTAMP
           WHERE owner_id=$1 AND id=$2`,
          [owner.id, id, input.notes, input.sensitivity],
        );
        return { id };
      },
    );
    const detail = await readMessage(database, owner.id, id);
    const { bodyText, ...summary } = detail.message;
    void bodyText;
    return outlookBrowserMessageWriteResponseSchema.parse({
      message: summary,
    });
  });

  app.get(`${base}/messages/:id`, async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = outlookBrowserMessageSchema
      .pick({ id: true })
      .parse(request.params);
    return outlookBrowserMessageDetailResponseSchema.parse(
      await readMessage(database, owner.id, id),
    );
  });

  app.get(`${outlookBrowserCollectorPathPrefix}state`, async (request) => {
    const collector = await requireCollector(database, request);
    const [source] = await database.query(
      'SELECT version FROM outlook_browser_sources WHERE owner_id=$1',
      [collector.owner],
    );
    const folders = await database.query(
      `SELECT id,provider_id AS "providerId",canonical_url AS "canonicalUrl",version
       FROM outlook_browser_folders WHERE owner_id=$1 AND selected=TRUE ORDER BY provider_id`,
      [collector.owner],
    );
    return outlookBrowserCollectorStateSchema.parse({
      sourceVersion: source!.version,
      folders,
    });
  });

  app.post(`${outlookBrowserCollectorPathPrefix}attempt`, async (request) => {
    const collector = await requireCollector(database, request);
    const input = outlookBrowserAttemptStartSchema.parse(request.body);
    return database.transaction(async (tx) => {
      const [source] = await tx.query(
        `SELECT version,coverage_revision AS "coverageRevision",active_attempt_id AS "activeAttemptId",active_attempt_progress_at AS "activeAttemptProgressRaw"
         FROM outlook_browser_sources WHERE owner_id=$1 FOR UPDATE`,
        [collector.owner],
      );
      if (!source || source.version !== input.expectedSourceVersion)
        throw new ApiError(
          409,
          'SOURCE_CHANGED',
          'Outlook browser settings changed.',
        );
      const [existing] = await tx.query(
        `SELECT source_version AS "sourceVersion" FROM outlook_browser_attempts WHERE owner_id=$1 AND id=$2`,
        [collector.owner, input.attemptId],
      );
      if (existing) {
        if (existing.sourceVersion !== input.expectedSourceVersion)
          throw new ApiError(
            409,
            'ATTEMPT_CHANGED',
            'The Outlook browser collection attempt changed.',
          );
        return outlookBrowserAttemptStartResponseSchema.parse({
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
            'An Outlook browser collection is already running.',
          );
        await invalidateAttempt(tx, collector.owner);
      }
      const [selected] = await tx.query<{ count: number }>(
        'SELECT COUNT(*)::integer AS count FROM outlook_browser_folders WHERE owner_id=$1 AND selected=TRUE',
        [collector.owner],
      );
      const count = selected?.count ?? 0;
      await tx.query(
        `INSERT INTO outlook_browser_attempts(id,owner_id,source_version,coverage_revision,selected_count)
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
        `UPDATE outlook_browser_sources SET last_attempt_at=CURRENT_TIMESTAMP,active_attempt_id=$2,active_attempt_progress_at=CURRENT_TIMESTAMP,last_attempt_outcome=NULL,last_error_code=NULL
         WHERE owner_id=$1`,
        [collector.owner, input.attemptId],
      );
      return outlookBrowserAttemptStartResponseSchema.parse({
        attemptId: input.attemptId,
      });
    });
  });

  app.post(
    `${outlookBrowserCollectorPathPrefix}discovery`,
    { bodyLimit: 1024 * 1024 },
    async (request) => {
      const collector = await requireCollector(database, request);
      const input = outlookBrowserDiscoverySchema.parse(request.body);
      for (const folder of input.folders)
        assertFolderUrl(folder.providerId, folder.canonicalUrl);
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
              'Outlook discovery retry does not match the first observation.',
            );
          await tx.query(
            'UPDATE outlook_browser_sources SET active_attempt_progress_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND active_attempt_id=$2',
            [collector.owner, input.attemptId],
          );
          return outlookBrowserObservationResultSchema.parse(
            attempt.discoveryCounts,
          );
        }
        let added = 0;
        let updated = 0;
        for (const folder of input.folders) {
          const inserted = await tx.query(
            `INSERT INTO outlook_browser_folders(id,owner_id,provider_id,name,canonical_url,availability)
             VALUES($1,$2,$3,$4,$5,'available') ON CONFLICT(owner_id,provider_id) DO NOTHING RETURNING id`,
            [
              randomUUID(),
              collector.owner,
              folder.providerId,
              folder.name,
              folder.canonicalUrl,
            ],
          );
          if (inserted.length) {
            added++;
            continue;
          }
          updated += (
            await tx.query(
              `UPDATE outlook_browser_folders SET name=$3,canonical_url=$4,availability='available',version=version+1,updated_at=CURRENT_TIMESTAMP
               WHERE owner_id=$1 AND provider_id=$2 AND (name IS DISTINCT FROM $3 OR canonical_url IS DISTINCT FROM $4 OR availability<>'available') RETURNING id`,
              [
                collector.owner,
                folder.providerId,
                folder.name,
                folder.canonicalUrl,
              ],
            )
          ).length;
        }
        let missing = 0;
        if (input.status === 'complete')
          missing = (
            await tx.query(
              `UPDATE outlook_browser_folders SET availability='missing',version=version+1,updated_at=CURRENT_TIMESTAMP
               WHERE owner_id=$1 AND availability='available' AND NOT(provider_id=ANY($2::text[])) RETURNING id`,
              [
                collector.owner,
                input.folders.map((folder) => folder.providerId),
              ],
            )
          ).length;
        const counts = { added, updated, missing };
        const changed = added + updated + missing;
        await tx.query(
          `UPDATE outlook_browser_attempts SET discovery_status=$3,discovery_hash=$4,discovery_counts=$5::jsonb WHERE owner_id=$1 AND id=$2`,
          [
            collector.owner,
            input.attemptId,
            input.status,
            payloadHash,
            JSON.stringify(counts),
          ],
        );
        await tx.query(
          `UPDATE outlook_browser_sources SET last_contact_at=CURRENT_TIMESTAMP,
             active_attempt_progress_at=CURRENT_TIMESTAMP,
             last_import_at=CASE WHEN $2::integer>0 THEN CURRENT_TIMESTAMP ELSE last_import_at END
           WHERE owner_id=$1`,
          [collector.owner, changed],
        );
        return outlookBrowserObservationResultSchema.parse(counts);
      });
    },
  );

  app.post(
    `${outlookBrowserCollectorPathPrefix}folder`,
    { bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      const collector = await requireCollector(database, request);
      const input = outlookBrowserFolderObservationSchema.parse(request.body);
      const payloadHash = digest(input);
      return database.transaction(async (tx) => {
        await activeAttempt(tx, collector.owner, input.attemptId);
        const [folder] = await tx.query(
          `SELECT id,provider_id AS "providerId",selected FROM outlook_browser_folders
           WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
          [collector.owner, input.folderId],
        );
        if (!folder || !folder.selected)
          throw new ApiError(
            409,
            'FOLDER_CHANGED',
            'Outlook browser folder selection changed.',
          );
        for (const message of input.messages)
          assertMessageUrl(
            String(folder.providerId),
            message.providerId,
            message.canonicalUrl,
          );
        const [prior] = await tx.query(
          `SELECT payload_hash AS "payloadHash",counts FROM outlook_browser_folder_observations
           WHERE owner_id=$1 AND attempt_id=$2 AND browser_folder_id=$3`,
          [collector.owner, input.attemptId, input.folderId],
        );
        if (prior) {
          if (prior.payloadHash !== payloadHash)
            throw new ApiError(
              409,
              'ATTEMPT_CHANGED',
              'Outlook folder retry does not match the first observation.',
            );
          await tx.query(
            'UPDATE outlook_browser_sources SET active_attempt_progress_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND active_attempt_id=$2',
            [collector.owner, input.attemptId],
          );
          return outlookBrowserObservationResultSchema.parse(prior.counts);
        }
        let added = 0;
        let updated = 0;
        for (const message of input.messages) {
          const inserted = await tx.query(
            `INSERT INTO outlook_browser_messages(id,owner_id,browser_folder_id,provider_id,conversation_id,canonical_url,subject,sender_display,sender_address,received_at,snippet,body_text,captured_at,availability)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'available')
             ON CONFLICT(owner_id,browser_folder_id,provider_id) DO NOTHING RETURNING id`,
            [
              randomUUID(),
              collector.owner,
              input.folderId,
              message.providerId,
              message.conversationId,
              message.canonicalUrl,
              message.subject,
              message.senderDisplay,
              message.senderAddress,
              message.receivedAt,
              message.snippet,
              message.bodyText,
              input.capturedAt,
            ],
          );
          let messageId: string;
          if (inserted.length) {
            added++;
            messageId = String(inserted[0]!.id);
          } else {
            const changed = await tx.query(
              `UPDATE outlook_browser_messages SET conversation_id=$4,canonical_url=$5,subject=$6,sender_display=$7,sender_address=$8,received_at=$9,snippet=$10,body_text=$11,captured_at=$12,availability='available',version=version+1,updated_at=CURRENT_TIMESTAMP
               WHERE owner_id=$1 AND browser_folder_id=$2 AND provider_id=$3
                 AND (conversation_id IS DISTINCT FROM $4 OR canonical_url IS DISTINCT FROM $5 OR subject IS DISTINCT FROM $6 OR sender_display IS DISTINCT FROM $7 OR sender_address IS DISTINCT FROM $8 OR received_at IS DISTINCT FROM $9::timestamptz OR snippet IS DISTINCT FROM $10 OR body_text IS DISTINCT FROM $11 OR availability<>'available') RETURNING id`,
              [
                collector.owner,
                input.folderId,
                message.providerId,
                message.conversationId,
                message.canonicalUrl,
                message.subject,
                message.senderDisplay,
                message.senderAddress,
                message.receivedAt,
                message.snippet,
                message.bodyText,
                input.capturedAt,
              ],
            );
            if (changed.length) {
              updated++;
              messageId = String(changed[0]!.id);
            } else {
              const [unchanged] = await tx.query(
                `UPDATE outlook_browser_messages SET captured_at=$4 WHERE owner_id=$1 AND browser_folder_id=$2 AND provider_id=$3 RETURNING id`,
                [
                  collector.owner,
                  input.folderId,
                  message.providerId,
                  input.capturedAt,
                ],
              );
              if (!unchanged)
                throw new ApiError(
                  409,
                  'ATTEMPT_CHANGED',
                  'Outlook browser message changed during collection.',
                );
              messageId = String(unchanged.id);
            }
          }
          const snapshot = outlookBrowserMessageCaptureDataSchema.parse({
            providerId: message.providerId,
            conversationId: message.conversationId,
            canonicalUrl: message.canonicalUrl,
            subject: message.subject,
            senderDisplay: message.senderDisplay,
            senderAddress: message.senderAddress,
            receivedAt: message.receivedAt,
            snippet: message.snippet,
          });
          await tx.query(
            `INSERT INTO outlook_browser_message_captures(id,owner_id,attempt_id,browser_message_id,snapshot,captured_at)
             VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
            [
              randomUUID(),
              collector.owner,
              input.attemptId,
              messageId,
              JSON.stringify(snapshot),
              input.capturedAt,
            ],
          );
        }
        let missing = 0;
        if (input.status === 'complete') {
          const missingMessages = await tx.query<{ id: string }>(
            `UPDATE outlook_browser_messages SET availability='missing',version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE owner_id=$1 AND browser_folder_id=$2 AND availability='available'
               AND NOT(provider_id=ANY($3::text[])) RETURNING id`,
            [
              collector.owner,
              input.folderId,
              input.messages.map((message) => message.providerId),
            ],
          );
          missing = missingMessages.length;
        }
        const counts = { added, updated, missing };
        const changed = added + updated + missing;
        await tx.query(
          `INSERT INTO outlook_browser_folder_observations(attempt_id,owner_id,browser_folder_id,status,payload_hash,observed_count,counts,captured_at)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [
            input.attemptId,
            collector.owner,
            input.folderId,
            input.status,
            payloadHash,
            input.messages.length,
            JSON.stringify(counts),
            input.capturedAt,
          ],
        );
        await tx.query(
          `UPDATE outlook_browser_folders SET last_contact_at=CURRENT_TIMESTAMP,
             last_import_at=CASE WHEN $3::integer>0 THEN CURRENT_TIMESTAMP ELSE last_import_at END,
             last_complete_at=CASE WHEN $4='complete' THEN CURRENT_TIMESTAMP ELSE last_complete_at END,
             last_observation_status=$4,last_observed_count=$5
           WHERE owner_id=$1 AND id=$2`,
          [
            collector.owner,
            input.folderId,
            changed,
            input.status,
            input.messages.length,
          ],
        );
        await tx.query(
          `UPDATE outlook_browser_sources SET last_contact_at=CURRENT_TIMESTAMP,
             active_attempt_progress_at=CURRENT_TIMESTAMP,
             last_import_at=CASE WHEN $2::integer>0 THEN CURRENT_TIMESTAMP ELSE last_import_at END
           WHERE owner_id=$1`,
          [collector.owner, changed],
        );
        return outlookBrowserObservationResultSchema.parse(counts);
      });
    },
  );

  app.post(
    `${outlookBrowserCollectorPathPrefix}attempt/finish`,
    async (request) => {
      const collector = await requireCollector(database, request);
      const input = outlookBrowserAttemptFinishSchema.parse(request.body);
      if (input.outcome === 'complete' && input.errorCode)
        throw new ApiError(
          400,
          'INVALID_INPUT',
          'A complete Outlook collection cannot have an error.',
        );
      return database.transaction(async (tx) => {
        const [source] = await tx.query(
          `SELECT version,active_attempt_id AS "activeAttemptId" FROM outlook_browser_sources WHERE owner_id=$1 FOR UPDATE`,
          [collector.owner],
        );
        const [attempt] = await tx.query(
          `SELECT source_version AS "sourceVersion",coverage_revision AS "coverageRevision",outcome,error_code AS "errorCode",discovery_status AS "discoveryStatus",selected_count AS "selectedCount"
           FROM outlook_browser_attempts WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
          [collector.owner, input.attemptId],
        );
        if (!source || !attempt)
          throw new ApiError(
            409,
            'ATTEMPT_CHANGED',
            'The Outlook browser collection attempt changed.',
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
            'The Outlook browser collection attempt changed.',
          );
        }
        if (
          source.activeAttemptId !== input.attemptId ||
          source.version !== attempt.sourceVersion
        )
          throw new ApiError(
            409,
            'ATTEMPT_CHANGED',
            'The Outlook browser collection attempt changed.',
          );
        const [completed] = await tx.query<{ count: number }>(
          `SELECT COUNT(*)::integer AS count FROM outlook_browser_folder_observations
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
              'Outlook folder discovery or selection is incomplete.',
            );
          if (completeCount !== attempt.selectedCount)
            throw new ApiError(
              409,
              'COVERAGE_INCOMPLETE',
              'Not every selected Outlook folder was completely collected.',
            );
        }
        await tx.query(
          `UPDATE outlook_browser_attempts SET outcome=$3,error_code=CASE WHEN $3='complete' THEN NULL ELSE $4 END,complete_count=$5,finished_at=CURRENT_TIMESTAMP
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
          `UPDATE outlook_browser_sources SET active_attempt_id=NULL,active_attempt_progress_at=NULL,last_attempt_outcome=$3,
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

export async function exportOutlookBrowser(tx: QueryExecutor, owner: string) {
  const [source] = await tx.query(
    'SELECT owner_id FROM outlook_browser_sources WHERE owner_id=$1',
    [owner],
  );
  if (!source)
    return {
      outlookBrowserSource: null,
      outlookBrowserFolders: [],
      outlookBrowserMessages: [],
      outlookBrowserMessageCaptures: [],
    };
  const connection = await readExistingConnection(tx, owner);
  const messages = await tx.query(
    `SELECT ${messageColumns},bm.body_text AS "bodyText" FROM outlook_browser_messages bm
     WHERE bm.owner_id=$1 ORDER BY bm.received_at DESC NULLS LAST,bm.id LIMIT 10001`,
    [owner],
  );
  const captures = await tx.query(
    `SELECT id,attempt_id AS "attemptId",browser_message_id AS "browserMessageId",snapshot,${stamp('captured_at', 'capturedAt')},${stamp('created_at', 'createdAt')}
     FROM outlook_browser_message_captures WHERE owner_id=$1 ORDER BY captured_at,id LIMIT 10001`,
    [owner],
  );
  const folderLabel = new Map(
    connection.folders.map((folder) => [folder.id, folder.sensitivity]),
  );
  return {
    outlookBrowserSource: {
      sensitivity: connection.sensitivity,
      version: connection.version,
    },
    outlookBrowserFolders: connection.folders,
    outlookBrowserMessages: messages.map((message) => ({
      ...message,
      effectiveSensitivity: strongest(
        connection.sensitivity,
        String(folderLabel.get(String(message.browserFolderId)) ?? 'unlabeled'),
        String(message.sensitivity),
      ),
    })),
    outlookBrowserMessageCaptures: captures.map((capture) =>
      outlookBrowserMessageCaptureSchema.parse(capture),
    ),
  };
}
