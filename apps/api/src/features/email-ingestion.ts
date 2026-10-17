import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  Temporal,
  emailConnectorCreateSchema,
  emailConnectorCreatedSchema,
  emailConnectorAttemptFinishSchema,
  emailConnectorAttemptResultSchema,
  emailConnectorAttemptSchema,
  emailConnectorRevokeSchema,
  emailConnectorStateSchema,
  emailConnectorsResponseSchema,
  emailUploadBatchSchema,
  emailUploadResultSchema,
  mailMessageResponseSchema,
  mailPageSchema,
  mailCategorySchema,
} from '@hub/contracts';
import { z } from 'zod';
import type { authService } from '../auth/routes.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { stamp } from './common.js';
import { mutate } from '../planner/mutations.js';

// Read-only mail ingestion (docs/email-ingestion.md). The local connector
// authenticates with a bearer token; owners manage connectors and read mail
// with their session. Message text is never logged.

export const connectorPathPrefix = '/api/v1/email/connector/';
const windowDays = 30;
const staleAfterMs = 30 * 60 * 1000;
const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

const connectorColumns = `id,name,sensitivity,to_char(since,'YYYY-MM-DD') AS since,version,${stamp('created_at', 'createdAt')},${stamp('last_seen_at', 'lastSeenAt')},${stamp('last_attempt_at', 'lastAttemptAt')},${stamp('last_contact_at', 'lastContactAt')},${stamp('last_import_at', 'lastImportAt')},${stamp('last_complete_at', 'lastCompleteAt')},last_attempt_outcome AS "lastAttemptOutcome",last_error_code AS "lastErrorCode",active_attempt_id AS "activeAttemptId",${stamp('revoked_at', 'revokedAt')}`;

function connectorHealthStatus(row: Record<string, unknown>) {
  if (row.revokedAt) return 'revoked';
  if (
    row.activeAttemptId &&
    row.lastAttemptAt &&
    Date.now() - new Date(String(row.lastAttemptAt)).getTime() <= staleAfterMs
  )
    return 'syncing';
  if (row.lastErrorCode === 'bridge-auth') return 'sign-in-required';
  if (row.lastErrorCode) return 'error';
  if (!row.lastAttemptAt) return 'never-synced';
  if (row.activeAttemptId) return 'partial';
  if (row.lastAttemptOutcome === 'partial') return 'partial';
  if (row.lastAttemptOutcome === 'failed') return 'error';
  if (!row.lastCompleteAt) return 'partial';
  return Date.now() - new Date(String(row.lastCompleteAt)).getTime() >
    staleAfterMs
    ? 'stale'
    : 'current';
}

async function readConnectors(tx: QueryExecutor, owner: string) {
  const connectors = await tx.query(
    `SELECT ${connectorColumns} FROM email_connectors WHERE owner_id=$1 ORDER BY created_at DESC`,
    [owner],
  );
  const folders = await tx.query(
    `SELECT f.connector_id AS "connectorId",f.path,f.role,f.exists_count AS exists,f.window_count AS "inWindow",${stamp('f.updated_at', 'syncedAt')},${stamp('f.last_complete_at', 'completeAt')},
       (SELECT COUNT(*)::integer FROM email_messages m WHERE m.owner_id=f.owner_id AND m.connector_id=f.connector_id AND f.path=ANY(m.folders)) AS imported
     FROM email_folders f WHERE f.owner_id=$1 ORDER BY f.path`,
    [owner],
  );
  return connectors.map((connector) => ({
    ...(connector as { id: string }),
    healthStatus: connectorHealthStatus(connector),
    // The response schema drops connectorId.
    folders: folders.filter((folder) => folder.connectorId === connector.id),
  }));
}

/** The connector for a bearer token, or 401. */
async function requireConnector(database: Database, request: FastifyRequest) {
  const match = /^Bearer (hubc_[A-Za-z0-9_-]{20,200})$/.exec(
    request.headers.authorization ?? '',
  );
  if (!match)
    throw new ApiError(401, 'UNAUTHENTICATED', 'Connector token required.');
  const [row] = await database.query(
    `SELECT id,owner_id AS owner,sensitivity,to_char(since,'YYYY-MM-DD') AS since FROM email_connectors WHERE token_hash=$1 AND revoked_at IS NULL`,
    [hash(match[1]!)],
  );
  if (!row)
    throw new ApiError(401, 'UNAUTHENTICATED', 'Connector token revoked.');
  return row as {
    id: string;
    owner: string;
    sensitivity: string;
    since: string;
  };
}

