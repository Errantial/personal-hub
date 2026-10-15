import {
  Temporal,
  agentTemplates,
  applyRequest,
  customInstructions,
} from '@hub/contracts';
import type {
  AgentTemplate,
  AssistantItem,
  AssistantTurn,
  RunOutcome,
} from '@hub/contracts';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { readAIActionPolicy } from './ai-actions.js';
import { plannedWrite } from './planner-write.js';

// One agent run's work after the model answers (D57): apply each proposal
// by the owner's action settings, then summarize the run's outcome.

export type RunCounts = {
  applied: number;
  proposed: number;
  notAllowed: number;
  failed: number;
};

/**
 * Settled charges plus held (uncertain) amounts of this agent's run turns,
 * first calls and mail rounds, in the UTC month of `now` (the month the
 * monthly cap uses). Owner replies in the thread are not counted.
 */
export async function agentSpend(
  tx: QueryExecutor,
  owner: string,
  responsibilityId: string,
  now = new Date(),
): Promise<number> {
  const [row] = await tx.query(
    `WITH turns AS (
       SELECT t.id FROM ai_conversation_turns t JOIN responsibilities r ON r.conversation_id=t.conversation_id
       WHERE t.owner_id=$1 AND r.id=$2 AND t.trigger='agent'),
     requests AS (
       SELECT id FROM turns UNION SELECT request_id FROM ai_conversation_turn_rounds WHERE turn_id IN (SELECT id FROM turns)
       UNION SELECT id FROM ai_assistant_requests WHERE owner_id=$1 AND agent_id=$2)
     SELECT COALESCE(SUM(CASE WHEN b.status='settled' THEN b.actual_micros WHEN b.status IN ('reserved','uncertain') THEN b.reserved_micros ELSE 0 END),0)::text AS spent
     FROM ai_assistant_requests a JOIN ai_budget_reservations b ON b.id=a.reservation_id
     WHERE a.owner_id=$1 AND a.id IN (SELECT id FROM requests) AND b.month=date_trunc('month',$3::timestamptz AT TIME ZONE 'UTC')::date`,
    [owner, responsibilityId, now.toISOString()],
  );
  return Number(row?.spent ?? 0);
}

const weekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
/** What the model receives: fixed instructions, the owner's goal, the run time. */
export function agentPrompt(
  agent: { template: AgentTemplate; goal: string },
  now: Temporal.Instant,
  timeZone: string,
): string {
  const local = now.toZonedDateTimeISO(timeZone);
  const instructions =
    agent.template === 'custom'
      ? customInstructions
      : agentTemplates[agent.template].instructions;
  return `${instructions}\n\nGoal: ${agent.goal}\n\nRun: ${local
    .toPlainDateTime()
    .toString({
      smallestUnit: 'minute',
    })}, ${weekdays[local.dayOfWeek - 1]} (${timeZone})`;
}

/**
 * Applies automatic proposals through the ordinary versioned planner writes,
 * leaves approval-required ones proposed and drops blocked ones (counted in
 * `not_allowed`). A conflict fails that item only. Email is never sent:
 * Assistant proposals cannot contain email.
 */
export async function applyByPolicy(
  database: Database,
  owner: string,
  turn: AssistantTurn,
): Promise<RunCounts> {
  return database.transaction(async (tx) => {
    await tx.query(
      'SELECT id FROM ai_conversation_turns WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [owner, turn.id],
    );
    const [saved] = await tx.query(
      'SELECT proposals,items,not_allowed,proposal_access FROM ai_conversation_turns WHERE owner_id=$1 AND id=$2',
      [owner, turn.id],
    );
    if (!saved)
      throw new ApiError(404, 'NOT_FOUND', 'This answer no longer exists.');
    const parse = (value: unknown) =>
      typeof value === 'string' ? JSON.parse(value) : value;
    const current = {
      ...turn,
      proposalAccess:
        saved.proposal_access === 'read-only'
          ? ('read-only' as const)
          : ('applicable' as const),
      items: parse(saved.items) as AssistantItem[],
      request: {
        ...turn.request,
        proposals: parse(
          saved.proposals,
        ) as AssistantTurn['request']['proposals'],
      },
    };
    return applyInTransaction(
      transactionDatabase(tx),
      owner,
      current,
      Number(saved.not_allowed),
    );
  });
}

