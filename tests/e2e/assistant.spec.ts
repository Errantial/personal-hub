import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
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

/** Saving applied state echoes the items back, as the server does. */
async function stubItems(page: Page) {
  let version = 1;
  await page.route('**/api/v1/assistant/turns/*/items', (route) => {
    const body = route.request().postDataJSON() as { items: unknown[] };
    version += 1;
    return route.fulfill({
      json: {
        turn: (lastTurn = { ...lastTurn, version, items: body.items }),
      },
    });
  });
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
});

test('without a server key the assistant says it is not set up, and the model can still be chosen', async ({
  page,
}) => {
  await stubThread(page);
  await page.goto('/assistant');
  const box = page.locator('main');
  await expect(box).toContainText('Not set up');
  await expect(
    box.getByRole('form', { name: 'Ask the assistant' }),
  ).toHaveCount(0);

  await page.goto('/settings/ai');
  const settings = page.getByRole('region', { name: /^Assistant/ });
  await expect(settings).toContainText('Not set up');
  const model = settings.getByRole('textbox', { name: 'Model', exact: true });
  const current = await model.inputValue();
  await model.fill('not a model');
  await settings.getByRole('button', { name: 'Save model' }).click();
  await expect(settings.getByText(/Use an OpenRouter model ID/)).toBeVisible();
  const next =
    current === 'anthropic/claude-sonnet-5.5'
      ? 'anthropic/claude-haiku-5.5'
      : 'anthropic/claude-sonnet-5.5';
  await model.fill(next);
  await settings.getByRole('button', { name: 'Save model' }).click();
  // Saved: the form reloads with the new value and nothing left to save.
  await expect(
    settings.getByRole('button', { name: 'Save model' }),
  ).toBeDisabled();
  await expect(model).toHaveValue(next);
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/v1/assistant/settings')).json())
          .settings.model,
    )
    .toBe(next);
});

test('proposed changes apply through the planner and can be undone', async ({
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

  await stubItems(page);
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
  await expect(box.getByText('Applied 2 changes.')).toBeVisible();
  let tasks = await read();
  expect(tasks.find((t) => t.id === task.id)?.dueDate).toBe('2036-03-12');
  expect(tasks.some((t) => t.title === newTitle)).toBe(true);

  await changes.getByRole('button', { name: 'Undo' }).click();
  await expect(box.getByText('Changes undone.')).toBeVisible();
  tasks = await read();
  expect(tasks.find((t) => t.id === task.id)?.dueDate).toBe('2036-03-10');
  expect(tasks.some((t) => t.title === newTitle)).toBe(false);
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
  await stubItems(page);
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

test('a turn shows the ask and reply as chat bubbles with a collapsible details line', async ({
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
      mailWithheld: 2,
      mailNote: null,
      mail: ['Field trip waiver', 'Lunch menu'].map((subject, index) => ({
        id: crypto.randomUUID(),
        subject,
        from: 'School Office',
        receivedAt: new Date().toISOString(),
        read: index === 0,
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
  await expect(sent).toContainText('Body sent');
  const changes = reply.getByRole('group', { name: 'Proposed changes' });
  await expect(
    changes.getByRole('button', { name: 'Apply 1 change' }),
  ).toBeEnabled();
});
