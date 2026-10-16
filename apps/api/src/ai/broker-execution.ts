import { randomUUID } from 'node:crypto';
import { mailBrokerReceiptSchema } from '@hub/contracts';
import type { Config } from '../config.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { reserveAIBudgetInTransaction, lockBudget } from './budget.js';
import { agentSpend } from './agent-spend.js';
import {
  brokerAlias,
  brokerPolicy,
  requireBrokerReady,
  verifyBrokerCatalog,
} from './broker-policy.js';
import {
  brokerCandidates,
  brokerDigest,
  candidateBinding,
  guardBrokerRetrieval,
  readBrokerRetrieval,
} from './mail-broker.js';
import type { BrokerBinding } from './mail-broker.js';
import {
  buildBrokerEnvelope,
  exchangeBroker,
  brokerThresholdRevision,
  brokerRubricRevision,
  brokerBoundsRevision,
} from './broker-protocol.js';
import type { BrokerDecision, BrokerExchange } from './broker-protocol.js';

async function reserveBatch(
  tx: QueryExecutor,
  config: Config,
  owner: string,
  batchId: string,
  intent: string,
) {
  await lockBudget(tx, owner);
  const [batch] = await tx.query(
    'SELECT * FROM mail_broker_batches WHERE owner_id=$1 AND id=$2 FOR UPDATE',
    [owner, batchId],
  );
  if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Mail batch not available.');
  // Durable at-most-once claim: uncertain/completed rows are receipts, never resend invitations.
  if (batch.status !== 'prepared') return null;
  requireCurrentSelectionPolicy(batch);
  const { retrieval, grant, policy } = await guardBrokerRetrieval(
    tx,
    config,
    owner,
    String(batch.retrieval_id),
  );
  if (
    !['pending', 'partial'].includes(retrieval.status) ||
    Number(batch.position) !== retrieval.position
  )
    throw new ApiError(
      409,
      'MAIL_BATCH_STATE',
      'Mail batch is no longer current.',
    );
  const [row] = await tx.query(
    'SELECT intent_digest FROM mail_broker_retrievals WHERE owner_id=$1 AND id=$2',
    [owner, retrieval.id],
  );
  if (row!.intent_digest !== brokerDigest([owner, intent]))
    throw new ApiError(
      409,
      'MAIL_INTENT_CHANGED',
      'Resupply the original mail request.',
    );
  const bindings = batch.sources as BrokerBinding[];
  const candidates = await brokerCandidates(
    tx,
    owner,
    grant,
    bindings.map((s) => s.id),
    policy.allowed,
  );
  if (brokerDigest(candidates.map(candidateBinding)) !== brokerDigest(bindings))
    throw new ApiError(409, 'MAIL_SOURCE_CHANGED', 'Mail source changed.');
  const bytes = buildBrokerEnvelope(policy.profile!.model, intent, candidates);
  if (
    Buffer.byteLength(bytes) >
      Math.min(20480, policy.verification!.envelopeByteLimit) ||
    bytes.length > policy.profile!.maxInputCharacters ||
    Buffer.byteLength(bytes) + 500 > policy.quote!.inputTokenLimit ||
    policy.quote!.inputTokenLimit < policy.verification!.inputTokenUpperBound
  )
    throw new ApiError(
      409,
      'MAIL_ENVELOPE_LIMIT',
      'Mail envelope exceeds its verified bound.',
    );
  const context = retrieval.context;
  const [budget] = await tx.query(
    'SELECT version,per_request_limit_micros FROM ai_budget_policies WHERE owner_id=$1',
    [owner],
  );
  // One downstream hold per logical request. J3 must consume this hold rather
  // than separately charging/reserving a second downstream request.
  const [downstream] = await tx.query(
    'SELECT id,status,reserved_micros,model,provider FROM ai_budget_reservations WHERE owner_id=$1 AND request_id=$2',
    [owner, context.logicalRequestId],
  );
  if (
    downstream &&
    (downstream.status !== 'reserved' ||
      Number(downstream.reserved_micros) !== context.downstreamMaximumMicros ||
      downstream.model !== policy.downstream!.model ||
      downstream.provider !== 'openrouter')
  )
    throw new ApiError(
      409,
      'MAIL_DOWNSTREAM_HOLD_CHANGED',
      'Downstream reservation changed.',
    );
  const [group] = await tx.query(
    `SELECT COALESCE(SUM(CASE WHEN b.status='settled' THEN b.actual_micros WHEN b.status IN('reserved','uncertain') THEN b.reserved_micros ELSE 0 END),0)::text AS used
    FROM mail_broker_batches b0 JOIN mail_broker_retrievals r ON r.id=b0.retrieval_id AND r.owner_id=b0.owner_id JOIN ai_budget_reservations b ON b.id=b0.reservation_id
    WHERE r.owner_id=$1 AND r.context->>'logicalRequestId'=$2`,
    [owner, context.logicalRequestId],
  );
  if (
    budget!.per_request_limit_micros === null ||
    BigInt(String(group!.used)) +
      BigInt(context.downstreamMaximumMicros) +
      BigInt(policy.quote!.maximumChargeMicros) >
      BigInt(String(budget!.per_request_limit_micros))
  )
    throw new ApiError(
      409,
      'REQUEST_BUDGET_EXCEEDED',
      'Combined mail and answer allowance is exhausted.',
    );
  if (context.agent) {
    const [agent] = await tx.query(
      'SELECT monthly_cap_micros FROM responsibilities WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [owner, context.agent.id],
    );
    const used = await agentSpend(tx, owner, context.agent.id);
    if (
      !agent ||
      used +
        BigInt(policy.quote!.maximumChargeMicros) +
        BigInt(downstream ? 0 : context.downstreamMaximumMicros) >
        BigInt(String(agent.monthly_cap_micros))
    )
      throw new ApiError(
        409,
        'AGENT_BUDGET_EXCEEDED',
        'Agent mail allowance is exhausted.',
      );
  }
  if (!downstream) {
    await reserveAIBudgetInTransaction(tx, owner, {
      requestId: context.logicalRequestId,
      expectedPolicyVersion: Number(budget!.version),
      provider: 'openrouter',
      model: policy.downstream!.model,
      maximumChargeMicros: context.downstreamMaximumMicros,
    });
  }
  const held = await reserveAIBudgetInTransaction(tx, owner, {
    requestId: batchId,
    expectedPolicyVersion: Number(budget!.version),
    provider: brokerAlias,
    model: policy.profile!.model,
    maximumChargeMicros: policy.quote!.maximumChargeMicros,
  });
  await tx.query(
    "UPDATE ai_budget_reservations SET status='uncertain',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
    [owner, held.id],
  );
  const metadata = {
    sources: bindings,
    profile: policy.profile!.policyRevision,
    consent: policy.consent.version,
    verification: policy.verification!.revision,
    verificationDigest: brokerDigest(policy.verification),
    downstream: policy.downstream,
    requestLabels: context.requestLabels,
    rubric: brokerRubricRevision,
    bounds: brokerBoundsRevision,
    threshold: brokerThresholdRevision,
  };
  const hash = brokerDigest([owner, batchId, bytes, metadata]);
  await tx.query(
    "UPDATE mail_broker_batches SET status='uncertain',reservation_id=$3,envelope_hash=$4,profile_revision=$5,approval_version=$6,verification_revision=$7 WHERE owner_id=$1 AND id=$2",
    [
      owner,
      batchId,
      held.id,
      hash,
      policy.profile!.policyRevision,
      policy.consent.version,
      policy.verification!.revision,
    ],
  );
  await tx.query(
    "UPDATE mail_broker_retrievals SET status='uncertain' WHERE owner_id=$1 AND id=$2",
    [owner, retrieval.id],
  );
  return {
    bytes,
    hash,
    metadata,
    candidates,
    model: policy.profile!.model,
    secret: policy.secret!,
    quote: {
      inputTokenLimit: policy.quote!.inputTokenLimit,
      outputTokenLimit: policy.profile!.maxOutputTokens,
      maximumChargeMicros: policy.quote!.maximumChargeMicros,
    },
    retrievalId: retrieval.id,
  };
}