/** Planner mutations retain ordinary receipts and rollback independently on conflict. */
export function transactionDatabase(tx: QueryExecutor): Database {
  let sequence = 0;
  return {
    ...tx,
    async transaction(work) {
      const savepoint = `agent_action_${++sequence}`;
      await tx.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = await work(tx);
        await tx.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await tx.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await tx.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    },
    async close() {
      throw new Error('Cannot close an active agent transaction.');
    },
  };
}

async function applyInTransaction(
  database: Database,
  owner: string,
  turn: AssistantTurn,
  notAllowed: number,
): Promise<RunCounts> {
  // Lock the owner's policy for this short database-only effect transaction.
  await database.query(
    'INSERT INTO ai_action_policies(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [owner],
  );
  await database.query(
    'SELECT owner_id FROM ai_action_policies WHERE owner_id=$1 FOR SHARE',
    [owner],
  );
  const { policy } = await readAIActionPolicy(database, owner);
  const counts: RunCounts = {
    applied: 0,
    proposed: 0,
    notAllowed,
    failed: 0,
  };
  const proposals = [];
  const items: AssistantItem[] = [];
  for (const [index, proposal] of turn.request.proposals.entries()) {
    const item = turn.items[index]!;
    // A resumed application must not undo or replace an already saved decision.
    if (item.state === 'applied' || item.state === 'undone') {
      proposals.push(proposal);
      items.push(item);
      if (item.state === 'applied') counts.applied++;
      continue;
    }
    // Older workers could commit a planner receipt before saving the turn's
    // item state. Recover that exact receipt even if the policy since changed;
    // this branch never starts an operation without an existing saved result.
    const [receipt] = await database.query(
      'SELECT operation_id FROM mutation_receipts WHERE owner_id=$1 AND operation_id=$2 AND result IS NOT NULL FOR SHARE',
      [owner, item.applyId],
    );
    if (receipt) {
      proposals.push(proposal);
      try {
        const applied = await plannedWrite(
          database,
          owner,
          applyRequest(proposal, item.applyId),
        );
        counts.applied++;
        items.push({ ...item, state: 'applied', applied, error: null });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        counts.failed++;
        items.push({
          ...item,
          state: 'failed',
          error: error.message.slice(0, 300),
        });
      }
      continue;
    }
    if (turn.proposalAccess === 'read-only') {
      proposals.push(proposal);
      items.push(item);
      counts.proposed++;
      continue;
    }
    const mode = proposal.kind.startsWith('task.')
      ? policy.tasks
      : policy.calendar;
    if (mode === 'blocked') {
      counts.notAllowed++;
      continue;
    }
    proposals.push(proposal);
    if (mode === 'approval-required') {
      counts.proposed++;
      items.push(item);
      continue;
    }
    try {
      const applied = await plannedWrite(
        database,
        owner,
        applyRequest(proposal, item.applyId),
      );
      counts.applied++;
      items.push({ ...item, state: 'applied', applied, error: null });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      counts.failed++;
      items.push({
        ...item,
        state: 'failed',
        error: error.message.slice(0, 300),
      });
    }
  }
  await database.query(
    'UPDATE ai_conversation_turns SET proposals=$3,items=$4,not_allowed=$5,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
    [
      owner,
      turn.id,
      JSON.stringify(proposals),
      JSON.stringify(items),
      counts.notAllowed,
    ],
  );
  return counts;
}

/** Whether the run needs the owner: review first, then changes, then warnings. */
export function outcomeOf(
  counts: RunCounts,
  turn: Pick<AssistantTurn, 'mailNote'>,
): RunOutcome {
  if (counts.proposed > 0) return 'needs-approval';
  if (counts.applied > 0) return 'applied';
  if (counts.failed > 0 || turn.mailNote) return 'warning';
  return 'quiet';
}

const changes = (count: number) => `${count} change${count === 1 ? '' : 's'}`;
/** Inbox title for a run that matters; quiet runs get none. */
export function notificationTitle(
  title: string,
  outcome: RunOutcome,
  counts: RunCounts,
): string {
  switch (outcome) {
    case 'applied':
      return `${title}: ${changes(counts.applied)} applied`;
    case 'needs-approval':
      return `${title}: ${changes(counts.proposed)} to review`;
    case 'warning':
      return `${title}: needs attention`;
    default:
      return `${title}: run failed`;
  }
}
