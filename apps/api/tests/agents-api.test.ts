import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  Temporal,
  agentSchema,
  agentTemplates,
  plannerExportSchema,
} from '@hub/contracts';
import type { Agent } from '@hub/contracts';
import { runAgentTick } from '../src/features/agent-worker.js';
import { startHarness } from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';

// Agents API (D57). Synthetic provider only.
let h: Harness;
const zone = 'America/Denver';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in agent tests.');
    }),
  );
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await h?.app.close();
});

const dailyPlan = (fields: Record<string, unknown> = {}) => ({
  operationId: randomUUID(),
  template: 'daily-plan',
  title: agentTemplates['daily-plan'].title,
  goal: agentTemplates['daily-plan'].goal,
  schedule: agentTemplates['daily-plan'].schedule,
  useMail: true,
  monthlyCapMicros: 2000000,
  timeZone: zone,
  ...fields,
});
const create = async (fields: Record<string, unknown> = {}) => {
  const response = await h.call('POST', '/api/v1/agents', dailyPlan(fields));
  expect(response.statusCode).toBe(200);
  return agentSchema.parse(response.json().agent);
};
const update = (agent: Agent, fields: Record<string, unknown>) =>
  h.call('PUT', `/api/v1/agents/${agent.id}`, {
    operationId: randomUUID(),
    expectedVersion: agent.version,
    title: agent.title,
    goal: agent.goal,
    schedule: agent.schedule,
    useMail: agent.useMail,
    monthlyCapMicros: agent.monthlyCapMicros,
    timeZone: agent.timeZone,
    ...fields,
  });
/** The next 07:00 in Denver strictly after now. */
const nextSeven = () => {
  const now = Temporal.Now.zonedDateTimeISO(zone);
  let candidate = now.with({
    hour: 7,
    minute: 0,
    second: 0,
    millisecond: 0,
    microsecond: 0,
    nanosecond: 0,
  });
  if (Temporal.ZonedDateTime.compare(candidate, now) <= 0)
    candidate = candidate.add({ days: 1 });
  return new Date(candidate.epochMilliseconds).toISOString();
};

it('creates an agent whose first run is the next future slot and pins its thread', async () => {
  h = await startHarness();
  const agent = await create();
  expect(agent).toMatchObject({
    template: 'daily-plan',
    status: 'active',
    pauseReason: null,
    spentMicros: 0,
    nextRunAt: nextSeven(),
    lastRun: null,
    schedule: { frequency: 'daily', times: ['07:00'] },
  });
  const conversations = (
    await h.call('GET', '/api/v1/assistant/conversations')
  ).json().conversations;
  expect(conversations).toHaveLength(1);
  expect(conversations[0]).toMatchObject({
    id: agent.conversationId,
    agent: { id: agent.id, title: 'Daily plan', status: 'active' },
  });
  expect(
    (await h.call('GET', '/api/v1/agents'))
      .json()
      .agents.map((item: Agent) => item.id),
  ).toEqual([agent.id]);
  // Nothing is due yet, so a tick runs nothing.
  expect(
    await runAgentTick(h.database, h.config, h.fetcher, new Date()),
  ).toEqual({ admitted: 0, ran: null });
});

it('weekly agents need a weekday and start on it', async () => {
  h = await startHarness();
  const missing = await h.call(
    'POST',
    '/api/v1/agents',
    dailyPlan({ schedule: { frequency: 'weekly', times: ['09:00'] } }),
  );
  expect(missing.statusCode).toBe(400);
  const agent = await create({
    schedule: { frequency: 'weekly', weekday: 3, times: ['09:00'] },
  });
  const next = Temporal.Instant.from(agent.nextRunAt!).toZonedDateTimeISO(zone);
  expect(next.dayOfWeek).toBe(3);
  expect(next.hour).toBe(9);
  expect(agent.schedule).toEqual({
    frequency: 'weekly',
    weekday: 3,
    times: ['09:00'],
  });
});

