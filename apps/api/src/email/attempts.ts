import { emailAttemptSchema } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { stamp } from '../features/common.js';

export const emailAttemptColumns = `id,draft_id AS "draftId",draft_version AS "draftVersion",content_hash AS "contentHash",
  approval_id AS "approvalId",approval_version AS "approvalVersion",adapter,status,version,
  ${stamp('created_at', 'createdAt')},${stamp('updated_at', 'updatedAt')},${stamp('finished_at', 'finishedAt')}`;
export async function readEmailAttempt(
  tx: QueryExecutor,
  owner: string,
  id: string,
) {
  const [row] = await tx.query(
    `SELECT ${emailAttemptColumns} FROM email_attempts WHERE owner_id=$1 AND id=$2`,
    [owner, id],
  );
  if (!row)
    throw new ApiError(404, 'NOT_FOUND', 'Email attempt is unavailable.');
  return emailAttemptSchema.parse(row);
}
export async function revisionEmailAttempt(
  tx: QueryExecutor,
  owner: string,
  draftId: string,
  draftVersion: number,
) {
  const [row] = await tx.query(
    `SELECT ${emailAttemptColumns} FROM email_attempts WHERE owner_id=$1 AND draft_id=$2 AND draft_version=$3`,
    [owner, draftId, draftVersion],
  );
  return row ? emailAttemptSchema.parse(row) : null;
}
