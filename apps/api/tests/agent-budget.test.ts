import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { admitLive, settleLive } from '../src/ai/live-request.js';
import { agentSpend } from '../src/features/agent-run.js';
import { answerTurn } from '../src/features/assistant.js';
import { migrate } from '../src/db/migrate.js';
import {
  startTurn,
  recordRound,
} from '../src/features/assistant-conversations.js';
import { completion, startHarness } from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';

let h: Harness;
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden.');
    }),
  );
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await h?.app.close();
});

async function agent(cap = 10000, owner = h.owner) {
  const id = randomUUID();
  const conversation = randomUUID();
  await h.database.query(
    'INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,$3)',
    [conversation, owner, 'Synthetic'],
  );
  await h.database.query(
    "INSERT INTO responsibilities(id,owner_id,title,goal,sensitivity,labels,template,conversation_id,time_zone,monthly_cap_micros) VALUES($1,$2,'Synthetic','Plan','unlabeled',ARRAY['unlabeled'],'daily-plan',$3,'UTC',$4)",
    [id, owner, conversation, cap],
  );
  return { id, conversation };
}
const request = (agentId: string, maximumMicros: number) => ({
  id: randomUUID(),
  kind: 'planner' as const,
  operationId: randomUUID(),
  hash: 'a'.repeat(64),
  model: 'anthropic/claude-haiku-5.5',
  maximumMicros,
  withheld: 0,
  agentId,
});

it('counts a hold durably before turn persistence and admits exactly the remaining allowance', async () => {
  h = await startHarness();
  const a = await agent(1000);
  await admitLive(h.database, h.owner, request(a.id, 600));
  expect(await agentSpend(h.database, h.owner, a.id)).toBe(600);
  await expect(
    admitLive(h.database, h.owner, request(a.id, 401)),
  ).rejects.toMatchObject({ code: 'AGENT_BUDGET_EXCEEDED' });
  await admitLive(h.database, h.owner, request(a.id, 400));
  expect(await agentSpend(h.database, h.owner, a.id)).toBe(1000);
  expect(
    await h.database.query('SELECT id FROM ai_conversation_turns'),
  ).toHaveLength(0);
  expect(
    await h.database.query('SELECT id FROM ai_budget_reservations'),
  ).toHaveLength(2);
});

it('serializes concurrent admissions and isolates the other agent and owner budget', async () => {
  h = await startHarness();
  const a = await agent(1000),
    b = await agent(1000);
  const results = await Promise.allSettled([
    admitLive(h.database, h.owner, request(a.id, 700)),
    admitLive(h.database, h.owner, request(a.id, 700)),
  ]);
  expect(results.map((x) => x.status).sort()).toEqual([
    'fulfilled',
    'rejected',
  ]);
  await admitLive(h.database, h.owner, request(b.id, 700));
  expect(await agentSpend(h.database, h.owner, a.id)).toBe(700);
  await h.database.query(
    'UPDATE ai_budget_policies SET monthly_limit_micros=1500,per_request_limit_micros=1000 WHERE owner_id=$1',
    [h.owner],
  );
  await expect(
    admitLive(h.database, h.owner, request(b.id, 200)),
  ).rejects.toMatchObject({ code: 'MONTHLY_BUDGET_EXCEEDED' });
  expect(await agentSpend(h.database, h.owner, b.id)).toBe(700);
});

it('releases confirmed refusals, retains uncertainty and uses settled charges without double counting', async () => {
  h = await startHarness();
  const a = await agent(1000);
  const first = request(a.id, 600);
  await admitLive(h.database, h.owner, first);
  await settleLive(
    h.database,
    h.owner,
    first.id,
    { status: 'rejected', reason: 'rate-limited' },
    { proposals: 0, dropped: 0 },
    null,
  );
  expect(await agentSpend(h.database, h.owner, a.id)).toBe(0);
  const second = request(a.id, 600);
  await admitLive(h.database, h.owner, second);
  await h.database.query(
    "UPDATE ai_budget_reservations SET status='settled',actual_micros=123 WHERE request_id=$1",
    [second.id],
  );
  expect(await agentSpend(h.database, h.owner, a.id)).toBe(123);
  await admitLive(h.database, h.owner, request(a.id, 877));
  expect(await agentSpend(h.database, h.owner, a.id)).toBe(1000);
});

