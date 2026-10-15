import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentRunsResponseSchema, agentSchema } from '@hub/contracts';
import { admitLive, settleLive } from '../src/ai/live-request.js';
import { runAgentTick } from '../src/features/agent-worker.js';
import { attemptOperation } from '../src/features/agent-operation.js';
import { roundOperation } from '../src/features/assistant.js';
import { answer, rateLimited, startHarness } from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';

let h: Harness;
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden.');
    }),
  ),
);
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await h?.app.close();
});

async function agent(title = 'Synthetic agent') {
  const response = await h.call('POST', '/api/v1/agents', {
    operationId: randomUUID(),
    template: 'daily-plan',
    title,
    goal: 'Private synthetic goal',
    schedule: { frequency: 'daily', times: ['07:00'] },
    useMail: false,
    monthlyCapMicros: 2000000,
    timeZone: 'UTC',
  });
  expect(response.statusCode).toBe(200);
  return agentSchema.parse(response.json().agent);
}
async function queue(a: { id: string; version: number }) {
  const response = await h.call('POST', `/api/v1/agents/${a.id}/run`, {
    operationId: randomUUID(),
    expectedVersion: a.version,
  });
  expect(response.statusCode).toBe(200);
  return response.json().runId as string;
}
async function history(id: string, query = '') {
  const response = await h.call('GET', `/api/v1/agents/${id}/runs${query}`);
  expect(response.statusCode).toBe(200);
  return agentRunsResponseSchema.parse(response.json());
}
const latest = async () =>
  agentSchema.parse((await h.call('GET', '/api/v1/agents')).json().agents[0]);
const request = (a: string, operationId: string, maximumMicros = 300) => ({
  id: randomUUID(),
  operationId,
  kind: 'planner' as const,
  model: 'anthropic/claude-haiku-5.5',
  hash: 'a'.repeat(64),
  maximumMicros,
  withheld: 0,
  agentId: a,
});
const refuse = (r: { id: string }) =>
  settleLive(
    h.database,
    h.owner,
    r.id,
    { status: 'rejected', reason: 'rate-limited' },
    { proposals: 0, dropped: 0 },
    null,
  );

it('shows queued, active progress/lease and completed metadata independently of worker liveness', async () => {
  h = await startHarness();
  const a = await agent();
  const id = await queue(a);
  expect((await latest()).runState).toBe('queued');
  expect((await history(a.id)).runs[0]).toMatchObject({
    id,
    state: 'queued',
    startedAt: null,
    progressAt: null,
    canRetry: false,
  });
  h.state.chat = async () => {
    const running = (await history(a.id)).runs[0]!;
    expect(running).toMatchObject({
      state: 'running',
      startedAt: expect.any(String),
      progressStage: 'provider-request',
      progressAt: expect.any(String),
      leaseExpired: false,
    });
    expect(Date.parse(running.leaseUntil!)).toBeGreaterThan(
      Date.parse(running.startedAt!),
    );
    expect((await h.call('GET', '/api/v1/agents/worker')).json()).toMatchObject(
      { enabled: true, state: 'healthy', healthy: true },
    );
    return answer('Private synthetic reply');
  };
  await runAgentTick(h.database, h.config, h.fetcher);
  const result = await history(a.id);
  expect(result.runs[0]).toMatchObject({
    state: 'completed',
    progressStage: 'finished',
    finishedAt: expect.any(String),
    settledMicros: 123,
    heldMicros: 0,
    canRetry: false,
  });
  expect(JSON.stringify(result)).not.toContain('Private synthetic');
  expect((await latest()).spending).toMatchObject({
    settledMicros: 123,
    heldMicros: 0,
    remainingMicros: 1999877,
  });
});

