import { expect, test } from '@playwright/test';
import {
  addTask,
  calendarRegion,
  eventEditor,
  newEvent,
  open,
  openSettings,
  openTask,
  showCalendar,
  showTasks,
  taskEditor,
  tasksRegion,
  toggleEink,
  syncState,
  signOut,
  expectConnected,
} from './shell';
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
  await expectConnected(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Today');
  await openSettings(page, 'Connections');
  await expect(
    page.getByRole('heading', { name: 'School Outlook' }),
  ).toBeVisible();
  await expect(
    page.getByText('Not available yet', { exact: true }),
  ).toHaveCount(1);
  await expect(
    page
      .getByRole('article', { name: 'School Outlook' })
      .getByRole('link', { name: 'Review Outlook access' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('article', { name: 'Canvas' })
      .getByText('Feed not configured', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('e-ink appearance persists across reload and can be switched off', async ({
  page,
}) => {
  await page.goto('/');
  await openSettings(page, 'Appearance');
  await page.getByRole('checkbox', { name: 'Use e-ink mode' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'eink');
  await page.reload();
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button', { name: /E-ink mode/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await toggleEink(page);
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
  await expectConnected(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('small-screen navigation and content fit without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await expectConnected(page);
  const fits = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
  for (const name of ['Today', 'Tasks', 'Inbox'] as const) {
    await open(page, name);
    expect(await fits()).toBe(true);
  }
  for (const section of ['Account', 'Connections', 'AI'] as const) {
    await openSettings(page, section);
    expect(await fits()).toBe(true);
  }
  // More closes on Escape and returns focus to its button.
  const more = page.getByRole('button', { name: /^More/ });
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
});

test('tasks survive reload, support edits/completion/deletion, and carry owner labels', async ({
  page,
}) => {
  await page.goto('/tasks');
  const panel = tasksRegion(page);
  await addTask(page, 'Browser planner task', '2026-11-05');
  await page.reload();
  await expect(
    panel.getByText('Browser planner task', { exact: true }),
  ).toBeVisible();
  await openTask(page, 'Browser planner task');
  const editor = taskEditor(page);
  await editor.getByLabel('Title', { exact: true }).fill('Edited browser task');
  await editor
    .getByRole('combobox', { name: 'Content label' })
    .selectOption('personal');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved.');
  const row = panel.getByRole('listitem').filter({
    has: page.getByRole('checkbox', {
      name: 'Complete Edited browser task',
      exact: true,
    }),
  });
  await expect(row.getByText('Personal', { exact: true })).toBeVisible();
  await expect(row).toContainText('Due Thu, Nov 5, 2026');
  // Completing moves the task from Open to Done.
  await row.getByRole('checkbox').click();
  await expect(row).toHaveCount(0);
  await showTasks(page, 'Done');
  await expect(row.getByRole('checkbox')).toBeChecked();
  await openTask(page, 'Edited browser task');
  await taskEditor(page).getByRole('button', { name: 'Delete task' }).click();
  await expect(
    panel.getByText('Deleted “Edited browser task”.', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('link', { name: 'Edited browser task' }),
  ).toHaveCount(0);
});

test('a lost save response can be retried without creating a duplicate', async ({
  page,
}) => {
  await page.goto('/tasks');
  const panel = tasksRegion(page);
  await panel.getByRole('button', { name: 'Add task', exact: true }).click();
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
  await panel.getByRole('button', { name: 'Save task', exact: true }).click();
  // A lost response is saved to the durable queue and retried with the same ID.
  await expect(
    panel.getByText('Lost response task', { exact: true }),
  ).toHaveCount(1);
  await expect(syncState(page)).toContainText('All saved');
  const response = await page.request.get('/api/v1/tasks');
  const data = (await response.json()) as { tasks: { title: string }[] };
  expect(
    data.tasks.filter((task) => task.title === 'Lost response task'),
  ).toHaveLength(1);
});

test('events reject reversed times and persist valid times with their display timezone', async ({
  page,
}) => {
  await page.goto('/calendar');
  await showCalendar(page, { date: '2026-11-05', view: 'Agenda' });
  await newEvent(page);
  const editor = eventEditor(page);
  await editor.getByLabel('Title', { exact: true }).fill('Browser study time');
  await editor.getByLabel('Starts', { exact: true }).fill('2026-11-05T10:00');
  await editor.getByLabel('Ends', { exact: true }).fill('2026-11-05T09:00');
  await editor
    .getByLabel('Event timezone', { exact: true })
    .fill('America/Denver');
  await editor.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(
    editor.getByText('The end must be after the start.'),
  ).toBeVisible();
  await expect(editor.getByLabel('Ends', { exact: true })).toBeFocused();
  await editor.getByLabel('Ends', { exact: true }).fill('2026-11-05T11:00');
  await editor.getByRole('button', { name: 'Save event', exact: true }).click();
  const panel = calendarRegion(page);
  await expect(
    panel.getByRole('link', { name: 'Browser study time', exact: true }),
  ).toBeVisible();
  await page.reload();
  await showCalendar(page, { date: '2026-11-05', view: 'Agenda' });
  await panel
    .getByRole('link', { name: 'Browser study time', exact: true })
    .click();
  await expect(
    eventEditor(page).getByLabel('Event timezone', { exact: true }),
  ).toHaveValue('America/Denver');
  await eventEditor(page)
    .getByRole('button', { name: 'Delete event', exact: true })
    .click();
  await expect(
    panel.getByRole('link', { name: 'Browser study time', exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByText('Deleted “Browser study time”.', { exact: true }),
  ).toBeVisible();
});

test('sign-out removes access and login restores the workspace', async ({
  page,
}) => {
  await page.goto('/');
  await signOut(page);
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  expect((await page.request.get('/api/v1/tasks')).status()).toBe(401);
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expectConnected(page);
});

test('a conflict preserves the draft and loading the latest version enables a deliberate retry', async ({
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
  await page.goto('/tasks');
  await openTask(page, 'Conflict original');
  const panel = tasksRegion(page);
  const editor = taskEditor(page);
  await editor.getByLabel('Title', { exact: true }).fill('Preserved draft');
  const elsewhere = await page.request.put(`/api/v1/tasks/${item.id}`, {
    headers: { Origin: origin },
    data: {
      title: 'Changed elsewhere',
      expectedVersion: item.version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(elsewhere.status()).toBe(200);
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('alert')).toContainText('Changed elsewhere');
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(
    'Preserved draft',
  );
  // Save stays disabled until the owner deliberately loads the latest version.
  await expect(
    editor.getByRole('button', { name: 'Save changes' }),
  ).toBeDisabled();
  await editor.getByRole('button', { name: 'Load latest version' }).click();
  await expect(
    panel.getByRole('link', { name: 'Changed elsewhere', exact: true }),
  ).toBeVisible();
  await expect(editor.getByText('Latest: Changed elsewhere')).toBeVisible();
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(
    'Preserved draft',
  );
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    panel.getByRole('link', { name: 'Preserved draft', exact: true }),
  ).toBeVisible();
  await expect(editor.getByRole('alert')).toHaveCount(0);
});

test('views have URLs that survive reload and browser Back/Forward', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/today$/);
  await open(page, 'Calendar');
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page).toHaveTitle('Calendar · Personal Hub');
  await open(page, 'Settings');
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Calendar');
  await page.goForward();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'AI', exact: true })
    .click();
  await expect(page).toHaveTitle('AI · Settings · Personal Hub');
  // Addresses from before the navigation change redirect.
  await page.goto('/reminders');
  await expect(page).toHaveURL(/\/inbox$/);
  await page.goto('/preferences');
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page.goto('/not-a-view');
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Today');
});

test('the sign-in screen uses the stored e-ink appearance', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('hub:eink', 'true'));
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'eink');
  await context.close();
});
