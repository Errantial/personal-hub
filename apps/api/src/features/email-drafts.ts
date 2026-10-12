import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  emailMessageSchema,
  emailDraftSchema,
  emailDraftResponseSchema,
  emailDraftSummarySchema,
  createEmailDraftSchema,
  updateEmailDraftSchema,
  emailDraftMutationSchema,
  approveEmailDraftSchema,
  emailApprovalSchema,
  emailApprovalResponseSchema,
  emailDraftPageQuerySchema,
  emailDraftPageSchema,
  emailApprovalPageQuerySchema,
  emailApprovalPageSchema,
  emailRevisionSchema,
  emailRevisionResponseSchema,
  emailRevisionPageQuerySchema,
  emailRevisionPageSchema,
  emailSendPreviewRequestSchema,
  emailSendPreviewSchema,
  emailAttemptSchema,
  emailAttemptResponseSchema,
  emailAttemptPageQuerySchema,
  emailAttemptPageSchema,
} from '@hub/contracts';
import type { EmailDraft, EmailMessage } from '@hub/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutate } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import { stamp, version } from './common.js';
import {
  emailAttemptColumns,
  revisionEmailAttempt,
} from '../email/attempts.js';

const idSchema = z.object({ id: z.string().uuid() });
const approvalParams = idSchema.extend({ approvalId: z.string().uuid() });
const attemptParams = idSchema.extend({ attemptId: z.string().uuid() });
const revisionParams = idSchema.extend({
  version: z.coerce.number().int().positive(),
});
export const emailApprovalColumns = `id,draft_id AS "draftId",version,draft_version AS "draftVersion",content_hash AS "contentHash",
  ${stamp('approved_at', 'approvedAt')},${stamp('revoked_at', 'revokedAt')}`;
export const emailRevisionColumns = `draft_id AS "draftId",version,message,content_hash AS "contentHash",${stamp('created_at', 'createdAt')}`;
const approvalProjection = `(SELECT jsonb_build_object('id',a.id,'draftId',a.draft_id,'version',a.version,
  'draftVersion',a.draft_version,'contentHash',a.content_hash,
  'approvedAt',to_char(a.approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revokedAt',NULL)
  FROM email_approvals a WHERE a.owner_id=email_drafts.owner_id AND a.draft_id=email_drafts.id
  AND a.draft_version=email_drafts.version AND a.content_hash=email_drafts.content_hash AND a.revoked_at IS NULL) AS approval`;
export const emailDraftColumns = `id,version,message,content_hash AS "contentHash",${stamp('created_at', 'createdAt')},
  ${stamp('updated_at', 'updatedAt')},${stamp('deleted_at', 'deletedAt')},${approvalProjection}`;
