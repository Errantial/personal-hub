import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authenticate } from './auth';
import AxeBuilder from '@axe-core/playwright';

// Persistent agents in the Assistant (D57). Agent endpoints are stubbed;
// the browser server runs without an agent worker or provider key.

const zone = 'America/Denver';
const conversationId = '00000000-0000-4000-8000-0000000000c1';
const agentId = '00000000-0000-4000-8000-0000000000a1';

type Json = Record<string, unknown>;
/** An agent as GET /api/v1/agents returns it; next run is in two hours. */
function agentFixture(fields: Json = {}): Json {
  return {
    id: agentId,
    version: 3,
    template: 'daily-plan',
    title: 'Daily plan',
    goal: 'Help me start each day with a clear, realistic plan.',
    status: 'active',
    pauseReason: null,
    schedule: { frequency: 'daily', times: ['07:00'] },
    useMail: true,
    monthlyCapMicros: 2000000,
    spentMicros: 1200,
    timeZone: zone,
    conversationId,
    nextRunAt: new Date(Date.now() + 2 * 3600000).toISOString(),
    lastRun: null,
    ...fields,
  };
}
const receipt = (fields: Json = {}) => ({
  id: crypto.randomUUID(),
  status: 'completed',
  reason: null,
  model: 'anthropic/claude-haiku-5.5',
  resultAvailable: true,
  reply: 'Here is your plan for today.',
  proposals: [],
  dropped: 0,
  withheld: 0,
  costMicros: 300,
  heldMicros: 0,
  createdAt: '2026-10-13T13:00:00.000Z',
  ...fields,
});
function runTurn(fields: Json = {}, request: Json = {}): Json {
  const id = crypto.randomUUID();
  const reqeust = receipt({ id, ...request });
  return {
    id,
    conversationId,
    ask: 'Scheduled run',
    trigger: 'agent',
    notAllowed: 0,
    version: 2,
    items: [],
    request: reqeust,
    ...fields,
  };
}

/**
 * Stubs agents and the pinned thread. `state.agents` and `state.turns` can be
 * changed between reloads; writes are recorded in `state.writes`.
 */
