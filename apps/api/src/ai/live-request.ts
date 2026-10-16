import { agentSpend } from './agent-spend.js';
import { defaultAssistantModel } from '@hub/contracts';
import type { Config } from '../config.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { stamp } from '../features/common.js';
import { lockBudget, reserveAIBudgetInTransaction } from './budget.js';
import { resolveLiveDestination } from './live-destination.js';
import type { LiveDestination } from './live-destination.js';
import type { SealedEnvelope } from './live-envelope.js';
import type { LiveManifest } from './live-manifest.js';
import { hasPrivateHost, modelPrice } from './openrouter-live.js';
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
  | 'billing'
  | 'context-changed'
  | 'route-blocked';

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

/**
 * The approved destination, its published price and the key, or the reason
 * nothing can be sent. Network checks run outside any transaction.
 */
export async function prepareLiveDestination(
  database: Database,
  config: Config,
  fetcher: OpenRouterFetch,
  owner: string,
): Promise<{
  key: string;
  destination: LiveDestination;
  cost: ModelPrice;
}> {
  const destination = await database.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return resolveLiveDestination(tx, config, owner);
  });
  let cost, privateHost;
  try {
    [cost, privateHost] = await Promise.all([
      modelPrice(fetcher, destination.model),
      hasPrivateHost(fetcher, destination.model, destination.upstream),
    ]);
  } catch {
    throw new ApiError(
      503,
      'ASSISTANT_CATALOG_UNAVAILABLE',
      'Model availability could not be checked.',
    );
  }
  if (!privateHost)
    throw new ApiError(
      409,
      'ASSISTANT_MODEL_NOT_PRIVATE',
      'The approved destination has no zero-retention endpoint for this model.',
    );
  if (!cost)
    throw new ApiError(
      409,
      'ASSISTANT_MODEL_UNAVAILABLE',
      'This model is not available as a text model.',
    );
  return { key: config.AI_SECRET_OPENROUTER!, destination, cost };
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
    /** The sealed envelope, bound in the same transaction as the hold. */
    sealed?: SealedEnvelope<LiveManifest> | undefined;
  },
) {
  const sealed = request.sealed;
  if (
    sealed &&
    (sealed.requestId !== request.id ||
      sealed.owner !== owner ||
      sealed.manifest.destination.model !== request.model)
  )
    throw new Error('Sealed envelope does not match its request.');
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
      const usage = await agentSpend(tx, owner, request.agentId);
      if (
        usage + BigInt(request.maximumMicros) >
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
    if (sealed)
      await tx.query(
        'INSERT INTO ai_live_exchanges(request_id,owner_id,format_version,manifest,integrity_hash,destination_revision,source_count) VALUES($1,$2,1,$3,$4,$5,$6)',
        [
          request.id,
          owner,
          JSON.stringify(sealed.manifest),
          sealed.integrityHash,
          sealed.manifest.destination.revision,
          sealed.manifest.sources.length,
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
