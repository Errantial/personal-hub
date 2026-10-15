import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  Temporal,
  responsibilityLocalRuleSchema,
  applyRequest,
} from '@hub/contracts';
import { applyByPolicy } from '../src/features/agent-run.js';
import { readTurn } from '../src/features/assistant-conversations.js';
import { runAgentTick } from '../src/features/agent-worker.js';
import { localReviewSlot } from '../src/features/responsibility-local-cadence.js';
import {
  action,
  approveLiveDestination,
  completion,
  answer,
  rateLimited,
  startHarness,
} from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';
import type { QueryExecutor } from '../src/db/database.js';
import { modelsUrl } from '../src/ai/openrouter-live.js';

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
  const agent = await seedAgent({ daysAgo: -2 });
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
  const agent = await seedAgent({ daysAgo: -2 });
  const missing = await queueRun(agent);
  await tick();
  expect(await run(missing)).toMatchObject({
    status: 'failed',
    error_code: 'ASSISTANT_NOT_CONFIGURED',
  });
  await h.app.close();
  h = await startHarness();
  const other = await seedAgent({ daysAgo: -2 });
  await h.database.query(
    "INSERT INTO ai_assistant_settings(owner_id,model) VALUES($1,'anthropic/claude-not-private')",
    [h.owner],
  );
  await approveLiveDestination(h.call, {
    model: 'anthropic/claude-not-private',
  });
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
  const agent = await seedAgent({ daysAgo: -2 });
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
  const agent = await seedAgent({ daysAgo: -2 });
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
  const agent = await seedAgent({ daysAgo: -2 });
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
  const agent = await seedAgent({ daysAgo: -2 });
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
  const agent = await seedAgent({ daysAgo: -2, cap: 100 });
  const id = await queueRun(agent);
  const now = new Date();
  await tick(now);
  expect(await run(id)).toMatchObject({
    status: 'failed',
    error_code: 'AGENT_BUDGET_EXCEEDED',
  });
  expect(h.chatCalls()).toBe(0);
  expect(await reservations()).toEqual([]);
  expect(await agentRow(agent)).toMatchObject({
    status: 'paused',
    pause_reason: 'cap-reached',
  });
  const later = new Date(now.getTime() + 31 * 86400000);
  expect((await tick(later)).admitted).toBe(0);
  expect(await agentRow(agent)).toMatchObject({ status: 'paused' });
  expect((await notifications()).at(-1)!.title as string).toContain(
    'run failed',
  );
});

it('keeps queued runs across a restart', async () => {
  const root = resolve('.artifacts');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(resolve(root, 'agents-'));
  try {
    h = await startHarness({ dataDir });
    const agent = await seedAgent({ daysAgo: -2 });
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

it('never sends a labeled agent goal', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -2 });
  await h.database.query(
    "UPDATE responsibilities SET sensitivity='restricted',labels=ARRAY['unlabeled','restricted'] WHERE id=$1",
    [agent.id],
  );
  const id = await queueRun(agent);
  await tick();
  expect(await run(id)).toMatchObject({
    status: 'failed',
    error_code: 'AGENT_LABELED',
  });
  expect(h.chatCalls()).toBe(0);
  expect(await reservations()).toHaveLength(0);
});

it.each(['sensitivity', 'inherited-label', 'goal'] as const)(
  'withholds a captured goal changed during catalog lookup: %s',
  async (change) => {
    h = await startHarness();
    const agent = await seedAgent({ daysAgo: -2 });
    await queueRun(agent);
    const original = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (url === modelsUrl) {
        if (change === 'goal')
          await h.database.query(
            "UPDATE responsibilities SET goal='Changed private goal',version=version+1 WHERE id=$1",
            [agent.id],
          );
        else if (change === 'sensitivity')
          await h.database.query(
            "UPDATE responsibilities SET sensitivity='restricted',version=version+1 WHERE id=$1",
            [agent.id],
          );
        else
          await h.database.query(
            "UPDATE responsibilities SET labels=ARRAY['unlabeled','restricted'],version=version+1 WHERE id=$1",
            [agent.id],
          );
      }
      return response;
    });
    await tick();
    expect(h.chatCalls()).toBe(0);
    expect(h.state.sent).toEqual([]);
  },
);