/** INTERNAL admitted transport; never exposed as an arbitrary-message endpoint. */
export async function executeBrokerBatch(
  database: Database,
  config: Config,
  owner: string,
  batchId: string,
  intent: string,
  fetcher: typeof fetch,
  options: {
    timeoutMs?: number;
    beforeGuard?: () => Promise<void>;
    authority?: (tx: QueryExecutor) => Promise<boolean>;
  } = {},
) {
  const existing = await readBrokerBatch(database, owner, batchId);
  if (existing.status !== 'prepared') return existing;
  const checkedPolicy = await brokerPolicy(database, config, owner);
  requireBrokerReady(checkedPolicy);
  await verifyBrokerCatalog(fetcher, checkedPolicy);
  const sealed = await database.transaction((tx) =>
    (async () => {
      const current = await brokerPolicy(tx, config, owner);
      if (brokerDigest(current) !== brokerDigest(checkedPolicy))
        throw new ApiError(
          409,
          'MAIL_ROUTE_CHANGED',
          'Mail broker policy changed.',
        );
      return reserveBatch(tx, config, owner, batchId, intent);
    })(),
  );
  if (!sealed) return readBrokerBatch(database, owner, batchId);
  await options.beforeGuard?.();
  // Immediately before handoff, reproject sources and verify both routes,
  // grant, lease, budget and exact serialized bytes against the durable claim.
  try {
    await database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (options.authority && !(await options.authority(tx)))
        throw new ApiError(
          401,
          'MAIL_AUTHORITY_CHANGED',
          'Owner authorization expired.',
        );
      const { grant, policy } = await guardBrokerRetrieval(
        tx,
        config,
        owner,
        sealed.retrievalId,
      );
      const [batch] = await tx.query(
        'SELECT * FROM mail_broker_batches WHERE owner_id=$1 AND id=$2',
        [owner, batchId],
      );
      if (batch) requireCurrentSelectionPolicy(batch);
      const current = await brokerCandidates(
        tx,
        owner,
        grant,
        sealed.candidates.map((c) => c.id),
        policy.allowed,
      );
      if (
        !batch ||
        batch.status !== 'uncertain' ||
        brokerDigest(current.map(candidateBinding)) !==
          brokerDigest(sealed.metadata.sources) ||
        batch.envelope_hash !==
          brokerDigest([owner, batchId, sealed.bytes, sealed.metadata]) ||
        batch.profile_revision !== policy.profile!.policyRevision ||
        batch.approval_version !== policy.consent.version ||
        batch.verification_revision !== policy.verification!.revision ||
        sealed.metadata.verificationDigest !==
          brokerDigest(policy.verification) ||
        Buffer.byteLength(sealed.bytes) > policy.verification!.envelopeByteLimit
      )
        throw new ApiError(
          409,
          'MAIL_CONTEXT_CHANGED',
          'Mail admission changed.',
        );
    });
  } catch {
    await database.transaction(async (tx) => {
      await lockBudget(tx, owner);
      await tx.query(
        "UPDATE ai_budget_reservations SET status='released',actual_micros=0,version=version+1 WHERE owner_id=$1 AND request_id=$2 AND status='uncertain'",
        [owner, batchId],
      );
      await tx.query(
        "UPDATE mail_broker_batches SET status='blocked',reason='context-changed' WHERE owner_id=$1 AND id=$2",
        [owner, batchId],
      );
      await tx.query(
        "UPDATE mail_broker_retrievals SET status='blocked' WHERE owner_id=$1 AND id=$2",
        [owner, sealed.retrievalId],
      );
    });
    await releaseBrokerHeadroom(database, owner, sealed.retrievalId);
    return readBrokerBatch(database, owner, batchId);
  }
  const result = await exchangeBroker(
    fetcher,
    sealed.secret,
    sealed.bytes,
    sealed.model,
    sealed.candidates,
    sealed.quote,
    options.timeoutMs,
  );
  await settleBrokerBatch(database, owner, batchId, result);
  return readBrokerBatch(database, owner, batchId);
}

