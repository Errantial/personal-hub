import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  Temporal,
  agentResponseSchema,
  agentRunRequestSchema,
  agentRunResponseSchema,
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
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { mutate } from '../planner/mutations.js';
import { stamp } from './common.js';
import { agentSpend } from './agent-run.js';
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
const lastRunColumns = `id,status,outcome,error_code AS "errorCode",${stamp('finished_at', 'finishedAt')},turn_id AS "turnId"`;

/** Agents of an owner (all, or one), as the API returns them. */
export async function readAgents(
  tx: QueryExecutor,
  owner: string,
  id?: string,
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
      `SELECT ${lastRunColumns} FROM responsibility_runs WHERE owner_id=$1 AND responsibility_id=$2 AND status<>'cancelled' ORDER BY created_at DESC,id DESC LIMIT 1`,
      [owner, row.id],
    );
    agents.push(
      agentSchema.parse({
        ...row,
        monthlyCapMicros: Number(row.capMicros),
        spentMicros: await agentSpend(tx, owner, String(row.id)),
        schedule: {
          frequency: rule.frequency,
          ...(rule.frequency === 'weekly'
            ? { weekday: Temporal.PlainDate.from(rule.startDate).dayOfWeek }
            : {}),
          times: rule.times ?? [rule.localTime],
        },
        nextRunAt: row.status === 'active' ? row.nextDueAt : null,
        lastRun: lastRun ?? null,
      }),
    );
  }
  return agents;
}
async function readAgent(tx: QueryExecutor, owner: string, id: string) {
  const [agent] = await readAgents(tx, owner, id);
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
) {
  const base = '/api/v1/agents';

  app.get(base, async (request) => {
    const owner = await auth.requireUser(request);
    return agentsResponseSchema.parse({
      agents: await readAgents(database, owner.id),
    });
  });

  app.get(`${base}/worker`, async (request) => {
    await auth.requireUser(request);
    const [row] = await database.query(
      `SELECT ${stamp('last_tick', 'lastTick')},error_code AS "errorCode" FROM worker_state WHERE name='agents'`,
    );
    return agentWorkerSchema.parse({
      lastTick: row?.lastTick ?? null,
      errorCode: row?.errorCode ?? null,
      healthy:
        !!row?.lastTick &&
        !row.errorCode &&
        Date.now() - Date.parse(String(row.lastTick)) < 90000,
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
          agent: await readAgent(tx, owner.id, id),
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
          agent: await readAgent(tx, owner.id, id),
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
          agent: await readAgent(tx, owner.id, id),
          runId: run.id,
        });
      },
    );
  });
}