it('uses completion time and fences a response returned after lease expiry', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -2 });
  const id = await queueRun(agent);
  const started = new Date();
  let now = started;
  h.state.chat = () => {
    now = minutes(11, started);
    return answer('Add a block.', [
      action({
        type: 'event.create',
        title: 'Expired block',
        start: '2036-03-09T09:00',
        end: '2036-03-09T10:00',
      }),
    ]);
  };
  await runAgentTick(h.database, h.config, h.fetcher, started, () => now);
  expect(await run(id)).toMatchObject({
    status: 'failed',
    error_code: 'AGENT_LEASE_LOST',
    turn_id: expect.any(String),
  });
  expect((await h.call('GET', '/api/v1/calendar')).json().events).toEqual([]);
  const [timestamps] = await h.database.query(
    'SELECT finished_at FROM responsibility_runs WHERE id=$1',
    [id],
  );
  expect(new Date(timestamps!.finished_at as string).getTime()).toBe(
    now.getTime(),
  );
  const [health] = await h.database.query(
    "SELECT last_tick FROM worker_state WHERE name='agents'",
  );
  expect(new Date(health!.last_tick as string).getTime()).toBe(now.getTime());
  await tick(now);
  expect(h.chatCalls()).toBe(1);
});

it('updates worker liveness while inference is pending without extending the lease', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -2 });
  const id = await queueRun(agent);
  const started = new Date();
  let now = started;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    h.state.chat = async () => {
      now = minutes(2, started);
      await vi.advanceTimersByTimeAsync(30000);
      const [health] = await h.database.query(
        "SELECT last_tick FROM worker_state WHERE name='agents'",
      );
      expect(new Date(health!.last_tick as string).getTime()).toBe(
        now.getTime(),
      );
      const [active] = await h.database.query(
        'SELECT status,lease_until FROM responsibility_runs WHERE id=$1',
        [id],
      );
      expect(active!.status).toBe('running');
      expect(new Date(active!.lease_until as string).getTime()).toBe(
        minutes(10, started).getTime(),
      );
      return answer('Done.');
    };
    await runAgentTick(h.database, h.config, h.fetcher, started, () => now);
    expect((await run(id)).status).toBe('completed');
  } finally {
    vi.useRealTimers();
  }
});

it('rolls back planner effects and receipts when saving applied items fails', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -2 });
  const id = await queueRun(agent);
  h.state.chat = () =>
    answer('Add a block.', [
      action({
        type: 'event.create',
        title: 'Atomic block',
        start: '2036-03-09T09:00',
        end: '2036-03-09T10:00',
      }),
    ]);
  const transaction = h.database.transaction.bind(h.database);
  const original = h.database.query.bind(h.database);
  vi.spyOn(h.database, 'transaction').mockImplementation((work) =>
    transaction((tx) =>
      work({
        ...tx,
        query: (async (sql: string, values?: unknown[]) => {
          if (sql.startsWith('UPDATE ai_conversation_turns SET proposals='))
            throw new Error('synthetic persistence interruption');
          return tx.query(sql, values);
        }) as QueryExecutor['query'],
      }),
    ),
  );
  await tick();
  expect(await run(id)).toMatchObject({
    status: 'failed',
    error_code: 'AGENT_APPLY_ERROR',
    turn_id: expect.any(String),
  });
  expect((await h.call('GET', '/api/v1/calendar')).json().events).toEqual([]);
  const [turn] = await original(
    'SELECT items FROM ai_conversation_turns WHERE id=$1',
    [(await run(id)).turn_id],
  );
  const items =
    typeof turn!.items === 'string' ? JSON.parse(turn!.items) : turn!.items;
  expect(items[0].state).toBe('proposed');
  const [receipt] = await original(
    'SELECT count(*)::int AS count FROM mutation_receipts WHERE operation_id=$1',
    [items[0].applyId],
  );
  expect(receipt!.count).toBe(0);
  await tick();
  expect(h.chatCalls()).toBe(1);
});

