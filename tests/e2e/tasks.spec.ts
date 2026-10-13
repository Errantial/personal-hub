import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authenticate } from './auth';
import { addTask, openTask, taskEditor, tasksRegion } from './shell';

const headers = { Origin: 'http://127.0.0.1:5180' };

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

/** Local calendar date, offset in days from today (matches the browser's zone). */
function day(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

async function createTask(
  page: Page,
  title: string,
  extra: Record<string, unknown> = {},
) {
  const reply = await page.request.post('/api/v1/tasks', {
    headers,
    data: { title, operationId: crypto.randomUUID(), ...extra },
  });
  expect(reply.status()).toBe(200);
  return ((await reply.json()) as { task: { id: string } }).task;
}

test('tasks group by deadline and filters have their own URLs', async ({
  page,
}) => {
  await createTask(page, 'Group overdue', { dueDate: day(-1) });
  await createTask(page, 'Group today', { dueDate: day(0) });
  await createTask(page, 'Group week', { dueDate: day(3) });
  await createTask(page, 'Group later', { dueDate: day(30) });
  await createTask(page, 'Group undated');
  await createTask(page, 'Group done', { completed: true });
  await page.goto('/tasks');
  const panel = tasksRegion(page);
  const labels = ['Overdue', 'Today', 'Next 7 days', 'Later', 'No date'];
  await expect(
    panel.getByRole('link', { name: 'Group undated', exact: true }),
  ).toBeVisible();
  const headings = await panel
    .getByRole('heading', { level: 3 })
    .allTextContents();
  expect(headings.filter((text) => labels.includes(text))).toEqual(labels);
  for (const [group, title] of [
    ['Overdue', 'Group overdue'],
    ['Today', 'Group today'],
    ['Next 7 days', 'Group week'],
    ['Later', 'Group later'],
    ['No date', 'Group undated'],
  ]) {
    await expect(
      panel
        .getByRole('region', { name: group, exact: true })
        .getByRole('link', { name: title, exact: true }),
    ).toBeVisible();
  }
  // Completed tasks are not in Open.
  await expect(panel.getByText('Group done', { exact: true })).toHaveCount(0);

  const filters = page.getByRole('navigation', { name: 'Task filters' });
  await filters.getByRole('link', { name: /^Overdue\b/ }).click();
  await expect(page).toHaveURL(/\/tasks\?filter=overdue$/);
  await expect(
    panel.getByRole('link', { name: 'Group overdue', exact: true }),
  ).toBeVisible();
  await expect(panel.getByText('Group today', { exact: true })).toHaveCount(0);

  await filters.getByRole('link', { name: /^Done\b/ }).click();
  await expect(
    panel.getByRole('link', { name: 'Group done', exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('checkbox', { name: 'Complete Group done' }),
  ).toBeChecked();

  await page.goBack();
  await expect(page).toHaveURL(/\/tasks\?filter=overdue$/);
  await page.goto('/tasks?filter=due-soon');
  await expect(
    filters.getByRole('link', { name: /^Due soon\b/ }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    panel.getByRole('link', { name: 'Group week', exact: true }),
  ).toBeVisible();
  await expect(panel.getByText('Group later', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Group overdue', { exact: true })).toHaveCount(
    0,
  );
  await filters.getByRole('link', { name: /^No date\b/ }).click();
  await expect(
    panel.getByRole('link', { name: 'Group undated', exact: true }),
  ).toBeVisible();
  await expect(panel.getByText('Group week', { exact: true })).toHaveCount(0);
});

test('a deleted task can be undone and restored from Recently deleted', async ({
  page,
}) => {
  await page.goto('/tasks');
  const panel = tasksRegion(page);
  await addTask(page, 'Undo me');
  await openTask(page, 'Undo me');
  await taskEditor(page).getByRole('button', { name: 'Delete task' }).click();
  await expect(
    panel.getByText('Deleted “Undo me”.', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(
    panel.getByRole('link', { name: 'Undo me', exact: true }),
  ).toHaveCount(0);
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel.getByText(/^Restored “Undo me”\./)).toBeVisible();
  await expect(
    panel.getByRole('link', { name: 'Undo me', exact: true }),
  ).toBeVisible();

  // Without the Undo notice, the task is still restorable while online.
  await openTask(page, 'Undo me');
  await taskEditor(page).getByRole('button', { name: 'Delete task' }).click();
  await expect(
    panel.getByRole('link', { name: 'Undo me', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await panel.getByText('Recently deleted', { exact: true }).click();
  await panel.getByRole('button', { name: 'Restore Undo me' }).click();
  await expect(panel.getByText(/^Restored “Undo me”\./)).toBeVisible();
  await expect(
    panel.getByRole('link', { name: 'Undo me', exact: true }),
  ).toBeVisible();
  const reply = await page.request.get('/api/v1/tasks');
  const tasks = (await reply.json()).tasks as { title: string }[];
  expect(tasks.filter((task) => task.title === 'Undo me')).toHaveLength(1);
});

test('the editor requires a title and keeps the draft when it is missing', async ({
  page,
}) => {
  const task = await createTask(page, 'Validate me');
  await page.goto(`/tasks/${task.id}`);
  const editor = taskEditor(page);
  const title = editor.getByLabel('Title', { exact: true });
  await expect(title).toHaveValue('Validate me');
  await title.fill('');
  await editor.getByLabel('Notes (optional)').fill('Keep these notes');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByText('Enter a title')).toBeVisible();
  await expect(title).toBeFocused();
  await expect(editor.getByLabel('Notes (optional)')).toHaveValue(
    'Keep these notes',
  );
  await title.fill('Validated');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved.');
  const reply = await page.request.get(`/api/v1/tasks/${task.id}`);
  expect((await reply.json()).task).toMatchObject({
    title: 'Validated',
    notes: 'Keep these notes',
  });
});

test('an unknown task address explains itself and links back to the list', async ({
  page,
}) => {
  await page.goto(`/tasks/${crypto.randomUUID()}`);
  const editor = page.getByRole('region', { name: 'Task editor' });
  await expect(editor).toContainText('This task is not available.');
  await editor.getByRole('link', { name: 'Back to tasks' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
});

for (const { theme, width, target } of [
  { theme: 'standard', width: 1280, target: 44 },
  { theme: 'eink', width: 320, target: 48 },
] as const) {
  test(`list and editor pass accessibility, overflow and target checks (${theme}, ${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(
      (value) => localStorage.setItem('hub:eink', String(value === 'eink')),
      theme,
    );
    const task = await createTask(page, `Layout ${theme}`, {
      dueDate: day(2),
      notes: 'Layout notes',
      priority: 'high',
      sensitivity: 'personal',
    });
    for (const [path, selecting] of [
      ['/tasks', false],
      ['/tasks', true],
      [`/tasks/${task.id}`, false],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tasks');
      await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
      if (selecting) {
        // Selection mode with its widest form (date input) showing.
        await page.getByRole('button', { name: 'Select', exact: true }).click();
        await page.getByLabel('Change').selectOption('Set due date');
      }
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(violations.map((item) => `${path}: ${item.id}`)).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const undersized = await page.evaluate(
        (minimum) =>
          [
            ...document.querySelectorAll<HTMLElement>(
              'main button, main a[href], main input, main select, main textarea, main summary',
            ),
          ]
            .filter((element) => element.offsetParent !== null)
            // A checkbox's tap area is its label (checked separately below).
            .filter(
              (element) => (element as HTMLInputElement).type !== 'checkbox',
            )
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return box.height < minimum - 0.5 || box.width < 24;
            })
            .map(
              (element) =>
                `${element.tagName.toLowerCase()} "${(element.textContent || element.getAttribute('name') || '').trim().slice(0, 30)}" ${Math.round(element.getBoundingClientRect().height)}px`,
            ),
        target,
      );
      expect(undersized, `${path} controls below ${target}px`).toEqual([]);
    }
    if (width < 1024) {
      // Narrow screens show the editor alone, with a way back.
      await expect(page.getByRole('region', { name: /^Open/ })).toBeHidden();
      await page.getByRole('link', { name: 'Back to tasks' }).click();
      await expect(page).toHaveURL(/\/tasks$/);
      await expect(page.getByRole('region', { name: /^Open/ })).toBeVisible();
    } else {
      // Wide screens keep the list beside the editor.
      await expect(page.getByRole('region', { name: /^Open/ })).toBeVisible();
    }
  });
}

test('selected tasks change together, and a change elsewhere blocks the whole batch', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [first, second, third] = await Promise.all(
    ['First', 'Second', 'Third'].map((name) =>
      createTask(page, `${name} ${suffix}`),
    ),
  );
  const current = async (id: string) =>
    (
      (await (await page.request.get(`/api/v1/tasks/${id}`)).json()) as {
        task: { version: number; priority: string; completed: boolean };
      }
    ).task;
  await page.goto('/tasks');
  const panel = tasksRegion(page);
  const bar = panel.getByRole('region', { name: 'Selected tasks' });
  const select = async (name: string) =>
    panel.getByRole('checkbox', { name: `Select ${name} ${suffix}` }).check();

  // One change applies to exactly the selected tasks.
  await panel.getByRole('button', { name: 'Select', exact: true }).click();
  await select('First');
  await select('Second');
  await expect(bar.getByText('2 tasks selected')).toBeVisible();
  await bar.getByLabel('Change').selectOption('Set priority');
  await bar.getByRole('combobox', { name: /^Priority/ }).selectOption('High');
  await bar.getByRole('button', { name: 'Apply to 2 tasks' }).click();
  await expect(
    panel.getByText('Set priority: 2 tasks updated.', { exact: true }),
  ).toBeVisible();
  expect((await current(first.id)).priority).toBe('high');
  expect((await current(second.id)).priority).toBe('high');
  expect((await current(third.id)).priority).toBe('normal');
  await expect(bar).toHaveCount(0);

  // A task changed after selection makes the whole batch fail unchanged.
  await panel.getByRole('button', { name: 'Select', exact: true }).click();
  await select('First');
  await select('Third');
  const { version } = await current(third.id);
  const edit = await page.request.put(`/api/v1/tasks/${third.id}`, {
    headers,
    data: {
      title: `Third ${suffix}`,
      expectedVersion: version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(edit.status()).toBe(200);
  await bar.getByRole('button', { name: 'Apply to 2 tasks' }).click();
  await expect(bar.getByRole('alert')).toContainText(
    'changed or was deleted elsewhere. Nothing was changed.',
  );
  expect((await current(first.id)).completed).toBe(false);
  await bar.getByRole('button', { name: 'Review latest versions' }).click();
  await bar.getByRole('button', { name: 'Apply to 2 tasks' }).click();
  await expect(
    panel.getByText('Mark done: 2 tasks updated.', { exact: true }),
  ).toBeVisible();
  expect((await current(first.id)).completed).toBe(true);
  expect((await current(third.id)).completed).toBe(true);

  // Deleting asks first and points to per-item restore.
  await panel.getByRole('button', { name: 'Select', exact: true }).click();
  await select('Second');
  await bar.getByLabel('Change').selectOption('Delete');
  await bar.getByRole('button', { name: 'Apply to 1 task' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete 1 task?' });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Delete 1 task' }).click();
  await expect(
    panel.getByText('Deleted 1 task. Restore from Recently deleted.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel.getByRole('link', { name: `Second ${suffix}`, exact: true }),
  ).toHaveCount(0);
  await panel.getByText('Recently deleted', { exact: true }).click();
  await expect(
    panel.getByRole('button', { name: `Restore Second ${suffix}` }),
  ).toBeVisible();
});
