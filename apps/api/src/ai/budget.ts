import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { aiBudgetReservationSchema, providerAliasSchema } from '@hub/contracts';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { mutate } from '../planner/mutations.js';
import { stamp, version } from '../features/common.js';
const columns = `id,request_id AS "requestId",version,to_char(month,'YYYY-MM') AS month,provider,model,policy_version AS "policyVersion",reserved_micros AS "reservedMicros",actual_micros AS "actualMicros",status,COALESCE(actual_micros>reserved_micros,FALSE) AS overrun,${stamp('created_at', 'createdAt')},${stamp('updated_at', 'updatedAt')}`;
const record = (row: Record<string, unknown>) =>
  aiBudgetReservationSchema.parse({
    ...row,
    reservedMicros: Number(row.reservedMicros),
    actualMicros: row.actualMicros === null ? null : Number(row.actualMicros),
  });
export async function readBudgetUsage(tx: QueryExecutor, owner: string) {
  const [row] = await tx.query(
    `SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC','YYYY-MM') AS month,COALESCE(SUM(actual_micros) FILTER(WHERE status='settled'),0)::text AS "spentMicros",COALESCE(SUM(reserved_micros) FILTER(WHERE status IN ('reserved','uncertain')),0)::text AS "heldMicros",COALESCE(SUM(reserved_micros) FILTER(WHERE status='uncertain'),0)::text AS "uncertainMicros",COUNT(*) FILTER(WHERE status='settled' AND actual_micros>reserved_micros)::integer AS overruns FROM ai_budget_reservations WHERE owner_id=$1 AND month=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`,
    [owner],
  );
  const [outstanding] = await tx.query(
    `SELECT COALESCE(SUM(reserved_micros),0)::text AS "outstandingHeldMicros",COALESCE(SUM(reserved_micros) FILTER(WHERE status='uncertain'),0)::text AS "outstandingUncertainMicros" FROM ai_budget_reservations WHERE owner_id=$1 AND status IN ('reserved','uncertain')`,
    [owner],
  );
  return { ...row!, ...outstanding! };
}
export async function readBudgetReservations(
  tx: QueryExecutor,
  owner: string,
  limit = 10001,
) {
  return (
    await tx.query(
      `SELECT ${columns} FROM ai_budget_reservations WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,
      [owner, limit],
    )
  ).map(record);
}
const reserveSchema = z.strictObject({
  requestId: z.string().uuid(),
  expectedPolicyVersion: z.number().int().positive(),
  provider: providerAliasSchema,
  model: z.string().min(1).max(100),
  maximumChargeMicros: z.number().int().min(1).max(1_000_000_000_000),
});
// INTERNAL ONLY. A future dispatcher must supply a server-derived worst-case charge,
// an owned durable inference-step ID and approved destination. No HTTP route invokes this.
// A reservation is accounting, not authorization to transmit or to retry a paid call.
export async function reserveAIBudget(
  database: Database,
  owner: string,
  candidate: z.infer<typeof reserveSchema>,
) {
  const input = reserveSchema.parse(candidate);
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return database.transaction(async (tx) => {
    await lockBudget(tx, owner);
    const [existing] = await tx.query(
      `SELECT ${columns},request_hash FROM ai_budget_reservations WHERE owner_id=$1 AND request_id=$2`,
      [owner, input.requestId],
    );
    if (existing) {
      if (existing.request_hash !== hash)
        throw new ApiError(
          409,
          'OPERATION_CONFLICT',
          'This inference step already has a different reservation.',
        );
      return record(existing);
    }
    const [policy] = await tx.query(
      'SELECT version,monthly_limit_micros,per_request_limit_micros FROM ai_budget_policies WHERE owner_id=$1',
      [owner],
    );
    version(policy!, input.expectedPolicyVersion);
    if (
      policy!.monthly_limit_micros === null ||
      policy!.per_request_limit_micros === null
    )
      throw new ApiError(409, 'BUDGET_UNSET', 'Configure spending limits.');
    if (
      BigInt(input.maximumChargeMicros) >
      BigInt(String(policy!.per_request_limit_micros))
    )
      throw new ApiError(
        409,
        'REQUEST_BUDGET_EXCEEDED',
        'The request exceeds its spending limit.',
      );
    const usage = await readBudgetUsage(tx, owner);
    if (
      BigInt(String(usage.spentMicros)) +
        BigInt(String(usage.heldMicros)) +
        BigInt(input.maximumChargeMicros) >
      BigInt(String(policy!.monthly_limit_micros))
    )
      throw new ApiError(
        409,
        'MONTHLY_BUDGET_EXCEEDED',
        'The monthly spending limit is exhausted.',
      );
    const [row] = await tx.query(
      `INSERT INTO ai_budget_reservations(id,owner_id,request_id,request_hash,month,provider,model,policy_version,reserved_micros,status) VALUES($1,$2,$3,$4,date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,$5,$6,$7,$8,'reserved') RETURNING ${columns}`,
      [
        randomUUID(),
        owner,
        input.requestId,
        hash,
        input.provider,
        input.model,
        input.expectedPolicyVersion,
        input.maximumChargeMicros,
      ],
    );
    return record(row!);
  });
}
async function lockBudget(tx: QueryExecutor, owner: string) {
  await tx.query(
    'INSERT INTO ai_budget_policies(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [owner],
  );
  await tx.query(
    'SELECT owner_id FROM ai_budget_policies WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
}
const changeSchema = z
  .strictObject({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    outcome: z.enum(['uncertain', 'released', 'settled']),
    actualMicros: z.number().int().min(0).max(1_000_000_000_000).optional(),
  })
  .refine((input) =>
    input.outcome === 'settled'
      ? input.actualMicros !== undefined
      : input.actualMicros === undefined,
  );
// Mark uncertain BEFORE transmission. Release is permitted only before that claim.
// Settling uncertain work requires confirmed usage (including confirmed zero charge),
// never an assumption from timeout/transport failure. Provider execution is not implemented.
export async function changeAIBudgetReservation(
  database: Database,
  owner: string,
  id: string,
  candidate: z.infer<typeof changeSchema>,
) {
  z.string().uuid().parse(id);
  const input = changeSchema.parse(candidate);
  return mutate(
    database,
    owner,
    input.operationId,
    { kind: 'ai.budget.reservation', id, input },
    async (tx) => {
      await lockBudget(tx, owner);
      const [row] = await tx.query(
        `SELECT ${columns} FROM ai_budget_reservations WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
        [owner, id],
      );
      if (!row)
        throw new ApiError(404, 'NOT_FOUND', 'Reservation not available.');
      version(row, input.expectedVersion);
      if (
        row.status !== 'reserved' &&
        !(row.status === 'uncertain' && input.outcome === 'settled')
      )
        throw new ApiError(
          409,
          'BUDGET_STATE',
          'Reservation cannot make this transition.',
        );
      const actual =
        input.outcome === 'settled'
          ? input.actualMicros!
          : input.outcome === 'released'
            ? 0
            : null;
      const [changed] = await tx.query(
        `UPDATE ai_budget_reservations SET status=$3,actual_micros=$4,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING ${columns}`,
        [owner, id, input.outcome, actual],
      );
      return record(changed!);
    },
  );
}