async function stub(page: Page, agents: Json[] = [agentFixture()]) {
  const state = {
    agents,
    turns: [] as Json[],
    writes: [] as { method: string; url: string; body: Json }[],
    failNext: 0,
  };
  const pinned = () =>
    state.agents.map((agent) => ({
      id: agent.conversationId,
      title: agent.title,
      turnCount: state.turns.length,
      version: 1,
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-13T13:00:00.000Z',
      agent: {
        id: agent.id,
        title: agent.title,
        status: agent.status,
        pauseReason: agent.pauseReason,
        nextRunAt: agent.nextRunAt,
        lastOutcome: null,
        lastRunAt: null,
      },
    }));
  await page.route('**/api/v1/assistant/conversations', (route) =>
    route.fulfill({
      json: {
        conversations: [
          ...pinned(),
          {
            id: '00000000-0000-4000-8000-0000000000c9',
            title: 'Weekend errands',
            turnCount: 1,
            version: 1,
            createdAt: '2026-10-10T12:00:00.000Z',
            updatedAt: '2026-10-10T12:00:00.000Z',
            agent: null,
          },
        ],
      },
    }),
  );
  await page.route(
    `**/api/v1/assistant/conversations/${conversationId}`,
    (route) =>
      route.fulfill({
        json: {
          conversation: pinned()[0] ?? {
            id: conversationId,
            title: 'Daily plan',
            turnCount: state.turns.length,
            version: 1,
            createdAt: '2026-10-01T12:00:00.000Z',
            updatedAt: '2026-10-13T13:00:00.000Z',
            agent: null,
          },
          turns: state.turns,
        },
      }),
  );
  await page.route('**/api/v1/agents', async (route) => {
    const request = route.request();
    if (request.method() === 'GET')
      return route.fulfill({ json: { agents: state.agents } });
    const body = request.postDataJSON() as Json;
    state.writes.push({ method: 'POST', url: request.url(), body });
    if (state.failNext-- > 0)
      return route.fulfill({
        status: 503,
        json: { error: { code: 'SERVER_BUSY', message: 'Try again.' } },
      });
    const created = agentFixture({
      ...body,
      id: crypto.randomUUID(),
      version: 1,
      spentMicros: 0,
    });
    delete created.operationId;
    state.agents = [...state.agents, created];
    return route.fulfill({ json: { agent: created } });
  });
  await page.route('**/api/v1/agents/*/run', (route) => {
    const body = route.request().postDataJSON() as Json;
    state.writes.push({ method: 'POST', url: route.request().url(), body });
    const agent = {
      ...state.agents[0]!,
      lastRun: {
        id: crypto.randomUUID(),
        status: 'queued',
        outcome: null,
        errorCode: null,
        finishedAt: null,
        turnId: null,
      },
    };
    state.agents = [agent];
    return route.fulfill({ json: { agent, runId: crypto.randomUUID() } });
  });
  await page.route('**/api/v1/agents/worker', (route) =>
    route.fulfill({
      json: {
        lastTick: new Date().toISOString(),
        errorCode: null,
        healthy: true,
      },
    }),
  );
  await page.route(/\/api\/v1\/agents\/[0-9a-f-]{36}$/, (route) => {
    const body = route.request().postDataJSON() as Json;
    state.writes.push({ method: 'PUT', url: route.request().url(), body });
    const raised =
      state.agents[0]!.pauseReason === 'cap-reached' &&
      Number(body.monthlyCapMicros) > Number(state.agents[0]!.spentMicros);
    const agent = {
      ...state.agents[0]!,
      ...body,
      version: Number(state.agents[0]!.version) + 1,
      ...(raised ? { status: 'active', pauseReason: null } : {}),
    };
    delete agent.operationId;
    delete agent.expectedVersion;
    state.agents = [agent];
    return route.fulfill({ json: { agent } });
  });
  return state;
}

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('pinned agents appear above conversations with their state and an unread dot', async ({
  page,
}) => {
  await stub(page, [
    agentFixture({
      lastRun: {
        id: '00000000-0000-4000-8000-0000000000f1',
        status: 'completed',
        outcome: 'applied',
        errorCode: null,
        finishedAt: new Date().toISOString(),
        turnId: null,
      },
    }),
  ]);
  await page.goto('/assistant');
  const agents = page.getByRole('navigation', { name: 'Agents' });
  const link = agents.getByRole('link', { name: /Daily plan/ });
  await expect(agents).toContainText(/Next (?:\w{3} )?\d{1,2}:\d{2} [AP]M/);
  await expect(agents.getByLabel('New run')).toBeVisible();
  const conversations = page.getByRole('navigation', { name: 'Conversations' });
  await expect(
    conversations.getByRole('link', { name: 'Weekend errands' }),
  ).toBeVisible();
  await expect(
    conversations.getByRole('link', { name: 'Daily plan' }),
  ).toHaveCount(0);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/assistant/${conversationId}$`));
  await expect(agents.getByLabel('New run')).toHaveCount(0);
});

test('creates an agent from a template', async ({ page }) => {
  const state = await stub(page, []);
  await page.goto('/assistant');
  await page.getByRole('button', { name: 'New agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await dialog.getByRole('radio', { name: 'Mail triage' }).check();
  await expect(dialog.getByLabel('Title')).toHaveValue('Mail triage');
  await expect(dialog.getByLabel(/^Time \d/)).toHaveCount(4);
  await expect(
    dialog.getByRole('checkbox', { name: 'Use mail' }),
  ).toBeChecked();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const body = state.writes.at(-1)!.body;
  expect(body).toMatchObject({
    template: 'mail-triage',
    title: 'Mail triage',
    useMail: true,
    monthlyCapMicros: 2000000,
    schedule: {
      frequency: 'daily',
      times: ['08:00', '12:00', '16:00', '20:00'],
    },
  });
  await expect(
    page
      .getByRole('navigation', { name: 'Agents' })
      .getByRole('link', { name: /Mail triage/ }),
  ).toBeVisible();
});

test('a failed save keeps the dialog open with the draft', async ({ page }) => {
  const state = await stub(page, []);
  state.failNext = 1;
  await page.goto('/assistant');
  await page.getByRole('button', { name: 'New agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await dialog.getByRole('radio', { name: 'Custom' }).check();
  await dialog.getByLabel('Title').fill('Reading list');
  await dialog.getByLabel('Goal').fill('Keep my reading list moving');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('Goal')).toHaveValue(
    'Keep my reading list moving',
  );
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  expect(state.writes[0]!.body.operationId).toBe(
    state.writes[1]!.body.operationId,
  );
});

test('times are limited to six, duplicates are refused, and the dialog fits 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await stub(page, []);
  await page.goto('/assistant');
  await page
    .getByRole('button', { name: 'Conversations', exact: true })
    .click();
  await page.getByRole('button', { name: 'New agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'New agent' });
  await dialog.getByRole('radio', { name: 'Daily plan' }).check();
  const add = dialog.getByRole('button', { name: 'Add time' });
  for (let count = 1; count < 6; count++) await add.click();
  await expect(dialog.getByLabel(/^Time \d/)).toHaveCount(6);
  await expect(add).toBeDisabled();
  await dialog.getByLabel('Time 2', { exact: true }).fill('07:00');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Each time can appear once.')).toBeVisible();
  await expect(dialog).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a capped agent cannot run until its cap is raised', async ({ page }) => {
  const state = await stub(page, [
    agentFixture({
      status: 'paused',
      pauseReason: 'cap-reached',
      spentMicros: 2000000,
    }),
  ]);
  await page.goto(`/assistant/${conversationId}`);
  await expect(page.getByRole('navigation', { name: 'Agents' })).toContainText(
    'Cap reached',
  );
  await page.getByRole('button', { name: 'Agent settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Daily plan' });
  await expect(dialog.getByRole('button', { name: 'Run now' })).toBeDisabled();
  await expect(dialog.getByText('Cap reached', { exact: true })).toBeVisible();
  await dialog.getByLabel('Monthly cap ($)').fill('5');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  expect(state.writes.at(-1)).toMatchObject({
    method: 'PUT',
    body: { monthlyCapMicros: 5000000, expectedVersion: 3 },
  });
});

test('run turns show a run line, applied items can be undone, and failed runs offer Retry', async ({
  page,
}) => {
  const state = await stub(page);
  const eventId = crypto.randomUUID();
  const applied = runTurn(
    {
      notAllowed: 1,
      items: [
        {
          state: 'applied',
          applied: { id: eventId, version: 1 },
          error: null,
          applyId: crypto.randomUUID(),
          undoId: crypto.randomUUID(),
        },
      ],
    },
    {
      reply: 'Added a study block.',
      proposals: [
        {
          kind: 'event.create',
          event: {
            title: 'Study block',
            timeZone: zone,
            startsAt: '2036-03-09T16:00:00.000Z',
            endsAt: '2036-03-09T17:00:00.000Z',
            allDay: false,
            startDate: null,
            endDate: null,
          },
        },
      ],
    },
  );
  const failed = runTurn(
    { ask: 'Run now' },
    {
      status: 'failed',
      reason: 'rate-limited',
      reply: null,
      resultAvailable: false,
      costMicros: null,
    },
  );
  state.turns = [applied, failed];
  let deleted: Json | null = null;
  await page.route(`**/api/v1/calendar/${eventId}`, (route) => {
    deleted = route.request().postDataJSON() as Json;
    return route.fulfill({
      json: {
        event: {
          id: eventId,
          title: 'Study block',
          notes: '',
          timeZone: zone,
          sensitivity: 'unlabeled',
          version: 2,
          allDay: false,
          recurrence: null,
          courseId: null,
          topicId: null,
          studyStatus: 'planned',
          startsAt: '2036-03-09T16:00:00.000Z',
          endsAt: '2036-03-09T17:00:00.000Z',
          startDate: null,
          endDate: null,
          createdAt: '2026-10-13T13:00:00.000Z',
          updatedAt: '2026-10-13T13:00:00.000Z',
          deletedAt: '2026-10-13T14:00:00.000Z',
          academicLabels: [],
        },
      },
    });
  });
  await page.route('**/api/v1/assistant/turns/*/items', (route) => {
    const body = route.request().postDataJSON() as { items: Json[] };
    return route.fulfill({
      json: { turn: { ...applied, version: 3, items: body.items } },
    });
  });
  await page.goto(`/assistant/${conversationId}`);
  const thread = page.locator('main');
  await expect(thread.getByRole('article', { name: 'You' })).toHaveCount(0);
  await expect(
    thread.getByText(/^Scheduled run · \w{3} \d{1,2}:\d{2} [AP]M$/),
  ).toBeVisible();
  await expect(thread.getByText(/^Run now · /)).toBeVisible();
  await expect(thread.getByText('Applied', { exact: true })).toBeVisible();
  await expect(thread.getByText(/1 not allowed by settings/)).toBeVisible();
  await thread.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => deleted).toMatchObject({ expectedVersion: 1 });
  await expect(thread.getByText('Undone', { exact: true })).toBeVisible();
  await expect(
    thread.getByText('OpenRouter is limiting requests.', { exact: false }),
  ).toBeVisible();
  await thread.getByRole('button', { name: 'Retry' }).click();
  await expect
    .poll(() => state.writes.at(-1)?.url ?? '')
    .toContain(`/api/v1/agents/${agentId}/run`);
});

test('a thread whose agent was deleted elsewhere stays readable without agent controls', async ({
  page,
}) => {
  const state = await stub(page);
  state.turns = [runTurn()];
  await page.goto(`/assistant/${conversationId}`);
  await expect(
    page.getByRole('button', { name: 'Agent settings' }),
  ).toBeVisible();
  state.agents = [];
  await page.reload();
  await expect(page.getByText('Here is your plan for today.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Agent settings' }),
  ).toHaveCount(0);
});

test('uncertain requests never offer Retry', async ({ page }) => {
  const state = await stub(page);
  state.turns = [
    runTurn(
      {},
      {
        status: 'uncertain',
        reason: 'timeout',
        heldMicros: 250000,
        reply: null,
        resultAvailable: false,
        costMicros: null,
      },
    ),
  ];
  await page.goto(`/assistant/${conversationId}`);
  await expect(page.getByText(/Nothing is resent/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry', exact: true }),
  ).toHaveCount(0);
});

test('completed scheduled runs appear while the thread stays open', async ({
  page,
}) => {
  const state = await stub(page);
  await page.goto(`/assistant/${conversationId}`);
  await expect(
    page.getByRole('button', { name: 'Agent settings' }),
  ).toBeVisible();
  state.turns = [runTurn()];
  state.agents = [
    agentFixture({
      lastRun: {
        id: crypto.randomUUID(),
        status: 'completed',
        outcome: 'quiet',
        errorCode: null,
        finishedAt: new Date().toISOString(),
        turnId: state.turns[0]!.id,
      },
    }),
  ];
  await expect(page.getByText('Here is your plan for today.')).toBeVisible({
    timeout: 22000,
  });
});

test('a failed precheck without a turn shows a reason and Retry', async ({
  page,
}) => {
  await stub(page, [
    agentFixture({
      lastRun: {
        id: crypto.randomUUID(),
        status: 'failed',
        outcome: 'failed',
        errorCode: 'AGENT_CHANGED',
        finishedAt: new Date().toISOString(),
        turnId: null,
      },
    }),
  ]);
  await page.goto(`/assistant/${conversationId}`);
  await expect(page.getByRole('alert')).toContainText(
    'The agent changed before this run could start.',
  );
  await expect(
    page.getByRole('button', { name: 'Retry', exact: true }),
  ).toBeEnabled();
});

test('agent controls use the real isolated API for create, pause, resume, Run now and delete', async ({
  page,
}) => {
  await page.goto('/assistant');
  await page.getByRole('button', { name: 'New agent' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill('Lifecycle test');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page
    .getByRole('navigation', { name: 'Agents' })
    .getByRole('link', { name: 'Lifecycle test' })
    .click();
  await page.getByRole('button', { name: 'Agent settings' }).click();
  await dialog.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Resume', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Run now', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Run now', exact: true }),
  ).toBeEnabled();
  const queued = page.waitForResponse((response) =>
    /\/api\/v1\/agents\/[^/]+\/run$/.test(response.url()),
  );
  await dialog.getByRole('button', { name: 'Run now', exact: true }).click();
  expect((await queued).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Agent settings' }).click();
  await page
    .getByRole('dialog', { name: 'Lifecycle test', exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await page.getByRole('button', { name: 'Delete agent', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Agent settings' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Lifecycle test', exact: true }),
  ).toBeVisible();
});

for (const theme of ['light', 'dark', 'eink'] as const) {
  test(`agent thread and dialog pass accessibility at 320px (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({
      colorScheme: theme === 'dark' ? 'dark' : 'light',
    });
    await page.addInitScript(
      (value) => localStorage.setItem('hub:eink', String(value === 'eink')),
      theme,
    );
    const state = await stub(page);
    state.turns = [runTurn()];
    await page.goto(`/assistant/${conversationId}`);
    await expect(page.getByText('Here is your plan for today.')).toBeVisible();
    await page
      .getByRole('button', { name: 'Conversations', exact: true })
      .click();
    await expect(
      page.getByRole('navigation', { name: 'Agents' }),
    ).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'New agent' }).click();
    const dialog = page.getByRole('dialog', { name: 'New agent' });
    await dialog.getByRole('radio', { name: 'Weekly', exact: true }).check();
    await expect(dialog.getByLabel('Weekday')).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const undersized = await dialog
      .locator(
        'button, input:not([type=radio]):not([type=checkbox]), select, textarea',
      )
      .evaluateAll(
        (elements, minimum) =>
          elements
            .filter(
              (element) =>
                element.getBoundingClientRect().height < minimum - 0.5,
            )
            .map((element) => element.outerHTML),
        theme === 'eink' ? 48 : 44,
      );
    expect(undersized).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'New agent' })).toBeFocused();
  });
}
