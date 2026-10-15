import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import { openDatabase } from '../../src/db/database.js';
import { chatUrl, modelsUrl, zdrUrl } from '../../src/ai/openrouter-live.js';

// Synthetic OpenRouter for agent tests: catalog, ZDR hosts and a chat
// handler the test swaps. Nothing reaches the network.
export const origin = 'http://127.0.0.1:5173';
export const model = 'anthropic/claude-haiku-5.5';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const catalog = () =>
  json({
    data: [
      {
        id: model,
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
        },
        pricing: { prompt: '0.0000001', completion: '0.0000005' },
      },
    ],
  });
const zdr = () =>
  json({
    data: [
      {
        model_id: model,
        tag: 'google-vertex/global',
        supported_parameters: ['structured_outputs'],
      },
    ],
  });

/** A confirmed completion whose content is the model's JSON answer. */
export const completion = (content: unknown, cost = '0.000123') =>
  new Response(
    `{"id":"gen-test-1","model":"${model}","usage":{"prompt_tokens":900,"completion_tokens":60,"total_tokens":960,"cost":${cost}},"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":${JSON.stringify(
      typeof content === 'string' ? content : JSON.stringify(content),
    )}}}]}`,
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
export const answer = (reply: string, actions: unknown[] = []) =>
  completion({ reply, actions });
export const rateLimited = () => json({ error: { code: 429 } }, 429);

/** One model action with every unused field null. */
export const action = (fields: Record<string, unknown>) => ({
  type: 'task.create',
  ref: null,
  title: null,
  dueDate: null,
  clearDueDate: false,
  priority: null,
  completed: null,
  start: null,
  end: null,
  allDay: null,
  notes: null,
  ...fields,
});

export type Harness = Awaited<ReturnType<typeof startHarness>>;
type Chat = (body: Record<string, unknown>) => Promise<Response> | Response;

/** Builds the app on a fresh database (or `dataDir`), signs up and sets limits. */
export async function startHarness(
  options: {
    key?: string | null;
    dataDir?: string;
    budget?: boolean;
  } = {},
) {
  const key = options.key === undefined ? 'sk-or-synthetic-test' : options.key;
  const config: Config = readConfig({
    NODE_ENV: 'test',
    PGLITE_DATA_DIR: options.dataDir ?? 'memory://',
    ...(key ? { AI_SECRET_OPENROUTER: key } : {}),
  });
  const database = await openDatabase(config);
  const state = {
    chat: (() => answer('Nothing to do.')) as Chat,
    sent: [] as Record<string, unknown>[],
  };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url === modelsUrl) return catalog();
    if (url === zdrUrl) return zdr();
    if (url === chatUrl) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.sent.push(body);
      return state.chat(body);
    }
    throw new Error(`Unexpected ${url}`);
  });
  const app = await buildApp(
    { logger: false },
    { config, database, openRouterFetch: fetcher },
  );
  let setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: { email: 'agents@example.test', password: 'synthetic-password' },
  });
  if (setup.statusCode !== 200)
    setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin },
      payload: { email: 'agents@example.test', password: 'synthetic-password' },
    });
  const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  const call = (method: string, url: string, payload?: object) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { origin, cookie },
      ...(payload ? { payload } : {}),
    });
  const owner = String(
    (await database.query('SELECT id FROM users LIMIT 1'))[0]!.id,
  );
  if (options.budget !== false) {
    const budget = await call('GET', '/api/v1/ai/budget');
    if (budget.json().policy?.monthlyLimitMicros == null)
      await call('PUT', '/api/v1/ai/budget', {
        operationId: randomUUID(),
        expectedVersion: budget.json().version ?? 1,
        policy: {
          monthlyLimitMicros: 50000000,
          perRequestLimitMicros: 250000,
        },
      });
  }
  const chatCalls = () =>
    fetcher.mock.calls.filter(([url]) => url === chatUrl).length;
  return { app, database, config, fetcher, call, owner, state, chatCalls };
}
