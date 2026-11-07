import type { Config } from '../config.js';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import {
  brokerCandidates,
  brokerDigest,
  candidateBinding,
  guardBrokerRetrieval,
  readBrokerGrant,
  validateBrokerScope,
} from './mail-broker.js';
import type { BrokerBinding, BrokerIdentity } from './mail-broker.js';
import { brokerPolicyForAlias, requireBrokerReady } from './broker-policy.js';
import {
  brokerBoundsRevision,
  brokerRubricRevision,
  brokerThresholdRevision,
} from './broker-protocol.js';
import type { LiveSource } from './live-manifest.js';

type ForwardingBindingV1 = {
  grantId: string;
  grantVersion: number;
  sources: BrokerBinding[];
  selectedIds: string[];
  policy: string;
};

export type ForwardingBinding = {
  policyVersion: 2;
  grantId: string;
  grantVersion: number;
  sources: BrokerBinding[];
  selectedIds: string[];
  broker: BrokerIdentity;
  downstream: unknown;
  settingsVersion: number;
  allowed: string[];
};

/** Exact pre-076 OpenRouter policy digest, retained only for legacy history. */
export async function brokerPolicyDigest(
  tx: QueryExecutor,
  config: Config,
  owner: string,
) {
  const policy = await brokerPolicyForAlias(tx, config, owner, 'mail-broker');
  requireBrokerReady(policy);
  return brokerDigest([
    policy.profile!.policyRevision,
    policy.consent.version,
    policy.verification,
    policy.downstream,
    policy.settingsVersion,
    policy.allowed,
    brokerRubricRevision,
    brokerBoundsRevision,
    brokerThresholdRevision,
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
  const identity = guarded.retrieval.limits.broker;
  if (!identity)
    throw new ApiError(
      409,
      'MAIL_BROKER_LEGACY_RECEIPT',
      'Historical mail receipts cannot create new forwarding authority.',
    );
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
    brokerDigest(
      batches.flatMap((batch) => batch.sources as BrokerBinding[]),
    ) !== brokerDigest(sources) ||
    brokerDigest(selection?.selected_ids) !== brokerDigest(selectedIds) ||
    batches.some(
      (batch) =>
        batch.profile_revision !== identity.profileRevision ||
        batch.approval_version !== identity.consentVersion ||
        batch.verification_revision !== identity.verificationRevision ||
        batch.rubric_revision !== identity.rubricRevision ||
        batch.bounds_revision !== identity.boundsRevision ||
        batch.threshold_revision !== identity.thresholdRevision,
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
    policyVersion: 2,
    grantId: String(retrieval.grant_id),
    grantVersion: Number(retrieval.grant_version),
    sources,
    selectedIds,
    broker: identity,
    downstream: guarded.policy.downstream,
    settingsVersion: guarded.policy.settingsVersion,
    allowed: guarded.policy.allowed,
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
    labels: [...new Set(sources.flatMap((source) => source.labels))].length
      ? [...new Set(sources.flatMap((source) => source.labels))]
      : ['unlabeled'],
    digest,
    brokerDigest: digest,
  };
}

/** History has no live run/deadline or current-selector requirement. */
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
  const binding = row.binding as ForwardingBinding | ForwardingBindingV1;
  if (brokerDigest(binding) !== digest) return false;
  try {
    const grant = await readBrokerGrant(tx, owner, binding.grantId);
    if (!grant.enabled || grant.version !== binding.grantVersion) return false;
    await validateBrokerScope(tx, owner, grant.scope);

    if ('policyVersion' in binding) {
      const policy = config
        ? await brokerPolicyForAlias(tx, config, owner, binding.broker.alias)
        : null;
      if (policy) {
        requireBrokerReady(policy);
        const current = historyBrokerIdentity(
          policy,
          binding.broker.selectorVersion,
        );
        if (
          brokerDigest(current) !== brokerDigest(binding.broker) ||
          brokerDigest(policy.downstream) !==
            brokerDigest(binding.downstream) ||
          policy.settingsVersion !== binding.settingsVersion ||
          brokerDigest(policy.allowed) !== brokerDigest(binding.allowed)
        )
          return false;
      }
      const originals = await brokerCandidates(
        tx,
        owner,
        grant,
        binding.sources.map((source) => source.id),
        policy?.allowed ?? ['unlabeled', 'personal'],
      );
      if (
        brokerDigest(originals.map(candidateBinding)) !==
        brokerDigest(binding.sources)
      )
        return false;
      if (
        config &&
        !(await batchesMatchIdentity(tx, owner, id, binding.broker))
      )
        return false;
      return true;
    }

    const current = await brokerCandidates(
      tx,
      owner,
      grant,
      binding.sources.map((source) => source.id),
      ['unlabeled', 'personal'],
    );
    if (
      brokerDigest(current.map(candidateBinding)) !==
      brokerDigest(binding.sources)
    )
      return false;
    if (config) {
      const policy = await brokerPolicyForAlias(
        tx,
        config,
        owner,
        'mail-broker',
      );
      requireBrokerReady(policy);
      const legacyIdentity: BrokerIdentity = {
        alias: 'mail-broker',
        adapter: 'openrouter',
        selectorVersion: 1,
        profileRevision: policy.profile!.policyRevision,
        consentVersion: policy.consent.version,
        credentialRevision: null,
        verificationRevision: policy.verification!.revision,
        verificationDigest: brokerDigest(policy.verification),
        rubricRevision: brokerRubricRevision,
        boundsRevision: brokerBoundsRevision,
        thresholdRevision: brokerThresholdRevision,
      };
      if (!(await batchesMatchIdentity(tx, owner, id, legacyIdentity)))
        return false;
      if ((await brokerPolicyDigest(tx, config, owner)) !== binding.policy)
        return false;
    }
    return true;
  } catch (error) {
    if (error instanceof ApiError) return false;
    throw error;
  }
}

function historyBrokerIdentity(
  policy: Awaited<ReturnType<typeof brokerPolicyForAlias>>,
  selectorVersion: number,
): BrokerIdentity {
  if (!policy.profile || !policy.verification)
    throw new ApiError(
      409,
      'MAIL_BROKER_BLOCKED',
      'Broker identity unavailable.',
    );
  return {
    alias: policy.alias,
    adapter: policy.adapter.kind,
    selectorVersion,
    profileRevision: policy.profile.policyRevision,
    consentVersion: policy.consent.version,
    credentialRevision: policy.credentialRevision,
    verificationRevision: policy.verification.revision,
    verificationDigest: brokerDigest(policy.verification),
    rubricRevision: policy.adapter.rubricRevision,
    boundsRevision: policy.adapter.boundsRevision,
    thresholdRevision: policy.adapter.thresholdRevision,
  };
}

async function batchesMatchIdentity(
  tx: QueryExecutor,
  owner: string,
  id: string,
  identity: BrokerIdentity,
) {
  const batches = await tx.query(
    "SELECT profile_revision,approval_version,verification_revision,rubric_revision,bounds_revision,threshold_revision FROM mail_broker_batches WHERE owner_id=$1 AND retrieval_id=$2 AND status='completed'",
    [owner, id],
  );
  return batches.every(
    (batch) =>
      batch.profile_revision === identity.profileRevision &&
      batch.approval_version === identity.consentVersion &&
      batch.verification_revision === identity.verificationRevision &&
      batch.rubric_revision === identity.rubricRevision &&
      batch.bounds_revision === identity.boundsRevision &&
      batch.threshold_revision === identity.thresholdRevision,
  );
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
