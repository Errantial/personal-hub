import { randomUUID } from 'node:crypto';
import type { AssistantProposal } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import type { VerifiedTurnOrigin } from './ai-planner-origin.js';

type CreateProposal = Extract<
  AssistantProposal,
  { kind: 'task.create' | 'event.create' }
>;

const unavailable = () =>
  new ApiError(
    409,
    'PROVENANCE_UNAVAILABLE',
    'This tracked deadline changed or is no longer available.',
  );

/**
 * Retains the server-resolved deadline source used for one created planner
 * record. The snapshot is immutable and contains no Canvas URL or source text.
 */
export async function retainDeadlinePlannerSource(
  tx: QueryExecutor,
  owner: string,
  kind: 'task' | 'event',
  recordId: string,
  proposal: CreateProposal,
  verified: VerifiedTurnOrigin,
) {
  if (!proposal.deadlineSource) return;
  if (proposal.kind === 'task.create' && proposal.academicSource)
    throw unavailable();
  const source = verified.capture.sources.find(
    (candidate) =>
      candidate.kind === 'tracked-deadline' &&
      candidate.id === proposal.deadlineSource!.id,
  );
  if (
    !source ||
    source.version !== proposal.deadlineSource.expectedVersion ||
    !source.deadlineSources?.length
  )
    throw unavailable();
  const snapshot = {
    id: proposal.deadlineSource.id,
    version: proposal.deadlineSource.expectedVersion,
    title: proposal.deadlineSource.title,
    due: proposal.deadlineSource.due,
    priority: proposal.deadlineSource.priority,
    sourceDependencies: source.deadlineSources,
  };
  await tx.query(
    `INSERT INTO tracked_deadline_planner_links
       (id,owner_id,deadline_id,task_id,event_id,snapshot,labels)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::text[])`,
    [
      randomUUID(),
      owner,
      proposal.deadlineSource.id,
      kind === 'task' ? recordId : null,
      kind === 'event' ? recordId : null,
      JSON.stringify(snapshot),
      source.labels,
    ],
  );
}
