import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  mailBrokerGrantSchema,
  mailBrokerRequestSchema,
  mailBrokerReceiptSchema,
} from '@hub/contracts';
import type { MailBrokerGrant, MailBrokerRequest } from '@hub/contracts';
import type { Database, QueryExecutor } from '../db/database.js';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';
import { brokerPolicy, requireBrokerReady } from './broker-policy.js';
import { maxLiveSources } from './live-manifest.js';
import { lockBudget } from './budget.js';
import {
  fitBrokerCandidates,
  brokerBoundsRevision,
  brokerRubricRevision,
  brokerThresholdRevision,
} from './broker-protocol.js';
import { agentSpend } from './agent-spend.js';

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, v]) => [key, canonical(v)]),
        )
      : value;
export const brokerDigest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const labels = z
  .array(z.enum(['unlabeled', 'personal', 'restricted']))
  .min(1)
  .max(3);
const contextSchema = z.strictObject({
  logicalRequestId: z.string().uuid(),
  requestLabels: labels,
  deadlineAt: z.string().datetime(),
  downstreamMaximumMicros: z.number().int().positive().max(1000000000000),
  agent: z
    .strictObject({
      id: z.string().uuid(),
      runId: z.string().uuid(),
      leaseToken: z.string().uuid(),
      goalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable(),
});
export type BrokerContext = z.infer<typeof contextSchema>;
export type BrokerCandidate = {
  id: string;
  version: number;
  connectorId: string;
  connectorVersion: number;
  labels: ('unlabeled' | 'personal' | 'restricted')[];
  digest: string;
  subject: string;
  from: string | null;
  receivedAt: string;
  body: string;
  truncated: boolean;
};
export type BrokerBinding = Omit<
  BrokerCandidate,
  'subject' | 'from' | 'receivedAt' | 'body' | 'truncated'
>;
export const candidateBinding = (c: BrokerCandidate): BrokerBinding => ({
  id: c.id,
  version: c.version,
  connectorId: c.connectorId,
  connectorVersion: c.connectorVersion,
  labels: c.labels,
  digest: c.digest,
});
export const grantColumns = 'id,agent_id AS "agentId",version,enabled,scope';
export async function readBrokerGrant(
  tx: QueryExecutor,
  owner: string,
  id: string,
) {
  const [row] = await tx.query(
    `SELECT ${grantColumns} FROM mail_broker_grants WHERE owner_id=$1 AND id=$2`,
    [owner, id],
  );
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Mail grant not available.');
  return mailBrokerGrantSchema.parse(row);
}
export async function validateBrokerScope(
  tx: QueryExecutor,
  owner: string,
  scope: MailBrokerGrant['scope'],
) {
  const rows = await tx.query(
    'SELECT id FROM email_connectors WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND revoked_at IS NULL',
    [owner, scope.connectorIds],
  );
  if (rows.length !== scope.connectorIds.length)
    throw new ApiError(
      409,
      'MAIL_SCOPE_UNAVAILABLE',
      'Choose active owned connectors.',
    );
}
export async function checkBrokerContext(
  tx: QueryExecutor,
  owner: string,
  context: BrokerContext,
) {
  const [workflow] = await tx.query(
    `SELECT c.id FROM mail_broker_workflows w LEFT JOIN ai_conversations c
    ON c.owner_id=w.owner_id AND c.id=w.conversation_id AND c.deleted_at IS NULL
    WHERE w.owner_id=$1 AND w.id=$2`,
    [owner, context.logicalRequestId],
  );
  if (workflow && !workflow.id)
    throw new ApiError(
      409,
      'MAIL_CONVERSATION_CHANGED',
      'The mail conversation is unavailable.',
    );
  if (Date.parse(context.deadlineAt) <= Date.now())
    throw new ApiError(
      409,
      'MAIL_DEADLINE',
      'Mail retrieval deadline expired.',
    );
  if (!context.agent) return;
  const agent = context.agent;
  const [row] = await tx.query(
    `SELECT r.goal,r.sensitivity,r.labels,r.monthly_cap_micros FROM responsibilities r JOIN responsibility_runs n ON n.owner_id=r.owner_id AND n.responsibility_id=r.id
    WHERE r.owner_id=$1 AND r.id=$2 AND r.template IS NOT NULL AND r.deleted_at IS NULL AND r.status IN ('active','paused')
    AND n.id=$3 AND n.status='running' AND n.lease_token=$4 AND n.lease_until>CURRENT_TIMESTAMP`,
    [owner, agent.id, agent.runId, agent.leaseToken],
  );
  if (
    !row ||
    row.sensitivity !== 'unlabeled' ||
    !Array.isArray(row.labels) ||
    row.labels.some((label) => label !== 'unlabeled') ||
    brokerDigest(row.goal) !== agent.goalDigest
  )
    throw new ApiError(409, 'MAIL_LEASE_CHANGED', 'Agent context changed.');
  if (
    (await agentSpend(tx, owner, agent.id)) >
    BigInt(String(row.monthly_cap_micros))
  )
    throw new ApiError(
      409,
      'AGENT_BUDGET_EXCEEDED',
      'Agent allowance changed.',
    );
}

/** Original text stays transient. The audit stores versions/labels/private hashes only. */
export async function brokerCandidates(
  tx: QueryExecutor,
  owner: string,
  grant: MailBrokerGrant,
  ids: string[],
  allowed: string[],
): Promise<BrokerCandidate[]> {
  if (!ids.length) return [];
  const rows = await tx.query(
    `SELECT m.id,m.version,m.connector_id,m.sensitivity,m.text_origin,m.subject,m.from_address,m.body,m.body_truncated,
    to_char(m.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received,
    c.version AS connector_version,c.sensitivity AS connector_label
    FROM email_messages m JOIN email_connectors c ON c.id=m.connector_id AND c.owner_id=m.owner_id
    WHERE m.owner_id=$1 AND m.id=ANY($2::uuid[]) AND m.connector_id=ANY($3::uuid[]) AND c.revoked_at IS NULL
    AND ($4::timestamptz IS NULL OR m.received_at >= $4) AND ($5::timestamptz IS NULL OR m.received_at < $5)`,
    [
      owner,
      ids,
      grant.scope.connectorIds,
      grant.scope.receivedAfter,
      grant.scope.receivedBefore,
    ],
  );
  return ids.flatMap((id) => {
    const row = rows.find((r) => r.id === id);
    if (!row || row.text_origin !== 'message-body-v1') return [];
    const sourceLabels = labels.parse([
      ...new Set([row.sensitivity, row.connector_label]),
    ]);
    if (
      sourceLabels.some(
        (label) => label === 'restricted' || !allowed.includes(label),
      )
    )
      return [];
    const address = row.from_address as {
      name: string | null;
      address: string;
    } | null;
    const original = {
      subject: String(row.subject),
      from: address ? address.name || address.address : null,
      receivedAt: String(row.received),
      body: String(row.body),
      truncated: row.body_truncated === true,
    };
    return [
      {
        id,
        version: Number(row.version),
        connectorId: String(row.connector_id),
        connectorVersion: Number(row.connector_version),
        labels: sourceLabels,
        digest: brokerDigest([owner, id, original]),
        ...original,
        body: original.body.slice(0, 6000).replace(/[\uD800-\uDBFF]$/, ''),
        truncated: original.truncated || original.body.length > 6000,
      },
    ];
  });
}

type Retrieval = {
  id: string;
  grant_id: string;
  grant_version: number;
  request_hash: string;
  snapshot: BrokerBinding[];
  context: BrokerContext;
  limits: {
    maxResults: number;
    maxCandidates: number;
    downstream: unknown;
    policyVersion: number;
    settingsVersion: number;
    windowHasMore: boolean;
    windowEnd?: { receivedAt: string; id: string };
    snapshotAt?: string;
    verificationDigest?: string;
  };
  cursor_token: string;
  position: number;
  status: string;
  coverage: z.infer<typeof mailBrokerReceiptSchema>['coverage'];
};
export async function readBrokerRetrieval(
  tx: QueryExecutor,
  owner: string,
  id: string,
  lock = false,
) {
  const [row] = await tx.query(
    'SELECT * FROM mail_broker_retrievals WHERE owner_id=$1 AND id=$2' +
      (lock ? ' FOR UPDATE' : ''),
    [owner, id],
  );
  if (!row)
    throw new ApiError(404, 'NOT_FOUND', 'Mail retrieval not available.');
  return row as unknown as Retrieval;
}
export const brokerReceipt = (r: Retrieval) =>
  mailBrokerReceiptSchema.parse({
    id: r.id,
    status: r.status,
    coverage: r.coverage,
  });

/** INTERNAL: context/labels/lease/headroom must come from the server, never a model or HTTP input. No dispatch. */
export async function beginBrokerRetrieval(
  database: Database,
  config: Config,
  owner: string,
  candidate: MailBrokerRequest,
  trustedContext: BrokerContext,
) {
  const input = mailBrokerRequestSchema.parse(candidate),
    context = contextSchema.parse(trustedContext);
  const hash = brokerDigest([input, context]);
  return database.transaction(async (tx) => {
    await lockBudget(tx, owner);
    const existing = await tx.query(
      'SELECT id,request_hash FROM mail_broker_retrievals WHERE owner_id=$1 AND operation_id=$2',
      [owner, input.operationId],
    );
    if (existing.length) {
      if (existing[0]!.request_hash !== hash)
        throw new ApiError(409, 'OPERATION_CONFLICT', 'Mail request changed.');
      await guardBrokerRetrieval(tx, config, owner, String(existing[0]!.id));
      const row = await readBrokerRetrieval(tx, owner, String(existing[0]!.id));
      return { receipt: brokerReceipt(row), cursor: row.cursor_token };
    }
    const grant = await readBrokerGrant(tx, owner, input.grantId);
    if (
      !grant.enabled ||
      grant.version !== input.expectedGrantVersion ||
      grant.agentId !== (context.agent?.id ?? null)
    )
      throw new ApiError(
        409,
        'MAIL_GRANT_CHANGED',
        'Mail grant unavailable or changed.',
      );
    await checkBrokerContext(tx, owner, context);
    await validateBrokerScope(tx, owner, grant.scope);
    if (context.agent) {
      const [count] = await tx.query(
        'SELECT count(*)::int AS n FROM mail_broker_retrievals WHERE owner_id=$1 AND run_id=$2',
        [owner, context.agent.runId],
      );
      if (Number(count!.n) >= 2)
        throw new ApiError(
          409,
          'MAIL_RUN_LIMIT',
          'This run has used its mail retrieval allowance.',
        );
    }
    const policy = await brokerPolicy(tx, config, owner);
    requireBrokerReady(policy);
    if (context.requestLabels.some((label) => !policy.allowed.includes(label)))
      throw new ApiError(
        409,
        'MAIL_REQUEST_ROUTE_BLOCKED',
        'The mail request cannot reach both destinations.',
      );
    const [budget] = await tx.query(
      'SELECT version FROM ai_budget_policies WHERE owner_id=$1',
      [owner],
    );
    let boundary: { receivedAt: string; id: string } | undefined;
    let snapshotAt = new Date().toISOString();
    if (input.continuation) {
      const [prior] = await tx.query(
        'SELECT r.*,f.binding AS forwarding,f.digest AS forwarding_digest FROM mail_broker_retrievals r JOIN mail_broker_forwardings f ON f.owner_id=r.owner_id AND f.retrieval_id=r.id WHERE r.owner_id=$1 AND r.cursor_token=$2',
        [owner, input.continuation],
      );
      if (
        !prior ||
        prior.grant_id !== grant.id ||
        prior.grant_version !== grant.version ||
        prior.agent_id !== (context.agent?.id ?? null) ||
        Number(prior.position) < (prior.snapshot as unknown[]).length ||
        !(prior.limits as Retrieval['limits']).windowHasMore
      )
        throw new ApiError(
          409,
          'MAIL_CONTINUATION_INVALID',
          'Mail continuation is unavailable.',
        );
      boundary = (prior.limits as Retrieval['limits']).windowEnd;
      const bindings = (prior.forwarding as { sources: BrokerBinding[] })
        .sources;
      const originals = await brokerCandidates(
        tx,
        owner,
        grant,
        bindings.map((s) => s.id),
        policy.allowed,
      );
      if (
        brokerDigest(prior.forwarding) !== prior.forwarding_digest ||
        brokerDigest(originals.map(candidateBinding)) !== brokerDigest(bindings)
      )
        throw new ApiError(
          409,
          'MAIL_CONTINUATION_INVALID',
          'A prior mail selection dependency changed.',
        );
      snapshotAt = (prior.limits as Retrieval['limits']).snapshotAt ?? '';
      if (!boundary || !snapshotAt)
        throw new ApiError(
          409,
          'MAIL_CONTINUATION_INVALID',
          'Mail continuation has no stable boundary.',
        );
    }
    const rows = await tx.query(
      `SELECT m.id,to_char(m.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "receivedAt" FROM email_messages m JOIN email_connectors c ON c.owner_id=m.owner_id AND c.id=m.connector_id
      WHERE m.owner_id=$1 AND m.connector_id=ANY($2::uuid[]) AND c.revoked_at IS NULL
      AND ($3::timestamptz IS NULL OR m.received_at >= $3) AND ($4::timestamptz IS NULL OR m.received_at < $4)
      AND m.created_at <= $6::timestamptz
      AND ($7::timestamptz IS NULL OR (m.received_at,m.id) < ($7::timestamptz,$8::uuid))
      ORDER BY m.received_at DESC,m.id DESC LIMIT $5`,
      [
        owner,
        grant.scope.connectorIds,
        grant.scope.receivedAfter,
        grant.scope.receivedBefore,
        input.maxCandidates + 1,
        snapshotAt,
        boundary?.receivedAt ?? null,
        boundary?.id ?? null,
      ],
    );
    const window = rows.slice(0, input.maxCandidates);
    const eligible = await brokerCandidates(
      tx,
      owner,
      grant,
      window.map((r) => String(r.id)),
      policy.allowed,
    );
    // Ranking depends on every evaluated candidate. Never discard lineage to fit.
    const snapshot = eligible.slice(0, maxLiveSources).map(candidateBinding);
    const now = new Date().toISOString(),
      id = randomUUID(),
      cursor = randomUUID();
    const connectors = await tx.query(
      `SELECT id,to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSeenAt",to_char(since,'YYYY-MM-DD') AS "importedSince" FROM email_connectors WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
      [owner, grant.scope.connectorIds],
    );
    const hasMore =
      rows.length > window.length || eligible.length > snapshot.length;
    const coverage = {
      scope: 'imported-mail',
      externalCompleteness: 'unverified',
      snapshotAt: now,
      connectors,
      inspected: window.length,
      judged: 0,
      eligible: snapshot.length,
      selected: 0,
      clipped: 0,
      hasMore,
      stopReason:
        eligible.length > snapshot.length
          ? 'lineage-limit'
          : hasMore
            ? 'candidate-limit'
            : snapshot.length
              ? 'page'
              : 'exhausted',
    };
    await tx.query(
      `INSERT INTO mail_broker_retrievals(id,owner_id,operation_id,request_hash,grant_id,grant_version,agent_id,run_id,intent_digest,snapshot,context,limits,cursor_token,coverage,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        owner,
        input.operationId,
        hash,
        grant.id,
        grant.version,
        context.agent?.id ?? null,
        context.agent?.runId ?? null,
        brokerDigest([owner, input.intent]),
        JSON.stringify(snapshot),
        JSON.stringify(context),
        JSON.stringify({
          maxResults: input.maxResults,
          maxCandidates: input.maxCandidates,
          downstream: policy.downstream,
          policyVersion: budget!.version,
          settingsVersion: policy.settingsVersion,
          windowHasMore: hasMore,
          snapshotAt,
          verificationDigest: brokerDigest(policy.verification),
          windowEnd: (() => {
            const end =
              eligible.length > snapshot.length
                ? window.find((r) => r.id === snapshot.at(-1)?.id)
                : window.at(-1);
            return end
              ? { id: String(end.id), receivedAt: String(end.receivedAt) }
              : undefined;
          })(),
        }),
        cursor,
        JSON.stringify(coverage),
        snapshot.length ? 'pending' : hasMore ? 'partial' : 'completed',
      ],
    );
    return {
      receipt: brokerReceipt(await readBrokerRetrieval(tx, owner, id)),
      cursor,
    };
  });
}

export async function guardBrokerRetrieval(
  tx: QueryExecutor,
  config: Config,
  owner: string,
  id: string,
) {
  const retrieval = await readBrokerRetrieval(tx, owner, id);
  const grant = await readBrokerGrant(tx, owner, retrieval.grant_id);
  if (!grant.enabled || grant.version !== retrieval.grant_version)
    throw new ApiError(409, 'MAIL_GRANT_CHANGED', 'Mail grant changed.');
  await checkBrokerContext(tx, owner, retrieval.context);
  await validateBrokerScope(tx, owner, grant.scope);
  const policy = await brokerPolicy(tx, config, owner);
  requireBrokerReady(policy);
  if (
    brokerDigest(policy.downstream) !==
      brokerDigest(retrieval.limits.downstream) ||
    policy.settingsVersion !== retrieval.limits.settingsVersion ||
    (retrieval.limits.verificationDigest !== undefined &&
      retrieval.limits.verificationDigest !==
        brokerDigest(policy.verification)) ||
    retrieval.context.requestLabels.some((l) => !policy.allowed.includes(l))
  )
    throw new ApiError(409, 'MAIL_ROUTE_CHANGED', 'Mail destinations changed.');
  const [budget] = await tx.query(
    'SELECT version FROM ai_budget_policies WHERE owner_id=$1',
    [owner],
  );
  if (budget?.version !== retrieval.limits.policyVersion)
    throw new ApiError(409, 'MAIL_BUDGET_CHANGED', 'Spending policy changed.');
  return { retrieval, grant, policy };
}

/** Stable snapshot pages, random owner-bound cursors, and metadata-only checkpoints. */
export async function prepareBrokerPage(
  database: Database,
  config: Config,
  owner: string,
  id: string,
  cursor: string,
  intent: string,
) {
  return database.transaction(async (tx) => {
    const retrieval = await readBrokerRetrieval(tx, owner, id, true);
    if (
      retrieval.cursor_token !== cursor ||
      !['pending', 'partial'].includes(retrieval.status)
    )
      throw new ApiError(409, 'MAIL_CURSOR_INVALID', 'Mail cursor is stale.');
    const { grant, policy } = await guardBrokerRetrieval(tx, config, owner, id);
    const [digest] = await tx.query(
      'SELECT intent_digest FROM mail_broker_retrievals WHERE owner_id=$1 AND id=$2',
      [owner, id],
    );
    if (digest!.intent_digest !== brokerDigest([owner, intent]))
      throw new ApiError(
        409,
        'MAIL_INTENT_CHANGED',
        'Resupply the original mail request.',
      );
    const bindings = retrieval.snapshot.slice(
      retrieval.position,
      retrieval.position + 25,
    );
    const page = await brokerCandidates(
      tx,
      owner,
      grant,
      bindings.map((s) => s.id),
      policy.allowed,
    );
    if (brokerDigest(page.map(candidateBinding)) !== brokerDigest(bindings))
      throw new ApiError(
        409,
        'MAIL_SOURCE_CHANGED',
        'Mail changed since selection began.',
      );
    const candidates = fitBrokerCandidates(
      policy.profile!.model,
      intent,
      page,
      policy.profile!.maxInputCharacters,
    );
    if (!candidates.length)
      throw new ApiError(
        409,
        'MAIL_ENVELOPE_LIMIT',
        'Mail request does not fit the approved envelope.',
      );
    const [existing] = await tx.query(
      'SELECT id,status,sources FROM mail_broker_batches WHERE owner_id=$1 AND retrieval_id=$2 AND position=$3',
      [owner, id, retrieval.position],
    );
    if (existing)
      return {
        id: String(existing.id),
        retrievalId: id,
        candidates,
        context: retrieval.context,
        status: String(existing.status),
        intent,
      };
    const batchId = randomUUID();
    await tx.query(
      'INSERT INTO mail_broker_batches(id,owner_id,retrieval_id,position,next_position,sources,bounds_revision,rubric_revision,threshold_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        batchId,
        owner,
        id,
        retrieval.position,
        retrieval.position + candidates.length,
        JSON.stringify(candidates.map(candidateBinding)),
        brokerBoundsRevision,
        brokerRubricRevision,
        brokerThresholdRevision,
      ],
    );
    return {
      id: batchId,
      retrievalId: id,
      candidates,
      context: retrieval.context,
      status: 'prepared',
      intent,
    };
  });
}