export function hashEmailMessage(message: EmailMessage) {
  return createHash('sha256')
    .update(JSON.stringify(emailMessageSchema.parse(message)))
    .digest('hex');
}
export function parseEmailDraft(row: Record<string, unknown>): EmailDraft {
  const parsed = emailDraftSchema.safeParse({
    ...row,
    status: row.deletedAt ? 'deleted' : row.approval ? 'approved' : 'pending',
  });
  if (
    !parsed.success ||
    hashEmailMessage(parsed.data.message) !== parsed.data.contentHash
  )
    throw new ApiError(
      409,
      'EMAIL_PAYLOAD_UNAVAILABLE',
      'Draft integrity could not be verified.',
    );
  return parsed.data;
}
export function parseEmailRevision(row: Record<string, unknown>) {
  const parsed = emailRevisionSchema.safeParse(row);
  if (
    !parsed.success ||
    hashEmailMessage(parsed.data.message) !== parsed.data.contentHash
  )
    throw new ApiError(
      409,
      'EMAIL_PAYLOAD_UNAVAILABLE',
      'Revision integrity could not be verified.',
    );
  return parsed.data;
}
export async function readEmailDraft(
  tx: QueryExecutor,
  owner: string,
  id: string,
  lock = false,
) {
  if (lock) {
    const [locked] = await tx.query(
      'SELECT id FROM email_drafts WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [owner, id],
    );
    if (!locked)
      throw new ApiError(404, 'NOT_FOUND', 'Email draft is unavailable.');
  }
  // Approval writes leave the parent content version unchanged. Under READ
  // COMMITTED, a separate statement sees approvals committed while waiting for
  // the draft lock; a scalar projection in the locking statement can be stale.
  const [row] = await tx.query(
    `SELECT ${emailDraftColumns} FROM email_drafts WHERE owner_id=$1 AND id=$2`,
    [owner, id],
  );
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Email draft is unavailable.');
  return parseEmailDraft(row);
}
async function captureRevision(
  tx: QueryExecutor,
  owner: string,
  draft: EmailDraft,
) {
  await tx.query(
    'INSERT INTO email_draft_revisions(owner_id,draft_id,version,message,content_hash) VALUES($1,$2,$3,$4::jsonb,$5)',
    [
      owner,
      draft.id,
      draft.version,
      JSON.stringify(draft.message),
      draft.contentHash,
    ],
  );
}
async function invalidate(tx: QueryExecutor, owner: string, id: string) {
  await tx.query(
    'UPDATE email_approvals SET revoked_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND draft_id=$2 AND revoked_at IS NULL',
    [owner, id],
  );
}
export async function verifyEmailRevision(
  tx: QueryExecutor,
  owner: string,
  draft: EmailDraft,
) {
  const [row] = await tx.query(
    `SELECT ${emailRevisionColumns} FROM email_draft_revisions WHERE owner_id=$1 AND draft_id=$2 AND version=$3`,
    [owner, draft.id, draft.version],
  );
  if (
    !row ||
    row.contentHash !== draft.contentHash ||
    parseEmailRevision(row).contentHash !== draft.contentHash
  )
    throw new ApiError(
      409,
      'EMAIL_PAYLOAD_UNAVAILABLE',
      'Draft revision could not be verified.',
    );
}
function summary(draft: EmailDraft) {
  return emailDraftSummarySchema.parse({
    ...draft,
    ...draft.message,
    recipientCount:
      draft.message.to.length +
      draft.message.cc.length +
      draft.message.bcc.length,
  });
}
export async function exportEmailDrafts(tx: QueryExecutor, owner: string) {
  return {
    emailDrafts: (
      await tx.query(
        `SELECT ${emailDraftColumns} FROM email_drafts WHERE owner_id=$1 ORDER BY id LIMIT 10001`,
        [owner],
      )
    ).map(parseEmailDraft),
    emailDraftRevisions: (
      await tx.query(
        `SELECT ${emailRevisionColumns} FROM email_draft_revisions WHERE owner_id=$1 ORDER BY draft_id,version LIMIT 10001`,
        [owner],
      )
    ).map(parseEmailRevision),
    emailApprovals: (
      await tx.query(
        `SELECT ${emailApprovalColumns} FROM email_approvals WHERE owner_id=$1 ORDER BY id LIMIT 10001`,
        [owner],
      )
    ).map((row) => emailApprovalSchema.parse(row)),
    emailAttempts: (
      await tx.query(
        `SELECT ${emailAttemptColumns} FROM email_attempts WHERE owner_id=$1 ORDER BY id LIMIT 10001`,
        [owner],
      )
    ).map((row) => emailAttemptSchema.parse(row)),
  };
}
export function registerEmailDrafts(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/email/drafts';
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
  app.get(base, (request) =>
    snapshot(request, async (tx, owner) => {
      const input = emailDraftPageQuerySchema.parse(request.query);
      const eligible = `owner_id=$1 AND ($2::text='all' OR (deleted_at IS NOT NULL)=($2='true'))`;
      if (input.after) {
        const [anchor] = await tx.query(
          `SELECT version FROM email_drafts WHERE ${eligible} AND id=$3`,
          [owner, input.deleted, input.after],
        );
        if (!anchor)
          throw new ApiError(404, 'NOT_FOUND', 'Draft cursor is unavailable.');
        version(anchor, input.expectedCursorVersion);
      }
      const rows = await tx.query(
        `SELECT ${emailDraftColumns} FROM email_drafts WHERE ${eligible}
      AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
        [owner, input.deleted, input.after ?? null, input.limit + 1],
      );
      const last = rows[input.limit - 1];
      return emailDraftPageSchema.parse({
        drafts: rows
          .slice(0, input.limit)
          .map((row) => summary(parseEmailDraft(row))),
        nextAfter:
          rows.length > input.limit && last
            ? { id: last.id, version: last.version }
            : null,
      });
    }),
  );
  app.get(`${base}/:id`, (request) =>
    snapshot(request, async (tx, owner) => {
      const { id } = idSchema.parse(request.params);
      return { draft: await readEmailDraft(tx, owner, id) };
    }),
  );
  app.post(base, async (request) => {
    const user = await auth.requireUser(request);
    const input = createEmailDraftSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'email.draft.create', input },
      async (tx) => {
        const id = randomUUID();
        const [row] = await tx.query(
          `INSERT INTO email_drafts(id,owner_id,message,content_hash) VALUES($1,$2,$3::jsonb,$4) RETURNING ${emailDraftColumns}`,
          [
            id,
            user.id,
            JSON.stringify(input.message),
            hashEmailMessage(input.message),
          ],
        );
        const draft = parseEmailDraft(row!);
        await captureRevision(tx, user.id, draft);
        return emailDraftResponseSchema.parse({ draft });
      },
    );
  });
  app.put(`${base}/:id`, async (request) => {
    const user = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    const input = updateEmailDraftSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'email.draft.update', id, input },
      async (tx) => {
        const before = await readEmailDraft(tx, user.id, id, true);
        if (before.deletedAt)
          throw new ApiError(404, 'NOT_FOUND', 'Email draft is unavailable.');
        version(before, input.expectedVersion);
        await invalidate(tx, user.id, id);
        const [row] = await tx.query(
          `UPDATE email_drafts SET message=$3::jsonb,content_hash=$4,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING ${emailDraftColumns}`,
          [
            user.id,
            id,
            JSON.stringify(input.message),
            hashEmailMessage(input.message),
          ],
        );
        const draft = parseEmailDraft(row!);
        await captureRevision(tx, user.id, draft);
        return { draft };
      },
    );
  });
  for (const restoring of [false, true]) {
    app.route({
      method: restoring ? 'POST' : 'DELETE',
      url: `${base}/:id${restoring ? '/restore' : ''}`,
      handler: async (request) => {
        const user = await auth.requireUser(request);
        const { id } = idSchema.parse(request.params);
        const input = emailDraftMutationSchema.parse(request.body);
        return mutate(
          database,
          user.id,
          input.operationId,
          {
            kind: restoring ? 'email.draft.restore' : 'email.draft.delete',
            id,
            input,
          },
          async (tx) => {
            const before = await readEmailDraft(tx, user.id, id, true);
            version(before, input.expectedVersion);
            if (restoring ? !before.deletedAt : before.deletedAt)
              throw new ApiError(
                409,
                'DRAFT_STATE_CONFLICT',
                'Reload the draft before changing its state.',
              );
            await invalidate(tx, user.id, id);
            const [row] = await tx.query(
              `UPDATE email_drafts SET deleted_at=${restoring ? 'NULL' : 'CURRENT_TIMESTAMP'},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING ${emailDraftColumns}`,
              [user.id, id],
            );
            const draft = parseEmailDraft(row!);
            await captureRevision(tx, user.id, draft);
            return { draft };
          },
        );
      },
    });
  }
  app.post(`${base}/:id/approve`, async (request) => {
    const user = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    const input = approveEmailDraftSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'email.draft.approve', id, input },
      async (tx) => {
        const draft = await readEmailDraft(tx, user.id, id, true);
        if (draft.deletedAt)
          throw new ApiError(
            409,
            'DRAFT_STATE_CONFLICT',
            'Restore and review the draft before approving.',
          );
        version(draft, input.expectedVersion);
        if (input.reviewedContentHash !== draft.contentHash)
          throw new ApiError(
            409,
            'EMAIL_REVIEW_CONFLICT',
            'Review the current message before approving.',
          );
        await verifyEmailRevision(tx, user.id, draft);
        if (await revisionEmailAttempt(tx, user.id, id, draft.version))
          throw new ApiError(
            409,
            'EMAIL_ATTEMPT_EXISTS',
            'This revision already has a delivery attempt.',
          );
        if (draft.approval) return { approval: draft.approval };
        const [row] = await tx.query(
          `INSERT INTO email_approvals(id,owner_id,draft_id,draft_version,content_hash) VALUES($1,$2,$3,$4,$5) RETURNING ${emailApprovalColumns}`,
          [randomUUID(), user.id, id, draft.version, draft.contentHash],
        );
        return emailApprovalResponseSchema.parse({ approval: row });
      },
    );
  });
  app.post(`${base}/:id/approvals/:approvalId/revoke`, async (request) => {
    const user = await auth.requireUser(request);
    const { id, approvalId } = approvalParams.parse(request.params);
    const input = emailDraftMutationSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'email.approval.revoke', id, approvalId, input },
      async (tx) => {
        await readEmailDraft(tx, user.id, id, true);
        const [row] = await tx.query(
          `SELECT ${emailApprovalColumns} FROM email_approvals WHERE owner_id=$1 AND draft_id=$2 AND id=$3 FOR UPDATE`,
          [user.id, id, approvalId],
        );
        if (!row)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Email approval is unavailable.',
          );
        version(row, input.expectedVersion);
        if (row.revokedAt)
          throw new ApiError(
            409,
            'APPROVAL_REVOKED',
            'This approval was already revoked.',
          );
        const [approval] = await tx.query(
          `UPDATE email_approvals SET revoked_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING ${emailApprovalColumns}`,
          [user.id, approvalId],
        );
        return emailApprovalResponseSchema.parse({ approval });
      },
    );
  });
  app.get(`${base}/:id/approvals`, (request) =>
    snapshot(request, async (tx, owner) => {
      const { id } = idSchema.parse(request.params);
      const input = emailApprovalPageQuerySchema.parse(request.query);
      await readEmailDraft(tx, owner, id);
      if (input.after) {
        const [anchor] = await tx.query(
          'SELECT version FROM email_approvals WHERE owner_id=$1 AND draft_id=$2 AND id=$3',
          [owner, id, input.after],
        );
        if (!anchor)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Approval cursor is unavailable.',
          );
        version(anchor, input.expectedCursorVersion);
      }
      const rows = await tx.query(
        `SELECT ${emailApprovalColumns} FROM email_approvals WHERE owner_id=$1 AND draft_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
        [owner, id, input.after ?? null, input.limit + 1],
      );
      const last = rows[input.limit - 1];
      return emailApprovalPageSchema.parse({
        approvals: rows.slice(0, input.limit),
        nextAfter:
          rows.length > input.limit && last
            ? { id: last.id, version: last.version }
            : null,
      });
    }),
  );
  app.get(`${base}/:id/revisions`, (request) =>
    snapshot(request, async (tx, owner) => {
      const { id } = idSchema.parse(request.params);
      const input = emailRevisionPageQuerySchema.parse(request.query);
      await readEmailDraft(tx, owner, id);
      if (input.afterVersion) {
        const [anchor] = await tx.query(
          'SELECT version FROM email_draft_revisions WHERE owner_id=$1 AND draft_id=$2 AND version=$3',
          [owner, id, input.afterVersion],
        );
        if (!anchor)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Revision cursor is unavailable.',
          );
      }
      const rows = await tx.query(
        `SELECT draft_id AS "draftId",version,content_hash AS "contentHash",${stamp('created_at', 'createdAt')} FROM email_draft_revisions
      WHERE owner_id=$1 AND draft_id=$2 AND version>$3 ORDER BY version LIMIT $4`,
        [owner, id, input.afterVersion ?? 0, input.limit + 1],
      );
      return emailRevisionPageSchema.parse({
        revisions: rows.slice(0, input.limit),
        nextAfterVersion:
          rows.length > input.limit ? rows[input.limit - 1]!.version : null,
      });
    }),
  );
  app.get(`${base}/:id/revisions/:version`, (request) =>
    snapshot(request, async (tx, owner) => {
      const input = revisionParams.parse(request.params);
      const [row] = await tx.query(
        `SELECT ${emailRevisionColumns} FROM email_draft_revisions WHERE owner_id=$1 AND draft_id=$2 AND version=$3`,
        [owner, input.id, input.version],
      );
      if (!row)
        throw new ApiError(404, 'NOT_FOUND', 'Email revision is unavailable.');
      const revision = parseEmailRevision(row);
      return emailRevisionResponseSchema.parse({ revision });
    }),
  );
  app.post(`${base}/:id/send-preview`, (request) =>
    snapshot(request, async (tx, owner) => {
      const { id } = idSchema.parse(request.params);
      const input = emailSendPreviewRequestSchema.parse(request.body);
      const draft = await readEmailDraft(tx, owner, id);
      version(draft, input.expectedVersion);
      await verifyEmailRevision(tx, owner, draft);
      const attempt = await revisionEmailAttempt(tx, owner, id, draft.version);
      let approval = draft.approval;
      if (input.approval) {
        const [row] = await tx.query(
          `SELECT ${emailApprovalColumns} FROM email_approvals WHERE owner_id=$1 AND draft_id=$2 AND id=$3`,
          [owner, id, input.approval.id],
        );
        if (!row)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Email approval is unavailable.',
          );
        version(row, input.approval.expectedVersion);
        approval = emailApprovalSchema.parse(row);
      }
      const approvalState = !approval
        ? attempt
          ? 'consumed'
          : 'missing'
        : approval.draftVersion !== draft.version ||
            approval.contentHash !== draft.contentHash
          ? 'stale'
          : attempt
            ? 'consumed'
            : approval.revokedAt
              ? 'revoked'
              : 'current';
      const blockers: Array<
        | 'EMAIL_APPROVAL_REQUIRED'
        | 'APPROVAL_REVOKED'
        | 'APPROVAL_STALE'
        | 'DRAFT_DELETED'
        | 'SENDER_UNVERIFIED'
        | 'SEND_CAPABILITY_UNVERIFIED'
        | 'EMAIL_EXECUTION_UNAVAILABLE'
        | 'EMAIL_ATTEMPT_EXISTS'
        | 'EMAIL_DELIVERY_UNCERTAIN'
      > = [];
      if (draft.deletedAt) blockers.push('DRAFT_DELETED');
      if (approvalState !== 'current') blockers.push('EMAIL_APPROVAL_REQUIRED');
      if (approvalState === 'stale') blockers.push('APPROVAL_STALE');
      if (approvalState === 'revoked') blockers.push('APPROVAL_REVOKED');
      if (attempt) blockers.push('EMAIL_ATTEMPT_EXISTS');
      if (attempt?.status === 'uncertain')
        blockers.push('EMAIL_DELIVERY_UNCERTAIN');
      blockers.push(
        'SENDER_UNVERIFIED',
        'SEND_CAPABILITY_UNVERIFIED',
        'EMAIL_EXECUTION_UNAVAILABLE',
      );
      return emailSendPreviewSchema.parse({
        draftId: id,
        draftVersion: draft.version,
        contentHash: draft.contentHash,
        approval,
        attempt,
        approvalState,
        executionEnabled: false,
        status: 'blocked',
        blockers,
      });
    }),
  );
  app.get(`${base}/:id/attempts`, (request) =>
    snapshot(request, async (tx, owner) => {
      const { id } = idSchema.parse(request.params);
      const input = emailAttemptPageQuerySchema.parse(request.query);
      await readEmailDraft(tx, owner, id);
      if (input.after) {
        const [anchor] = await tx.query(
          'SELECT version FROM email_attempts WHERE owner_id=$1 AND draft_id=$2 AND id=$3',
          [owner, id, input.after],
        );
        if (!anchor)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'Attempt cursor is unavailable.',
          );
        version(anchor, input.expectedCursorVersion);
      }
      const rows = await tx.query(
        `SELECT ${emailAttemptColumns} FROM email_attempts WHERE owner_id=$1 AND draft_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
        [owner, id, input.after ?? null, input.limit + 1],
      );
      const last = rows[input.limit - 1];
      return emailAttemptPageSchema.parse({
        attempts: rows.slice(0, input.limit),
        nextAfter:
          rows.length > input.limit && last
            ? { id: last.id, version: last.version }
            : null,
      });
    }),
  );
  app.get(`${base}/:id/attempts/:attemptId`, (request) =>
    snapshot(request, async (tx, owner) => {
      const { id, attemptId } = attemptParams.parse(request.params);
      const [row] = await tx.query(
        `SELECT ${emailAttemptColumns} FROM email_attempts WHERE owner_id=$1 AND draft_id=$2 AND id=$3`,
        [owner, id, attemptId],
      );
      if (!row)
        throw new ApiError(404, 'NOT_FOUND', 'Email attempt is unavailable.');
      return emailAttemptResponseSchema.parse({ attempt: row });
    }),
  );
}
