import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@hub/contracts';
import type { AgentTemplate, AssistantTurn, RunOutcome } from '@hub/contracts';
import type { Config } from '../config.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import type { OpenRouterFetch } from '../ai/openrouter-live.js';
import { answerTurn } from './assistant.js';
import {
  agentPrompt,
  agentSpend,
  applyByPolicy,
  notificationTitle,
  outcomeOf,
  transactionDatabase,
} from './agent-run.js';
import { readTurn } from './assistant-conversations.js';
import type { RunCounts } from './agent-run.js';
import {
  admitSlot,
  appendResponsibilityActivity,
  cancelResponsibilityRuns,
  readResponsibility,
  readResponsibilitySchedule,
} from './responsibilities.js';

// Agent worker (D57). In-process, one run at a time, following the reminder
// worker's lease pattern: admit due slots, claim the oldest queued run,
// recheck, answer through the shared Assistant pipeline, apply by action
// settings, finish. Uncertain provider outcomes are never resent.

const leaseMs = 10 * 60000;
const retryMs = 15 * 60000;
const tickMs = 30000;
/** Errors that happen before anything is held and are safe to retry once. */
const retryableCodes = new Set(['ASSISTANT_CATALOG_UNAVAILABLE']);

type AgentRow = {
  id: string;
  ownerId: string;
  version: number;
  status: string;
  title: string;
  goal: string;
  template: AgentTemplate;
  conversationId: string;
  timeZone: string;
  useMail: boolean;
  capMicros: number;
  pauseReason: string | null;
  sensitivity: string;
  labels: string[];
};
const agentColumns = `id,owner_id AS "ownerId",version,status,title,goal,template,conversation_id AS "conversationId",time_zone AS "timeZone",use_mail AS "useMail",monthly_cap_micros::text AS "capMicros",pause_reason AS "pauseReason",sensitivity,labels`;

/** Agent fields of one responsibility; null when it is not an agent. */
export async function readAgentRow(
  tx: QueryExecutor,
  owner: string,
  id: string,
): Promise<AgentRow | null> {
  const [row] = await tx.query(
    `SELECT ${agentColumns} FROM responsibilities WHERE owner_id=$1 AND id=$2 AND template IS NOT NULL AND deleted_at IS NULL`,
    [owner, id],
  );
  return row
    ? ({ ...row, capMicros: Number(row.capMicros) } as AgentRow)
    : null;
}

type Claimed = {
  id: string;
  ownerId: string;
  responsibilityId: string;
  responsibilityVersion: number;
  trigger: 'manual' | 'schedule';
  attempts: number;
  token: string;
};

async function activity(
  tx: QueryExecutor,
  owner: string,
  responsibilityId: string,
  kind: 'run-started' | 'run-completed' | 'run-failed' | 'cap-reached',
  runId: string | null,
) {
  const value = await readResponsibility(tx, owner, responsibilityId);
  await appendResponsibilityActivity(tx, owner, value, kind, runId);
}

async function notify(
  tx: QueryExecutor,
  owner: string,
  runId: string,
  conversationId: string,
  title: string,
  now: Date,
) {
  await tx.query(
    'INSERT INTO notifications(id,owner_id,title,created_at,run_id,conversation_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id) DO NOTHING',
    [randomUUID(), owner, title.slice(0, 200), now, runId, conversationId],
  );
}

/** Pauses an agent that reached its monthly cap and cancels its queued runs. */
async function pauseAtCap(
  tx: QueryExecutor,
  owner: string,
  responsibilityId: string,
) {
  const [row] = await tx.query(
    "UPDATE responsibilities SET status='paused',pause_reason='cap-reached',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 AND status='active' RETURNING id",
    [owner, responsibilityId],
  );
  if (!row) return;
  const value = await readResponsibility(tx, owner, responsibilityId);
  await cancelResponsibilityRuns(tx, owner, value, 'cap-reached');
  await appendResponsibilityActivity(tx, owner, value, 'cap-reached', null);
}

/** Ends a claimed run as failed, if this worker still holds its lease. */
async function failRun(
  database: Database,
  run: Claimed,
  agent: { title: string; conversationId: string } | null,
  code: string,
  now: Date,
  turnId: string | null = null,
) {
  await database.transaction(async (tx) => {
    const [row] = await tx.query(
      "UPDATE responsibility_runs SET status='failed',outcome='failed',error_code=$3,finished_at=$4,turn_id=COALESCE($5,turn_id),lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",
      [run.id, run.token, code, now, turnId],
    );
    if (!row) return;
    await activity(tx, run.ownerId, run.responsibilityId, 'run-failed', run.id);
    if (agent)
      await notify(
        tx,
        run.ownerId,
        run.id,
        agent.conversationId,
        notificationTitle(agent.title, 'failed', {
          applied: 0,
          proposed: 0,
          notAllowed: 0,
          failed: 0,
        }),
        now,
      );
  });
}

