import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { applyRequest, undoRequest } from '@hub/contracts';
import type { AssistantTurn } from '@hub/contracts';
import { authenticate } from './auth';

const headers = { Origin: 'http://127.0.0.1:5180' };

/** A stubbed answer with its stored turn, as the server returns it. */
function answer(route: Route, request: { proposals: unknown[] }) {
  const sent = route.request().postDataJSON() as {
    text: string;
    conversationId: string;
  };
  const id = crypto.randomUUID();
  const reply = {
    request: { ...request, id },
    turn: {
      id,
      conversationId: sent.conversationId,
      ask: sent.text,
      version: 1,
      inferenceHistory: 'bound',
      proposalAccess: 'applicable',
      request: { ...request, id },
      items: request.proposals.map(() => ({
        state: 'proposed',
        applied: null,
        error: null,
        applyId: crypto.randomUUID(),
        undoId: crypto.randomUUID(),
      })),
    },
  };
  lastTurn = reply.turn;
  return reply;
}

/** Synthetic server operation adapter: browser sends only indexes and identity. */
async function stubOperations(page: Page, loseFirstResponse = false) {
  const receipts = new Map<string, unknown>();
  const requests: unknown[] = [];
  let lost = false;
  await page.route('**/api/v1/assistant/turns/*/items', () => {
    throw new Error('The browser must not save assistant item states.');
  });
  await page.route(
    /\/api\/v1\/assistant\/turns\/[^/]+\/(apply|undo)$/,
    async (route) => {
      const body = route.request().postDataJSON() as {
        expectedVersion: number;
        indexes: number[];
        operationId: string;
      };
      requests.push(body);
      const replay = receipts.get(body.operationId);
      if (replay) {
        expect(body).toEqual(replay);
        await route.fulfill({ json: { turn: lastTurn } });
        return;
      }
      const turn = lastTurn as unknown as AssistantTurn;
      expect(body.expectedVersion).toBe(turn.version);
      const undo = route.request().url().endsWith('/undo');
      const items = [...turn.items];
      for (const index of undo ? [...body.indexes].reverse() : body.indexes) {
        const item = items[index]!;
        const proposal = turn.request.proposals[index]!;
        const planned = undo
          ? undoRequest(proposal, item.applied!, item.undoId)
          : applyRequest(proposal, item.applyId);
        // This test-only server adapter makes the planner request independently;
        // page routes can detect any forbidden browser-side planner write.
        const response = await page.request.fetch(planned.path, {
          method: planned.method,
          headers,
          data: planned.body,
        });
        if (response.ok()) {
          const record = (await response.json())[
            planned.returns === 'task' ? 'task' : 'event'
          ];
          items[index] = {
            ...item,
            state: undo ? 'undone' : 'applied',
            applied: undo
              ? item.applied
              : { id: record.id, version: record.version },
            error: null,
          };
        } else {
          items[index] = {
            ...item,
            state: undo ? 'applied' : 'failed',
            error: 'Changed or removed since the assistant read it. Ask again.',
          };
        }
      }
      lastTurn = { ...lastTurn, version: turn.version + 1, items };
      receipts.set(body.operationId, body);
      if (loseFirstResponse && !lost) {
        lost = true;
        await route.abort('failed');
        return;
      }
      await route.fulfill({ json: { turn: lastTurn } });
    },
  );
  return requests;
}
let lastTurn: Record<string, unknown> = {};

