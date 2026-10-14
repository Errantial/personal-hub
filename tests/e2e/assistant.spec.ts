import { expect, test } from '@playwright/test';
import { authenticate } from './auth';

const headers = { Origin: 'http://127.0.0.1:5180' };

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('without a server key the assistant says it is not set up, and the model can still be chosen', async ({
  page,
}) => {
  await page.goto('/');
  const box = page.getByRole('region', { name: 'Assistant' });
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
      json: {
        request: {
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
        },
      },
    });
  });

  await page.goto('/');
  const box = page.getByRole('region', { name: 'Assistant' });
  const form = box.getByRole('form', { name: 'Ask the assistant' });
  await form
    .getByRole('textbox', { name: 'Ask', exact: true })
    .fill('Add buy notebook and push the lab report');
  await form.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(box).toContainText('Added a task and moved the lab report.');
  await expect(box).toContainText('$0.000123');
  await expect(box).toContainText('2 items left out');
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
      json: {
        request: {
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
        },
      },
    }),
  );
  await page.goto('/');
  const box = page.getByRole('region', { name: 'Assistant' });
  await box
    .getByRole('textbox', { name: 'Ask', exact: true })
    .fill('Mark the essay done');
  await box.getByRole('button', { name: 'Ask', exact: true }).click();
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