async function settleBrokerBatch(
  database: Database,
  owner: string,
  batchId: string,
  result: BrokerExchange,
) {
  await database.transaction(async (tx) => {
    await lockBudget(tx, owner);
    const [batch] = await tx.query(
      'SELECT * FROM mail_broker_batches WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [owner, batchId],
    );
    if (!batch || batch.status !== 'uncertain') return;
    if (result.status === 'uncertain') {
      await tx.query(
        'UPDATE mail_broker_batches SET reason=$3 WHERE owner_id=$1 AND id=$2',
        [owner, batchId, result.reason],
      );
      return;
    }
    await tx.query(
      "UPDATE ai_budget_reservations SET status='settled',actual_micros=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
      [owner, batch.reservation_id, result.usage.actualMicros],
    );
    await tx.query(
      'UPDATE mail_broker_batches SET status=$3,reason=$4,decisions=$5,usage=$6 WHERE owner_id=$1 AND id=$2',
      [
        owner,
        batchId,
        result.reason ? 'blocked' : 'completed',
        result.reason,
        JSON.stringify(result.decisions),
        JSON.stringify(result.usage),
      ],
    );
    const retrieval = await readBrokerRetrieval(
      tx,
      owner,
      String(batch.retrieval_id),
      true,
    );
    const end = Number(batch.next_position) >= retrieval.snapshot.length;
    await tx.query(
      'UPDATE mail_broker_retrievals SET status=$3,position=$4,cursor_token=$5,coverage=$6 WHERE owner_id=$1 AND id=$2',
      [
        owner,
        retrieval.id,
        result.reason
          ? 'blocked'
          : end
            ? retrieval.limits.windowHasMore
              ? 'partial'
              : 'completed'
            : 'partial',
        Number(batch.next_position),
        randomUUID(),
        JSON.stringify({
          ...retrieval.coverage,
          judged: Number(batch.next_position),
          stopReason: result.reason
            ? 'blocked'
            : end && retrieval.coverage.stopReason === 'page'
              ? 'exhausted'
              : retrieval.coverage.stopReason,
        }),
      ],
    );
  });
}
export async function readBrokerBatch(
  tx: QueryExecutor,
  owner: string,
  batchId: string,
) {
  const [row] = await tx.query(
    'SELECT id,status,reason,usage FROM mail_broker_batches WHERE owner_id=$1 AND id=$2',
    [owner, batchId],
  );
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Mail batch not available.');
  return row;
}
/** Unsent downstream headroom may be abandoned; uncertain broker charges remain held. */
export async function releaseBrokerHeadroom(
  database: Database,
  owner: string,
  retrievalId: string,
) {
  await database.transaction(async (tx) => {
    await lockBudget(tx, owner);
    const retrieval = await readBrokerRetrieval(tx, owner, retrievalId);
    await tx.query(
      "UPDATE ai_budget_reservations SET status='released',actual_micros=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND request_id=$2 AND status='reserved'",
      [owner, retrieval.context.logicalRequestId],
    );
  });
}

