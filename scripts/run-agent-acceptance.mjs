// Local synthetic acceptance for the real in-process scheduled-agent worker.
// Uses an isolated database and injected fake OpenRouter responses only.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from '../apps/api/src/app.ts';
import { readConfig } from '../apps/api/src/config.ts';
import { openDatabase } from '../apps/api/src/db/database.ts';
import {
  chatUrl,
  modelsUrl,
  zdrUrl,
} from '../apps/api/src/ai/openrouter-live.ts';
import { agentRule, scheduleFromNow } from '../apps/api/src/features/agents.ts';
import { defaultAssistantModel } from '../packages/contracts/src/assistant.ts';

const origin = 'http://127.0.0.1:5173';
const zone = 'America/Denver';
const password = 'synthetic-agent-acceptance-password';
const email = 'synthetic-agent-acceptance@example.test';
const schedule = { frequency: 'daily', times: ['07:00'] };

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function syntheticProvider(state) {
  return async (url, init = {}) => {
    if (url === modelsUrl)
      return json({
        data: [
          {
            id: defaultAssistantModel,
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
            pricing: { prompt: '0.0000001', completion: '0.0000005' },
          },
        ],
      });
    if (url === zdrUrl)
      return json({
        data: [
          {
            model_id: defaultAssistantModel,
            tag: 'google-vertex/global',
            supported_parameters: ['structured_outputs'],
          },
        ],
      });
    if (url !== chatUrl) throw new Error(`Synthetic runner blocked ${url}`);
    state.chatDispatches++;
    const request = JSON.parse(String(init.body));
    if (request.model !== defaultAssistantModel)
      throw new Error('Synthetic runner received an unexpected model.');
    if (
      request.provider?.allow_fallbacks !== false ||
      request.provider?.zdr !== true
    )
      throw new Error(
        'Synthetic runner requires pinned ZDR/no-fallback routing.',
      );
    const actions =
      state.chatDispatches === 3
        ? [
            {
              type: 'task.create',
              ref: null,
              title: 'Synthetic review task',
              dueDate: null,
              clearDueDate: false,
              priority: 'normal',
              completed: null,
              start: null,
              end: null,
              allDay: null,
              notes: 'Synthetic ask-first acceptance proposal.',
            },
          ]
        : [];
    return json({
      id: `gen-agent-acceptance-${state.chatDispatches}`,
      model: defaultAssistantModel,
      usage: {
        prompt_tokens: 900,
        completion_tokens: 60,
        total_tokens: 960,
        cost: 0.000123,
      },
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              reply: actions.length
                ? 'Synthetic acceptance result: one change needs review.'
                : 'Synthetic acceptance result: no changes needed.',
              actions,
            }),
          },
        },
      ],
    });
  };
}

function configFor(dataDir) {
  return readConfig({
    NODE_ENV: 'test',
    PGLITE_DATA_DIR: dataDir,
    AGENT_WORKER: 'on',
    AI_SECRET_OPENROUTER: 'synthetic-agent-acceptance-key',
  });
}

async function openApp(dataDir, fetcher, runWorker) {
  const config = configFor(dataDir);
  const database = await openDatabase(config);
  const app = await buildApp(
    { logger: false },
    { config, database, runWorker, openRouterFetch: fetcher },
  );
  await app.ready();
  return { app, database };
}

function expectStatus(response, expected, label) {
  if (response.statusCode !== expected)
    throw new Error(
      `${label} returned ${response.statusCode}: ${JSON.stringify(response.json())}`,
    );
  return response.json();
}

async function session(app, mode = 'login') {
  const response = await app.inject({
    method: 'POST',
    url: mode === 'setup' ? '/api/v1/auth/setup' : '/api/v1/auth/login',
    headers: { origin },
    payload: { email, password },
  });
  expectStatus(response, mode === 'setup' ? 201 : 200, mode);
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  if (!cookie) throw new Error(`${mode} did not return a session cookie.`);
  return (method, url, payload) =>
    app.inject({
      method,
      url,
      headers: { origin, cookie },
      ...(payload === undefined ? {} : { payload }),
    });
}

