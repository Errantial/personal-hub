import { defaultAssistantModel } from '@hub/contracts';
import type { Config } from '../config.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { stamp } from '../features/common.js';
import { lockBudget, reserveAIBudgetInTransaction } from './budget.js';
import { hasPrivateHost, hostsFor, modelPrice } from './openrouter-live.js';
import type {
  ExchangeResult,
  ModelPrice,
  OpenRouterFetch,
} from './openrouter-live.js';

// Shared lifecycle for live OpenRouter requests (docs/ai-assistant.md):
// replay by operation ID, budget hold marked uncertain before sending,
// settlement from reported usage. Request rows hold metadata only.

export type LiveKind =
  'planner' | 'planner-round' | 'mail-classify' | 'mail-tasks';
export type LiveReason =
  | 'invalid'
  | 'provider-error'
  | 'blocked'
  | 'unauthorized'
  | 'payment-required'
  | 'unavailable'
  | 'rate-limited'
  | 'rejected'
  | 'timeout'
  | 'transport'
  | 'response'
  | 'billing';

export async function readAssistantSettings(tx: QueryExecutor, owner: string) {
  const [row] = await tx.query(
    'SELECT model,version,allow_personal_mail,use_mail FROM ai_assistant_settings WHERE owner_id=$1',
    [owner],
  );
  return {
    model: (row?.model as string | undefined) ?? defaultAssistantModel,
    version: (row?.version as number | undefined) ?? 1,
    allowPersonalMail:
      (row?.allow_personal_mail as boolean | undefined) ?? false,
    useMail: (row?.use_mail as boolean | undefined) ?? false,
  };
}

const columns = `id,status,reason,model,dropped,withheld,cost_micros AS "costMicros",${stamp('created_at', 'createdAt')}`;
/** Metadata for one request; heldMicros is non-zero only while uncertain. */
export async function liveReceipt(
  tx: QueryExecutor,
  owner: string,
  id: string,
) {
  const [row] = await tx.query(
    `SELECT ${columns},(SELECT CASE WHEN r.status='uncertain' THEN r.reserved_micros ELSE 0 END FROM ai_budget_reservations r WHERE r.id=a.reservation_id) AS "heldMicros" FROM ai_assistant_requests a WHERE owner_id=$1 AND id=$2`,
    [owner, id],
  );
  return {
    ...row!,
    costMicros: row!.costMicros === null ? null : Number(row!.costMicros),
    heldMicros: Number(row!.heldMicros),
  };
}

/**
 * The stored receipt for a repeated operation, or null. A different payload
 * (or kind) under the same operation ID conflicts. Never calls the model.
 */
export async function findReplay(
  database: Database,
  owner: string,
  kind: LiveKind,
  operationId: string,
  hash: string,
) {
  const [row] = await database.query(
    'SELECT id,request_hash,kind FROM ai_assistant_requests WHERE owner_id=$1 AND operation_id=$2',
    [owner, operationId],
  );
  if (!row) return null;
  if (row.request_hash !== hash || row.kind !== kind)
    throw new ApiError(
      409,
      'OPERATION_CONFLICT',
      'This operation already has a different request.',
    );
  return liveReceipt(database, owner, row.id as string);
}

/** Key, model and published price, or the reason nothing can be sent. */
export async function prepareLive(
  database: Database,
  config: Config,
  fetcher: OpenRouterFetch,
  owner: string,
): Promise<{
  key: string;
  settings: Awaited<ReturnType<typeof readAssistantSettings>>;
  cost: ModelPrice;
}> {
  const key = config.AI_SECRET_OPENROUTER;
  if (!key)
    throw new ApiError(
      409,
      'ASSISTANT_NOT_CONFIGURED',
      'The server has no OpenRouter key.',
    );
  const settings = await readAssistantSettings(database, owner);
  if (!hostsFor(settings.model))
    throw new ApiError(
      409,
      'ASSISTANT_MODEL_UNSUPPORTED',
      'Use a model from a supported provider.',
    );
  let cost, privateHost;
  try {
    [cost, privateHost] = await Promise.all([
      modelPrice(fetcher, settings.model),
      hasPrivateHost(fetcher, settings.model),
    ]);
  } catch {
    throw new ApiError(
      503,
      'ASSISTANT_CATALOG_UNAVAILABLE',
      'Model availability could not be checked.',
    );
  }
  // Checked before any hold: a model without an allowed zero-retention host
  // could only fail at OpenRouter.
  if (!privateHost)
    throw new ApiError(
      409,
      'ASSISTANT_MODEL_NOT_PRIVATE',
      'No allowed host serves this model with zero data retention. Choose another model in Settings › AI › Assistant.',
    );
  if (!cost)
    throw new ApiError(
      409,
      'ASSISTANT_MODEL_UNAVAILABLE',
      'This model is not available as a text model.',
    );
  return { key, settings, cost };
}

/**
 * Reserves the worst-case charge, marks it uncertain and records the
 * request, in one transaction, before anything is sent. Returns false when
 * a concurrent identical operation already did so.
 */
