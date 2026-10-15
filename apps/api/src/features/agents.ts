import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  Temporal,
  agentResponseSchema,
  agentRunRequestSchema,
  agentRunResponseSchema,
  agentRunsQuerySchema,
  agentRunsResponseSchema,
  agentSchema,
  agentUpdateSchema,
  agentWorkerSchema,
  agentWriteSchema,
  agentsResponseSchema,
  responsibilityLocalRuleSchema,
} from '@hub/contracts';
import type {
  Agent,
  AgentSchedule,
  ResponsibilityLocalRule,
} from '@hub/contracts';
import type { authService } from '../auth/routes.js';
import type { Config } from '../config.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { mutate } from '../planner/mutations.js';
import { stamp, version } from './common.js';
import { agentSpend } from './agent-run.js';
import {
  agentRunColumns,
  describeAgentRun,
  readAgentSpending,
} from './agent-status.js';
import {
  appendResponsibilityActivity,
  cancelResponsibilityRuns,
  createResponsibilityRun,
  readResponsibility,
} from './responsibilities.js';
import { firstSlotAfter } from './responsibility-local-cadence.js';

// Agents API (D57): an agent is a responsibility with a template, a pinned
// Assistant conversation and a local schedule. Pause, resume and delete use
// the responsibility endpoints.

const ids = z.object({ id: z.string().uuid() });
const notFound = () =>
  new ApiError(404, 'NOT_FOUND', 'This agent no longer exists.');

/** The stored local rule for an agent schedule, starting today (or on the weekday). */
export function agentRule(
  schedule: AgentSchedule,
  timeZone: string,
  now: number,
): ResponsibilityLocalRule {
  let start = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  if (schedule.frequency === 'weekly')
    start = start.add({ days: (schedule.weekday! - start.dayOfWeek + 7) % 7 });
  return responsibilityLocalRuleSchema.parse({
    startDate: start.toString(),
    localTime: schedule.times[0],
    times: schedule.times,
    timeZone,
    frequency: schedule.frequency,
    interval: 1,
  });
}

/** Points the schedule at the first future slot (no back-fill). */
export async function scheduleFromNow(
  tx: QueryExecutor,
  owner: string,
  id: string,
  rule: ResponsibilityLocalRule,
  now: number,
) {
  const first = firstSlotAfter(rule, now);
  if (!first)
    throw new ApiError(
      400,
      'AGENT_SCHEDULE_RANGE',
      'Choose a supported schedule.',
    );
  await tx.query(
    `INSERT INTO responsibility_schedules(owner_id,responsibility_id,starts_at,interval_minutes,next_due_at,local_rule,next_local_index) VALUES($1,$2,$3,NULL,$3,$4::jsonb,$5)
     ON CONFLICT(owner_id,responsibility_id) DO UPDATE SET starts_at=$3,interval_minutes=NULL,next_due_at=$3,local_rule=$4::jsonb,next_local_index=$5,deleted_at=NULL,version=responsibility_schedules.version+1,updated_at=CURRENT_TIMESTAMP`,
    [owner, id, first.at, JSON.stringify(rule), first.index],
  );
}

const agentColumns = `r.id,r.version,r.template,r.title,r.goal,r.status,r.pause_reason AS "pauseReason",r.use_mail AS "useMail",r.monthly_cap_micros::text AS "capMicros",r.time_zone AS "timeZone",r.conversation_id AS "conversationId",s.local_rule AS "localRule",${stamp('s.next_due_at', 'nextDueAt')}`;