it('rolls back an applied planner change if the lease expires before commit', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -2 });
  const id = await queueRun(agent);
  const started = new Date();
  let now = started;
  h.state.chat = () =>
    answer('Add a block.', [
      action({
        type: 'event.create',
        title: 'Lease-bound block',
        start: '2036-03-09T09:00',
        end: '2036-03-09T10:00',
      }),
    ]);
  const transaction = h.database.transaction.bind(h.database);
  let wrote = false;
  vi.spyOn(h.database, 'transaction').mockImplementation((work) =>
    transaction((tx) =>
      work({
        ...tx,
        query: (async (sql: string, values?: unknown[]) => {
          const result = await tx.query(sql, values);
          if (/INSERT INTO events\s*\(/i.test(sql)) {
            wrote = true;
            now = minutes(11, started);
          }
          return result;
        }) as QueryExecutor['query'],
      }),
    ),
  );
  await runAgentTick(h.database, h.config, h.fetcher, started, () => now);
  expect(wrote).toBe(true);
  expect(await run(id)).toMatchObject({
    status: 'failed',
    error_code: 'AGENT_LEASE_LOST',
  });
  expect((await h.call('GET', '/api/v1/calendar')).json().events).toEqual([]);
  expect(h.chatCalls()).toBe(1);
});

it('recovers a completed answer link after restart without redispatch or auto-apply', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -2 });
  const id = await queueRun(agent);
  await tick();
  const finished = await run(id);
  await h.database.query(
    "UPDATE responsibility_runs SET status='running',outcome=NULL,finished_at=NULL,turn_id=NULL,lease_token=$2,lease_until=$3 WHERE id=$1",
    [id, randomUUID(), minutes(-1)],
  );
  await tick();
  expect(await run(id)).toMatchObject({
    status: 'failed',
    error_code: 'LEASE_EXPIRED',
    turn_id: finished.turn_id,
  });
  expect(h.chatCalls()).toBe(1);
});

it('recovers an older committed planner receipt without applying twice after policy changes', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -2 });
  const id = await queueRun(agent);
  h.state.chat = () =>
    answer('Add a task.', [
      action({ type: 'task.create', title: 'Receipt recovery' }),
    ]);
  await tick();
  const turn = (await readTurn(
    h.database,
    h.owner,
    String((await run(id)).turn_id),
  ))!;
  const request = applyRequest(
    turn.request.proposals[0]!,
    turn.items[0]!.applyId,
  );
  expect(
    (await h.call(request.method, request.path, request.body)).statusCode,
  ).toBe(200);
  // Simulate the legacy crash boundary: planner write/receipt persisted but
  // the conversation still says proposed. The current owner now blocks tasks.
  const policy = (await h.call('GET', '/api/v1/ai/actions')).json();
  expect(
    (
      await h.call('PUT', '/api/v1/ai/actions', {
        operationId: randomUUID(),
        expectedVersion: policy.version,
        policy: {
          tasks: 'blocked',
          calendar: 'automatic',
          email: 'approval-required',
        },
      })
    ).statusCode,
  ).toBe(200);
  const counts = await applyByPolicy(h.database, h.owner, turn);
  expect(counts).toEqual({ applied: 1, proposed: 0, failed: 0, notAllowed: 0 });
  expect((await h.call('GET', '/api/v1/tasks')).json().tasks).toHaveLength(1);
  expect((await readTurn(h.database, h.owner, turn.id))!.items[0]!.state).toBe(
    'applied',
  );
  expect(h.chatCalls()).toBe(1);
});

it('an unapproved destination fails once with no hold and notifies the owner', async () => {
  h = await startHarness({ destination: false });
  const agent = await seedAgent({ daysAgo: -2 });
  const id = await queueRun(agent);
  await tick();
  expect(await run(id)).toMatchObject({
    status: 'failed',
    error_code: 'ASSISTANT_ROUTE_UNSET',
    attempts: 1,
  });
  expect(h.chatCalls()).toBe(0);
  expect(await reservations()).toEqual([]);
  expect(await notifications()).toHaveLength(1);
});