it('keeps an older running execution visible when a newer run is queued', async () => {
  h = await startHarness();
  const a = await agent();
  const runningId = await queue(a);
  h.state.chat = async () => {
    const queuedId = await queue(a);
    const current = await latest();
    expect(current.runState).toBe('running');
    expect(current.activeRun).toMatchObject({
      id: runningId,
      state: 'running',
      progressStage: 'provider-request',
      leaseUntil: expect.any(String),
    });
    expect(current.lastRun).toMatchObject({ id: queuedId, state: 'queued' });
    return answer('Done.');
  };
  await runAgentTick(h.database, h.config, h.fetcher);
  expect((await latest()).activeRun).toBeNull();
});

it('classifies the actual unset budget admission error as blocked before any exchange', async () => {
  h = await startHarness({ budget: false });
  const a = await agent();
  await queue(a);
  await runAgentTick(h.database, h.config, h.fetcher);
  expect((await history(a.id)).runs[0]).toMatchObject({
    state: 'blocked',
    errorCode: 'BUDGET_UNSET',
    exchangeCount: 0,
    turnId: null,
  });
  expect(h.chatCalls()).toBe(0);
});

it('exposes pre-turn failures, unavailable configuration and unknown legacy timestamps without invented retry safety', async () => {
  h = await startHarness({ key: null });
  const a = await agent();
  await queue(a);
  await runAgentTick(h.database, h.config, h.fetcher);
  expect((await history(a.id)).runs[0]).toMatchObject({
    status: 'failed',
    state: 'blocked',
    errorCode: 'ASSISTANT_NOT_CONFIGURED',
    turnId: null,
    exchangeCount: 0,
    canRetry: false,
  });
  expect((await h.call('GET', '/api/v1/agents/worker')).json()).toMatchObject({
    enabled: false,
    state: 'not-configured',
    disabledReason: 'missing-key',
    healthy: false,
  });
  await h.database.query(
    'UPDATE responsibility_runs SET started_at=NULL,progress_at=NULL,progress_stage=NULL WHERE responsibility_id=$1',
    [a.id],
  );
  const legacy = (await history(a.id)).runs[0]!;
  expect(legacy.startedAt).toBeNull();
  expect(legacy.progressAt).toBeNull();
  expect(legacy.canRetry).toBe(false);
  h.config.AI_SECRET_OPENROUTER = 'synthetic-only';
  expect((await latest()).lastRun!.canRetry).toBe(false);
});

it('preserves retry-scheduled state and permits a new request only after all attempts were confirmed refused', async () => {
  h = await startHarness();
  h.state.chat = rateLimited;
  const a = await agent();
  await queue(a);
  const now = new Date();
  await runAgentTick(h.database, h.config, h.fetcher, now);
  expect((await history(a.id)).runs[0]).toMatchObject({
    status: 'queued',
    state: 'retry-scheduled',
    attempts: 1,
    canRetry: false,
    heldMicros: 0,
  });
  expect((await latest()).runState).toBe('retry-scheduled');
  await runAgentTick(
    h.database,
    h.config,
    h.fetcher,
    new Date(now.getTime() + 15 * 60000),
  );
  expect((await latest()).lastRun).toMatchObject({
    status: 'failed',
    state: 'failed',
    attempts: 2,
    exchangeCount: 2,
    canRetry: true,
    settledMicros: 0,
    heldMicros: 0,
  });
  // History is an inspection surface; it never advertises a replay action.
  expect((await history(a.id)).runs[0]!.canRetry).toBe(false);
  h.config.AGENT_WORKER = 'off';
  expect((await latest()).lastRun!.canRetry).toBe(false);
  h.config.AGENT_WORKER = 'on';
  // Legacy CHECK semantics can permit released/NULL. Unknown is not proof
  // of a confirmed free refusal, even when the held amount is now zero.
  await h.database.query(
    "UPDATE ai_budget_reservations SET actual_micros=NULL WHERE owner_id=$1 AND status='released'",
    [h.owner],
  );
  expect((await latest()).lastRun!.canRetry).toBe(false);
});

