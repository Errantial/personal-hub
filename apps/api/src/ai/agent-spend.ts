import type { QueryExecutor } from '../db/database.js';
// Shared attribution includes all ordinary live calls and both broker hops.
// Called only under the same owner budget lock used by admitLive.
export async function agentSpend(
  tx: QueryExecutor,
  owner: string,
  agentId: string,
) {
  const row = await agentSpendingComponents(tx, owner, agentId);
  return BigInt(String(row.settled)) + BigInt(String(row.held));
}
export async function agentSpendingComponents(
  tx: QueryExecutor,
  owner: string,
  agentId: string,
  now = new Date(),
) {
  const [row] = await tx.query(
    `WITH turns AS (
    SELECT t.id FROM ai_conversation_turns t JOIN responsibilities r ON r.conversation_id=t.conversation_id
    WHERE t.owner_id=$1 AND r.id=$2 AND t.trigger='agent'),
    requests AS (SELECT reservation_id AS id FROM ai_assistant_requests WHERE owner_id=$1 AND (agent_id=$2 OR id IN(SELECT id FROM turns) OR id IN(SELECT request_id FROM ai_conversation_turn_rounds WHERE turn_id IN(SELECT id FROM turns)))
    UNION SELECT b.reservation_id FROM mail_broker_batches b JOIN mail_broker_retrievals r ON r.id=b.retrieval_id AND r.owner_id=b.owner_id WHERE r.owner_id=$1 AND r.agent_id=$2
    UNION SELECT b.id FROM ai_budget_reservations b JOIN mail_broker_retrievals r ON r.context->>'logicalRequestId'=b.request_id::text AND r.owner_id=b.owner_id WHERE r.owner_id=$1 AND r.agent_id=$2)
    SELECT to_char($3::timestamptz AT TIME ZONE 'UTC','YYYY-MM') AS month,
      to_char(date_trunc('month',$3::timestamptz AT TIME ZONE 'UTC')+interval '1 month','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "resetsAt",
      COALESCE(sum(actual_micros) FILTER(WHERE status='settled'),0)::text AS settled,
      COALESCE(sum(reserved_micros) FILTER(WHERE status IN('reserved','uncertain')),0)::text AS held,
      COALESCE(sum(reserved_micros) FILTER(WHERE status='uncertain'),0)::text AS uncertain
    FROM ai_budget_reservations WHERE owner_id=$1 AND id IN(SELECT id FROM requests) AND month=date_trunc('month',$3::timestamptz AT TIME ZONE 'UTC')::date`,
    [owner, agentId, now.toISOString()],
  );
  return row!;
}
