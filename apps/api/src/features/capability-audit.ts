import { randomUUID } from 'node:crypto';
import type { AssistantProposal } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';

export type CapabilityDecision = 'applied' | 'proposed' | 'blocked' | 'failed';

const capability = (proposal: AssistantProposal) =>
  proposal.kind === 'capability'
    ? 'general'
    : proposal.kind.startsWith('task.')
      ? 'task'
      : proposal.kind.startsWith('event.')
        ? 'calendar'
        : 'reminder';

const actionByCapability: Record<string, string> = {
  'task.delete': 'delete',
  'task.restore': 'restore',
  'event.delete': 'delete',
  'event.restore': 'restore',
  'study.preferences.update': 'update',
  'course.create': 'create',
  'course.update': 'update',
  'course.delete': 'delete',
  'topic.create': 'create',
  'topic.update': 'update',
  'topic.delete': 'delete',
  'academicWork.create': 'create',
  'academicWork.update': 'update',
  'academicWork.delete': 'delete',
  'academicWork.restore': 'restore',
  'trackedDeadline.update': 'update',
  'trackedDeadline.complete': 'update',
  'trackedDeadline.reopen': 'update',
  'settings.auto_approve': 'update',
  'mail.archive': 'update',
  'mail.label': 'update',
  'mail.read': 'update',
  'mail.send': 'send',
};
const action = (proposal: AssistantProposal) =>
  proposal.kind === 'capability'
    ? (actionByCapability[proposal.capability] ??
      (proposal.capability.endsWith('.delete')
        ? 'delete'
        : proposal.capability.endsWith('.cancel')
          ? 'cancel'
          : 'update'))
    : proposal.kind.endsWith('.create')
      ? 'create'
      : proposal.kind.endsWith('.update')
        ? 'update'
        : proposal.kind.endsWith('.cancel')
          ? 'cancel'
          : 'delete';

const target = (proposal: AssistantProposal) => {
  if (proposal.kind === 'capability') return { kind: null, id: null };
  if (proposal.kind === 'task.create' || proposal.kind === 'event.create')
    return {
      kind: proposal.kind.startsWith('task.') ? 'task' : 'event',
      id: null,
    };
  if (proposal.kind.startsWith('reminder.'))
    return { kind: 'reminder', id: proposal.target.id };
  return {
    kind: proposal.kind.startsWith('task.') ? 'task' : 'event',
    id: proposal.target.id,
  };
};

/** One audit row per capability decision; never stores prompt/answer text. */
export async function recordCapabilityAudit(
  tx: QueryExecutor,
  owner: string,
  turnId: string,
  proposal: AssistantProposal,
  decision: CapabilityDecision,
  options: {
    agentId?: string | undefined;
    reason?: string | null;
    operationId?: string | null;
    tool?: string | null;
    before?: unknown;
    after?: unknown;
    targetId?: string | null;
    undoable?: boolean;
    autoApproved?: boolean;
  } = {},
) {
  const item = target(proposal);
  const targetId = options.targetId === undefined ? item.id : options.targetId;
  const id = randomUUID();
  await tx.query(
    `INSERT INTO ai_capability_audit
      (id,owner_id,agent_id,turn_id,capability,action,target_kind,target_id,decision,reason,operation_id,before,after,undoable,tool,auto_approved)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16)`,
    [
      id,
      owner,
      options.agentId ?? null,
      turnId,
      capability(proposal),
      action(proposal),
      item.kind,
      targetId,
      decision,
      options.reason ?? null,
      options.operationId ?? null,
      options.before === undefined ? null : JSON.stringify(options.before),
      options.after === undefined ? null : JSON.stringify(options.after),
      options.undoable ?? false,
      options.tool ?? null,
      options.autoApproved ?? false,
    ],
  );
  return id;
}
