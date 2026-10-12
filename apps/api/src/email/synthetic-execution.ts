import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { emailApprovalSchema, emailAttemptSchema } from '@hub/contracts';
import type { EmailMessage } from '@hub/contracts';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import { version } from '../features/common.js';
import {
  readEmailDraft,
  verifyEmailRevision,
  emailApprovalColumns,
} from '../features/email-drafts.js';
import {
  emailAttemptColumns,
  readEmailAttempt,
  revisionEmailAttempt,
} from './attempts.js';

const inputSchema = z.strictObject({
  draftId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  approvalId: z.string().uuid(),
  expectedApprovalVersion: z.number().int().positive(),
  reviewedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SyntheticEmailInput = z.infer<typeof inputSchema>;
export interface SyntheticEmailAdapter {
  kind: 'synthetic';
  execute(input: {
    attemptId: string;
    message: EmailMessage;
  }): Promise<unknown>;
}
const resultSchema = z.strictObject({ outcome: z.enum(['sent', 'not-sent']) });
function testOnly(config: Config) {
  if (config.NODE_ENV !== 'test')
    throw new ApiError(
      409,
      'EMAIL_EXECUTION_UNAVAILABLE',
      'Email execution is disabled.',
    );
}
// Internal test harness only. No HTTP admission, live adapter, credential,
// worker or production switch. Consumption commits BEFORE the sole callback.
export async function beginSyntheticEmailAttempt(
  database: Database,
  config: Config,
  owner: string,
  candidate: SyntheticEmailInput,
) {
  testOnly(config);
  z.string().uuid().parse(owner);
  const input = inputSchema.parse(candidate);
  return database.transaction(async (tx) => {
    const draft = await readEmailDraft(tx, owner, input.draftId, true);
    const existing = await revisionEmailAttempt(
      tx,
      owner,
      draft.id,
      input.expectedVersion,
    );
    if (existing) {
      if (
        existing.approvalId !== input.approvalId ||
        existing.approvalVersion !== input.expectedApprovalVersion ||
        existing.contentHash !== input.reviewedContentHash
      )
        throw new ApiError(
          409,
          'EMAIL_ATTEMPT_EXISTS',
          'This revision already has a delivery attempt.',
        );
      return { claimed: false as const, attempt: existing };
    }
    version(draft, input.expectedVersion);
    if (draft.deletedAt)
      throw new ApiError(
        409,
        'DRAFT_STATE_CONFLICT',
        'Email draft is deleted.',
      );
    await verifyEmailRevision(tx, owner, draft);
    const [row] = await tx.query(
      `SELECT ${emailApprovalColumns} FROM email_approvals WHERE owner_id=$1 AND draft_id=$2 AND id=$3`,
      [owner, draft.id, input.approvalId],
    );
    if (!row)
      throw new ApiError(404, 'NOT_FOUND', 'Email approval is unavailable.');
    const approval = emailApprovalSchema.parse(row);
    version(approval, input.expectedApprovalVersion);
    if (
      approval.revokedAt ||
      approval.draftVersion !== draft.version ||
      approval.contentHash !== draft.contentHash ||
      input.reviewedContentHash !== draft.contentHash
    )
      throw new ApiError(
        409,
        'EMAIL_APPROVAL_REQUIRED',
        'Review and approve the current message.',
      );
    const addresses = [
      draft.message.sender,
      ...draft.message.to,
      ...draft.message.cc,
      ...draft.message.bcc,
    ];
    if (addresses.some((address) => !address.toLowerCase().endsWith('.test')))
      throw new ApiError(
        409,
        'SYNTHETIC_ADDRESS_REQUIRED',
        'Synthetic attempts require reserved test addresses.',
      );
    const [attempt] = await tx.query(
      `INSERT INTO email_attempts(id,owner_id,draft_id,draft_version,content_hash,approval_id,approval_version,adapter) VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic') RETURNING ${emailAttemptColumns}`,
      [
        randomUUID(),
        owner,
        draft.id,
        draft.version,
        draft.contentHash,
        approval.id,
        approval.version,
      ],
    );
    return {
      claimed: true as const,
      attempt: emailAttemptSchema.parse(attempt),
      message: draft.message,
    };
  });
}
// Confirmed test outcomes only; never a resend. Failed or lost confirmations
// retain uncertainty and the unique revision claim across process restarts.
export async function confirmSyntheticEmailAttempt(
  database: Database,
  config: Config,
  owner: string,
  id: string,
  candidate: unknown,
) {
  testOnly(config);
  z.string().uuid().parse(owner);
  z.string().uuid().parse(id);
  const result = resultSchema.parse(candidate);
  return database.transaction(async (tx) => {
    const [row] = await tx.query(
      'SELECT status FROM email_attempts WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [owner, id],
    );
    if (!row)
      throw new ApiError(404, 'NOT_FOUND', 'Email attempt is unavailable.');
    if (row.status !== 'uncertain') {
      if (row.status !== result.outcome)
        throw new ApiError(
          409,
          'EMAIL_RESULT_CONFLICT',
          'This attempt has a different confirmed outcome.',
        );
      return readEmailAttempt(tx, owner, id);
    }
    await tx.query(
      'UPDATE email_attempts SET status=$3,version=version+1,updated_at=CURRENT_TIMESTAMP,finished_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
      [owner, id, result.outcome],
    );
    return readEmailAttempt(tx, owner, id);
  });
}
export async function executeSyntheticEmail(
  database: Database,
  config: Config,
  owner: string,
  input: SyntheticEmailInput,
  adapter: SyntheticEmailAdapter,
) {
  testOnly(config);
  if (adapter.kind !== 'synthetic')
    throw new ApiError(
      409,
      'EMAIL_EXECUTION_UNAVAILABLE',
      'Only synthetic adapters are supported.',
    );
  const claim = await beginSyntheticEmailAttempt(
    database,
    config,
    owner,
    input,
  );
  if (!claim.claimed) return claim.attempt;
  try {
    const result = await adapter.execute({
      attemptId: claim.attempt.id,
      message: claim.message,
    });
    return await confirmSyntheticEmailAttempt(
      database,
      config,
      owner,
      claim.attempt.id,
      result,
    );
  } catch {
    // Do not persist exception text: it may contain message/credential data.
    return readEmailAttempt(database, owner, claim.attempt.id);
  }
}