/** Internal preview of original selected mail; NOT permission to disclose it to an agent.
 * J3 must guard again and consume the downstream hold at the actual transmission. */
export async function selectedBrokerMail(
  database: Database,
  config: Config,
  owner: string,
  retrievalId: string,
) {
  return database.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const { retrieval, grant, policy } = await guardBrokerRetrieval(
      tx,
      config,
      owner,
      retrievalId,
    );
    const batches = await tx.query(
      "SELECT sources,decisions,profile_revision,approval_version,verification_revision,rubric_revision,bounds_revision,threshold_revision FROM mail_broker_batches WHERE owner_id=$1 AND retrieval_id=$2 AND status='completed' ORDER BY position",
      [owner, retrievalId],
    );
    if (retrieval.status === 'uncertain' || retrieval.status === 'blocked')
      throw new ApiError(
        409,
        'MAIL_SELECTION_UNAVAILABLE',
        'Mail selection is incomplete.',
      );
    if (
      batches.some(
        (b) =>
          b.profile_revision !== policy.profile!.policyRevision ||
          b.approval_version !== policy.consent.version ||
          b.verification_revision !== policy.verification!.revision,
      )
    )
      throw new ApiError(
        409,
        'MAIL_ROUTE_CHANGED',
        'Selection approval changed.',
      );
    batches.forEach(requireCurrentSelectionPolicy);
    const sources = batches.flatMap((b) => b.sources as BrokerBinding[]);
    const originals = await brokerCandidates(
      tx,
      owner,
      grant,
      sources.map((s) => s.id),
      policy.allowed,
    );
    if (brokerDigest(originals.map(candidateBinding)) !== brokerDigest(sources))
      throw new ApiError(
        409,
        'MAIL_SOURCE_CHANGED',
        'A selection dependency changed.',
      );
    const decisions = batches
      .flatMap((b) => b.decisions as BrokerDecision[])
      .filter((d) => d.selected);
    const messages = [];
    let bytes = 2,
      clipped = 0;
    let stopReason = retrieval.coverage.stopReason;
    for (const decision of decisions) {
      if (messages.length >= retrieval.limits.maxResults) {
        stopReason = 'result-limit';
        break;
      }
      const original = originals.find((c) => c.id === decision.id)!;
      const message = {
        id: original.id,
        subject: original.subject,
        from: original.from,
        receivedAt: original.receivedAt,
        body: original.body,
        truncated: original.truncated,
      };
      const size =
        Buffer.byteLength(JSON.stringify(message)) + (messages.length ? 1 : 0);
      if (bytes + size > 128 * 1024) {
        stopReason = 'byte-limit';
        break;
      }
      bytes += size;
      messages.push(message);
      if (message.truncated) clipped++;
    }
    const coverage = {
      ...retrieval.coverage,
      selected: messages.length,
      clipped,
      hasMore:
        retrieval.limits.windowHasMore ||
        retrieval.position < retrieval.snapshot.length,
      stopReason,
    };
    await tx.query(
      'UPDATE mail_broker_retrievals SET selected_ids=$3,coverage=$4 WHERE owner_id=$1 AND id=$2',
      [
        owner,
        retrieval.id,
        messages.map((m) => m.id),
        JSON.stringify(coverage),
      ],
    );
    return {
      messages,
      dependencies: sources,
      receipt: mailBrokerReceiptSchema.parse({
        id: retrieval.id,
        status: retrieval.status,
        coverage,
      }),
      cursor:
        retrieval.position < retrieval.snapshot.length
          ? retrieval.cursor_token
          : null,
      downstreamRequestId: retrieval.context.logicalRequestId,
    };
  });
}

function requireCurrentSelectionPolicy(batch: Record<string, unknown>) {
  if (
    batch.rubric_revision !== brokerRubricRevision ||
    batch.bounds_revision !== brokerBoundsRevision ||
    batch.threshold_revision !== brokerThresholdRevision
  )
    throw new ApiError(
      409,
      'MAIL_SELECTION_POLICY_CHANGED',
      'Mail selection policy changed. Start a new retrieval.',
    );
}