/** Agents of an owner (all, or one), as the API returns them. */
export async function readAgents(
  tx: QueryExecutor,
  owner: string,
  id?: string,
  allowNewRun = false,
): Promise<Agent[]> {
  const rows = await tx.query(
    `SELECT ${agentColumns} FROM responsibilities r LEFT JOIN responsibility_schedules s ON s.owner_id=r.owner_id AND s.responsibility_id=r.id AND s.deleted_at IS NULL
     WHERE r.owner_id=$1 AND r.template IS NOT NULL AND r.deleted_at IS NULL AND r.status<>'cancelled'${id ? ' AND r.id=$2' : ''} ORDER BY r.title,r.id`,
    id ? [owner, id] : [owner],
  );
  const agents: Agent[] = [];
  for (const row of rows) {
    const rule = responsibilityLocalRuleSchema.parse(
      typeof row.localRule === 'string'
        ? JSON.parse(row.localRule)
        : row.localRule,
    );
    const [lastRun] = await tx.query(
      `SELECT ${agentRunColumns} FROM responsibility_runs WHERE owner_id=$1 AND responsibility_id=$2 AND status<>'cancelled' ORDER BY created_at DESC,id DESC LIMIT 1`,
      [owner, row.id],
    );
    const spending = await readAgentSpending(
      tx,
      owner,
      String(row.id),
      Number(row.capMicros),
    );
    const run = lastRun
      ? await describeAgentRun(
          tx,
          owner,
          lastRun,
          new Date().toISOString(),
          allowNewRun && row.status === 'active',
        )
      : null;
    const activeRow =
      lastRun?.status === 'running'
        ? lastRun
        : (
            await tx.query(
              `SELECT ${agentRunColumns} FROM responsibility_runs WHERE owner_id=$1 AND responsibility_id=$2 AND status='running' ORDER BY lease_until DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`,
              [owner, row.id],
            )
          )[0];
    const activeRun = activeRow
      ? activeRow.id === run?.id
        ? run
        : await describeAgentRun(tx, owner, activeRow, new Date().toISOString())
      : null;
    agents.push(
      agentSchema.parse({
        ...row,
        monthlyCapMicros: Number(row.capMicros),
        spentMicros: await agentSpend(tx, owner, String(row.id)),
        spending,
        activeRun,
        runState: activeRun
          ? activeRun.state
          : row.pauseReason === 'cap-reached'
            ? 'cap-paused'
            : row.status === 'paused'
              ? 'paused'
              : (run?.state ?? 'idle'),
        schedule: {
          frequency: rule.frequency,
          ...(rule.frequency === 'weekly'
            ? { weekday: Temporal.PlainDate.from(rule.startDate).dayOfWeek }
            : {}),
          times: rule.times ?? [rule.localTime],
        },
        nextRunAt: row.status === 'active' ? row.nextDueAt : null,
        lastRun: run,
      }),
    );
  }
  return agents;
}
async function readAgent(
  tx: QueryExecutor,
  owner: string,
  id: string,
  allowNewRun = false,
) {
  const [agent] = await readAgents(tx, owner, id, allowNewRun);
  if (!agent) throw notFound();
  return agent;
}
/** Locks an agent's responsibility row and checks its version. */
async function lockAgent(
  tx: QueryExecutor,
  owner: string,
  id: string,
  expectedVersion: number,
) {
  const [row] = await tx.query(
    'SELECT r.version,r.status,r.pause_reason AS "pauseReason",s.local_rule AS "localRule",r.time_zone AS "timeZone" FROM responsibilities r LEFT JOIN responsibility_schedules s ON s.owner_id=r.owner_id AND s.responsibility_id=r.id WHERE r.owner_id=$1 AND r.id=$2 AND r.template IS NOT NULL AND r.deleted_at IS NULL AND r.status<>\'cancelled\' FOR UPDATE OF r',
    [owner, id],
  );
  if (!row) throw notFound();
  if (row.version !== expectedVersion)
    throw new ApiError(
      409,
      'VERSION_CONFLICT',
      'This agent changed. Reload it first.',
    );
  return row;
}

