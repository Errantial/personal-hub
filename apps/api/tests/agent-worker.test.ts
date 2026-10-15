import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Temporal, responsibilityLocalRuleSchema } from '@hub/contracts';
import { runAgentTick } from '../src/features/agent-worker.js';
import { localReviewSlot } from '../src/features/responsibility-local-cadence.js';
import {
  action,
  answer,
  rateLimited,
  startHarness,
} from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';

// Agent worker (D57): admission, claim, rechecks, execution and finish.
// Every tick gets an explicit `now`; nothing reaches the network.
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

const minutes = (count: number, from = new Date()) =>
  new Date(from.getTime() + count * 60000);
const tick = (now = new Date()) =>
  runAgentTick(h.database, h.config, h.fetcher, now);

/** An active agent whose first slot is `daysAgo` days ago at 00:05 local. */
async function seedAgent(
  options: { title?: string; daysAgo?: number; cap?: number } = {},
) {
  const id = randomUUID();
  const conversationId = randomUUID();
  const startDate = Temporal.Now.plainDateISO(zone)
    .subtract({ days: options.daysAgo ?? 0 })
    .toString();
  const rule = responsibilityLocalRuleSchema.parse({
    startDate,
    localTime: '00:05',
    timeZone: zone,
    frequency: 'daily',
  });
  const title = options.title ?? 'Daily plan';
  await h.database.query(
    'INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,$3)',
    [conversationId, h.owner, title],
  );
  await h.database.query(
    "INSERT INTO responsibilities(id,owner_id,title,goal,sensitivity,labels,status,template,conversation_id,time_zone,monthly_cap_micros) VALUES($1,$2,$3,'Plan my day','unlabeled',ARRAY['unlabeled'],'active','daily-plan',$4,$5,$6)",
    [id, h.owner, title, conversationId, zone, options.cap ?? 2000000],
  );
  await h.database.query(
    'UPDATE ai_conversations SET responsibility_id=$1 WHERE id=$2',
    [id, conversationId],
  );
  const first = localReviewSlot(rule, 0)!;
  await h.database.query(
    'INSERT INTO responsibility_schedules(owner_id,responsibility_id,starts_at,next_due_at,local_rule,next_local_index) VALUES($1,$2,$3,$3,$4::jsonb,0)',
    [h.owner, id, first, JSON.stringify(rule)],
  );
  return { id, conversationId, title };
}
/** A queued Run now run at the agent's current version. */
async function queueRun(agent: { id: string }) {
  const runId = randomUUID();
  await h.database.query(
    "INSERT INTO responsibility_runs(id,owner_id,responsibility_id,responsibility_version,trigger,input_hash,labels,status) SELECT $1,owner_id,id,version,'manual',$3,labels,'queued' FROM responsibilities WHERE id=$2",
    [runId, agent.id, 'b'.repeat(64)],
  );
  return runId;
}
const run = async (id: string) =>
  (
    await h.database.query(
      'SELECT status,outcome,error_code,cancel_reason,not_before,turn_id,attempts,skipped_intervals FROM responsibility_runs WHERE id=$1',
      [id],
    )
  )[0]!;
const runs = (agent: { id: string }) =>
  h.database.query(
    'SELECT id,status,outcome,error_code,cancel_reason,skipped_intervals FROM responsibility_runs WHERE responsibility_id=$1 ORDER BY created_at',
    [agent.id],
  );
const agentRow = async (agent: { id: string }) =>
  (
    await h.database.query(
      'SELECT status,pause_reason,version FROM responsibilities WHERE id=$1',
      [agent.id],
    )
  )[0]!;
const notifications = () =>
  h.database.query(
    'SELECT title,run_id,conversation_id,reminder_id FROM notifications ORDER BY created_at',
  );
const reservations = () =>
  h.database.query('SELECT status FROM ai_budget_reservations');