export async function admitLive(
  database: Database,
  owner: string,
  request: {
    id: string;
    kind: LiveKind;
    operationId: string;
    hash: string;
    model: string;
    maximumMicros: number;
    withheld: number;
    /** Trusted worker attribution, never accepted from the public request. */
    agentId?: string | undefined;
  },
) {
  await database.transaction(async (tx) => {
    await lockBudget(tx, owner);
    if (request.agentId) {
      const [agent] = await tx.query(
        "SELECT monthly_cap_micros FROM responsibilities WHERE owner_id=$1 AND id=$2 AND template IS NOT NULL AND deleted_at IS NULL AND status IN ('active','paused') FOR UPDATE",
        [owner, request.agentId],
      );
      if (!agent)
        throw new ApiError(
          409,
          'AGENT_UNAVAILABLE',
          'This agent is unavailable.',
        );
      // Include legacy turn-linked requests and new pre-turn attribution. UNION
      // deduplicates rows that have both. The owner budget lock serializes all
      // holds/settlements; a crash before startTurn/recordRound retains its hold.
      const [usage] = await tx.query(
        `WITH turns AS (
          SELECT t.id FROM ai_conversation_turns t JOIN responsibilities r ON r.conversation_id=t.conversation_id
          WHERE t.owner_id=$1 AND r.id=$2 AND t.trigger='agent'),
        requests AS (
          SELECT id FROM ai_assistant_requests WHERE owner_id=$1 AND agent_id=$2
          UNION SELECT id FROM turns
          UNION SELECT request_id FROM ai_conversation_turn_rounds WHERE turn_id IN (SELECT id FROM turns))
        SELECT COALESCE(SUM(CASE WHEN b.status='settled' THEN b.actual_micros
          WHEN b.status IN ('reserved','uncertain') THEN b.reserved_micros ELSE 0 END),0)::text AS used
        FROM ai_assistant_requests a JOIN ai_budget_reservations b ON b.id=a.reservation_id
        WHERE a.owner_id=$1 AND a.id IN (SELECT id FROM requests)
          AND b.month=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`,
        [owner, request.agentId],
      );
      if (
        BigInt(String(usage!.used)) + BigInt(request.maximumMicros) >
        BigInt(String(agent.monthly_cap_micros))
      )
        throw new ApiError(
          409,
          'AGENT_BUDGET_EXCEEDED',
          'The remaining agent allowance cannot fund this call.',
        );
    }
    const [policy] = await tx.query(
      'SELECT version FROM ai_budget_policies WHERE owner_id=$1',
      [owner],
    );
    const reservation = await reserveAIBudgetInTransaction(tx, owner, {
      requestId: request.id,
      expectedPolicyVersion: policy!.version as number,
      provider: 'openrouter',
      model: request.model,
      maximumChargeMicros: request.maximumMicros,
    });
    // Uncertain before transmission: a crash after this point keeps the hold.
    await tx.query(
      "UPDATE ai_budget_reservations SET status='uncertain',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 AND status='reserved'",
      [owner, reservation.id],
    );
    await tx.query(
      `INSERT INTO ai_assistant_requests(id,owner_id,operation_id,request_hash,model,reservation_id,status,withheld,kind,agent_id) VALUES($1,$2,$3,$4,$5,$6,'uncertain',$7,$8,$9)`,
      [
        request.id,
        owner,
        request.operationId,
        request.hash,
        request.model,
        reservation.id,
        request.withheld,
        request.kind,
        request.agentId ?? null,
      ],
    );
  });
}

/** Records the outcome: release refusals, settle reported cost, keep unknowns. */
export async function settleLive(
  database: Database,
  owner: string,
  id: string,
  result: ExchangeResult,
  counts: { proposals: number; dropped: number },
  invalid: LiveReason | null,
) {
  await database.transaction(async (tx) => {
    await lockBudget(tx, owner);
    const [row] = await tx.query(
      'SELECT reservation_id FROM ai_assistant_requests WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [owner, id],
    );
    const reservation = row!.reservation_id as string;
    if (result.status === 'uncertain') {
      await tx.query(
        'UPDATE ai_assistant_requests SET reason=$3,generation_id=$4,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
        [owner, id, result.reason, result.generationId],
      );
      return;
    }
    if (result.status === 'rejected') {
      // Refused before processing: confirmed zero charge.
      await tx.query(
        "UPDATE ai_budget_reservations SET status='released',actual_micros=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
        [owner, reservation],
      );
      await tx.query(
        "UPDATE ai_assistant_requests SET status='failed',reason=$3,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
        [owner, id, result.reason],
      );
      return;
    }
    await tx.query(
      "UPDATE ai_budget_reservations SET status='settled',actual_micros=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
      [owner, reservation, result.usage.actualMicros],
    );
    const reason =
      result.outputState === 'validated' ? invalid : result.outputState;
    await tx.query(
      "UPDATE ai_assistant_requests SET status='completed',reason=$3,generation_id=$4,input_tokens=$5,output_tokens=$6,cost_micros=$7,proposal_count=$8,dropped=$9,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
      [
        owner,
        id,
        reason,
        result.generationId,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.actualMicros,
        counts.proposals,
        counts.dropped,
      ],
    );
  });
}
