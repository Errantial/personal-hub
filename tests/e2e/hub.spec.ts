import { expect, test } from '@playwright/test';
import { authenticate } from './auth';

const credentials = {
  email: 'browser@example.test',
  password: 'synthetic-browser-password',
};
test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('web and API connect and show the actual scaffold account state', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.api-indicator')).toHaveText('Hub API connected');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Today');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'School Outlook' }),
  ).toBeVisible();
  await expect(page.getByText('Not connected', { exact: true })).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('e-ink appearance persists across reload and can be switched off', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Use e-ink mode' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'eink');
  await page.reload();
  await expect(
    page.getByRole('button', { name: /E-ink mode/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /E-ink mode/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'standard');
});

test('the workspace stays usable during API failure and retry recovers', async ({
  page,
}) => {
  await page.route('**/api/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText(
    'The hub server is unavailable.',
  );
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.unroute('**/api/**');
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.locator('.api-indicator')).toHaveText('Hub API connected');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('small-screen navigation and content fit without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await expect(page.locator('.api-indicator')).toHaveText('Hub API connected');
  for (const name of ['Today', 'Connections', 'Preferences']) {
    await page.getByRole('button', { name, exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

test('tasks survive reload, support edits/completion/deletion, and carry owner labels', async ({
  page,
}) => {
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Tasks' });
  await panel.getByLabel('Task title').fill('Browser planner task');
  await panel.getByLabel('Due date').fill('2026-11-05');
  await panel.getByLabel('Content label').selectOption('personal');
  await panel.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(
    panel.getByText('Browser planner task', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    panel.getByText('Browser planner task', { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole('button', { name: 'Edit Browser planner task', exact: true })
    .click();
  await panel.getByLabel('Task title').fill('Edited browser task');
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await panel
    .getByRole('checkbox', { name: 'Complete Edited browser task' })
    .check();
  await expect(
    panel.getByRole('checkbox', { name: 'Complete Edited browser task' }),
  ).toBeChecked();
  await expect(panel.getByText('personal', { exact: true })).toBeVisible();
  await panel
    .getByRole('button', { name: 'Delete Edited browser task' })
    .click();
  await expect(
    panel.getByText('Edited browser task', { exact: true }),
  ).toHaveCount(0);
});

test('a lost save response can be retried without creating a duplicate', async ({
  page,
}) => {
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Tasks' });
  await panel.getByLabel('Task title').fill('Lost response task');
  let interrupted = false;
  await page.route('**/api/v1/tasks', async (route) => {
    if (route.request().method() === 'POST' && !interrupted) {
      interrupted = true;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort();
    } else await route.continue();
  });
  await panel.getByRole('button', { name: 'Add task', exact: true }).click();
  // A lost response is saved to the durable queue and retried with the same ID.
  await expect(
    panel.getByText('Lost response task', { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Task sync' })).toContainText(
    '0 pending changes',
  );
  const response = await page.request.get('/api/v1/tasks');
  const data = (await response.json()) as { tasks: { title: string }[] };
  expect(
    data.tasks.filter((task) => task.title === 'Lost response task'),
  ).toHaveLength(1);
});

test('events reject reversed times and persist valid times with their display timezone', async ({
  page,
}) => {
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Events' });
  await panel.getByLabel('Event title').fill('Browser study time');
  await panel.getByLabel('Starts', { exact: true }).fill('2026-11-05T10:00');
  await panel.getByLabel('Ends', { exact: true }).fill('2026-11-05T09:00');
  await panel.getByLabel('Display timezone').fill('America/Denver');
  await panel.getByRole('button', { name: 'Add event', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(
    'Check the entered values',
  );
  await panel.getByLabel('Ends', { exact: true }).fill('2026-11-05T11:00');
  await panel.getByRole('button', { name: 'Add event', exact: true }).click();
  await expect(
    panel.getByText('Browser study time', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    panel.getByText('Browser study time', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.locator('li').filter({ hasText: 'Browser study time' }),
  ).toContainText('America/Denver');
  await panel
    .getByRole('button', { name: 'Delete Browser study time' })
    .click();
  await expect(
    panel.getByText('Browser study time', { exact: true }),
  ).toHaveCount(0);
});

test('sign-out removes access and login restores the workspace', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  expect((await page.request.get('/api/v1/tasks')).status()).toBe(401);
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.api-indicator')).toHaveText('Hub API connected');
});

test('a conflict preserves the draft and reload enables a deliberate retry', async ({
  page,
}) => {
  const origin = 'http://127.0.0.1:5180';
  const created = await page.request.post('/api/v1/tasks', {
    headers: { Origin: origin },
    data: { title: 'Conflict original', operationId: crypto.randomUUID() },
  });
  const item = (
    (await created.json()) as { task: { id: string; version: number } }
  ).task;
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Tasks' });
  await panel
    .getByRole('button', { name: 'Edit Conflict original', exact: true })
    .click();
  await panel.getByLabel('Task title').fill('Preserved draft');
  const elsewhere = await page.request.put(`/api/v1/tasks/${item.id}`, {
    headers: { Origin: origin },
    data: {
      title: 'Changed elsewhere',
      expectedVersion: item.version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(elsewhere.status()).toBe(200);
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByRole('alert')).toContainText('changed elsewhere');
  await expect(panel.getByLabel('Task title')).toHaveValue('Preserved draft');
  await panel.getByRole('button', { name: 'Reload list' }).click();
  await expect(
    panel.getByText('Changed elsewhere', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByLabel('Task title')).toHaveValue('Preserved draft');
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    panel.getByText('Preserved draft', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});