/** Leases that outlived a restart: failed, never resent (the call may have gone out). */
async function failExpiredLeases(database: Database, now: Date) {
  const expired = await database.query(
    'SELECT r.id,r.owner_id AS "ownerId",r.responsibility_id AS "responsibilityId",r.attempts,r.lease_token AS token,p.title,p.conversation_id AS "conversationId" FROM responsibility_runs r JOIN responsibilities p ON p.owner_id=r.owner_id AND p.id=r.responsibility_id WHERE r.status=\'running\' AND r.lease_until <= $1',
    [now],
  );
  for (const row of expired) {
    // Recover a durable answer for owner review without repeating inference or
    // automatically applying work whose execution ownership has expired.
    const [request] = await database.query(
      'SELECT id FROM ai_assistant_requests WHERE owner_id=$1 AND operation_id=$2',
      [row.ownerId, attemptOperation(String(row.id), Number(row.attempts))],
    );
    const turn = request
      ? await readTurn(database, String(row.ownerId), String(request.id))
      : null;
    await failRun(
      database,
      row as unknown as Claimed,
      row.conversationId
        ? {
            title: String(row.title),
            conversationId: String(row.conversationId),
          }
        : null,
      'LEASE_EXPIRED',
      now,
      turn?.id ?? null,
    );
  }
}

/** Admits every due slot of active agents into queued runs. */
async function admitDue(database: Database, now: Date) {
  const due = await database.query(
    `SELECT s.owner_id AS owner,s.responsibility_id AS id FROM responsibility_schedules s JOIN responsibilities r ON r.owner_id=s.owner_id AND r.id=s.responsibility_id
     WHERE r.status='active' AND r.template IS NOT NULL AND r.deleted_at IS NULL AND s.deleted_at IS NULL AND s.next_due_at <= $1 ORDER BY s.responsibility_id`,
    [now],
  );
  let admitted = 0;
  for (const row of due) {
    try {
      await database.transaction(async (tx) => {
        const value = await readResponsibility(
          tx,
          String(row.owner),
          String(row.id),
          true,
        );
        if (value.status !== 'active' || value.deletedAt) return;
        const saved = await readResponsibilitySchedule(
          tx,
          String(row.owner),
          value.id,
        );
        if (!saved || saved.deletedAt || !saved.nextDueAt) return;
        if (Date.parse(saved.nextDueAt) > now.getTime()) return;
        await admitSlot(tx, String(row.owner), value, saved, now.getTime());
        admitted++;
      });
    } catch (error) {
      // One agent's broken schedule must not stop the others.
      if (!(error instanceof ApiError)) throw error;
    }
  }
  return admitted;
}

/** Claims the oldest ready queued run unless another run holds a live lease. */
async function claim(database: Database, now: Date): Promise<Claimed | null> {
  return database.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO worker_state(name,last_tick,error_code) VALUES('agents',$1,NULL) ON CONFLICT (name) DO NOTHING",
      [now],
    );
    await tx.query(
      "SELECT name FROM worker_state WHERE name='agents' FOR UPDATE",
    );
    const [busy] = await tx.query(
      "SELECT id FROM responsibility_runs WHERE status='running' AND lease_until > $1 LIMIT 1",
      [now],
    );
    if (busy) return null;
    const [row] = await tx.query(
      `SELECT r.id,r.owner_id AS "ownerId",r.responsibility_id AS "responsibilityId",r.responsibility_version AS "responsibilityVersion",r.trigger,r.attempts
       FROM responsibility_runs r JOIN responsibilities p ON p.owner_id=r.owner_id AND p.id=r.responsibility_id
       WHERE r.status='queued' AND (r.not_before IS NULL OR r.not_before <= $1) AND p.template IS NOT NULL
       ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
      [now],
    );
    if (!row) return null;
    const token = randomUUID();
    await tx.query(
      "UPDATE responsibility_runs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=$3,not_before=NULL,version=version+1 WHERE id=$1",
      [row.id, token, new Date(now.getTime() + leaseMs)],
    );
    await activity(
      tx,
      String(row.ownerId),
      String(row.responsibilityId),
      'run-started',
      String(row.id),
    );
    return {
      ...(row as unknown as Omit<Claimed, 'token'>),
      attempts: Number(row.attempts) + 1,
      token,
    };
  });
}

/** A stable operation ID per run attempt, so a replay never calls twice. */
function attemptOperation(runId: string, attempt: number) {
  const hex = createHash('sha256')
    .update(`${runId}:attempt:${attempt}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16]!, 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Puts a run back in the queue for its one retry. */
