import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  Temporal,
  agentTemplates,
  customInstructions,
  undoRequest,
} from '@hub/contracts';
import type { AssistantTurn } from '@hub/contracts';
import { answerTurn } from '../src/features/assistant.js';
import {
  agentPrompt,
  agentSpend,
  applyByPolicy,
  outcomeOf,
} from '../src/features/agent-run.js';
import { action, answer, startHarness } from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';

// Persistent agents (D57). Every provider exchange is synthetic.
let h: Harness;

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

const setPolicy = async (tasks: string, calendar: string) => {
  const current = (await h.call('GET', '/api/v1/ai/actions')).json();
  const saved = await h.call('PUT', '/api/v1/ai/actions', {
    operationId: randomUUID(),
    expectedVersion: current.version,
    policy: { tasks, calendar, email: 'approval-required' },
  });
  expect(saved.statusCode).toBe(200);
};
const agentTurn = (conversationId = randomUUID()) =>
  answerTurn(h.database, h.config, h.fetcher, h.owner, {
    operationId: randomUUID(),
    prompt: 'Plan today',
    ask: 'Scheduled run',
    timeZone: 'America/Denver',
    conversationId,
    useMail: false,
    trigger: 'agent',
  });
const studyBlock = action({
  type: 'event.create',
  title: 'Study block',
  start: '2036-03-09T09:00',
  end: '2036-03-09T10:00',
});
const readTurn = async (id: string): Promise<AssistantTurn> => {
  const [row] = await h.database.query(
    'SELECT conversation_id FROM ai_conversation_turns WHERE id=$1',
    [id],
  );
  const conversation = (
    await h.call(
      'GET',
      `/api/v1/assistant/conversations/${String(row!.conversation_id)}`,
    )
  ).json();
  return conversation.turns.find((turn: AssistantTurn) => turn.id === id);
};

it('applies automatic calendar changes, keeps ask-first tasks proposed and counts blocked ones', async () => {
  h = await startHarness();
  await setPolicy('approval-required', 'automatic');
  h.state.chat = () =>
    answer('Planned.', [
      studyBlock,
      action({ type: 'task.create', title: 'Read chapter 3' }),
    ]);
  const turn = await agentTurn();
  const counts = await applyByPolicy(h.database, h.owner, turn);
  expect(counts).toEqual({ applied: 1, proposed: 1, notAllowed: 0, failed: 0 });
  const saved = await readTurn(turn.id);
  expect(saved.items.map((item) => item.state)).toEqual([
    'applied',
    'proposed',
  ]);
  const events = (await h.call('GET', '/api/v1/calendar')).json().events;
  expect(events.map((event: { title: string }) => event.title)).toContain(
    'Study block',
  );
  expect(outcomeOf(counts, saved)).toBe('needs-approval');

  await setPolicy('blocked', 'automatic');
  const second = await agentTurn();
  const blocked = await applyByPolicy(h.database, h.owner, second);
  expect(blocked).toEqual({
    applied: 1,
    proposed: 0,
    notAllowed: 1,
    failed: 0,
  });
  const stored = await readTurn(second.id);
  expect(stored.request.proposals).toHaveLength(1);
  expect(stored.items).toHaveLength(1);
  expect(stored.notAllowed).toBe(1);
  expect(outcomeOf(blocked, stored)).toBe('applied');
});

it('fails only the item whose target changed after the model read it', async () => {
  h = await startHarness();
  await setPolicy('automatic', 'automatic');
  const make = async (title: string) =>
    (
      await h.call('POST', '/api/v1/tasks', {
        title,
        operationId: randomUUID(),
      })
    ).json().task;
  const first = await make('First');
  const second = await make('Second');
  h.state.chat = () =>
    answer('Raised priorities.', [
      action({ type: 'task.update', ref: 't1', priority: 'high' }),
      action({ type: 'task.update', ref: 't2', priority: 'high' }),
    ]);
  const turn = await agentTurn();
  const target = turn.request.proposals[0]!;
  const edited = target.kind === 'task.update' ? target.target : null;
  const owned = [first, second].find((task) => task.id === edited!.id);
  const edit = await h.call('PUT', `/api/v1/tasks/${owned.id}`, {
    title: `${owned.title} (edited)`,
    notes: owned.notes,
    dueDate: owned.dueDate,
    priority: owned.priority,
    completed: owned.completed,
    operationId: randomUUID(),
    expectedVersion: owned.version,
  });
  expect(edit.statusCode).toBe(200);
  const counts = await applyByPolicy(h.database, h.owner, turn);
  expect(counts).toEqual({ applied: 1, proposed: 0, notAllowed: 0, failed: 1 });
  const saved = await readTurn(turn.id);
  expect(saved.items[0]).toMatchObject({ state: 'failed' });
  expect(saved.items[0]!.error).toBeTruthy();
  expect(saved.items[1]).toMatchObject({ state: 'applied' });
  expect(outcomeOf(counts, saved)).toBe('applied');
});

it('undoes an auto-applied item through the ordinary endpoints', async () => {
  h = await startHarness();
  h.state.chat = () => answer('Added a block.', [studyBlock]);
  const turn = await agentTurn();
  await applyByPolicy(h.database, h.owner, turn);
  const saved = await readTurn(turn.id);
  const item = saved.items[0]!;
  expect(item.state).toBe('applied');
  const undo = undoRequest(
    saved.request.proposals[0]!,
    item.applied!,
    item.undoId,
  );
  const response = await h.call(undo.method, undo.path, undo.body);
  expect(response.statusCode).toBe(200);
  expect((await h.call('GET', '/api/v1/calendar')).json().events).toEqual([]);
});

it('counts settled and held charges of agent run turns only', async () => {
  h = await startHarness();
  const conversationId = randomUUID();
  const responsibility = randomUUID();
  await agentTurn(conversationId);
  // An owner reply in the same thread is not agent spend.
  await answerTurn(h.database, h.config, h.fetcher, h.owner, {
    operationId: randomUUID(),
    prompt: 'Thanks',
    ask: 'Thanks',
    timeZone: 'America/Denver',
    conversationId,
    useMail: false,
    trigger: 'owner',
  });
  await h.database.query(
    "INSERT INTO responsibilities(id,owner_id,title,goal,sensitivity,labels,template,conversation_id,time_zone) VALUES($1,$2,'Daily plan','Plan','unlabeled',ARRAY['unlabeled'],'daily-plan',$3,'America/Denver')",
    [responsibility, h.owner, conversationId],
  );
  expect(await agentSpend(h.database, h.owner, responsibility)).toBe(123);
});

it("builds each template's prompt from its instructions, the goal and the run time", () => {
  const now = Temporal.Instant.from('2026-11-03T14:00:00Z');
  for (const template of [
    'daily-plan',
    'mail-triage',
    'deadline-watch',
  ] as const) {
    const prompt = agentPrompt(
      { template, goal: 'My goal' },
      now,
      'America/Denver',
    );
    expect(prompt.startsWith(agentTemplates[template].instructions)).toBe(true);
    expect(prompt).toContain('Goal: My goal');
    expect(prompt).toContain('Run: 2026-11-03T07:00, Tuesday (America/Denver)');
  }
  expect(
    agentPrompt({ template: 'custom', goal: 'G' }, now, 'UTC').startsWith(
      customInstructions,
    ),
  ).toBe(true);
});
