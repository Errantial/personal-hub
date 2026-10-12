import { createHash } from 'node:crypto';
import {
  aiRequestSchema,
  aiAttemptSchema,
  aiPreflightSchema,
} from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { stamp } from '../features/common.js';
import { ApiError } from '../errors.js';
export const requestColumns = `r.id,r.version,r.status,COALESCE(r.input_manifest->'saveAnswer','false'::jsonb) AS "saveAnswer",${stamp('r.created_at', 'createdAt')},${stamp('r.updated_at', 'updatedAt')},${stamp('r.deleted_at', 'deletedAt')}`;
export const attemptColumns = `id,version,request_id AS "requestId",reservation_id AS "reservationId",status,adapter,admission_metadata AS admission,input_tokens AS "inputTokens",output_tokens AS "outputTokens",actual_micros AS "actualMicros",result_metadata AS "resultMetadata",protocol_metadata AS "protocolMetadata",protocol_observation AS "protocolObservation",${stamp('created_at', 'createdAt')},${stamp('finished_at', 'finishedAt')}`;
export const boundTextHash = (owner: string, id: string, text: string) =>
  createHash('sha256')
    .update(JSON.stringify([owner, id, text]))
    .digest('hex');
export async function readAIRequest(
  tx: QueryExecutor,
  owner: string,
  id: string,
  includeHidden = false,
) {
  const [row] = await tx.query(
    `SELECT ${requestColumns},p.metadata AS assessment,p.id AS "preflightId",p.version AS "preflightVersion",${stamp('p.created_at', 'preflightCreatedAt')},${stamp('p.deleted_at', 'preflightDeletedAt')} FROM ai_requests r JOIN ai_preflights p ON p.id=r.preflight_id AND p.owner_id=r.owner_id WHERE r.owner_id=$1 AND r.id=$2 ${includeHidden ? '' : 'AND r.deleted_at IS NULL'}`,
    [owner, id],
  );
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'AI request not available.');
  const [attempt] = await tx.query(
    `SELECT ${attemptColumns} FROM ai_attempts WHERE owner_id=$1 AND request_id=$2`,
    [owner, id],
  );
  return aiRequestSchema.parse({
    ...row,
    dispatchEnabled: false,
    requiresTextResupply: row.status === 'blocked',
    textRetained: false,
    assessment: aiPreflightSchema.parse({
      ...(row.assessment as object),
      id: row.preflightId,
      version: row.preflightVersion,
      createdAt: row.preflightCreatedAt,
      deletedAt: row.preflightDeletedAt,
    }),
    attempt: attempt
      ? aiAttemptSchema.parse({
          ...attempt,
          actualMicros:
            attempt.actualMicros === null ? null : Number(attempt.actualMicros),
        })
      : null,
  });
}
export async function readAIRequests(
  tx: QueryExecutor,
  owner: string,
  limit = 10001,
) {
  const rows = await tx.query(
    'SELECT id FROM ai_requests WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2',
    [owner, limit],
  );
  const result = [];
  for (const row of rows)
    result.push(await readAIRequest(tx, owner, String(row.id), true));
  return result;
}