async function seed(dataDir, fetcher) {
  const { app, database } = await openApp(dataDir, fetcher, false);
  try {
    const call = await session(app, 'setup');
    const budget = expectStatus(
      await call('GET', '/api/v1/ai/budget'),
      200,
      'budget read',
    );
    if (budget.policy?.monthlyLimitMicros == null)
      expectStatus(
        await call('PUT', '/api/v1/ai/budget', {
          operationId: randomUUID(),
          expectedVersion: budget.version ?? 1,
          policy: {
            monthlyLimitMicros: 50000000,
            perRequestLimitMicros: 250000,
          },
        }),
        200,
        'budget save',
      );
    const destination = expectStatus(
      await call('GET', '/api/v1/assistant/destination'),
      200,
      'destination read',
    ).destination;
    expectStatus(
      await call('PUT', '/api/v1/assistant/destination', {
        model: defaultAssistantModel,
        upstream: 'google-vertex',
        expectedVersion: destination.version,
      }),
      200,
      'destination approval',
    );
    const created = expectStatus(
      await call('POST', '/api/v1/agents', {
        operationId: randomUUID(),
        template: 'daily-plan',
        title: 'Synthetic daily plan',
        goal: 'Return a synthetic no-op planning result.',
        schedule,
        useMail: false,
        monthlyCapMicros: 2000000,
        timeZone: zone,
      }),
      200,
      'agent create',
    ).agent;
    expectStatus(
      await call('POST', `/api/v1/agents/${created.id}/run`, {
        operationId: randomUUID(),
        expectedVersion: created.version,
      }),
      200,
      'Run now',
    );

    // Re-point only this isolated fixture's schedule to a valid slot from two
    // days ago. The production admission code still decides that it is due,
    // creates the scheduled run and advances the local cadence.
    const [owner] = await database.query(
      'SELECT owner_id AS id FROM responsibilities WHERE id=$1',
      [created.id],
    );
    const fixtureNow = Date.now() - 48 * 60 * 60 * 1000;
    const rule = agentRule(schedule, zone, fixtureNow);
    await database.transaction((tx) =>
      scheduleFromNow(tx, String(owner.id), created.id, rule, fixtureNow),
    );
    return { id: created.id, conversationId: created.conversationId };
  } finally {
    await app.close();
  }
}

async function workerStartup(dataDir, fetcher) {
  const { app } = await openApp(dataDir, fetcher, true);
  // onClose calls worker.stop(), which waits for the immediate startup tick.
  await app.close();
}

async function queueFollowUpManual(dataDir, fetcher, agent) {
  const { app } = await openApp(dataDir, fetcher, false);
  try {
    const call = await session(app, 'login');
    const agents = expectStatus(
      await call('GET', '/api/v1/agents'),
      200,
      'agent list',
    ).agents;
    const current = agents.find((value) => value.id === agent.id);
    if (!current)
      throw new Error('Synthetic agent disappeared before follow-up.');
    expectStatus(
      await call('POST', `/api/v1/agents/${agent.id}/run`, {
        operationId: randomUUID(),
        expectedVersion: current.version,
      }),
      200,
      'follow-up Run now',
    );
  } finally {
    await app.close();
  }
}