it('edits cancel queued runs and raising the cap resumes a cap-reached agent', async () => {
  h = await startHarness();
  const agent = await create();
  const queued = await h.call('POST', `/api/v1/agents/${agent.id}/run`, {
    operationId: randomUUID(),
    expectedVersion: agent.version,
  });
  expect(queued.statusCode).toBe(200);
  const runId = queued.json().runId;
  const edited = await update(agent, { goal: 'A new goal' });
  expect(edited.statusCode).toBe(200);
  const [run] = await h.database.query(
    'SELECT status,cancel_reason FROM responsibility_runs WHERE id=$1',
    [runId],
  );
  expect(run).toEqual({ status: 'cancelled', cancel_reason: 'source-changed' });
  await h.database.query(
    "UPDATE responsibilities SET status='paused',pause_reason='cap-reached' WHERE id=$1",
    [agent.id],
  );
  const paused = agentSchema.parse(
    (await h.call('GET', '/api/v1/agents')).json().agents[0],
  );
  expect(paused).toMatchObject({
    status: 'paused',
    pauseReason: 'cap-reached',
  });
  const blocked = await h.call('POST', `/api/v1/agents/${agent.id}/run`, {
    operationId: randomUUID(),
    expectedVersion: paused.version,
  });
  expect(blocked.json().error.code).toBe('AGENT_PAUSED');
  const raised = await update(paused, { monthlyCapMicros: 5000000 });
  expect(agentSchema.parse(raised.json().agent)).toMatchObject({
    status: 'active',
    pauseReason: null,
    monthlyCapMicros: 5000000,
    nextRunAt: nextSeven(),
  });
});

it('Run now queues a manual run that the next tick answers as a run turn', async () => {
  h = await startHarness();
  const agent = await create({ useMail: false });
  const queued = await h.call('POST', `/api/v1/agents/${agent.id}/run`, {
    operationId: randomUUID(),
    expectedVersion: agent.version,
  });
  expect(queued.json().agent.lastRun).toMatchObject({ status: 'queued' });
  await runAgentTick(h.database, h.config, h.fetcher, new Date());
  const listed = agentSchema.parse(
    (await h.call('GET', '/api/v1/agents')).json().agents[0],
  );
  expect(listed.lastRun).toMatchObject({
    status: 'completed',
    outcome: 'quiet',
  });
  expect(listed.spentMicros).toBe(123);
  const thread = (
    await h.call(
      'GET',
      `/api/v1/assistant/conversations/${agent.conversationId}`,
    )
  ).json();
  expect(thread.turns).toHaveLength(1);
  expect(thread.turns[0]).toMatchObject({
    id: listed.lastRun!.turnId,
    ask: 'Run now',
    trigger: 'agent',
  });
});

it('keeps the pinned thread until the agent is deleted, then unpins it', async () => {
  h = await startHarness();
  const agent = await create();
  const refused = await h.call(
    'DELETE',
    `/api/v1/assistant/conversations/${agent.conversationId}`,
    { expectedVersion: 1 },
  );
  expect(refused.json().error.code).toBe('AGENT_CONVERSATION');
  const deleted = await h.call(
    'DELETE',
    `/api/v1/responsibilities/${agent.id}`,
    { operationId: randomUUID(), expectedVersion: agent.version },
  );
  expect(deleted.statusCode).toBe(200);
  expect((await h.call('GET', '/api/v1/agents')).json().agents).toEqual([]);
  const thread = await h.call(
    'GET',
    `/api/v1/assistant/conversations/${agent.conversationId}`,
  );
  expect(thread.statusCode).toBe(200);
  expect(thread.json().conversation.agent).toBeNull();
});