it('a captured goal edit at the catalog withholds, releases and requeues once', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -2 });
  const id = await queueRun(agent);
  const original = h.fetcher.getMockImplementation()!;
  h.fetcher.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (url === modelsUrl)
      await h.database.query(
        "UPDATE responsibilities SET goal=goal||' edited',version=version+1 WHERE id=$1",
        [agent.id],
      );
    return response;
  });
  const now = new Date();
  await tick(now);
  expect(await run(id)).toMatchObject({ status: 'queued', attempts: 1 });
  expect(h.chatCalls()).toBe(0);
  expect(await reservations()).toEqual([{ status: 'released' }]);
  await tick(minutes(16, now));
  expect(await run(id)).toMatchObject({
    status: 'failed',
    attempts: 2,
    error_code: 'LIVE_CONTEXT_CHANGED',
  });
  expect(h.chatCalls()).toBe(0);
  expect(await reservations()).toEqual([
    { status: 'released' },
    { status: 'released' },
  ]);
});

it('pause committed during catalog lookup still sends and saves the running turn', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -2 });
  const id = await queueRun(agent);
  const original = h.fetcher.getMockImplementation()!;
  h.fetcher.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (url === modelsUrl)
      await h.database.query(
        "UPDATE responsibilities SET status='paused',version=version+1 WHERE id=$1",
        [agent.id],
      );
    return response;
  });
  await tick();
  expect(h.chatCalls()).toBe(1);
  expect(await run(id)).toMatchObject({ status: 'completed' });
});

it('a lease lost during catalog lookup never sends or leaves an uncertain hold', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -2 });
  const id = await queueRun(agent);
  const original = h.fetcher.getMockImplementation()!;
  h.fetcher.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (url === modelsUrl)
      await h.database.query(
        "UPDATE responsibility_runs SET lease_until=CURRENT_TIMESTAMP-interval '1 second' WHERE id=$1",
        [id],
      );
    return response;
  });
  await tick();
  expect(h.chatCalls()).toBe(0);
  expect(await reservations()).toEqual([{ status: 'released' }]);
  expect((await run(id)).error_code).toBe('AGENT_LEASE_LOST');
});

it('mail-derived agent proposals remain proposed under automatic task policy', async () => {
  h = await startHarness();
  const agent = await seedAgent({ daysAgo: -2 });
  await h.database.query(
    'UPDATE responsibilities SET use_mail=true WHERE id=$1',
    [agent.id],
  );
  const { token } = (
    await h.call('POST', '/api/v1/email/connectors', {
      name: 'Synthetic mail',
      sensitivity: 'unlabeled',
      operationId: randomUUID(),
    })
  ).json();
  expect(
    (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/email/connector/batch',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          path: 'INBOX',
          role: null,
          uidValidity: '1',
          exists: 1,
          inWindow: 1,
          lastUid: 1,
          messages: [
            {
              uid: 1,
              messageKey: '<agent-mail@example.test>',
              from: { name: 'Office', address: 'office@example.test' },
              to: [],
              cc: [],
              subject: 'Waiver',
              sentAt: null,
              receivedAt: '2026-10-01T10:00:00.000Z',
              body: 'Return waiver.',
              bodyTruncated: false,
              attachmentCount: 0,
              textOrigin: 'message-body-v1',
            },
          ],
        },
      })
    ).statusCode,
  ).toBe(200);
  await h.database.query(
    `INSERT INTO ai_action_policies(owner_id,policy) VALUES($1,'{"tasks":"automatic","calendar":"automatic","email":"approval-required"}') ON CONFLICT(owner_id) DO UPDATE SET policy=EXCLUDED.policy`,
    [h.owner],
  );
  h.state.chat = () =>
    completion(
      h.state.sent.length === 1
        ? { reply: 'Search', actions: [], mailSearch: ['waiver'] }
        : h.state.sent.length === 2
          ? { reply: 'Read', actions: [], read: ['m1'] }
          : {
              reply: 'Create waiver task',
              actions: [action({ title: 'Return waiver' })],
            },
    );
  const id = await queueRun(agent);
  await tick();
  expect(h.chatCalls()).toBe(3);
  expect(await run(id)).toMatchObject({
    status: 'completed',
    outcome: 'needs-approval',
  });
  expect((await h.call('GET', '/api/v1/tasks')).json().tasks).toEqual([]);
  const turn = await readTurn(
    h.database,
    h.owner,
    (await run(id)).turn_id as string,
  );
  expect(turn?.proposalAccess).toBe('read-only');
  expect(turn?.items[0]!.state).toBe('proposed');
});
