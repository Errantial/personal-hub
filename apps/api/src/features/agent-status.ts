import { agentRunSchema, agentSpendingSchema } from '@hub/contracts';
import type { AgentRun } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { stamp } from './common.js';
import { attemptOperation } from './agent-operation.js';
import { roundOperation } from './assistant.js';

export const agentRunColumns = `id,version,status,trigger,outcome,error_code AS "errorCode",cancel_reason AS "cancelReason",turn_id AS "turnId",attempts,
  ${stamp('created_at', 'createdAt')},${stamp('started_at', 'startedAt')},${stamp('finished_at', 'finishedAt')},
  ${stamp('progress_at', 'progressAt')},progress_stage AS "progressStage",${stamp('lease_until', 'leaseUntil')},${stamp('not_before', 'retryAt')}`;

/** Read-only metadata; first-call identity also finds holds before turn creation. */
export async function describeAgentRun(
  tx: QueryExecutor,
  owner: string,
  row: Record<string, unknown>,
  asOf: string,
  allowNewRun = false,
): Promise<AgentRun> {
  // D57 permits one initial attempt and one safe retry. A stored turn remains
  // a compatibility reference for older rows; no provider lookup is performed.
  const firstOperations = [
    attemptOperation(String(row.id), 1),
    attemptOperation(String(row.id), 2),
  ];
  const operations = firstOperations.flatMap((operation) => [
    operation,
    roundOperation(operation, 2),
    roundOperation(operation, 3),
  ]);
  const [usage] = await tx.query(
    `WITH first_calls AS (
      SELECT id FROM ai_assistant_requests WHERE owner_id=$1 AND (operation_id=ANY($2::uuid[]) OR id=$3::uuid)),
    requests AS (SELECT id FROM first_calls UNION SELECT request_id FROM ai_conversation_turn_rounds WHERE turn_id IN (SELECT id FROM first_calls))
    SELECT count(*)::int AS exchanges,
      COALESCE(sum(b.actual_micros) FILTER(WHERE b.status='settled'),0)::text AS settled,
      COALESCE(sum(b.reserved_micros) FILTER(WHERE b.status IN ('reserved','uncertain')),0)::text AS held,
      COALESCE(sum(b.reserved_micros) FILTER(WHERE b.status='uncertain'),0)::text AS uncertain,
      COALESCE(bool_and(COALESCE(a.status='failed' AND b.status='released' AND b.actual_micros=0,false)),true) AS "confirmedZero",
      EXISTS(SELECT 1 FROM ai_conversation_turns t CROSS JOIN LATERAL jsonb_array_elements(t.items) i
        WHERE t.owner_id=$1 AND (t.id IN (SELECT id FROM first_calls) OR t.id=$3::uuid)
        AND (i->>'state' IN ('applied','undone') OR EXISTS(SELECT 1 FROM mutation_receipts m
          WHERE m.owner_id=$1 AND m.operation_id=(i->>'applyId')::uuid AND m.result IS NOT NULL))) AS "hasEffects"
    FROM ai_assistant_requests a JOIN ai_budget_reservations b ON b.id=a.reservation_id
    WHERE a.owner_id=$1 AND a.id IN (SELECT id FROM requests)`,
    [owner, operations, row.turnId ?? null],
  );
  const settledMicros = Number(usage!.settled),
    heldMicros = Number(usage!.held),
    uncertainMicros = Number(usage!.uncertain);
  let state: AgentRun['state'] = row.status as AgentRun['state'];
  if (state === 'queued' && row.retryAt && Number(row.attempts) > 0)
    state = 'retry-scheduled';
  if (
    ['failed', 'completed', 'cancelled'].includes(state) &&
    uncertainMicros > 0
  )
    state = 'uncertain';
  // These are known pre-admission blockers, not retry authority. Raw status
  // and error code remain available independently of the presentation state.
  if (
    state === 'failed' &&
    Number(usage!.exchanges) === 0 &&
    preAdmissionBlockers.has(String(row.errorCode))
  )
    state = 'blocked';
  return agentRunSchema.parse({
    ...row,
    state,
    settledMicros,
    heldMicros,
    uncertainMicros,
    exchangeCount: usage!.exchanges,
    leaseExpired:
      row.status === 'running' &&
      !!row.leaseUntil &&
      Date.parse(String(row.leaseUntil)) <= Date.parse(asOf),
    canRetry:
      allowNewRun &&
      row.status === 'failed' &&
      !unsafeRetryErrors.has(String(row.errorCode)) &&
      !!row.startedAt &&
      !!row.progressAt &&
      Number(row.attempts) >= 1 &&
      Number(row.attempts) <= 2 &&
      usage!.confirmedZero === true &&
      usage!.hasEffects === false,
  });
}

const unsafeRetryErrors = new Set([
  'LEASE_EXPIRED',
  'AGENT_LEASE_LOST',
  'AGENT_APPLY_ERROR',
  'AGENT_RUN_ERROR',
]);

const preAdmissionBlockers = new Set([
  'AGENT_PAUSED',
  'AGENT_CHANGED',
  'AGENT_LABELED',
  'AGENT_UNAVAILABLE',
  'AGENT_BUDGET_EXCEEDED',
  'ASSISTANT_NOT_CONFIGURED',
  'ASSISTANT_MODEL_NOT_PRIVATE',
  'ASSISTANT_CATALOG_UNAVAILABLE',
  'BUDGET_UNSET',
  'MONTHLY_BUDGET_EXCEEDED',
  'REQUEST_BUDGET_EXCEEDED',
]);

/** Current UTC admission month, distinct from all-time history charge metadata. */
export async function readAgentSpending(
  tx: QueryExecutor,
  owner: string,
  id: string,
  capMicros: number,
) {
  const [row] = await tx.query(
    `WITH turns AS (SELECT t.id FROM ai_conversation_turns t JOIN responsibilities r ON r.conversation_id=t.conversation_id
      WHERE t.owner_id=$1 AND r.id=$2 AND t.trigger='agent'),
    requests AS (SELECT id FROM turns UNION SELECT request_id FROM ai_conversation_turn_rounds WHERE turn_id IN (SELECT id FROM turns)
      UNION SELECT id FROM ai_assistant_requests WHERE owner_id=$1 AND agent_id=$2)
    SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC','YYYY-MM') AS month,
      to_char((date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '1 month'),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "resetsAt",
      COALESCE(sum(b.actual_micros) FILTER(WHERE b.status='settled'),0)::text AS settled,
      COALESCE(sum(b.reserved_micros) FILTER(WHERE b.status IN ('reserved','uncertain')),0)::text AS held,
      COALESCE(sum(b.reserved_micros) FILTER(WHERE b.status='uncertain'),0)::text AS uncertain
    FROM ai_assistant_requests a JOIN ai_budget_reservations b ON b.id=a.reservation_id
    WHERE a.owner_id=$1 AND a.id IN (SELECT id FROM requests)
      AND b.month=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`,
    [owner, id],
  );
  const settledMicros = Number(row!.settled),
    heldMicros = Number(row!.held);
  return agentSpendingSchema.parse({
    month: row!.month,
    resetsAt: row!.resetsAt,
    settledMicros,
    heldMicros,
    uncertainMicros: Number(row!.uncertain),
    remainingMicros: Math.max(0, capMicros - settledMicros - heldMicros),
    capMicros,
    overCap: settledMicros + heldMicros > capMicros,
  });
}