it('admits a due slot once and coalesces missed slots into one run', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: 3 });
  const now = new Date();
  expect((await tick(now)).admitted).toBe(1);
  expect((await tick(now)).admitted).toBe(0);
  const all = await runs(agent);
  expect(all).toHaveLength(1);
  expect(all[0]!.skipped_intervals).toBeGreaterThanOrEqual(2);
  expect(all[0]!.status).toBe('completed');
});

it('runs one at a time and fails an expired lease without resending', async () => {
  h = await startHarness();
  const first = await seedAgent({ title: 'First' });
  const second = await seedAgent({ title: 'Second' });
  const now = new Date();
  const result = await tick(now);
  expect(result.admitted).toBe(2);
  expect(result.ran).not.toBeNull();
  const queued = [...(await runs(first)), ...(await runs(second))].find(
    (row) => row.status === 'queued',
  )!;
  expect(queued).toBeTruthy();
  // Another worker holds a live lease: nothing else is claimed.
  await h.database.query(
    "UPDATE responsibility_runs SET status='running',lease_token=$2,lease_until=$3,attempts=1 WHERE id=$1",
    [queued.id, randomUUID(), minutes(10, now)],
  );
  const calls = h.chatCalls();
  expect((await tick(minutes(1, now))).ran).toBeNull();
  // After a restart the lease expires: failed, notified, never resent.
  await tick(minutes(11, now));
  expect(await run(String(queued.id))).toMatchObject({
    status: 'failed',
    outcome: 'failed',
    error_code: 'LEASE_EXPIRED',
  });
  expect(h.chatCalls()).toBe(calls);
  expect(
    (await notifications()).find((row) => row.run_id === queued.id),
  ).toMatchObject({ title: expect.stringContaining('run failed') });
});

it('rechecks the agent version and cap before any hold', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -1 });
  const changed = await queueRun(agent);
  await h.database.query(
    'UPDATE responsibilities SET version=version+1 WHERE id=$1',
    [agent.id],
  );
  await tick();
  expect(await run(changed)).toMatchObject({
    status: 'failed',
    error_code: 'AGENT_CHANGED',
  });
  // One completed run spends 123 micros; a cap of 100 then stops the next.
  const spender = await queueRun(agent);
  await tick();
  expect((await run(spender)).status).toBe('completed');
  const blocked = await queueRun(agent);
  await h.database.query(
    'UPDATE responsibilities SET monthly_cap_micros=100 WHERE id=$1',
    [agent.id],
  );
  const calls = h.chatCalls();
  const held = (await reservations()).length;
  await tick();
  expect(await run(blocked)).toMatchObject({
    status: 'cancelled',
    cancel_reason: 'cap-reached',
  });
  expect(await agentRow(agent)).toMatchObject({
    status: 'paused',
    pause_reason: 'cap-reached',
  });
  expect(h.chatCalls()).toBe(calls);
  expect(await reservations()).toHaveLength(held);
});

it('fails without a hold when the key is missing or the model is not private', async () => {
  h = await startHarness({ key: null });
  const agent = await seedAgent({ daysAgo: -1 });
  const missing = await queueRun(agent);
  await tick();
  expect(await run(missing)).toMatchObject({
    status: 'failed',
    error_code: 'ASSISTANT_NOT_CONFIGURED',
  });
  await h.app.close();
  h = await startHarness();
  const other = await seedAgent({ daysAgo: -1 });
  await h.database.query(
    "INSERT INTO ai_assistant_settings(owner_id,model) VALUES($1,'anthropic/claude-not-private')",
    [h.owner],
  );
  const notPrivate = await queueRun(other);
  await tick();
  expect(await run(notPrivate)).toMatchObject({
    status: 'failed',
    error_code: 'ASSISTANT_MODEL_NOT_PRIVATE',
  });
  expect(await reservations()).toHaveLength(0);
  expect(h.chatCalls()).toBe(0);
});