it('finds an orphan third-round hold before recordRound or turn creation and never permits retry', async () => {
  h = await startHarness();
  const a = await agent();
  const id = await queue(a);
  const operation = attemptOperation(id, 1);
  for (const op of [operation, roundOperation(operation, 2)]) {
    const r = request(a.id, op);
    await admitLive(h.database, h.owner, r);
    await refuse(r);
  }
  const orphan = request(a.id, roundOperation(operation, 3));
  await admitLive(h.database, h.owner, orphan);
  await h.database.query(
    "UPDATE responsibility_runs SET status='failed',outcome='failed',error_code='PROVIDER_UNCERTAIN',finished_at=CURRENT_TIMESTAMP,started_at=CURRENT_TIMESTAMP,progress_at=CURRENT_TIMESTAMP,progress_stage='finished',attempts=1 WHERE id=$1",
    [id],
  );
  expect((await history(a.id)).runs[0]).toMatchObject({
    state: 'uncertain',
    status: 'failed',
    turnId: null,
    exchangeCount: 3,
    heldMicros: 300,
    uncertainMicros: 300,
    canRetry: false,
  });
  expect((await latest()).lastRun).toMatchObject({
    state: 'uncertain',
    canRetry: false,
  });
  expect((await latest()).spending).toMatchObject({
    settledMicros: 0,
    heldMicros: 300,
    uncertainMicros: 300,
    remainingMicros: 1999700,
  });
  // Current-month allowance and historical uncertainty have separate meanings.
  await h.database.query(
    "UPDATE ai_budget_reservations SET month=(date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-interval '1 month')::date WHERE request_id=$1",
    [orphan.id],
  );
  expect((await latest()).spending).toMatchObject({
    heldMicros: 0,
    remainingMicros: 2000000,
  });
  expect((await history(a.id)).runs[0]!.uncertainMicros).toBe(300);
});

it('refuses retry after a committed planner receipt even when every provider attempt was refused', async () => {
  h = await startHarness();
  h.state.chat = rateLimited;
  const a = await agent();
  await queue(a);
  const now = new Date();
  await runAgentTick(h.database, h.config, h.fetcher, now);
  await runAgentTick(
    h.database,
    h.config,
    h.fetcher,
    new Date(now.getTime() + 15 * 60000),
  );
  const turnId = (await latest()).lastRun!.turnId!;
  expect((await latest()).lastRun!.canRetry).toBe(true);
  const applyId = randomUUID();
  const created = await h.call('POST', '/api/v1/tasks', {
    operationId: applyId,
    title: 'Synthetic effect receipt',
  });
  expect(created.statusCode).toBe(200);
  const item = {
    state: 'proposed',
    applied: null,
    error: null,
    applyId,
    undoId: randomUUID(),
  };
  await h.database.query(
    'UPDATE ai_conversation_turns SET items=$2 WHERE id=$1',
    [turnId, JSON.stringify([item])],
  );
  expect((await latest()).lastRun!.canRetry).toBe(false);
});

it('guards bounded history pagination by parent, version and full timestamp ordering', async () => {
  h = await startHarness();
  const a = await agent();
  const ids = [];
  for (let n = 0; n < 5; n++) ids.push(await queue(a));
  await h.database.query(
    "UPDATE responsibility_runs SET created_at='2026-10-15T00:00:00.123456Z' WHERE responsibility_id=$1",
    [a.id],
  );
  const first = await history(a.id, '?limit=2');
  expect(first.totalCount).toBe(5);
  const cursor = first.nextAfter!;
  const second = await history(
    a.id,
    `?limit=2&after=${cursor.id}&expectedCursorVersion=${cursor.version}`,
  );
  const last = second.nextAfter!;
  const third = await history(
    a.id,
    `?limit=2&after=${last.id}&expectedCursorVersion=${last.version}`,
  );
  expect(
    new Set([...first.runs, ...second.runs, ...third.runs].map((r) => r.id))
      .size,
  ).toBe(5);
  expect(third.nextAfter).toBeNull();
  await h.database.query(
    'UPDATE responsibility_runs SET version=version+1 WHERE id=$1',
    [cursor.id],
  );
  expect(
    (
      await h.call(
        'GET',
        `/api/v1/agents/${a.id}/runs?after=${cursor.id}&expectedCursorVersion=${cursor.version}`,
      )
    ).statusCode,
  ).toBe(409);
  expect(
    (await h.call('GET', `/api/v1/agents/${a.id}/runs?limit=51`)).statusCode,
  ).toBe(400);
  expect(
    (await h.call('GET', `/api/v1/agents/${a.id}/runs?after=${cursor.id}`))
      .statusCode,
  ).toBe(400);
  const b = await agent('Other agent');
  expect(
    (
      await h.call(
        'GET',
        `/api/v1/agents/${b.id}/runs?after=${cursor.id}&expectedCursorVersion=1`,
      )
    ).statusCode,
  ).toBe(404);
  expect(
    (await h.app.inject({ url: `/api/v1/agents/${a.id}/runs` })).statusCode,
  ).toBe(401);
});

