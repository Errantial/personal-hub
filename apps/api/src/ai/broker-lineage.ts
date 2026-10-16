import type { Config } from '../config.js';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import {
  brokerCandidates,
  brokerDigest,
  candidateBinding,
  readBrokerGrant,
  guardBrokerRetrieval,
  validateBrokerScope,
} from './mail-broker.js';
import type { BrokerBinding } from './mail-broker.js';
import { jevPolicy, requireJevReady } from './jev-policy.js';
import {
  jevBoundsRevision,
  jevRubricRevision,
  jevThresholdRevision,
} from './jev-protocol.js';
import type { LiveSource } from './live-manifest.js';

export type ForwardingBinding = {
  grantId: string;
  grantVersion: number;
  sources: BrokerBinding[];
  selectedIds: string[];
  policy: string;
};

export async function brokerPolicyDigest(
  tx: QueryExecutor,
  config: Config,
  owner: string,
) {
  const policy = await jevPolicy(tx, config, owner);
  requireJevReady(policy);
  return brokerDigest([
    policy.profile!.policyRevision,
    policy.consent.version,
    policy.verification,
    policy.downstream,
    policy.settingsVersion,
    policy.allowed,
    jevRubricRevision,
    jevBoundsRevision,
    jevThresholdRevision,
  ]);
}

/** Immutable forwarding receipt: all judged candidates remain dependencies, including losers. */
export async function bindBrokerForwarding(
  tx: QueryExecutor,
  config: Config,
  owner: string,
  requestId: string,
  retrievalId: string,
  selectedIds: string[],
  sources: BrokerBinding[],
): Promise<LiveSource> {
  const guarded = await guardBrokerRetrieval(tx, config, owner, retrievalId);
  const batches = await tx.query(
    "SELECT sources,profile_revision,approval_version,verification_revision,rubric_revision,bounds_revision,threshold_revision FROM mail_broker_batches WHERE owner_id=$1 AND retrieval_id=$2 AND status='completed' ORDER BY position",
    [owner, retrievalId],
  );
  const [selection] = await tx.query(
    'SELECT selected_ids FROM mail_broker_retrievals WHERE owner_id=$1 AND id=$2',
    [owner, retrievalId],
  );
  if (
    ['blocked', 'uncertain'].includes(guarded.retrieval.status) ||
    brokerDigest(batches.flatMap((b) => b.sources as BrokerBinding[])) !==
      brokerDigest(sources) ||
    brokerDigest(selection?.selected_ids) !== brokerDigest(selectedIds) ||
    batches.some(
      (b) =>
        b.profile_revision !== guarded.policy.profile!.policyRevision ||
        b.approval_version !== guarded.policy.consent.version ||
        b.verification_revision !== guarded.policy.verification!.revision ||
        b.rubric_revision !== jevRubricRevision ||
        b.bounds_revision !== jevBoundsRevision ||
        b.threshold_revision !== jevThresholdRevision,
    )
  )
    throw new ApiError(
      409,
      'MAIL_SELECTION_CHANGED',
      'Mail selection authorization changed.',
    );
  const [retrieval] = await tx.query(
    'SELECT grant_id,grant_version FROM mail_broker_retrievals WHERE owner_id=$1 AND id=$2',
    [owner, retrievalId],
  );
  if (!retrieval)
    throw new ApiError(
      409,
      'MAIL_SELECTION_UNAVAILABLE',
      'Mail selection is unavailable.',
    );
  const binding: ForwardingBinding = {
    grantId: String(retrieval.grant_id),
    grantVersion: Number(retrieval.grant_version),
    sources,
    selectedIds,
    policy: await brokerPolicyDigest(tx, config, owner),
  };
  const digest = brokerDigest(binding);
  await tx.query(
    'INSERT INTO mail_broker_forwardings(retrieval_id,owner_id,request_id,binding,digest) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [retrievalId, owner, requestId, JSON.stringify(binding), digest],
  );
  const [stored] = await tx.query(
    'SELECT digest,request_id FROM mail_broker_forwardings WHERE owner_id=$1 AND retrieval_id=$2',
    [owner, retrievalId],
  );
  if (stored?.digest !== digest || stored.request_id !== requestId)
    throw new ApiError(
      409,
      'MAIL_FORWARDING_CHANGED',
      'Mail forwarding was already bound differently.',
    );
  return {
    kind: 'mail-broker',
    projection: 'mail-broker-v1',
    id: retrievalId,
    version: 1,
    ref: 'broker',
    labels: [...new Set(sources.flatMap((s) => s.labels))].length
      ? [...new Set(sources.flatMap((s) => s.labels))]
      : ['unlabeled'],
    digest,
    brokerDigest: digest,
  };
}

/** History has no live run/deadline requirement. Its grant and complete original bindings still apply. */
export async function brokerLineageEligible(
  tx: QueryExecutor,
  owner: string,
  id: string,
  digest: string,
  config?: Config,
  requestId?: string,
) {
  const [row] = await tx.query(
    'SELECT binding,digest,request_id FROM mail_broker_forwardings WHERE owner_id=$1 AND retrieval_id=$2',
    [owner, id],
  );
  if (
    !row ||
    row.digest !== digest ||
    (requestId && row.request_id !== requestId)
  )
    return false;
  const binding = row.binding as ForwardingBinding;
  if (brokerDigest(binding) !== digest) return false;
  try {
    const grant = await readBrokerGrant(tx, owner, binding.grantId);
    if (!grant.enabled || grant.version !== binding.grantVersion) return false;
    await validateBrokerScope(tx, owner, grant.scope);
    const current = await brokerCandidates(
      tx,
      owner,
      grant,
      binding.sources.map((s) => s.id),
      ['unlabeled', 'personal'],
    );
    if (
      brokerDigest(current.map(candidateBinding)) !==
      brokerDigest(binding.sources)
    )
      return false;
    if (
      config &&
      (await brokerPolicyDigest(tx, config, owner)) !== binding.policy
    )
      return false;
    return true;
  } catch (error) {
    if (error instanceof ApiError) return false;
    throw error;
  }
}

export async function brokerDependencyCount(
  tx: QueryExecutor,
  owner: string,
  ids: string[],
) {
  if (!ids.length) return 0;
  const [row] = await tx.query(
    "SELECT COALESCE(SUM(jsonb_array_length(binding->'sources')),0)::int AS n FROM mail_broker_forwardings WHERE owner_id=$1 AND retrieval_id=ANY($2::uuid[])",
    [owner, ids],
  );
  return Number(row!.n);
}
