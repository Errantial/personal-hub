import type { Config } from '../config.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { boundLiveHash } from './context-binding.js';
import { lockBudget } from './budget.js';
import { liveAllowedLabels, readLiveDestination } from './live-destination.js';
import type { SealedEnvelope } from './live-envelope.js';
import { historySourcesEligible } from './live-history.js';
import {
  sourceDigest,
  turnDigest,
  liveHistorySourceSchema,
} from './live-manifest.js';
import type { LiveManifest, LiveSource } from './live-manifest.js';
import {
  livePlannerContext,
  mailSources,
  projectEvent,
  projectTask,
} from './live-projections.js';
import type { MailProjected } from './live-projections.js';
import { readAssistantSettings } from './live-request.js';
import { exchange, pinnedRouting } from './openrouter-live.js';
import type { ExchangeResult, OpenRouterFetch } from './openrouter-live.js';

// Final transmission guard (docs/live-context-admission-design.md).
//
// Linearization: the guard's REPEATABLE READ snapshot is taken by its first
// query. A revocation committed before that point blocks the send; a later
// one cannot retract bytes already handed to transport.
//
// Locks: the guard takes no row locks. Its only writes are its own
// ai_live_exchanges row and, for agents, its own run row (lease-fenced), in
// that order. releaseUnsent uses the existing settlement order: owner budget
// → ai_assistant_requests → ai_live_exchanges. Agent completion locks runs →
// turns → action policy → planner rows → responsibilities, so no cycle exists.

export type LiveSealed = SealedEnvelope<LiveManifest>;
export type GuardReason = 'context-changed' | 'route-blocked';

/** Re-projects mail sources as the call site sent them; null if not sendable. */
export type MailReprojector = (
  tx: QueryExecutor,
  sources: LiveSource[],
) => Promise<Map<string, MailProjected | null>>;

export type GuardContext = {
  /** HTTP exchanges: the owner's session must still be valid. */
  authority?: (tx: QueryExecutor) => Promise<boolean>;
  /** Agent exchanges: the run must still hold its lease. */
  agentRun?: { runId: string; token: string; now: () => Date };
  /** Required when the manifest has mail sources. */
  reprojectMail?: MailReprojector;
};

const key = (source: { projection: string; id: string }) =>
  `${source.projection}:${source.id}`;