/** The stored conversation behind the latest stubbed answer. */
async function stubThread(page: Page) {
  const conversation = () => ({
    id: lastTurn.conversationId,
    title: lastTurn.ask,
    turnCount: 1,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await page.route('**/api/v1/assistant/conversations', (route) =>
    route.fulfill({
      json: { conversations: lastTurn.id ? [conversation()] : [] },
    }),
  );
  await page.route('**/api/v1/assistant/conversations/*', (route) =>
    route.fulfill({
      json: { conversation: conversation(), turns: [lastTurn] },
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await authenticate(page);
  await stubDestination(page);
});

test('destination panel replaces the model picker and can approve and revoke without a server key', async ({
  page,
}) => {
  await page.unroute('**/api/v1/assistant/destination*');
  await page.setViewportSize({ width: 320, height: 800 });
  await stubThread(page);
  await page.goto('/assistant');
  await expect(page.locator('main')).toContainText(
    'Assistant blocked: Server key missing',
  );
  await expect(
    page.getByRole('button', { name: 'Ask', exact: true }),
  ).toBeDisabled();
  await page.goto('/settings/ai');
  const settings = page.getByRole('region', { name: /^Assistant/ });
  await expect(settings).toContainText('Blocked: Server key missing');
  await expect(
    settings.getByRole('button', { name: 'Save model' }),
  ).toHaveCount(0);
  const model = settings.getByRole('textbox', { name: 'Model', exact: true });
  await model.fill('not a model');
  await settings.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(settings.getByText(/Use an OpenRouter model ID/)).toBeVisible();
  await model.fill('anthropic/claude-haiku-5.5');
  await settings
    .getByRole('radio', { name: 'google-vertex', exact: true })
    .check();
  await settings.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Revoke' })).toBeVisible();
  const approved = (
    await (await page.request.get('/api/v1/assistant/destination')).json()
  ).destination;
  expect(approved.approved).toEqual({
    model: 'anthropic/claude-haiku-5.5',
    upstream: 'google-vertex',
  });
  const help = settings.getByRole('button', {
    name: 'Help: Destination',
    exact: true,
  });
  await help.focus();
  await help.press('Enter');
  await expect(settings).toContainText(
    'Requests go only to this host through OpenRouter',
  );
  await help.press('Escape');
  await help.click();
  await expect(settings).toContainText('there is no fallback');
  await settings.getByRole('button', { name: 'Revoke' }).click();
  await expect(settings.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('server-owned Apply retries a lost response without browser planner writes and can be undone', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const created = await page.request.post('/api/v1/tasks', {
    headers,
    data: {
      title: `Lab report ${suffix}`,
      dueDate: '2036-03-10',
      operationId: crypto.randomUUID(),
    },
  });
  const task = (await created.json()).task;
  const newTitle = `Buy notebook ${suffix}`;
  // Only the assistant endpoints are simulated; no provider is called.
  await page.route('**/api/v1/assistant/settings', (route) =>
    route.fulfill({
      json: {
        settings: {
          model: 'anthropic/claude-haiku-5.5',
          version: 1,
          configured: true,
        },
      },
    }),
  );
  let asked: { text?: string } = {};
  await page.route('**/api/v1/assistant/requests', (route) => {
    asked = route.request().postDataJSON() as { text?: string };
    return route.fulfill({
      json: answer(route, {
        id: crypto.randomUUID(),
        status: 'completed',
        reason: null,
        model: 'anthropic/claude-haiku-5.5',
        resultAvailable: true,
        reply: 'Added a task and moved the lab report.',
        proposals: [
          {
            kind: 'task.create',
            task: {
              title: newTitle,
              notes: '',
              dueDate: '2036-03-01',
              priority: 'normal',
            },
          },
          {
            kind: 'task.update',
            target: task,
            changes: { dueDate: '2036-03-12' },
          },
        ],
        dropped: 0,
        withheld: 2,
        costMicros: 123,
        heldMicros: 0,
        createdAt: new Date().toISOString(),
      }),
    });
  });

  const operations = await stubOperations(page, true);
  let browserWrites = 0;
  await page.route(/\/api\/v1\/(tasks|calendar)(\/|$)/, (route) => {
    if (route.request().method() !== 'GET') browserWrites += 1;
    return route.continue();
  });
  await stubThread(page);
  await page.goto('/assistant');
  const box = page.locator('main');
  const form = box.getByRole('form', { name: 'Ask the assistant' });
  await form
    .getByRole('textbox', { name: 'Ask', exact: true })
    .fill('Add buy notebook and push the lab report');
  await form.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(box).toContainText('Added a task and moved the lab report.');
  await expect(box).toContainText('$0.000123');
  await expect(box).toContainText('2 left out');
  expect(asked.text).toBe('Add buy notebook and push the lab report');
  const changes = box.getByRole('group', { name: 'Proposed changes' });
  await expect(
    changes.getByRole('checkbox', {
      name: new RegExp(`^Add task “${newTitle}”`),
    }),
  ).toBeChecked();

  // Nothing changes before Apply.
  const read = async () =>
    (await (await page.request.get('/api/v1/tasks')).json()).tasks as {
      id: string;
      title: string;
      dueDate: string | null;
    }[];
  expect((await read()).find((t) => t.id === task.id)?.dueDate).toBe(
    '2036-03-10',
  );
  await changes.getByRole('button', { name: 'Apply 2 changes' }).click();
  await expect(
    box.getByText('The result could not be confirmed.', { exact: false }),
  ).toBeVisible();
  await changes
    .getByRole('button', { name: 'Retry Apply', exact: true })
    .click();
  await expect(box.getByText('Applied 2 changes.')).toBeVisible();
  expect(operations).toHaveLength(2);
  expect(operations[1]).toEqual(operations[0]);
  expect(browserWrites).toBe(0);
  let tasks = await read();
  expect(tasks.find((t) => t.id === task.id)?.dueDate).toBe('2036-03-12');
  expect(tasks.some((t) => t.title === newTitle)).toBe(true);

  await changes.getByRole('button', { name: 'Undo' }).click();
  await expect(box.getByText('Changes undone.')).toBeVisible();
  tasks = await read();
  expect(tasks.find((t) => t.id === task.id)?.dueDate).toBe('2036-03-10');
  expect(tasks.some((t) => t.title === newTitle)).toBe(false);
  expect(browserWrites).toBe(0);
});

test('a change made elsewhere is a conflict, not an overwrite', async ({
  page,
}) => {
  const created = await page.request.post('/api/v1/tasks', {
    headers,
    data: {
      title: `Essay ${crypto.randomUUID().slice(0, 8)}`,
      operationId: crypto.randomUUID(),
    },
  });
  const task = (await created.json()).task;
  await page.request.put(`/api/v1/tasks/${task.id}`, {
    headers,
    data: {
      title: task.title,
      notes: 'edited elsewhere',
      dueDate: null,
      priority: 'high',
      completed: false,
      expectedVersion: task.version,
      operationId: crypto.randomUUID(),
    },
  });
  await page.route('**/api/v1/assistant/settings', (route) =>
    route.fulfill({
      json: {
        settings: {
          model: 'anthropic/claude-haiku-5.5',
          version: 1,
          configured: true,
        },
      },
    }),
  );
  await page.route('**/api/v1/assistant/requests', (route) =>
    route.fulfill({
      json: answer(route, {
        id: crypto.randomUUID(),
        status: 'completed',
        reason: null,
        model: 'anthropic/claude-haiku-5.5',
        resultAvailable: true,
        reply: 'Marked the essay done.',
        proposals: [
          { kind: 'task.update', target: task, changes: { completed: true } },
        ],
        dropped: 0,
        withheld: 0,
        costMicros: 80,
        heldMicros: 0,
        createdAt: new Date().toISOString(),
      }),
    }),
  );
  await stubOperations(page);
  await stubThread(page);
  await page.goto('/assistant');
  const box = page.locator('main');
  const ask = box.getByRole('textbox', { name: 'Ask', exact: true });
  // Shift+Enter adds a line; Enter asks.
  await ask.fill('Mark the essay');
  await ask.press('Shift+Enter');
  await expect(ask).toHaveValue('Mark the essay\n');
  await ask.fill('Mark the essay done');
  await ask.press('Enter');
  await box.getByRole('button', { name: 'Apply 1 change' }).click();
  await expect(
    box.getByText(/Changed or removed since the assistant read it/),
  ).toBeVisible();
  await expect(box.getByText('Not applied')).toBeVisible();
  const current = (
    await (await page.request.get('/api/v1/tasks')).json()
  ).tasks.find((t: { id: string }) => t.id === task.id);
  expect(current).toMatchObject({
    completed: false,
    notes: 'edited elsewhere',
  });
});

test('the Assistant page keeps a conversation, continues it and deletes it', async ({
  page,
}) => {
  await page.route('**/api/v1/assistant/settings', (route) =>
    route.fulfill({
      json: {
        settings: {
          model: 'anthropic/claude-haiku-5.5',
          version: 1,
          configured: true,
          allowPersonalMail: false,
        },
      },
    }),
  );
  const asks: { text: string; conversationId: string }[] = [];
  const turns: Record<string, unknown>[] = [];
  await page.route('**/api/v1/assistant/requests', (route) => {
    const sent = route.request().postDataJSON() as {
      text: string;
      conversationId: string;
    };
    asks.push(sent);
    const reply = answer(route, {
      status: 'completed',
      reason: null,
      model: 'anthropic/claude-haiku-5.5',
      resultAvailable: true,
      reply: `Answer ${asks.length}`,
      proposals: [],
      dropped: 0,
      withheld: 0,
      costMicros: 100,
      heldMicros: 0,
      createdAt: new Date().toISOString(),
    });
    turns.push(reply.turn);
    return route.fulfill({ json: reply });
  });
  const conversation = () => ({
    id: asks[0]!.conversationId,
    title: asks[0]!.text,
    turnCount: turns.length,
    version: turns.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  let deleted = false;
  await page.route('**/api/v1/assistant/conversations', (route) =>
    route.fulfill({
      json: { conversations: asks.length && !deleted ? [conversation()] : [] },
    }),
  );
  await page.route('**/api/v1/assistant/conversations/*', (route) => {
    if (route.request().method() === 'DELETE') {
      deleted = true;
      return route.fulfill({ json: { deleted: true } });
    }
    return route.fulfill({ json: { conversation: conversation(), turns } });
  });

  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Assistant' })
    .first()
    .click();
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByText('No conversations yet.')).toBeVisible();
  const ask = page.getByRole('textbox', { name: 'Ask', exact: true });
  await ask.fill('What is due this week?');
  // Asking waits for the assistant settings to load.
  await expect(
    page.getByRole('button', { name: 'Ask', exact: true }),
  ).toBeEnabled();
  await ask.press('Enter');
  await expect(page.getByText('Answer 1')).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/assistant/${asks[0]!.conversationId}$`),
  );
  const list = page.getByRole('navigation', { name: 'Conversations' });
  await expect(
    list.getByRole('link', { name: 'What is due this week?' }),
  ).toBeVisible();
  await expect(page.getByText('Answer 1')).toBeVisible();
  // A follow-up joins the same conversation.
  await ask.fill('And next week?');
  await ask.press('Enter');
  await expect(page.getByText('Answer 2')).toBeVisible();
  expect(asks[1]!.conversationId).toBe(asks[0]!.conversationId);
  // Reloading shows the stored conversation.
  await page.reload();
  await expect(page.getByText('And next week?')).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete conversation' })
    .click();
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByText('No conversations yet.')).toBeVisible();
  expect(deleted).toBe(true);
});

test('Use mail is remembered and each answer lists the mail that was sent', async ({
  page,
}) => {
  let settings = {
    model: 'anthropic/claude-haiku-5.5',
    version: 1,
    configured: true,
    allowPersonalMail: false,
    useMail: false,
  };
  await page.route('**/api/v1/assistant/settings', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { useMail: boolean };
      settings = {
        ...settings,
        useMail: body.useMail,
        version: settings.version + 1,
      };
    }
    return route.fulfill({ json: { settings } });
  });
  let sentUseMail: boolean | undefined;
  await page.route('**/api/v1/assistant/requests', (route) => {
    sentUseMail = (route.request().postDataJSON() as { useMail: boolean })
      .useMail;
    const reply = answer(route, {
      status: 'completed',
      reason: null,
      model: 'anthropic/claude-haiku-5.5',
      resultAvailable: true,
      reply: 'The waiver is due Friday.',
      proposals: [],
      dropped: 0,
      withheld: 0,
      costMicros: 300,
      heldMicros: 0,
      createdAt: new Date().toISOString(),
    });
    Object.assign(reply.turn, {
      useMail: true,
      proposalAccess: 'read-only',
      mailWithheld: 2,
      mailNote: null,
      mail: [
        {
          id: crypto.randomUUID(),
          subject: 'Field trip waiver',
          from: 'School Office',
          receivedAt: new Date().toISOString(),
          read: true,
        },
        {
          id: crypto.randomUUID(),
          subject: 'Lunch menu',
          from: 'School Office',
          receivedAt: new Date().toISOString(),
          read: false,
        },
      ],
    });
    return route.fulfill({ json: reply });
  });
  await stubThread(page);
  await page.goto('/assistant');
  const box = page.locator('main');
  const useMail = box.getByRole('checkbox', { name: 'Use mail' });
  await expect(useMail).not.toBeChecked();
  await useMail.check();
  await expect.poll(() => settings.useMail).toBe(true);
  // The choice comes back after a reload, as on another device.
  await page.reload();
  await expect(useMail).toBeChecked();
  const ask = box.getByRole('textbox', { name: 'Ask', exact: true });
  await ask.fill('When is the waiver due?');
  await ask.press('Enter');
  await expect(box).toContainText('The waiver is due Friday.');
  expect(sentUseMail).toBe(true);
  await box
    .getByText(
      'anthropic/claude-haiku-5.5 · $0.0003 · 2 messages sent · 2 left out',
    )
    .click();
  await expect(box).toContainText('Field trip waiver');
  await expect(box).toContainText('Body sent');
  await expect(box).toContainText('Subject and sender only');
});

test('mail proposals are read-only chat cards with keyboard Help at 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.route('**/api/v1/assistant/settings', (route) =>
    route.fulfill({
      json: {
        settings: {
          model: 'anthropic/claude-haiku-5.5',
          version: 1,
          configured: true,
          allowPersonalMail: false,
          useMail: true,
        },
      },
    }),
  );
  await page.route('**/api/v1/assistant/requests', (route) => {
    const reply = answer(route, {
      status: 'completed',
      reason: null,
      model: 'anthropic/claude-haiku-5.5',
      resultAvailable: true,
      reply: 'Added the waiver task.',
      proposals: [
        {
          kind: 'task.create',
          task: {
            title: 'Sign the waiver',
            notes: '',
            dueDate: '2036-03-01',
            priority: 'normal',
          },
        },
      ],
      dropped: 0,
      withheld: 0,
      costMicros: 300,
      heldMicros: 0,
      createdAt: new Date().toISOString(),
    });
    Object.assign(reply.turn, {
      useMail: true,
      proposalAccess: 'read-only',
      mailWithheld: 2,
      mailNote: null,
      mail: ['Field trip waiver', 'Lunch menu'].map((subject, index) => ({
        id: crypto.randomUUID(),
        subject,
        from: 'School Office',
        receivedAt: new Date().toISOString(),
        read: index === 0,
        truncated: index === 0,
      })),
    });
    return route.fulfill({ json: reply });
  });
  await stubThread(page);
  await page.goto('/assistant');
  const box = page.locator('main');
  const ask = box.getByRole('textbox', { name: 'Ask', exact: true });
  await expect(ask).toBeEnabled();
  await ask.fill('Add the waiver');
  await ask.press('Enter');
  const mine = box.getByRole('article', { name: 'You' });
  await expect(mine).toHaveText('Add the waiver');
  const reply = box.getByRole('article', { name: 'Assistant' });
  await expect(reply).toContainText('Added the waiver task.');
  const details = reply.getByText(
    'anthropic/claude-haiku-5.5 · $0.0003 · 2 messages sent · 2 left out',
  );
  await expect(reply.getByText('Field trip waiver')).toBeHidden();
  await details.click();
  const sent = reply
    .getByRole('listitem')
    .filter({ hasText: 'Field trip waiver' });
  await expect(sent).toContainText('Body sent (cut)');
  const changes = reply.getByRole('group', { name: 'From mail · read only' });
  await expect(changes.getByRole('button', { name: /Apply/ })).toHaveCount(0);
  await expect(changes.getByRole('checkbox')).toHaveCount(0);
  const help = changes.getByRole('button', {
    name: 'Help: Read-only suggestions',
  });
  await help.focus();
  await help.press('Enter');
  await expect(changes).toContainText(
    "Suggestions based on mail can't be applied",
  );
  await help.press('Escape');
  await help.click();
  await expect(changes).toContainText(
    'Create the item yourself if you want it.',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

/** Configured settings and a plain answer per ask, numbered from 1. */
async function stubAnswers(page: Page) {
  await page.route('**/api/v1/assistant/settings', (route) =>
    route.fulfill({
      json: {
        settings: {
          model: 'anthropic/claude-haiku-5.5',
          version: 1,
          configured: true,
          allowPersonalMail: false,
          useMail: false,
        },
      },
    }),
  );
  let count = 0;
  await page.route('**/api/v1/assistant/requests', (route) =>
    route.fulfill({
      json: answer(route, {
        status: 'completed',
        reason: null,
        model: 'anthropic/claude-haiku-5.5',
        resultAvailable: true,
        reply: `Answer ${++count}`,
        proposals: [],
        dropped: 0,
        withheld: 0,
        costMicros: 100,
        heldMicros: 0,
        createdAt: new Date().toISOString(),
      }),
    }),
  );
  await stubThread(page);
}

test('the conversation list collapses behind a button on narrow screens', async ({
  page,
}) => {
  await stubAnswers(page);
  await page.goto('/assistant');
  const ask = page.getByRole('textbox', { name: 'Ask', exact: true });
  await expect(ask).toBeEnabled();
  await ask.fill('Plan my week');
  await ask.press('Enter');
  await expect(page.locator('main')).toContainText('Answer 1');
  await page.goto('/assistant');
  await page.setViewportSize({ width: 390, height: 800 });
  const toggle = page.getByRole('button', { name: 'Conversations' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const list = page.getByRole('navigation', { name: 'Conversations' });
  await expect(list).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await list.getByRole('link', { name: 'Plan my week' }).click();
  await expect(page).toHaveURL(/\/assistant\/[0-9a-f-]{36}$/);
  await expect(list).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('after an answer the newest turn is in view and focus returns to the composer', async ({
  page,
}) => {
  await stubAnswers(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto('/assistant');
  const ask = page.getByRole('textbox', { name: 'Ask', exact: true });
  await expect(ask).toBeEnabled();
  for (const n of [1, 2, 3]) {
    await ask.fill(`Question ${n} ${'with a long body '.repeat(20)}`);
    await ask.press('Enter');
    await expect(page.locator('main')).toContainText(`Answer ${n}`);
  }
  const latest = page.getByRole('article', { name: 'Assistant' }).last();
  await expect(latest).toContainText('Answer 3');
  await expect(latest).toBeInViewport();
  await expect(ask).toBeFocused();
});

async function stubDestination(
  page: Page,
  override: Record<string, unknown> = {},
) {
  await page.route('**/api/v1/assistant/destination*', (route) =>
    route.fulfill({
      json: {
        destination: {
          status: 'ready',
          reason: null,
          approved: {
            model: 'anthropic/claude-haiku-5.5',
            upstream: 'google-vertex',
          },
          model: 'anthropic/claude-haiku-5.5',
          hosts: ['anthropic', 'google-vertex', 'amazon-bedrock'],
          personalMail: false,
          version: 1,
          ...override,
        },
      },
    }),
  );
}

for (const { theme, width, target } of [
  { theme: 'standard', width: 1280, target: 44 },
  { theme: 'eink', width: 320, target: 48 },
]) {
  for (const view of ['assistant', 'today']) {
    test(`blocked destination offers an accessible Settings target (${view}, ${theme})`, async ({
      page,
    }) => {
      await stubAnswers(page);
      await stubDestination(page, {
        status: 'blocked',
        reason: 'approval-required',
        approved: null,
        version: 0,
      });
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript((eink) => {
        localStorage.setItem('hub:eink', String(eink));
        localStorage.setItem('hub:command-mode', 'ask');
      }, theme === 'eink');
      await page.goto(`/${view}`);
      await expect(page.locator('main')).toContainText(
        'Assistant blocked: Not approved',
      );
      await expect(
        page.getByRole('button', { name: 'Ask', exact: true }),
      ).toBeDisabled();
      const settings = page
        .locator('main')
        .getByRole('link', { name: 'Settings', exact: true });
      await expect(settings).toBeVisible();
      const box = (await settings.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(target);
      expect(box.width).toBeGreaterThanOrEqual(target);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await settings.focus();
      await settings.press('Enter');
      await expect(page).toHaveURL(/settings\/ai$/);
    });
  }
}

test('earlier-messages note offers a new conversation and keyboard Help at 320px', async ({
  page,
}) => {
  await stubAnswers(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/assistant');
  await page
    .getByRole('textbox', { name: 'Ask', exact: true })
    .fill('An older question');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('main')).toContainText('Answer 1');
  lastTurn.inferenceHistory = 'unbound';
  await page.reload();
  await expect(page.locator('main')).toContainText(
    "Older messages aren't sent with new asks.",
  );
  const help = page.getByRole('button', { name: 'Help: Earlier messages' });
  await help.focus();
  await help.press('Enter');
  await expect(page.locator('main')).toContainText('They stay readable.');
  await help.press('Escape');
  await help.click();
  await expect(page.locator('main')).toContainText('They stay readable.');
  await page
    .getByRole('button', { name: 'New conversation', exact: true })
    .click();
  await expect(page).toHaveURL(/\/assistant$/);
});

test('a retained Apply control checks the server and refuses newly read-only mail proposals', async ({
  page,
}) => {
  await stubAnswers(page);
  let writes = 0;
  await page.route('**/api/v1/tasks', (route) => {
    if (route.request().method() === 'POST') writes += 1;
    return route.continue();
  });
  await page.goto('/assistant');
  const ask = page.getByRole('textbox', { name: 'Ask', exact: true });
  await ask.fill('Suggest a task');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('main')).toContainText('Answer 1');
  // A stored legacy turn is displayed as applicable. The server migration
  // changes its access without a turn version bump while the page stays open.
  const proposal = {
    kind: 'task.create',
    task: {
      title: 'Mail-derived suggestion',
      notes: '',
      dueDate: null,
      priority: 'normal',
    },
  };
  Object.assign(lastTurn, {
    request: {
      ...(lastTurn.request as Record<string, unknown>),
      proposals: [proposal],
    },
    items: [
      {
        state: 'proposed',
        applied: null,
        error: null,
        applyId: crypto.randomUUID(),
        undoId: crypto.randomUUID(),
      },
    ],
  });
  await page.reload();
  const apply = page.getByRole('button', {
    name: 'Apply 1 change',
    exact: true,
  });
  await expect(apply).toBeVisible();
  let unavailable = true;
  await page.route(
    `**/api/v1/assistant/conversations/${lastTurn.conversationId}`,
    (route) =>
      unavailable
        ? route.fulfill({
            status: 503,
            json: { error: { code: 'SERVER_BUSY' } },
          })
        : route.fallback(),
  );
  await apply.click();
  await expect(page.locator('main')).toContainText(
    'Could not verify these suggestions. Nothing was changed.',
  );
  expect(writes).toBe(0);
  unavailable = false;
  lastTurn.proposalAccess = 'read-only';
  await apply.click();
  await expect(
    page.getByRole('group', { name: 'From mail · read only' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Apply 1 change/ }),
  ).toHaveCount(0);
  await expect(page.locator('main')).toContainText('Nothing was changed.');
  expect(writes).toBe(0);
});

test('academic selection pins versions, survives a refused ask and clears after an answer', async ({
  page,
}) => {
  const courseReply = await page.request.post('/api/v1/courses', {
    headers,
    data: { name: 'Academic picker', operationId: crypto.randomUUID() },
  });
  expect(courseReply.ok()).toBe(true);
  const course = (await courseReply.json()).course;
  const workReply = await page.request.post('/api/v1/academic-work', {
    headers,
    data: {
      courseId: course.id,
      title: `Picker essay ${crypto.randomUUID()}`,
      operationId: crypto.randomUUID(),
    },
  });
  expect(workReply.ok()).toBe(true);
  const work = (await workReply.json()).work;
  await page.route('**/api/v1/assistant/settings', (route) =>
    route.fulfill({
      json: {
        settings: {
          model: 'anthropic/claude-haiku-5.5',
          version: 1,
          configured: true,
        },
      },
    }),
  );
  await stubThread(page);
  await stubOperations(page);
  let attempts = 0;
  await page.route('**/api/v1/assistant/requests', (route) => {
    const body = route.request().postDataJSON();
    expect(body.academic).toEqual([
      {
        id: work.id,
        expectedVersion: work.version,
        expectedCourseVersion: course.version,
      },
    ]);
    attempts++;
    if (attempts === 1)
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'Reload academic context.',
          },
        },
      });
    const reply = answer(route, {
      proposals: [
        {
          kind: 'task.create',
          academicSource: {
            id: work.id,
            expectedWorkVersion: work.version,
            expectedCourseVersion: course.version,
            title: work.title,
          },
          task: {
            title: 'Draft selected essay',
            dueDate: null,
            notes: '',
            priority: 'normal',
          },
        },
      ],
      status: 'completed',
      reason: null,
      model: 'anthropic/claude-haiku-5.5',
      resultAvailable: true,
      reply: 'Review the essay.',
      dropped: 0,
      withheld: 1,
      costMicros: 1,
      heldMicros: 0,
      createdAt: new Date().toISOString(),
    });
    Object.assign(reply.turn, {
      academic: [
        {
          id: work.id,
          ref: 'w1',
          title: work.title,
          kind: 'assignment',
          dueDate: null,
          estimatedMinutes: null,
          status: 'planned',
          priority: 3,
        },
      ],
    });
    lastTurn = reply.turn;
    return route.fulfill({ json: reply });
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/assistant');
  await page.getByText('Academic work (0/20)', { exact: true }).click();
  await page.getByRole('button', { name: 'Reload academic work' }).click();
  await page.getByRole('checkbox', { name: new RegExp(work.title) }).check();
  await page
    .getByRole('textbox', { name: 'Ask', exact: true })
    .fill('Help with this essay');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(
    page.getByText('Academic work (1/20)', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(
    page.getByText('Academic work (0/20)', { exact: true }),
  ).toBeVisible();
  await page.locator('.turn-details summary').click();
  await expect(
    page.getByText('Manual academic work sent with this ask'),
  ).toBeVisible();
  await expect(page.locator('.turn-details')).toContainText('Effort unknown');
  await expect(page.locator('.turn-details')).toContainText(
    '1 planner, academic or memory item',
  );
  await expect(
    page.getByText(new RegExp('Source: ' + work.title)),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Apply 1 change', exact: true })
    .click();
  await expect(
    page.locator('.assistant__state').getByText('Applied', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    page.locator('.assistant__state').getByText('Undone', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