async function requeue(
  database: Database,
  run: Claimed,
  now: Date,
  turnId: string | null,
) {
  await database.query(
    "UPDATE responsibility_runs SET status='queued',not_before=$3,turn_id=COALESCE($4,turn_id),lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=$1 AND lease_token=$2 AND status='running'",
    [run.id, run.token, new Date(now.getTime() + retryMs), turnId],
  );
}

const providerCode = (turn: AssistantTurn) =>
  `PROVIDER_${(turn.request.reason ?? turn.request.status).toUpperCase().replace(/-/g, '_')}`;

async function execute(
  database: Database,
  config: Config,
  fetcher: OpenRouterFetch,
  run: Claimed,
  clock: () => Date,
) {
  const now = clock();
  const agent = await readAgentRow(database, run.ownerId, run.responsibilityId);
  // Recheck before any hold.
  if (!agent || agent.status !== 'active' || agent.pauseReason)
    return failRun(database, run, agent, 'AGENT_PAUSED', now);
  if (agent.version !== run.responsibilityVersion)
    return failRun(database, run, agent, 'AGENT_CHANGED', now);
  // Goals are sent to OpenRouter: only unlabeled agents run.
  if (
    agent.sensitivity !== 'unlabeled' ||
    agent.labels.some((label) => label !== 'unlabeled')
  )
    return failRun(database, run, agent, 'AGENT_LABELED', now);
  if (
    (await agentSpend(database, run.ownerId, agent.id, now)) >= agent.capMicros
  ) {
    await database.transaction(async (tx) => {
      const [row] = await tx.query(
        "UPDATE responsibility_runs SET status='cancelled',cancel_reason='cap-reached',cancelled_at=$3,lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",
        [run.id, run.token, now],
      );
      if (!row) return;
      await pauseAtCap(tx, run.ownerId, agent.id);
      await notify(
        tx,
        run.ownerId,
        run.id,
        agent.conversationId,
        `${agent.title}: paused at its monthly cap`,
        now,
      );
    });
    return;
  }

  let turn: AssistantTurn;
  try {
    const ownedFetch: OpenRouterFetch = async (url, init) => {
      const current = await readAgentRow(database, run.ownerId, agent.id);
      if (!current || !['active', 'paused'].includes(current.status))
        throw new ApiError(
          409,
          'AGENT_UNAVAILABLE',
          'This agent is unavailable.',
        );
      if (
        current.sensitivity !== 'unlabeled' ||
        current.labels.some((label) => label !== 'unlabeled')
      )
        throw new ApiError(
          409,
          'AGENT_LABELED',
          'This agent is no longer eligible for this provider.',
        );
      // Pause changes the version but intentionally lets the current run finish.
      // A changed goal must never disclose its captured predecessor again.
      if (current.goal !== agent.goal)
        throw new ApiError(
          409,
          'AGENT_CHANGED',
          'This agent changed during its run.',
        );
      await requireLease(database, run, clock());
      return fetcher(url, init);
    };
    turn = await answerTurn(database, config, ownedFetch, run.ownerId, {
      operationId: attemptOperation(run.id, run.attempts),
      prompt: agentPrompt(
        agent,
        Temporal.Instant.fromEpochMilliseconds(now.getTime()),
        agent.timeZone,
      ),
      ask: run.trigger === 'manual' ? 'Run now' : 'Scheduled run',
      timeZone: agent.timeZone,
      conversationId: agent.conversationId,
      useMail: agent.useMail,
      trigger: 'agent',
      agentId: agent.id,
    });
  } catch (error) {
    if (!(error instanceof ApiError))
      return failRun(database, run, agent, 'AGENT_RUN_ERROR', clock());
    if (error.code === 'AGENT_BUDGET_EXCEEDED') {
      return database.transaction(async (tx) => {
        await requireLease(tx, run, clock(), true);
        await failRun(transactionDatabase(tx), run, agent, error.code, clock());
        await pauseAtCap(tx, run.ownerId, agent.id);
      });
    }
    if (retryableCodes.has(error.code) && run.attempts === 1)
      return requeue(database, run, clock(), null);
    return failRun(database, run, agent, error.code, clock());
  }
  if (turn.request.status !== 'completed' || turn.request.reason !== null) {
    const rateLimited =
      turn.request.status === 'failed' &&
      turn.request.reason === 'rate-limited';
    if (rateLimited && run.attempts === 1)
      return requeue(database, run, clock(), turn.id);
    return failRun(database, run, agent, providerCode(turn), clock(), turn.id);
  }

  try {
    await database.transaction(async (tx) => {
      // The run lock, lease predicate, planner receipts/effects, turn items and
      // terminal result share one transaction. A stale worker cannot commit
      // planner changes, even if it completed inference after losing its lease.
      await requireLease(tx, run, clock(), true);
      const counts: RunCounts = await applyByPolicy(
        transactionDatabase(tx),
        run.ownerId,
        turn,
      );
      const outcome: RunOutcome = outcomeOf(counts, turn);
      const finished = clock();
      await activity(tx, run.ownerId, agent.id, 'run-completed', run.id);
      const capped =
        (await agentSpend(tx, run.ownerId, agent.id, finished)) >=
        agent.capMicros;
      if (capped) await pauseAtCap(tx, run.ownerId, agent.id);
      if (outcome !== 'quiet' || capped)
        await notify(
          tx,
          run.ownerId,
          run.id,
          agent.conversationId,
          outcome === 'quiet'
            ? `${agent.title}: paused at its monthly cap`
            : `${notificationTitle(agent.title, outcome, counts)}${capped ? ' · paused at its monthly cap' : ''}`,
          finished,
        );
      // Check the deadline after all potentially blocking effect/receipt work.
      // A failed terminal predicate rolls back the entire transaction.
      const committedAt = clock();
      const [row] = await tx.query(
        "UPDATE responsibility_runs SET status='completed',outcome=$3,turn_id=$4,finished_at=$5,lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until > $5 RETURNING id",
        [run.id, run.token, outcome, turn.id, committedAt],
      );
      if (!row)
        throw new ApiError(
          409,
          'AGENT_LEASE_LOST',
          'This run no longer owns execution.',
        );
    });
  } catch (error) {
    return failRun(
      database,
      run,
      agent,
      error instanceof ApiError && error.code === 'AGENT_LEASE_LOST'
        ? error.code
        : 'AGENT_APPLY_ERROR',
      clock(),
      turn.id,
    );
  }
}

