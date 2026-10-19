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

const canvasDeadlineFeed = (
  providerId: string,
  first: { title: string; at: string },
  second?: { title: string; at: string },
) => {
  const event = (suffix: string, item: { title: string; at: string }) =>
    `BEGIN:VEVENT\r\nUID:deadline-${providerId}-${suffix}\r\nDTSTART:${item.at}\r\nDTEND:${item.at}\r\nSUMMARY:${item.title}\r\nURL:https://canvas.colorado.edu/courses/1/assignments/${providerId}\r\nEND:VEVENT\r\n`;
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${event('a', first)}${second ? event('b', second) : ''}END:VCALENDAR\r\n`;
};

async function importTrackedDeadline(
  page: Page,
  providerId: string,
  first: { title: string; at: string },
  second?: { title: string; at: string },
) {
  const reply = await page.request.post('/api/v1/connections/canvas/import', {
    headers,
    data: {
      operationId: crypto.randomUUID(),
      feed: canvasDeadlineFeed(providerId, first, second),
    },
  });
  expect(reply.status()).toBe(200);
  const deadlines = (
    await (
      await page.request.get('/api/v1/deadlines?status=all&limit=200')
    ).json()
  ).deadlines as Array<{
    id: string;
    title: string;
    canonicalKey: string;
    version: number;
    dueOverride: unknown;
    sourceConflict: boolean;
  }>;
  const tracked = deadlines.find((item) =>
    item.canonicalKey.endsWith(`/courses/1/assignments/${providerId}`),
  );
  expect(tracked).toBeDefined();
  return tracked!;
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

test('an ambiguous owner due time requires a fold choice and can clear time without clearing date', async ({
  page,
}) => {
  await page.goto('/tasks');
  const panel = tasksRegion(page);
  await panel.getByRole('button', { name: 'Add task', exact: true }).click();
  const capture = panel.getByRole('region', { name: 'Quick task capture' });
  await capture.getByLabel('Task title').fill('DST deadline');
  await capture.getByLabel('Due date (optional)').fill('2027-11-07');
  await capture.getByLabel('Due time (optional)').fill('01:30');
  await capture.getByLabel('Timezone').fill('America/New_York');
  await expect(
    capture.getByText('This due time happens twice. Choose one.'),
  ).toBeVisible();
  await capture.getByLabel(/^Later \(/).check();
  await capture.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(
    panel.getByRole('link', { name: 'DST deadline', exact: true }),
  ).toBeVisible();

  const saved = (
    (await (await page.request.get('/api/v1/tasks')).json()) as {
      tasks: Array<{
        id: string;
        title: string;
        dueDate: string | null;
        dueAt: string | null;
        dueTimeZone: string | null;
      }>;
    }
  ).tasks.find((task) => task.title === 'DST deadline');
  expect(saved).toMatchObject({
    dueDate: '2027-11-07',
    dueAt: '2027-11-07T06:30:00.000Z',
    dueTimeZone: 'America/New_York',
  });

  await openTask(page, 'DST deadline');
  const editor = taskEditor(page);
  await expect(editor.getByLabel('Due time (optional)')).toHaveValue('01:30');
  await expect(editor.getByLabel('Timezone')).toHaveValue('America/New_York');
  await expect(editor.getByLabel(/^Later \(/)).toBeChecked();
  await editor.getByLabel('Due time (optional)').fill('');
  await expect(editor.getByLabel('Timezone')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved.');
  const cleared = await page.request.get(`/api/v1/tasks/${saved!.id}`);
  expect((await cleared.json()).task).toMatchObject({
    dueDate: '2027-11-07',
    dueAt: null,
    dueTimeZone: null,
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

test('imported Canvas deadlines are locally editable/completable, preserve overrides through source refresh and review provider conflicts', async ({
  page,
  context,
}) => {
  const providerId = '991236';
  const tracked = await importTrackedDeadline(
    page,
    providerId,
    { title: 'Canvas provider deadline', at: '20300301T170000Z' },
    { title: 'Canvas alternate deadline', at: '20300301T180000Z' },
  );
  expect(tracked.sourceConflict).toBe(true);

  await page.goto('/tasks');
  const tasks = tasksRegion(page);
  const imported = tasks.getByRole('region', { name: 'Imported deadlines' });
  const title = imported.getByRole('link', {
    name: 'Canvas provider deadline',
    exact: true,
  });
  await expect(title).toBeVisible();
  await expect(imported.getByText('Canvas sources differ')).toBeVisible();
  await imported
    .getByRole('button', { name: 'Help: Imported deadlines' })
    .click();
  await expect(imported).toContainText(
    'do not submit, reopen or change work in Canvas',
  );

  const complete = imported.getByRole('checkbox', {
    name: 'Complete Canvas provider deadline in Personal Hub',
  });
  await complete.click();
  await expect(title).toHaveCount(0);
  await imported
    .getByRole('button', { name: 'Completed', exact: true })
    .click();
  const reopen = imported.getByRole('checkbox', {
    name: 'Reopen Canvas provider deadline in Personal Hub',
  });
  await expect(reopen).toBeChecked();
  await reopen.click();
  await imported.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(title).toBeVisible();

  await title.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/deadline/${tracked.id}$`));
  const editor = page.getByRole('region', { name: 'Edit imported deadline' });
  await expect(editor).toContainText(
    'Edits and completion are local to Personal Hub. Nothing here submits or reopens Canvas work.',
  );
  await expect(editor.getByText('Canvas sources disagree.')).toBeVisible();
  await expect(
    editor.getByText('Canvas provider deadline', { exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByText('Canvas alternate deadline', { exact: true }),
  ).toBeVisible();
  const canvasLink = editor.getByRole('link', { name: 'Open in Canvas' });
  await expect(canvasLink).toHaveAttribute(
    'href',
    `https://canvas.colorado.edu/courses/1/assignments/${providerId}`,
  );
  await expect(canvasLink).toHaveAttribute('target', '_blank');

  await context.setOffline(true);
  await expect(
    editor.getByText('Imported deadline changes need a connection.'),
  ).toBeVisible();
  await expect(
    editor.getByRole('button', { name: 'Save Personal Hub changes' }),
  ).toBeDisabled();
  await context.setOffline(false);

  await editor
    .getByLabel('Personal Hub title override (optional)')
    .fill('My local deadline');
  await editor.getByLabel('Personal Hub due override').check();
  await editor.getByLabel('Due date (optional)').fill('2030-03-02');
  await editor.getByLabel('Due time (optional)').fill('14:30');
  await editor.getByLabel('Timezone').fill('UTC');
  await editor.getByLabel('Priority').selectOption('high');
  await editor.getByLabel('Notes (optional)').fill('Local planning notes');
  await editor
    .getByRole('combobox', { name: 'Content label', exact: true })
    .selectOption('personal');
  await editor
    .getByRole('button', { name: 'Save Personal Hub changes' })
    .click();
  await expect(
    editor.getByText('Saved in Personal Hub. Canvas was not changed.', {
      exact: true,
    }),
  ).toBeVisible();
  let current = (
    await (await page.request.get(`/api/v1/deadlines/${tracked.id}`)).json()
  ).deadline;
  expect(current).toMatchObject({
    titleOverride: 'My local deadline',
    priority: 'high',
    notes: 'Local planning notes',
    sensitivity: 'personal',
    dueOverride: {
      kind: 'timed',
      dueAt: '2030-03-02T14:30:00.000Z',
      timeZone: 'UTC',
    },
  });

  await importTrackedDeadline(
    page,
    providerId,
    { title: 'Canvas refreshed provider', at: '20300303T190000Z' },
    { title: 'Canvas refreshed alternate', at: '20300303T200000Z' },
  );
  await page.reload();
  await expect(editor.getByLabel('Personal Hub due override')).toBeChecked();
  await expect(
    editor.getByLabel('Personal Hub title override (optional)'),
  ).toHaveValue('My local deadline');
  await expect(
    editor.getByText('Canvas refreshed provider', { exact: true }),
  ).toBeVisible();
  await expect(editor.getByLabel('Due date (optional)')).toHaveValue(
    '2030-03-02',
  );

  await editor.getByRole('button', { name: 'Use Canvas value' }).click();
  await editor
    .getByRole('button', { name: 'Save Personal Hub changes' })
    .click();
  current = (
    await (await page.request.get(`/api/v1/deadlines/${tracked.id}`)).json()
  ).deadline;
  expect(current.dueOverride).toEqual({ kind: 'provider' });
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
    const tracked = await importTrackedDeadline(
      page,
      theme === 'standard' ? '991240' : '991241',
      {
        title: `Imported layout ${theme}`,
        at: '20300501T170000Z',
      },
    );
    for (const [path, selecting] of [
      ['/tasks', false],
      ['/tasks', true],
      [`/tasks/${task.id}`, false],
      [`/tasks/deadline/${tracked.id}`, false],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tasks');
      await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
      if (selecting) {
        // Selection mode with its widest form (date input) showing.
        await page.getByRole('button', { name: 'Select', exact: true }).click();
        await page
          .getByRole('region', { name: 'Selected tasks' })
          .getByRole('combobox')
          .selectOption('Set due date');
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
            // Checkbox/radio tap areas are their labels (checked separately below).
            .filter(
              (element) =>
                !['checkbox', 'radio'].includes(
                  (element as HTMLInputElement).type,
                ),
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