it('resuming a paused agent starts at the next future slot without back-filling', async () => {
  h = await startHarness();
  const agent = await create();
  const paused = await h.call(
    'POST',
    `/api/v1/responsibilities/${agent.id}/pause`,
    { operationId: randomUUID(), expectedVersion: agent.version },
  );
  expect(paused.statusCode).toBe(200);
  // Pretend the pause lasted days: the stored slot is in the past.
  await h.database.query(
    "UPDATE responsibility_schedules SET starts_at=starts_at - interval '3 days',next_due_at=next_due_at - interval '3 days' WHERE responsibility_id=$1",
    [agent.id],
  );
  await h.call('POST', `/api/v1/responsibilities/${agent.id}/resume`, {
    operationId: randomUUID(),
    expectedVersion: paused.json().responsibility.version,
  });
  const resumed = (await h.call('GET', '/api/v1/agents')).json().agents[0];
  expect(resumed.nextRunAt).toBe(nextSeven());
  expect(
    (await runAgentTick(h.database, h.config, h.fetcher, new Date())).admitted,
  ).toBe(0);
});

it('rejects goals over 2000 characters, unknown IDs and non-agent responsibilities', async () => {
  h = await startHarness();
  expect(
    (
      await h.call(
        'POST',
        '/api/v1/agents',
        dailyPlan({ goal: 'x'.repeat(2001) }),
      )
    ).statusCode,
  ).toBe(400);
  const plain = (
    await h.call('POST', '/api/v1/responsibilities', {
      operationId: randomUUID(),
      title: 'Plain review',
      goal: 'Review',
    })
  ).json().responsibility;
  for (const id of [randomUUID(), plain.id]) {
    const response = await h.call('PUT', `/api/v1/agents/${id}`, {
      operationId: randomUUID(),
      expectedVersion: 1,
      title: 'x',
      goal: 'x',
      schedule: { frequency: 'daily', times: ['07:00'] },
      useMail: false,
      monthlyCapMicros: 2000000,
      timeZone: zone,
    });
    expect(response.statusCode).toBe(404);
  }
});

it('exports agent fields and run outcomes, and lists agent notifications', async () => {
  h = await startHarness();
  const agent = await create({ useMail: false });
  const exported = plannerExportSchema.parse(
    (await h.call('GET', '/api/v1/planner/export')).json(),
  );
  expect(exported.records.agents).toEqual([
    {
      id: agent.id,
      template: 'daily-plan',
      conversationId: agent.conversationId,
      timeZone: zone,
      useMail: false,
      monthlyCapMicros: 2000000,
      pauseReason: null,
    },
  ]);
  expect(exported.records.responsibilities[0]!.id).toBe(agent.id);
});

it('reports worker health', async () => {
  h = await startHarness();
  expect((await h.call('GET', '/api/v1/agents/worker')).json()).toMatchObject({
    lastTick: null,
    errorCode: null,
    healthy: false,
  });
  await runAgentTick(h.database, h.config, h.fetcher, new Date());
  expect((await h.call('GET', '/api/v1/agents/worker')).json()).toMatchObject({
    errorCode: null,
    healthy: true,
  });
});

it('refuses legacy responsibility edits on agents so their rules hold', async () => {
  h = await startHarness();
  const agent = await create();
  const change = { operationId: randomUUID(), expectedVersion: agent.version };
  const responses = [
    await h.call('PUT', `/api/v1/responsibilities/${agent.id}`, {
      ...change,
      title: agent.title,
      goal: agent.goal,
      sensitivity: 'restricted',
    }),
    await h.call('PUT', `/api/v1/responsibilities/${agent.id}/schedule`, {
      ...change,
      operationId: randomUUID(),
      schedule: null,
    }),
    await h.call('PUT', `/api/v1/responsibilities/${agent.id}/local-schedule`, {
      ...change,
      operationId: randomUUID(),
      rule: {
        startDate: '2020-01-01',
        localTime: '07:00',
        timeZone: zone,
        frequency: 'daily',
      },
    }),
  ];
  for (const response of responses)
    expect(response.json().error.code).toBe('AGENT_USE_AGENT_API');
  expect((await h.call('GET', '/api/v1/agents')).json().agents).toHaveLength(1);
});