export function registerAgents(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
  config: Config,
) {
  const base = '/api/v1/agents';
  const allowNewRun = () =>
    config.AGENT_WORKER === 'on' && !!config.AI_SECRET_OPENROUTER;

  app.get(base, async (request) => {
    const owner = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      return agentsResponseSchema.parse({
        agents: await readAgents(tx, owner.id, undefined, allowNewRun()),
      });
    });
  });

  app.get(`${base}/worker`, async (request) => {
    await auth.requireUser(request);
    const [row] = await database.query(
      `SELECT ${stamp('last_tick', 'lastTick')},error_code AS "errorCode" FROM worker_state WHERE name='agents'`,
    );
    const disabledReason =
      config.AGENT_WORKER === 'off'
        ? 'config'
        : !config.AI_SECRET_OPENROUTER
          ? 'missing-key'
          : null;
    const enabled = disabledReason === null;
    const asOf = new Date().toISOString();
    const age = row?.lastTick
      ? Date.parse(asOf) - Date.parse(String(row.lastTick))
      : null;
    const healthy =
      enabled && age !== null && age >= -5000 && age < 90000 && !row?.errorCode;
    return agentWorkerSchema.parse({
      enabled,
      disabledReason,
      asOf,
      state:
        disabledReason === 'config'
          ? 'disabled'
          : disabledReason === 'missing-key'
            ? 'not-configured'
            : !row?.lastTick
              ? 'starting'
              : healthy
                ? 'healthy'
                : 'unhealthy',
      lastTick: row?.lastTick ?? null,
      errorCode: row?.errorCode ?? null,
      healthy,
    });
  });

  app.get(`${base}/:id/runs`, async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = ids.parse(request.params);
    const input = agentRunsQuerySchema.parse(request.query);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      // Tombstoned agents retain owned metadata/history; their text is never
      // returned here. Never accept a cross-owner parent or cursor.
      const [parent] = await tx.query(
        'SELECT id FROM responsibilities WHERE owner_id=$1 AND id=$2 AND template IS NOT NULL',
        [owner.id, id],
      );
      if (!parent) throw notFound();
      const [time] = await tx.query(
        `SELECT ${stamp('CURRENT_TIMESTAMP', 'asOf')}`,
      );
      const asOf = String(time!.asOf);
      let cursorTime: unknown = null;
      if (input.after) {
        const [anchor] = await tx.query(
          `SELECT version,${stamp('created_at', 'cursorTime').replace('.MS', '.US')} FROM responsibility_runs WHERE owner_id=$1 AND responsibility_id=$2 AND id=$3`,
          [owner.id, id, input.after],
        );
        if (!anchor)
          throw new ApiError(404, 'NOT_FOUND', 'Run cursor is unavailable.');
        version(anchor, input.expectedCursorVersion);
        cursorTime = anchor.cursorTime;
      }
      const [summary] = await tx.query(
        'SELECT count(*)::int AS total FROM responsibility_runs WHERE owner_id=$1 AND responsibility_id=$2',
        [owner.id, id],
      );
      const rows = await tx.query(
        `SELECT ${agentRunColumns} FROM responsibility_runs WHERE owner_id=$1 AND responsibility_id=$2 AND ($3::uuid IS NULL OR (created_at,id)<($4::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5`,
        [owner.id, id, input.after ?? null, cursorTime, input.limit + 1],
      );
      const runs = [];
      for (const row of rows.slice(0, input.limit))
        runs.push(await describeAgentRun(tx, owner.id, row, asOf));
      const last = rows[input.limit - 1];
      return agentRunsResponseSchema.parse({
        asOf,
        runs,
        totalCount: summary!.total,
        nextAfter:
          rows.length > input.limit && last
            ? { id: last.id, version: last.version }
            : null,
      });
    });
  });

  app.post(base, async (request) => {
    const owner = await auth.requireUser(request);
    const input = agentWriteSchema.parse(request.body);
    return mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'agent.create', input },
      async (tx) => {
        const id = randomUUID();
        const conversationId = randomUUID();
        await tx.query(
          'INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,$3)',
          [conversationId, owner.id, input.title.slice(0, 80)],
        );
        // Agent goals are sent to OpenRouter, so agents are unlabeled.
        await tx.query(
          `INSERT INTO responsibilities(id,owner_id,title,goal,sensitivity,labels,status,template,conversation_id,time_zone,use_mail,monthly_cap_micros)
           VALUES($1,$2,$3,$4,'unlabeled',ARRAY['unlabeled'],'active',$5,$6,$7,$8,$9)`,
          [
            id,
            owner.id,
            input.title,
            input.goal,
            input.template,
            conversationId,
            input.timeZone,
            input.useMail,
            input.monthlyCapMicros,
          ],
        );
        await tx.query(
          'UPDATE ai_conversations SET responsibility_id=$1 WHERE id=$2',
          [id, conversationId],
        );
        await scheduleFromNow(
          tx,
          owner.id,
          id,
          agentRule(input.schedule, input.timeZone, Date.now()),
          Date.now(),
        );
        const value = await readResponsibility(tx, owner.id, id);
        for (const kind of ['created', 'schedule-set', 'resumed'] as const)
          await appendResponsibilityActivity(tx, owner.id, value, kind);
        return agentResponseSchema.parse({
          agent: await readAgent(tx, owner.id, id, allowNewRun()),
        });
      },
    );
  });

  app.put(`${base}/:id`, async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = ids.parse(request.params);
    const input = agentUpdateSchema.parse(request.body);
    return mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'agent.update', id, input },
      async (tx) => {
        const before = await lockAgent(tx, owner.id, id, input.expectedVersion);
        const now = Date.now();
        const rule = agentRule(input.schedule, input.timeZone, now);
        const previous =
          typeof before.localRule === 'string'
            ? JSON.parse(before.localRule)
            : before.localRule;
        // Same slots in the same zone: keep the schedule position.
        const same = (value: ResponsibilityLocalRule | null) =>
          value &&
          JSON.stringify([
            value.frequency,
            value.timeZone,
            value.times ?? [value.localTime],
            value.frequency === 'weekly'
              ? Temporal.PlainDate.from(value.startDate).dayOfWeek
              : null,
          ]);
        const scheduleChanged = same(previous) !== same(rule);
        // A raised cap lifts a cap pause; the owner's own pause stays.
        const resume =
          before.pauseReason === 'cap-reached' &&
          input.monthlyCapMicros > (await agentSpend(tx, owner.id, id));
        await tx.query(
          `UPDATE responsibilities SET title=$3,goal=$4,use_mail=$5,monthly_cap_micros=$6,time_zone=$7,
             status=CASE WHEN $8 THEN 'active' ELSE status END,pause_reason=CASE WHEN $8 THEN NULL ELSE pause_reason END,
             version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2`,
          [
            owner.id,
            id,
            input.title,
            input.goal,
            input.useMail,
            input.monthlyCapMicros,
            input.timeZone,
            resume,
          ],
        );
        await tx.query(
          'UPDATE ai_conversations SET title=$3 WHERE owner_id=$1 AND responsibility_id=$2',
          [owner.id, id, input.title.slice(0, 80)],
        );
        if (scheduleChanged || resume)
          await scheduleFromNow(tx, owner.id, id, rule, now);
        const value = await readResponsibility(tx, owner.id, id);
        await cancelResponsibilityRuns(
          tx,
          owner.id,
          value,
          scheduleChanged ? 'schedule-changed' : 'source-changed',
        );
        await appendResponsibilityActivity(tx, owner.id, value, 'updated');
        if (scheduleChanged)
          await appendResponsibilityActivity(
            tx,
            owner.id,
            value,
            'schedule-set',
          );
        if (resume)
          await appendResponsibilityActivity(tx, owner.id, value, 'resumed');
        return agentResponseSchema.parse({
          agent: await readAgent(tx, owner.id, id, allowNewRun()),
        });
      },
    );
  });

  app.post(`${base}/:id/run`, async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = ids.parse(request.params);
    const input = agentRunRequestSchema.parse(request.body);
    return mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'agent.run', id, input },
      async (tx) => {
        const before = await lockAgent(tx, owner.id, id, input.expectedVersion);
        if (before.status !== 'active')
          throw new ApiError(
            409,
            'AGENT_PAUSED',
            before.pauseReason === 'cap-reached'
              ? 'This agent reached its monthly cap. Raise the cap to run it.'
              : 'Resume this agent to run it.',
          );
        const value = await readResponsibility(tx, owner.id, id);
        const run = await createResponsibilityRun(tx, owner.id, value, null);
        return agentRunResponseSchema.parse({
          agent: await readAgent(tx, owner.id, id, allowNewRun()),
          runId: run.id,
        });
      },
    );
  });
}