it('retries a rate limit once, 15 minutes later', async () => {
  h = await startHarness();
  h.state.chat = rateLimited;
  const agent = await seedAgent({ daysAgo: -1 });
  const id = await queueRun(agent);
  const now = new Date();
  await tick(now);
  const queued = await run(id);
  expect(queued.status).toBe('queued');
  expect(new Date(queued.not_before as string | Date).getTime()).toBe(
    minutes(15, now).getTime(),
  );
  expect((await tick(minutes(14, now))).ran).toBeNull();
  await tick(minutes(15, now));
  expect(await run(id)).toMatchObject({
    status: 'failed',
    error_code: 'PROVIDER_RATE_LIMITED',
    attempts: 2,
  });
  expect(h.chatCalls()).toBe(2);
});

it('never resends an uncertain outcome and keeps its hold', async () => {
  h = await startHarness();
  h.state.chat = () => {
    throw new Error('connection reset');
  };
  const agent = await seedAgent({ daysAgo: -1 });
  const id = await queueRun(agent);
  const now = new Date();
  await tick(now);
  expect(await run(id)).toMatchObject({ status: 'failed', outcome: 'failed' });
  await tick(minutes(20, now));
  await tick(minutes(40, now));
  expect(h.chatCalls()).toBe(1);
  expect((await reservations()).map((row) => row.status)).toEqual([
    'uncertain',
  ]);
});

it('finishes a running run after the owner pauses the agent', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -1 });
  const id = await queueRun(agent);
  h.state.chat = async () => {
    const { version } = await agentRow(agent);
    const paused = await h.call(
      'POST',
      `/api/v1/responsibilities/${agent.id}/pause`,
      { operationId: randomUUID(), expectedVersion: version },
    );
    expect(paused.statusCode).toBe(200);
    return answer('Here is your plan.');
  };
  await tick();
  const finished = await run(id);
  expect(finished).toMatchObject({ status: 'completed', outcome: 'quiet' });
  const conversation = (
    await h.call(
      'GET',
      `/api/v1/assistant/conversations/${agent.conversationId}`,
    )
  ).json();
  expect(conversation.turns[0]).toMatchObject({
    id: finished.turn_id,
    trigger: 'agent',
    ask: 'Run now',
  });
});

it('notifies only when a run needs the owner', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -1 });
  await queueRun(agent);
  await tick();
  expect(await notifications()).toHaveLength(0);
  h.state.chat = () =>
    answer('One task to add.', [
      action({ type: 'task.create', title: 'Submit form' }),
    ]);
  const id = await queueRun(agent);
  await tick();
  expect(await run(id)).toMatchObject({ outcome: 'needs-approval' });
  expect(await notifications()).toEqual([
    {
      title: 'Daily plan: 1 change to review',
      run_id: id,
      conversation_id: agent.conversationId,
      reminder_id: null,
    },
  ]);
  const listed = (await h.call('GET', '/api/v1/notifications')).json()
    .notifications[0];
  expect(listed).toMatchObject({
    runId: id,
    conversationId: agent.conversationId,
    reminderId: null,
  });
});

it('pauses at the monthly cap and does not resume at the next month', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -1, cap: 100 });
  const id = await queueRun(agent);
  const now = new Date();
  await tick(now);
  expect((await run(id)).status).toBe('completed');
  expect(await agentRow(agent)).toMatchObject({
    status: 'paused',
    pause_reason: 'cap-reached',
  });
  const later = new Date(now.getTime() + 31 * 86400000);
  expect((await tick(later)).admitted).toBe(0);
  expect(await agentRow(agent)).toMatchObject({ status: 'paused' });
  expect((await notifications()).at(-1)!.title as string).toContain(
    'monthly cap',
  );
});

it('keeps queued runs across a restart', async () => {
  const root = resolve('.artifacts');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(resolve(root, 'agents-'));
  try {
    h = await startHarness({ dataDir });
    const agent = await seedAgent({ daysAgo: -1 });
    const id = await queueRun(agent);
    await h.app.close();
    h = await startHarness({ dataDir });
    await tick();
    expect((await run(id)).status).toBe('completed');
  } finally {
    await h.app.close();
    h = undefined as unknown as Harness;
    await rm(dataDir, { recursive: true, force: true });
  }
});