it('stops a later mail exchange before its hold or dispatch when allowance was reduced', async () => {
  h = await startHarness();
  const a = await agent();
  h.state.chat = async () => {
    await h.database.query(
      'UPDATE responsibilities SET monthly_cap_micros=124 WHERE id=$1',
      [a.id],
    );
    return completion({
      reply: 'Searching.',
      actions: [],
      mailSearch: ['deadline'],
      read: [],
    });
  };
  const turn = await answerTurn(h.database, h.config, h.fetcher, h.owner, {
    operationId: randomUUID(),
    prompt: 'Find deadlines',
    ask: 'Run',
    timeZone: 'UTC',
    conversationId: a.conversation,
    useMail: true,
    trigger: 'agent',
    agentId: a.id,
  });
  expect(h.chatCalls()).toBe(1);
  expect(turn.mailNote).toContain('remaining agent allowance');
  expect(
    await h.database.query('SELECT id FROM ai_budget_reservations'),
  ).toHaveLength(1);
  expect(await agentSpend(h.database, h.owner, a.id)).toBe(123);
});

it('rejects deleted or foreign agent attribution without creating a hold', async () => {
  h = await startHarness();
  const foreignOwner = randomUUID();
  await h.database.query(
    'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',
    [foreignOwner, 'other@example.test', 'not-a-login-hash'],
  );
  const foreign = await agent(1000, foreignOwner);
  await expect(
    admitLive(h.database, h.owner, request(foreign.id, 100)),
  ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' });
  await expect(
    admitLive(h.database, h.owner, request(randomUUID(), 100)),
  ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' });
  const a = await agent();
  await h.database.query(
    "UPDATE responsibilities SET deleted_at=CURRENT_TIMESTAMP,status='cancelled' WHERE id=$1",
    [a.id],
  );
  await expect(
    admitLive(h.database, h.owner, request(a.id, 100)),
  ).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' });
  expect(
    await h.database.query('SELECT id FROM ai_budget_reservations'),
  ).toHaveLength(0);
});

it('deduplicates durable attribution with legacy turn and round links', async () => {
  h = await startHarness();
  const a = await agent(1000);
  const first = request(a.id, 300),
    second = { ...request(a.id, 400), kind: 'planner-round' as const };
  await admitLive(h.database, h.owner, first);
  await startTurn(h.database, h.owner, {
    id: first.id,
    conversationId: a.conversation,
    ask: 'Run',
    useMail: true,
    trigger: 'agent',
  });
  await admitLive(h.database, h.owner, second);
  await recordRound(h.database, {
    requestId: second.id,
    turnId: first.id,
    round: 2,
  });
  expect(await agentSpend(h.database, h.owner, a.id)).toBe(700);
  await expect(
    admitLive(h.database, h.owner, request(a.id, 301)),
  ).rejects.toMatchObject({ code: 'AGENT_BUDGET_EXCEEDED' });
});

it('assigns allowance by reservation UTC month without dropping old uncertain receipts', async () => {
  h = await startHarness();
  const a = await agent(1000);
  const old = request(a.id, 1000);
  await admitLive(h.database, h.owner, old);
  await h.database.query(
    "UPDATE ai_budget_reservations SET month=(date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-interval '1 month')::date WHERE request_id=$1",
    [old.id],
  );
  expect(await agentSpend(h.database, h.owner, a.id)).toBe(0);
  await admitLive(h.database, h.owner, request(a.id, 1000));
  expect(await agentSpend(h.database, h.owner, a.id)).toBe(1000);
  expect(
    await h.database.query(
      "SELECT id FROM ai_budget_reservations WHERE status='uncertain'",
    ),
  ).toHaveLength(2);
});

it('upgrades existing request metadata and holds without inventing agent attribution', async () => {
  h = await startHarness();
  const a = await agent();
  const legacy = { ...request(a.id, 500), agentId: undefined };
  await admitLive(h.database, h.owner, legacy);
  await h.database.exec(
    'ALTER TABLE ai_assistant_requests DROP COLUMN agent_id',
  );
  await h.database.query(
    "DELETE FROM schema_migrations WHERE name='058_agent_request_budget.sql'",
  );
  const before = await h.database.query('SELECT * FROM ai_assistant_requests');
  const holds = await h.database.query('SELECT * FROM ai_budget_reservations');
  await migrate(h.database);
  expect(await h.database.query('SELECT * FROM ai_assistant_requests')).toEqual(
    before.map((row) => ({ ...row, agent_id: null })),
  );
  expect(
    await h.database.query('SELECT * FROM ai_budget_reservations'),
  ).toEqual(holds);
});