/** Every check from admission, re-run in one snapshot. Null when sendable. */
export async function verifyLive(
  tx: QueryExecutor,
  config: Config,
  sealed: LiveSealed,
  context: GuardContext,
): Promise<GuardReason | null> {
  const { manifest, owner, requestId } = sealed;
  // Binding bytes alone does not prove they request the approved route.
  // Check the actual serialized fields before any transport can begin.
  try {
    const body = JSON.parse(sealed.bytes) as Record<string, unknown>;
    const provider = body.provider as Record<string, unknown> | undefined;
    const pinned = pinnedRouting(manifest.destination.upstream);
    if (
      body.model !== manifest.destination.model ||
      body.model !== sealed.model ||
      body.max_tokens !== sealed.maxTokens ||
      !Number.isSafeInteger(sealed.maxTokens) ||
      sealed.maxTokens <= 0 ||
      Buffer.byteLength(sealed.bytes) !== manifest.bytes ||
      !provider ||
      Object.keys(provider).length !== Object.keys(pinned).length ||
      !Object.entries(pinned).every(
        ([field, value]) =>
          JSON.stringify(provider[field]) === JSON.stringify(value),
      )
    )
      return 'context-changed';
  } catch {
    return 'context-changed';
  }
  const [row] = await tx.query(
    'SELECT guard_state,integrity_hash FROM ai_live_exchanges WHERE owner_id=$1 AND request_id=$2',
    [owner, requestId],
  );
  if (
    !row ||
    row.guard_state !== 'admitted' ||
    row.integrity_hash !==
      boundLiveHash(owner, requestId, sealed.bytes, manifest) ||
    manifest.owner !== owner ||
    manifest.requestId !== requestId
  )
    return 'context-changed';
  if (!(await tx.query('SELECT 1 FROM users WHERE id=$1', [owner])).length)
    return 'context-changed';
  if (context.authority && !(await context.authority(tx)))
    return 'context-changed';
  if (
    manifest.conversationId &&
    !(
      await tx.query(
        'SELECT 1 FROM ai_conversations WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL',
        [owner, manifest.conversationId],
      )
    ).length
  )
    return 'context-changed';

  const destination = await readLiveDestination(tx, config, owner);
  const bound = manifest.destination;
  if (
    !destination.destination ||
    destination.destination.version !== bound.version ||
    destination.destination.revision !== bound.revision ||
    destination.destination.model !== bound.model ||
    destination.destination.upstream !== bound.upstream ||
    sealed.model !== bound.model
  )
    return 'route-blocked';
  const settings = await readAssistantSettings(tx, owner);
  if (settings.version !== manifest.settingsVersion) return 'context-changed';
  const allowed = liveAllowedLabels(settings);
  const labels = [
    ...manifest.request.labels,
    ...manifest.sources.flatMap((source) => source.labels),
    ...manifest.history.sources.flatMap((source) => source.labels),
  ];
  if (labels.some((label) => !allowed.includes(label)))
    return 'context-changed';

  if (manifest.history.turns.length) {
    const turns = await tx.query(
      `SELECT t.id,t.ask,t.reply,t.inference_history,t.inference_digest,t.inference_sources FROM ai_conversation_turns t JOIN ai_conversations c ON c.id=t.conversation_id
       WHERE t.owner_id=$1 AND t.conversation_id=$2 AND t.id=ANY($3::uuid[]) AND c.deleted_at IS NULL`,
      [
        owner,
        manifest.conversationId,
        manifest.history.turns.map((turn) => turn.id),
      ],
    );
    const ok = manifest.history.turns.every((turn) =>
      turns.some((current) => {
        let refs: unknown;
        try {
          refs =
            typeof current.inference_sources === 'string'
              ? JSON.parse(current.inference_sources)
              : current.inference_sources;
        } catch {
          return false;
        }
        const parsed = liveHistorySourceSchema
          .array()
          .max(1000)
          .safeParse(refs);
        return (
          parsed.success &&
          parsed.data.every((ref) =>
            manifest.history.sources.some(
              (bound) =>
                ref.kind === bound.kind &&
                ref.id === bound.id &&
                ref.labels.every((label) => bound.labels.includes(label)) &&
                ref.connector?.id === bound.connector?.id &&
                ref.connector?.version === bound.connector?.version,
            ),
          ) &&
          current.id === turn.id &&
          current.inference_history === 'bound' &&
          typeof current.ask === 'string' &&
          typeof current.reply === 'string' &&
          turnDigest(owner, turn.id, current.ask, current.reply) ===
            turn.digest &&
          current.inference_digest === turn.digest
        );
      }),
    );
    if (!ok) return 'context-changed';
  }
  if (
    !(await historySourcesEligible(tx, owner, manifest.history.sources, {
      allowed,
      useMail: manifest.useMail,
    }))
  )
    return 'context-changed';

  const planner = manifest.sources.filter(
    (source) => source.kind === 'task' || source.kind === 'event',
  );
  if (planner.length) {
    const current = await livePlannerContext(tx, owner, {
      tasks: planner.filter((s) => s.kind === 'task').map((s) => s.id),
      events: planner.filter((s) => s.kind === 'event').map((s) => s.id),
    });
    for (const source of planner) {
      const record =
        source.kind === 'task'
          ? current.tasks.find((task) => task.id === source.id)
          : current.events.find((event) => event.id === source.id);
      if (!record || record.version !== source.version)
        return 'context-changed';
      const projected =
        source.kind === 'task'
          ? projectTask(record as Parameters<typeof projectTask>[0], source.ref)
          : projectEvent(
              record as Parameters<typeof projectEvent>[0],
              source.ref,
              manifest.timeZone ?? 'UTC',
            );
      if (
        sourceDigest(
          owner,
          requestId,
          source.projection,
          source.id,
          projected,
        ) !== source.digest
      )
        return 'context-changed';
    }
  }

  const mail = manifest.sources.filter((s) => s.kind === 'mail-message');
  if (mail.length) {
    if (!context.reprojectMail) return 'context-changed';
    const reprojected = await context.reprojectMail(tx, mail);
    const items = mail.map((source) => reprojected.get(key(source)) ?? null);
    if (items.some((item) => item === null)) return 'context-changed';
    let current: LiveSource[];
    try {
      current = await mailSources(
        tx,
        owner,
        requestId,
        items as MailProjected[],
      );
    } catch {
      return 'context-changed';
    }
    const same = mail.every((source, index) => {
      const now = current[index]!;
      return (
        now.version === source.version &&
        now.digest === source.digest &&
        now.connector?.id === source.connector?.id &&
        now.connector?.version === source.connector?.version &&
        now.labels.length === source.labels.length &&
        now.labels.every((label) => source.labels.includes(label))
      );
    });
    if (!same) return 'context-changed';
  }

  const agent = manifest.request.agent;
  if (agent) {
    const [responsibility] = await tx.query(
      "SELECT goal,sensitivity,labels FROM responsibilities WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL AND status IN ('active','paused')",
      [owner, agent.id],
    );
    if (
      !responsibility ||
      responsibility.sensitivity !== 'unlabeled' ||
      !Array.isArray(responsibility.labels) ||
      responsibility.labels.some((label: unknown) => label !== 'unlabeled') ||
      sourceDigest(
        owner,
        requestId,
        'agent-goal',
        agent.id,
        responsibility.goal,
      ) !== agent.goalDigest
    )
      return 'context-changed';
  }
  if (context.agentRun) {
    const [run] = await tx.query(
      "SELECT 1 FROM responsibility_runs WHERE owner_id=$1 AND id=$2 AND status='running' AND lease_token=$3 AND lease_until > $4",
      [
        owner,
        context.agentRun.runId,
        context.agentRun.token,
        context.agentRun.now(),
      ],
    );
    if (!run) return 'context-changed';
  }
  return null;
}