async function verify(dataDir, fetcher, agent, state) {
  const { app, database } = await openApp(dataDir, fetcher, false);
  try {
    const call = await session(app, 'login');
    const history = expectStatus(
      await call('GET', `/api/v1/agents/${agent.id}/runs?limit=10`),
      200,
      'run history',
    );
    if (history.totalCount !== 3 || history.runs.length !== 3)
      throw new Error(
        `Expected exactly three runs, found ${history.totalCount}.`,
      );
    const triggers = history.runs.map((run) => run.trigger).sort();
    if (
      JSON.stringify(triggers) !==
      JSON.stringify(['manual', 'manual', 'schedule'])
    )
      throw new Error(`Unexpected run triggers: ${JSON.stringify(triggers)}`);
    for (const run of history.runs) {
      if (
        run.status !== 'completed' ||
        !['quiet', 'needs-approval'].includes(run.outcome) ||
        run.attempts !== 1 ||
        run.exchangeCount !== 1 ||
        run.settledMicros !== 123 ||
        run.heldMicros !== 0 ||
        run.uncertainMicros !== 0 ||
        !run.startedAt ||
        !run.finishedAt ||
        !run.turnId
      )
        throw new Error(`Run did not settle cleanly: ${JSON.stringify(run)}`);
    }
    const thread = expectStatus(
      await call(
        'GET',
        `/api/v1/assistant/conversations/${agent.conversationId}`,
      ),
      200,
      'conversation',
    );
    if (thread.turns.length !== 3)
      throw new Error(
        `Expected three retained turns, found ${thread.turns.length}.`,
      );
    const asks = thread.turns.map((turn) => turn.ask).sort();
    if (
      JSON.stringify(asks) !==
      JSON.stringify(['Run now', 'Run now', 'Scheduled run'])
    )
      throw new Error(`Unexpected turn asks: ${JSON.stringify(asks)}`);
    if (thread.turns.some((turn) => turn.trigger !== 'agent'))
      throw new Error(
        'Every synthetic acceptance turn must be agent-triggered.',
      );
    const notifications = expectStatus(
      await call('GET', '/api/v1/notifications'),
      200,
      'notifications',
    ).notifications;
    if (notifications.length !== 1)
      throw new Error(
        `Expected one ask-first review notification, found ${notifications.length}.`,
      );
    const approvalRun = history.runs.find(
      (run) => run.outcome === 'needs-approval',
    );
    if (!approvalRun || notifications[0]?.runId !== approvalRun.id)
      throw new Error(
        'The ask-first review notification is not bound to its run.',
      );
    const [scheduleState] = await database.query(
      'SELECT next_due_at AS "nextDueAt" FROM responsibility_schedules WHERE responsibility_id=$1 AND deleted_at IS NULL',
      [agent.id],
    );
    if (
      !scheduleState?.nextDueAt ||
      new Date(scheduleState.nextDueAt).getTime() <= Date.now()
    )
      throw new Error('Scheduled admission did not advance to a future slot.');
    const [effects] = await database.query(
      `SELECT
         (SELECT count(*)::int FROM tasks WHERE owner_id=r.owner_id) AS tasks,
         (SELECT count(*)::int FROM events WHERE owner_id=r.owner_id) AS events
       FROM responsibilities r WHERE r.id=$1`,
      [agent.id],
    );
    if (Number(effects?.tasks) !== 0 || Number(effects?.events) !== 0)
      throw new Error(
        'Synthetic no-op runs unexpectedly changed planner records.',
      );
    const worker = expectStatus(
      await call('GET', '/api/v1/agents/worker'),
      200,
      'worker health',
    );
    if (!worker.healthy || worker.state !== 'healthy')
      throw new Error(
        `Worker heartbeat is not healthy: ${JSON.stringify(worker)}`,
      );
    if (state.chatDispatches !== 3)
      throw new Error(
        `Expected exactly three synthetic provider dispatches, found ${state.chatDispatches}.`,
      );
    return {
      version: 1,
      synthetic: true,
      runCount: history.totalCount,
      manualRuns: history.runs.filter((run) => run.trigger === 'manual').length,
      scheduledRuns: history.runs.filter((run) => run.trigger === 'schedule')
        .length,
      completedRuns: history.runs.filter((run) => run.status === 'completed')
        .length,
      needsApprovalRuns: history.runs.filter(
        (run) => run.outcome === 'needs-approval',
      ).length,
      conversationTurns: thread.turns.length,
      inboxNotifications: notifications.length,
      chatDispatches: state.chatDispatches,
      settledMicros: history.runs.reduce(
        (sum, run) => sum + run.settledMicros,
        0,
      ),
      heldMicros: history.runs.reduce((sum, run) => sum + run.heldMicros, 0),
      uncertainMicros: history.runs.reduce(
        (sum, run) => sum + run.uncertainMicros,
        0,
      ),
      workerHealthy: worker.healthy,
      scheduleAdvanced: true,
      plannerEffects: 0,
      cleanRestartNoDuplicateDispatch: true,
      askFirstNotificationBound: true,
    };
  } finally {
    await app.close();
  }
}

export async function runAgentAcceptance() {
  const dataDir = await mkdtemp(join(tmpdir(), 'hub-agent-acceptance-'));
  const state = { chatDispatches: 0 };
  const fetcher = syntheticProvider(state);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(
      `Synthetic acceptance blocked global network access: ${url}`,
    );
  };
  try {
    const agent = await seed(dataDir, fetcher);
    // Each app startup exercises the real onReady -> startAgentWorker path.
    // Two clean app startups process the original manual + scheduled pair.
    await workerStartup(dataDir, fetcher);
    await workerStartup(dataDir, fetcher);
    // Queue another owned Run now through the HTTP API. Its synthetic answer
    // proposes a task; the default ask-first task policy must keep it pending,
    // emit exactly one review notification and create no planner record.
    await queueFollowUpManual(dataDir, fetcher, agent);
    await workerStartup(dataDir, fetcher);
    // A final clean reopen proves none of the completed/needs-review runs are
    // redispatched and the review notification is not duplicated. Crash and
    // in-flight ownership recovery remain covered by the focused worker tests.
    await workerStartup(dataDir, fetcher);
    return await verify(dataDir, fetcher, agent, state);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const result = await runAgentAcceptance();
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