async function requireLease(
  tx: QueryExecutor,
  run: Claimed,
  now: Date,
  lock = false,
) {
  const [row] = await tx.query(
    `SELECT id FROM responsibility_runs WHERE id=$1 AND owner_id=$2 AND status='running' AND lease_token=$3 AND lease_until > $4${lock ? ' FOR UPDATE' : ''}`,
    [run.id, run.ownerId, run.token, now],
  );
  if (!row)
    throw new ApiError(
      409,
      'AGENT_LEASE_LOST',
      'This run no longer owns execution.',
    );
}

async function heartbeat(database: Database, now: Date) {
  await database.query(
    "INSERT INTO worker_state(name,last_tick,error_code) VALUES('agents',$1,NULL) ON CONFLICT (name) DO UPDATE SET last_tick=EXCLUDED.last_tick,error_code=NULL",
    [now],
  );
}

/**
 * One worker pass: fail expired leases, admit due slots, then claim and run
 * at most one queued run. Tests drive it with an explicit `now`.
 */
export async function runAgentTick(
  database: Database,
  config: Config,
  fetcher: OpenRouterFetch,
  now?: Date,
  clock: () => Date = now ? () => now! : () => new Date(),
): Promise<{ admitted: number; ran: string | null }> {
  now = clock();
  await heartbeat(database, now);
  // Liveness is separate from a provider call's latency. Do not renew the
  // execution lease: ten minutes remains an absolute ownership bound.
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(() => heartbeat(database, clock()))
      .catch(() => undefined);
  }, tickMs);
  timer.unref();
  try {
    await failExpiredLeases(database, now);
    const admitted = await admitDue(database, now);
    const run = await claim(database, now);
    if (run) await execute(database, config, fetcher, run, clock);
    await heartbeat(database, clock());
    return { admitted, ran: run?.id ?? null };
  } finally {
    clearInterval(timer);
    await pending;
  }
}

export function startAgentWorker(
  database: Database,
  config: Config,
  fetcher: OpenRouterFetch,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  async function tick() {
    try {
      await runAgentTick(database, config, fetcher);
    } catch {
      await database
        .query(
          "INSERT INTO worker_state (name,last_tick,error_code) VALUES ('agents',CURRENT_TIMESTAMP,'WORKER_FAILED') ON CONFLICT (name) DO UPDATE SET error_code='WORKER_FAILED'",
        )
        .catch(() => undefined);
    }
    if (!stopped)
      timer = setTimeout(() => {
        running = tick();
      }, tickMs);
  }
  running = tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