export function registerEmailIngestion(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  // Owner: connectors.
  app.get('/api/v1/email/connectors', async (request) => {
    const owner = await auth.requireUser(request);
    return emailConnectorsResponseSchema.parse({
      connectors: await readConnectors(database, owner.id),
    });
  });

  app.post('/api/v1/email/connectors', async (request, reply) => {
    const owner = await auth.requireUser(request);
    const input = emailConnectorCreateSchema.parse(request.body);
    const token = `hubc_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    const since = Temporal.Now.plainDateISO('UTC')
      .subtract({ days: windowDays })
      .toString();
    let fresh = false;
    await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'email.connector.create', ...input },
      async (tx) => {
        await tx.query(
          'INSERT INTO email_connectors(id,owner_id,name,token_hash,sensitivity,since) VALUES($1,$2,$3,$4,$5,$6)',
          [id, owner.id, input.name, hash(token), input.sensitivity, since],
        );
        fresh = true;
        return { id };
      },
    );
    if (!fresh)
      throw new ApiError(
        409,
        'TOKEN_ALREADY_ISSUED',
        'This connector was already added. Its token cannot be shown again. Reload Connections, revoke it, and add a replacement if the token was lost.',
      );
    const connector = (await readConnectors(database, owner.id)).find(
      (row) => row.id === id,
    );
    reply.code(201);
    return emailConnectorCreatedSchema.parse({ connector, token });
  });

  app.post('/api/v1/email/connectors/:id/revoke', async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = emailConnectorRevokeSchema.parse(request.body);
    await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'email.connector.revoke', id, ...input },
      async (tx) => {
        const [row] = await tx.query(
          `UPDATE email_connectors SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP),version=version+1 WHERE owner_id=$1 AND id=$2 AND version=$3 RETURNING id`,
          [owner.id, id, input.expectedVersion],
        );
        if (!row) {
          const [exists] = await tx.query(
            'SELECT 1 FROM email_connectors WHERE owner_id=$1 AND id=$2',
            [owner.id, id],
          );
          throw exists
            ? new ApiError(409, 'VERSION_CONFLICT', 'The connector changed.')
            : new ApiError(404, 'NOT_FOUND', 'Connector not available.');
        }
        return { id };
      },
    );
    return emailConnectorsResponseSchema.parse({
      connectors: await readConnectors(database, owner.id),
    });
  });

  // Owner: mail.
  app.get('/api/v1/email/messages', async (request) => {
    const owner = await auth.requireUser(request);
    const query = z
      .strictObject({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        before: z.string().uuid().optional(),
        folder: z.string().min(1).max(1000).optional(),
        category: z
          .union([mailCategorySchema, z.literal('uncategorized')])
          .optional(),
      })
      .parse(request.query);
    return database.transaction(async (tx) => {
      let anchor: Record<string, unknown> | undefined;
      if (query.before) {
        [anchor] = await tx.query(
          `SELECT id,received_at FROM email_messages WHERE owner_id=$1 AND id=$2`,
          [owner.id, query.before],
        );
        if (!anchor)
          throw new ApiError(404, 'NOT_FOUND', 'Mail cursor not available.');
      }
      const rows = await tx.query(
        `SELECT id,version,category,category_source AS "categorySource",category_rule_id AS "categoryRuleId",category_rule_capture AS "categoryRuleCapture",connector_id AS "connectorId",from_address AS "from",subject,${stamp('received_at', 'receivedAt')},folders,left(body,200) AS snippet,attachment_count AS "attachmentCount",sensitivity
         FROM email_messages WHERE owner_id=$1
         AND ($3::text IS NULL OR $3=ANY(folders))
         AND ($4::text IS NULL OR ($4='uncategorized' AND category IS NULL) OR category=$4)
         ${anchor ? 'AND (received_at,id)<($5::timestamptz,$6::uuid)' : ''}
         ORDER BY received_at DESC,id DESC LIMIT $2`,
        [
          owner.id,
          query.limit + 1,
          query.folder ?? null,
          query.category ?? null,
          ...(anchor ? [anchor.received_at, anchor.id] : []),
        ],
      );
      return mailPageSchema.parse({
        messages: rows.slice(0, query.limit),
        nextBefore:
          rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      });
    });
  });

  app.get('/api/v1/email/messages/:id', async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [row] = await database.query(
      `SELECT id,version,category,category_source AS "categorySource",category_rule_id AS "categoryRuleId",category_rule_capture AS "categoryRuleCapture",connector_id AS "connectorId",from_address AS "from",to_addresses AS "to",cc_addresses AS cc,subject,${stamp('sent_at', 'sentAt')},${stamp('received_at', 'receivedAt')},folders,body,body_truncated AS "bodyTruncated",attachment_count AS "attachmentCount",sensitivity
       FROM email_messages WHERE owner_id=$1 AND id=$2`,
      [owner.id, id],
    );
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Message not available.');
    return mailMessageResponseSchema.parse({ message: row });
  });

  // Connector: bearer token, no browser origin.
  app.post(`${connectorPathPrefix}attempt`, async (request) => {
    const connector = await requireConnector(database, request);
    const input = emailConnectorAttemptSchema.parse(request.body);
    const [row] = await database.query(
      `UPDATE email_connectors SET last_attempt_at=CURRENT_TIMESTAMP,last_contact_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP,active_attempt_id=$2,last_attempt_outcome=NULL,last_error_code=NULL
       WHERE id=$1 AND revoked_at IS NULL RETURNING active_attempt_id AS "attemptId"`,
      [connector.id, input.attemptId],
    );
    if (!row)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Connector token revoked.');
    return emailConnectorAttemptResultSchema.parse(row);
  });

  app.get(`${connectorPathPrefix}state`, async (request) => {
    const connector = await requireConnector(database, request);
    const folders = (
      await database.query(
        `SELECT path,uid_validity AS "uidValidity",last_uid::text AS "lastUid" FROM email_folders WHERE connector_id=$1 ORDER BY path`,
        [connector.id],
      )
    ).map((row) => ({ ...row, lastUid: Number(row.lastUid) }));
    await database.query(
      'UPDATE email_connectors SET last_seen_at=CURRENT_TIMESTAMP,last_contact_at=CURRENT_TIMESTAMP WHERE id=$1',
      [connector.id],
    );
    return emailConnectorStateSchema.parse({ since: connector.since, folders });
  });

  app.post(
    `${connectorPathPrefix}batch`,
    { bodyLimit: 4 * 1024 * 1024 },
    async (request) => {
      const connector = await requireConnector(database, request);
      const input = emailUploadBatchSchema.parse(request.body);
      return database.transaction(async (tx) => {
        // Serialize uploads (including first-folder inserts) with revocation.
        const [active] = await tx.query(
          'SELECT id FROM email_connectors WHERE id=$1 AND revoked_at IS NULL FOR UPDATE',
          [connector.id],
        );
        if (!active)
          throw new ApiError(
            401,
            'UNAUTHENTICATED',
            'Connector token revoked.',
          );
        const [folder] = await tx.query(
          'SELECT uid_validity,last_uid FROM email_folders WHERE connector_id=$1 AND path=$2 FOR UPDATE',
          [connector.id, input.path],
        );
        // A new UIDVALIDITY means Bridge renumbered the folder: start over.
        // Messages de-duplicate by key, so nothing is stored twice.
        const previous =
          folder && folder.uid_validity === input.uidValidity
            ? Number(folder.last_uid)
            : 0;
        const lastUid = Math.max(previous, input.lastUid);
        await tx.query(
          `INSERT INTO email_folders(owner_id,connector_id,path,role,uid_validity,last_uid,exists_count,window_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT(connector_id,path) DO UPDATE SET role=$4,uid_validity=$5,last_uid=$6,exists_count=$7,window_count=$8,updated_at=CURRENT_TIMESTAMP`,
          [
            connector.owner,
            connector.id,
            input.path,
            input.role,
            input.uidValidity,
            lastUid,
            input.exists,
            input.inWindow,
          ],
        );
        if (input.complete)
          await tx.query(
            `UPDATE email_folders SET last_complete_at=CURRENT_TIMESTAMP,last_complete_uid=$3 WHERE connector_id=$1 AND path=$2`,
            [connector.id, input.path, lastUid],
          );
        let imported = 0;
        for (const message of input.messages) {
          const [stored] = await tx.query(
            `INSERT INTO email_messages(id,owner_id,connector_id,message_key,from_address,to_addresses,cc_addresses,subject,sent_at,received_at,body,body_truncated,attachment_count,folders,sensitivity,text_origin)
             VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,ARRAY[$14::text],$15,$16)
             ON CONFLICT(owner_id,connector_id,message_key) DO UPDATE SET
               folders=CASE WHEN $14=ANY(email_messages.folders) THEN email_messages.folders ELSE array_append(email_messages.folders,$14) END,
               updated_at=CURRENT_TIMESTAMP
             RETURNING (xmax = 0) AS inserted`,
            [
              randomUUID(),
              connector.owner,
              connector.id,
              message.messageKey,
              JSON.stringify(message.from),
              JSON.stringify(message.to),
              JSON.stringify(message.cc),
              message.subject,
              message.sentAt,
              message.receivedAt,
              message.body,
              message.bodyTruncated,
              message.attachmentCount,
              input.path,
              connector.sensitivity,
              message.textOrigin ?? null,
            ],
          );
          if (stored?.inserted) imported++;
          const [savedMessage] = await tx.query(
            `SELECT id FROM email_messages WHERE owner_id=$1 AND connector_id=$2 AND message_key=$3`,
            [connector.owner, connector.id, message.messageKey],
          );
          if (!savedMessage)
            throw new ApiError(
              500,
              'IMPORT_FAILED',
              'Imported message was not stored.',
            );
          await tx.query(
            `INSERT INTO email_folder_memberships(owner_id,connector_id,path,uid_validity,uid,message_id)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT(connector_id,path,uid_validity,uid) DO UPDATE SET message_id=$6,observed_at=CURRENT_TIMESTAMP`,
            [
              connector.owner,
              connector.id,
              input.path,
              input.uidValidity,
              message.uid,
              savedMessage.id,
            ],
          );
        }
        if (input.complete) {
          const currentUids = input.windowUids ?? [];
          const removed = await tx.query(
            `DELETE FROM email_folder_memberships
             WHERE owner_id=$1 AND connector_id=$2 AND path=$3
               AND (uid_validity<>$4 OR NOT (uid=ANY($5::bigint[])))
             RETURNING message_id AS "messageId"`,
            [
              connector.owner,
              connector.id,
              input.path,
              input.uidValidity,
              currentUids,
            ],
          );
          const affected = new Set<string>([
            ...removed.map((row) => String(row.messageId)),
            ...(
              await tx.query(
                `SELECT DISTINCT message_id AS "messageId" FROM email_folder_memberships
                 WHERE owner_id=$1 AND connector_id=$2 AND path=$3`,
                [connector.owner, connector.id, input.path],
              )
            ).map((row) => String(row.messageId)),
          ]);
          for (const messageId of affected) {
            const memberships = await tx.query(
              `SELECT DISTINCT path FROM email_folder_memberships WHERE owner_id=$1 AND message_id=$2 ORDER BY path`,
              [connector.owner, messageId],
            );
            await tx.query(
              `UPDATE email_messages SET folders=$3::text[],updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2`,
              [connector.owner, messageId, memberships.map((row) => row.path)],
            );
          }
        }
        await tx.query(
          `UPDATE email_connectors SET last_seen_at=CURRENT_TIMESTAMP,last_contact_at=CURRENT_TIMESTAMP,
             last_import_at=CASE WHEN $2::integer>0 THEN CURRENT_TIMESTAMP ELSE last_import_at END
           WHERE id=$1`,
          [connector.id, imported],
        );
        return emailUploadResultSchema.parse({
          stored: input.messages.length,
          lastUid,
        });
      });
    },
  );

  app.post(`${connectorPathPrefix}attempt/finish`, async (request) => {
    const connector = await requireConnector(database, request);
    const input = emailConnectorAttemptFinishSchema.parse(request.body);
    if (input.outcome === 'complete' && input.errorCode)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'A complete sync cannot have an error.',
      );
    const [row] = await database.query(
      `UPDATE email_connectors SET active_attempt_id=NULL,
         last_complete_at=CASE WHEN $3='complete' THEN CURRENT_TIMESTAMP ELSE last_complete_at END,
         last_attempt_outcome=$3,
         last_error_code=CASE WHEN $3='failed' THEN $4 ELSE NULL END,
         last_contact_at=CURRENT_TIMESTAMP,last_seen_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND active_attempt_id=$2 AND revoked_at IS NULL RETURNING id`,
      [connector.id, input.attemptId, input.outcome, input.errorCode],
    );
    if (!row)
      throw new ApiError(
        409,
        'ATTEMPT_CHANGED',
        'The connector attempt changed.',
      );
    return { ok: true };
  });
}
