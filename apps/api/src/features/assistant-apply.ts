import {
  applyRequest,
  undoRequest,
  assistantItemSchema,
  assistantProposalSchema,
} from '@hub/contracts';
import type { AssistantItem, AssistantProposal } from '@hub/contracts';
import { z } from 'zod';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { mutate } from '../planner/mutations.js';
import { lockSchedule } from '../planner/schedule-lock.js';
import type { VerifiedTurnOrigin } from './ai-planner-origin.js';
import {
  verifyTurnOrigin,
  verifyProposalOrigin,
  retainPlannerOrigin,
} from './ai-planner-origin.js';
import { retainDeadlinePlannerSource } from './deadline-planner-origin.js';
import { plannedWrite } from './planner-write.js';
import { transactionDatabase } from '../planner/nested-database.js';
import { recordCapabilityAudit } from './capability-audit.js';

export { transactionDatabase } from '../planner/nested-database.js';

/** Only saved proposals reach this helper; new effects require verified origin. */
export async function applySavedProposal(
  tx: QueryExecutor,
  owner: string,
  turnId: string,
  proposal: AssistantProposal,
  item: AssistantItem,
  verified?: VerifiedTurnOrigin,
  agentId?: string,
  autoApproved = false,
) {
  return transactionDatabase(tx).transaction(async (inner) => {
    await lockSchedule(inner, owner);
    const origin = verified ?? (await verifyTurnOrigin(inner, owner, turnId));
    verifyProposalOrigin(owner, turnId, proposal, item, origin);
    if (
      proposal.kind === 'task.create' &&
      proposal.academicSource &&
      !origin.capture.sources.some(
        (source) =>
          source.kind === 'academic-work' &&
          source.id === proposal.academicSource!.id,
      )
    ) {
      throw new ApiError(
        409,
        'PROVENANCE_UNAVAILABLE',
        'This academic source was not admitted with the answer.',
      );
    }
    if (
      (proposal.kind === 'task.create' || proposal.kind === 'event.create') &&
      proposal.deadlineSource &&
      !origin.capture.sources.some(
        (source) =>
          source.kind === 'tracked-deadline' &&
          source.id === proposal.deadlineSource!.id &&
          source.version === proposal.deadlineSource!.expectedVersion,
      )
    )
      throw new ApiError(
        409,
        'PROVENANCE_UNAVAILABLE',
        'This tracked deadline was not admitted with the answer.',
      );
    const applied = await plannedWrite(
      transactionDatabase(inner),
      owner,
      applyRequest(proposal, item.applyId),
      { turnId, agentId: agentId ?? undefined, autoApproved },
    );
    if (proposal.kind !== 'capability')
      await recordCapabilityAudit(inner, owner, turnId, proposal, 'applied', {
        agentId,
        autoApproved,
      });
    if (proposal.kind.startsWith('task.') || proposal.kind.startsWith('event.'))
      await retainPlannerOrigin(
        inner,
        owner,
        proposal.kind.startsWith('task.') ? 'task' : 'event',
        applied.id,
        turnId,
        origin.capture,
      );
    if (proposal.kind === 'task.create' || proposal.kind === 'event.create')
      await retainDeadlinePlannerSource(
        inner,
        owner,
        proposal.kind === 'task.create' ? 'task' : 'event',
        applied.id,
        proposal,
        origin,
      );
    return applied;
  });
}

const json = (value: unknown) =>
  typeof value === 'string' ? JSON.parse(value) : value;

/** A receipt covers selection and state updates as well as all planner receipts. */
export async function changeSavedTurn(
  database: Database,
  owner: string,
  id: string,
  action: 'apply' | 'undo',
  input: { expectedVersion: number; indexes: number[]; operationId: string },
) {
  await mutate(
    database,
    owner,
    input.operationId,
    { kind: `assistant.${action}`, id, ...input },
    async (tx) => {
      // Conversation lock prevents a late write racing text deletion.
      const [parent] = await tx.query(
        'SELECT c.id FROM ai_conversations c JOIN ai_conversation_turns t ON t.conversation_id=c.id WHERE t.owner_id=$1 AND t.id=$2 AND c.deleted_at IS NULL FOR SHARE OF c',
        [owner, id],
      );
      if (!parent)
        throw new ApiError(404, 'NOT_FOUND', 'This answer no longer exists.');
      const [row] = await tx.query(
        'SELECT proposals,items,version,proposal_access FROM ai_conversation_turns WHERE owner_id=$1 AND id=$2 FOR UPDATE',
        [owner, id],
      );
      if (!row)
        throw new ApiError(404, 'NOT_FOUND', 'This answer no longer exists.');
      if (row.version !== input.expectedVersion)
        throw new ApiError(
          409,
          'VERSION_CONFLICT',
          'These changes were updated on another device. Reload first.',
        );
      const proposals = z
        .array(assistantProposalSchema)
        .parse(json(row.proposals));
      const items = z.array(assistantItemSchema).parse(json(row.items));
      if (input.indexes.some((index) => !proposals[index] || !items[index]))
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'The selected changes do not match this answer.',
        );
      if (action === 'apply' && row.proposal_access === 'read-only')
        throw new ApiError(
          409,
          'PROPOSAL_READ_ONLY',
          "These suggestions can't be applied yet.",
        );
      await lockSchedule(tx, owner);
      const needsApply =
        action === 'apply' &&
        input.indexes.some(
          (index) => !['applied', 'undone'].includes(items[index]!.state),
        );
      const verified = needsApply
        ? await verifyTurnOrigin(tx, owner, id)
        : undefined;
      for (const index of input.indexes) {
        const item = items[index]!;
        const proposal = proposals[index]!;
        if (
          action === 'apply' &&
          (item.state === 'applied' || item.state === 'undone')
        )
          continue;
        if (action === 'undo' && item.state === 'undone') continue;
        if (action === 'undo' && !item.applied)
          throw new ApiError(
            409,
            'NOT_APPLIED',
            'Apply this change before undoing it.',
          );
        try {
          if (action === 'apply') {
            const applied = await applySavedProposal(
              tx,
              owner,
              id,
              proposal,
              item,
              verified,
            );
            items[index] = { ...item, state: 'applied', applied, error: null };
          } else {
            await plannedWrite(
              transactionDatabase(tx),
              owner,
              undoRequest(proposal, item.applied!, item.undoId),
            );
            items[index] = { ...item, state: 'undone', error: null };
          }
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          await recordCapabilityAudit(tx, owner, id, proposal, 'failed', {
            reason: error.message.slice(0, 300),
          });
          items[index] = {
            ...item,
            state: 'failed',
            error: error.message.slice(0, 300),
          };
        }
      }
      await tx.query(
        'UPDATE ai_conversation_turns SET items=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
        [owner, id, JSON.stringify(items)],
      );
      return { done: true };
    },
  );
}