/**
 * Verifies the sealed exchange in a short lock-free snapshot, marks it
 * verified, then sends exactly its bytes. A failed check releases the hold:
 * nothing was sent, and nothing is ever resent automatically.
 */
export async function transmitLive(
  database: Database,
  config: Config,
  fetcher: OpenRouterFetch,
  apiKey: string,
  sealed: LiveSealed,
  context: GuardContext,
): Promise<ExchangeResult | { status: 'withheld'; reason: GuardReason }> {
  let reason: GuardReason | null;
  try {
    reason = await database.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const failed = await verifyLive(tx, config, sealed, context);
      if (failed) return failed;
      const marked = await tx.query(
        "UPDATE ai_live_exchanges SET guard_state='verified',guarded_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND request_id=$2 AND guard_state='admitted' RETURNING request_id",
        [sealed.owner, sealed.requestId],
      );
      if (!marked.length) return 'context-changed';
      if (context.agentRun) {
        const progressed = await tx.query(
          "UPDATE responsibility_runs SET progress_stage='provider-request',progress_at=$4,version=version+1 WHERE owner_id=$1 AND id=$2 AND status='running' AND lease_token=$3 AND lease_until > $4 RETURNING id",
          [
            sealed.owner,
            context.agentRun.runId,
            context.agentRun.token,
            context.agentRun.now(),
          ],
        );
        // Throwing rolls back the verified mark: nothing is sent.
        if (!progressed.length) throw new GuardRollback();
      }
      return null;
    });
  } catch (error) {
    // A lost lease or a serialization failure (40001): nothing was sent.
    if (
      error instanceof GuardRollback ||
      (error as { code?: string }).code === '40001'
    )
      reason = 'context-changed';
    else throw error;
  }
  if (reason) {
    await releaseUnsent(database, sealed.owner, sealed.requestId, reason);
    return { status: 'withheld', reason };
  }
  return exchange(fetcher, apiKey, sealed);
}

class GuardRollback extends Error {}

/** Releases the hold of an exchange that was never handed to transport. */
export async function releaseUnsent(
  database: Database,
  owner: string,
  requestId: string,
  reason: GuardReason,
) {
  await database.transaction(async (tx) => {
    await lockBudget(tx, owner);
    const [request] = await tx.query(
      'SELECT reservation_id FROM ai_assistant_requests WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [owner, requestId],
    );
    // Only an exchange that never passed the guard can be released.
    const blocked = await tx.query(
      "UPDATE ai_live_exchanges SET guard_state='blocked',guarded_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND request_id=$2 AND guard_state='admitted' RETURNING request_id",
      [owner, requestId],
    );
    if (!request || !blocked.length) return;
    await tx.query(
      "UPDATE ai_budget_reservations SET status='released',actual_micros=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 AND status='uncertain'",
      [owner, request.reservation_id],
    );
    await tx.query(
      "UPDATE ai_assistant_requests SET status='failed',reason=$3,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
      [owner, requestId, reason],
    );
  });
}