it('reports disabled, starting, healthy and stale workers separately from an expired run lease', async () => {
  h = await startHarness();
  expect((await h.call('GET', '/api/v1/agents/worker')).json()).toMatchObject({
    enabled: true,
    state: 'starting',
    healthy: false,
  });
  await h.database.query(
    "INSERT INTO worker_state(name,last_tick) VALUES('agents',CURRENT_TIMESTAMP)",
  );
  expect((await h.call('GET', '/api/v1/agents/worker')).json().state).toBe(
    'healthy',
  );
  const a = await agent();
  const id = await queue(a);
  await h.database.query(
    "UPDATE responsibility_runs SET status='running',attempts=1,lease_token=$2,lease_until=CURRENT_TIMESTAMP-interval '1 second' WHERE id=$1",
    [id, randomUUID()],
  );
  expect((await history(a.id)).runs[0]).toMatchObject({
    state: 'running',
    leaseExpired: true,
  });
  expect((await h.call('GET', '/api/v1/agents/worker')).json().healthy).toBe(
    true,
  );
  h.config.AGENT_WORKER = 'off';
  expect((await h.call('GET', '/api/v1/agents/worker')).json()).toMatchObject({
    enabled: false,
    state: 'disabled',
    disabledReason: 'config',
    healthy: false,
  });
  h.config.AGENT_WORKER = 'on';
  await h.database.query(
    "UPDATE worker_state SET last_tick=CURRENT_TIMESTAMP-interval '2 minutes' WHERE name='agents'",
  );
  expect((await h.call('GET', '/api/v1/agents/worker')).json().state).toBe(
    'unhealthy',
  );
});

it("retains cancelled/deleted-agent run metadata but never exposes another owner's history", async () => {
  h = await startHarness();
  const a = await agent();
  await queue(a);
  const paused = await h.call(
    'POST',
    `/api/v1/responsibilities/${a.id}/pause`,
    { operationId: randomUUID(), expectedVersion: a.version },
  );
  expect(paused.statusCode).toBe(200);
  expect((await history(a.id)).runs[0]!.state).toBe('cancelled');
  const current = await latest();
  expect(
    (
      await h.call('DELETE', `/api/v1/responsibilities/${a.id}`, {
        operationId: randomUUID(),
        expectedVersion: current.version,
      })
    ).statusCode,
  ).toBe(200);
  expect((await history(a.id)).totalCount).toBe(1);
  const otherOwner = randomUUID(),
    otherAgent = randomUUID(),
    conversation = randomUUID();
  await h.database.query(
    'INSERT INTO users(id,email,password_hash) SELECT $1,$2,password_hash FROM users WHERE id=$3',
    [otherOwner, 'other@example.test', h.owner],
  );
  await h.database.query(
    "INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,'Other')",
    [conversation, otherOwner],
  );
  await h.database.query(
    "INSERT INTO responsibilities(id,owner_id,title,goal,sensitivity,labels,template,conversation_id,time_zone) VALUES($1,$2,'Other','Other','unlabeled',ARRAY['unlabeled'],'daily-plan',$3,'UTC')",
    [otherAgent, otherOwner, conversation],
  );
  expect(
    (await h.call('GET', `/api/v1/agents/${otherAgent}/runs`)).statusCode,
  ).toBe(404);
});
