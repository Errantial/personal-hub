import { expect, test } from '@playwright/test';
import { Temporal } from '@hub/contracts';
import { authenticate } from './auth';
import { syncNow, syncState } from './shell';

const headers = { Origin: 'http://127.0.0.1:5180' };
test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('Today shows failed delivery and the latest three unread reminders without marking them read', async ({
  page,
}) => {
  const now = new Date().toISOString();
  await page.route('**/api/v1/reminders', (route) =>
    route.fulfill({
      json: {
        reminders: [
          {
            id: crypto.randomUUID(),
            version: 1,
            title: 'Today failed delivery',
            scheduledAt: now,
            targetKind: null,
            targetId: null,
            occurrenceDate: null,
            status: 'failed',
            attempts: 3,
            lastError: 'SYNTHETIC_FAILURE',
            createdAt: now,
            updatedAt: now,
          },
        ],
        worker: { healthy: true, lastTick: now, errorCode: null },
      },
    }),
  );
  await page.route('**/api/v1/notifications', (route) =>
    route.fulfill({
      json: {
        notifications: Array.from({ length: 5 }, (_, index) => ({
          id: crypto.randomUUID(),
          reminderId: crypto.randomUUID(),
          title: `Today notification ${index}`,
          createdAt: new Date(Date.now() - index * 1000).toISOString(),
          readAt: index === 4 ? now : null,
        })),
      },
    }),
  );
  const reads: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /notifications.*read/.test(request.url())
    )
      reads.push(request.url());
  });
  await page.goto('/today');
  await expect(page.getByRole('region', { name: 'Overdue' })).toContainText(
    'Today failed delivery',
  );
  const unread = page.getByRole('group', { name: 'Unread reminders · 4' });
  await unread.getByText('Unread reminders · 4').click();
  for (const index of [0, 1, 2])
    await expect(
      unread.getByText(`Today notification ${index}`, { exact: true }),
    ).toBeVisible();
  await expect(
    unread.getByText('Today notification 3', { exact: true }),
  ).toHaveCount(0);
  await expect(
    unread.getByText('Today notification 4', { exact: true }),
  ).toHaveCount(0);
  expect(reads).toEqual([]);
});

test('Today lists deadlines, due tasks, events and study in one ordered list', async ({
  page,
}) => {
  await page.goto('/today');
  const date = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  const yesterday = Temporal.PlainDate.from(date)
    .subtract({ days: 1 })
    .toString();
  const tomorrow = Temporal.PlainDate.from(date).add({ days: 1 }).toString();
  for (const [title, dueDate, completed] of [
    ['Today overdue', yesterday, false],
    ['Today due', date, false],
    ['Today upcoming', tomorrow, false],
    ['Today finished', yesterday, true],
  ] as const) {
    expect(
      (
        await page.request.post('/api/v1/tasks', {
          headers,
          data: { title, dueDate, completed, operationId: crypto.randomUUID() },
        })
      ).ok(),
    ).toBe(true);
  }
  const course = await page.request.post('/api/v1/courses', {
    headers,
    data: { name: 'Today class', operationId: crypto.randomUUID() },
  });
  const courseId = (await course.json()).course.id;
  const zone = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const start = Temporal.PlainDate.from(date)
    .toZonedDateTime({ timeZone: zone, plainTime: '12:00' })
    .toInstant();
  expect(
    (
      await page.request.post('/api/v1/calendar', {
        headers,
        data: {
          title: 'Today reserved study',
          startsAt: start.toString(),
          endsAt: start.add({ hours: 1 }).toString(),
          timeZone: zone,
          courseId,
          operationId: crypto.randomUUID(),
        },
      })
    ).ok(),
  ).toBe(true);
  const instant = start.toString().replace(/[-:]/g, '');
  expect(
    (
      await page.request.post('/api/v1/connections/canvas/import', {
        headers,
        data: {
          operationId: crypto.randomUUID(),
          feed: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:today-deadline\r\nDTSTART:${instant}\r\nDTEND:${instant}\r\nSUMMARY:Today Canvas deadline\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
        },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  const attention = page.getByRole('region', { name: 'Overdue' });
  await expect(
    attention.getByText('Today overdue', { exact: true }),
  ).toBeVisible();
  await expect(attention).toContainText(
    `Due ${new Date(yesterday).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    })}`,
  );
  await expect(page.getByText('Today finished', { exact: true })).toHaveCount(
    0,
  );
  const list = page.getByRole('region', { name: 'Today' });
  const rows = list.getByRole('listitem');
  await expect(rows.filter({ hasText: 'Today reserved study' })).toBeVisible();
  await expect(rows.filter({ hasText: 'Today Canvas deadline' })).toBeVisible();
  const titles = ['Today due', 'Today Canvas deadline', 'Today reserved study'];
  const order = await Promise.all(
    titles.map(async (title) =>
      (await rows.allTextContents()).findIndex((text) => text.includes(title)),
    ),
  );
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  await expect(rows.filter({ hasText: 'Today due' })).toContainText('Task');
  await expect(rows.filter({ hasText: 'Today due' })).toContainText(
    'Due today',
  );
  await expect(rows.filter({ hasText: 'Today Canvas deadline' })).toContainText(
    'Deadline',
  );
  await expect(rows.filter({ hasText: 'Today reserved study' })).toContainText(
    'Study',
  );
  const week = page.getByRole('group', { name: /^Next 7 days · \d+$/ });
  await week.getByText(/^Next 7 days/).click();
  await expect(week.getByText('Today upcoming', { exact: true })).toBeVisible();
  const records = (await (await page.request.get('/api/v1/tasks')).json())
    .tasks;
  expect(
    records.find((item: { title: string }) => item.title === 'Today overdue')
      .dueDate,
  ).toBe(yesterday);
});

test('a failed Canvas section preserves planner content and retries independently', async ({
  page,
}) => {
  await page.route('**/api/v1/connections/canvas/calendar?**', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }),
  );
  await page.goto('/today');
  const schedule = page.getByRole('region', { name: 'Today' });
  await expect(schedule.getByRole('alert')).toHaveText(
    'Canvas deadlines unavailable. Retry Canvas.',
  );
  await expect(
    schedule.getByRole('button', { name: 'Reload tasks' }),
  ).toBeEnabled();
  await expect(
    page
      .getByRole('region', { name: 'Add or ask' })
      .getByRole('textbox', { name: 'Add a task' }),
  ).toBeEnabled();
  await page.unroute('**/api/v1/connections/canvas/calendar?**');
  await schedule
    .getByRole('button', { name: 'Retry Canvas', exact: true })
    .click();
  await expect(schedule.getByRole('alert')).toHaveCount(0);
});

test('cached Today and quick capture survive offline reload and replay once at 320px e-ink', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.addInitScript(() => localStorage.setItem('hub:eink', 'true'));
  await page.goto('/today');
  await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Reload schedule' }),
  ).toBeEnabled();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(/^Cached schedule:/)).toBeVisible();
  const capture = page.getByRole('region', { name: 'Add or ask' });
  await capture
    .getByRole('textbox', { name: 'Add a task' })
    .fill('Today offline capture');
  await capture.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(capture.getByRole('status')).toHaveText('Task queued for sync.');
  await expect(syncState(page)).toContainText('1 queued');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await expect(syncState(page)).toContainText('1 queued');
  await context.setOffline(false);
  await syncNow(page);
  await expect(syncState(page)).toContainText('All saved');
  const records = (await (await page.request.get('/api/v1/tasks')).json())
    .tasks as { title: string }[];
  expect(
    records.filter((item) => item.title === 'Today offline capture'),
  ).toHaveLength(1);
});

test('the Today command bar adds a task, remembers its mode and sends asks to the Assistant page', async ({
  page,
}) => {
  let settings = {
    model: 'anthropic/claude-haiku-5.5',
    version: 1,
    configured: true,
    allowPersonalMail: false,
    useMail: true,
  };
  await page.route('**/api/v1/assistant/settings', (route) =>
    route.fulfill({ json: { settings } }),
  );
  let sent: { text: string; conversationId: string; useMail: boolean } | null =
    null;
  await page.route('**/api/v1/assistant/requests', (route) => {
    sent = route.request().postDataJSON();
    const id = crypto.randomUUID();
    const request = {
      id,
      status: 'completed',
      reason: null,
      model: settings.model,
      resultAvailable: true,
      reply: 'Done.',
      proposals: [],
      dropped: 0,
      withheld: 0,
      costMicros: 10,
      heldMicros: 0,
      createdAt: new Date().toISOString(),
    };
    return route.fulfill({
      json: {
        request,
        turn: {
          id,
          conversationId: sent!.conversationId,
          ask: sent!.text,
          version: 1,
          request,
          items: [],
        },
      },
    });
  });
  const title = `Buy stamps ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto('/');
  const bar = page.getByRole('region', { name: 'Add or ask' });
  await expect(bar.getByRole('radio', { name: 'Add task' })).toBeChecked();
  const field = bar.getByRole('textbox', { name: 'Add a task' });
  await field.fill(title);
  await field.press('Enter');
  await expect(bar.getByRole('status')).toHaveText('Task saved.');
  const tasks = (await (await page.request.get('/api/v1/tasks')).json())
    .tasks as { title: string }[];
  expect(tasks.some((task) => task.title === title)).toBe(true);

  await bar.getByRole('radio', { name: 'Ask assistant' }).check();
  const ask = bar.getByRole('textbox', { name: 'Ask the assistant' });
  await ask.fill('What is due this week?');
  await ask.press('Enter');
  await expect(page).toHaveURL(/\/assistant\/[0-9a-f-]{36}$/);
  expect(sent).toMatchObject({ text: 'What is due this week?', useMail: true });

  await page.goto('/');
  await expect(
    page
      .getByRole('region', { name: 'Add or ask' })
      .getByRole('radio', { name: 'Ask assistant' }),
  ).toBeChecked();

  settings = { ...settings, configured: false };
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Add or ask' })
      .getByRole('radio', { name: 'Ask assistant' }),
  ).toBeDisabled();
});

/** Serves one task list and no reminders, for layout checks. */
async function stubLists(
  page: import('@playwright/test').Page,
  tasks: { title: string; dueDate: string | null }[],
  unread = 0,
) {
  const now = new Date().toISOString();
  await page.route('**/api/v1/tasks', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            tasks: tasks.map((task) => ({
              id: crypto.randomUUID(),
              title: task.title,
              notes: '',
              dueDate: task.dueDate,
              priority: 'normal',
              completed: false,
              sensitivity: 'unlabeled',
              version: 1,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            })),
          },
        })
      : route.continue(),
  );
  await page.route('**/api/v1/reminders', (route) =>
    route.fulfill({
      json: {
        reminders: [],
        worker: { healthy: true, lastTick: now, errorCode: null },
      },
    }),
  );
  await page.route('**/api/v1/notifications', (route) =>
    route.fulfill({
      json: {
        notifications: Array.from({ length: unread }, (_, index) => ({
          id: crypto.randomUUID(),
          reminderId: crypto.randomUUID(),
          title: `Unread ${index}`,
          createdAt: now,
          readAt: null,
        })),
      },
    }),
  );
}
const localToday = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });

test('Overdue appears only when something is overdue or failed', async ({
  page,
}) => {
  await page.goto('/today');
  const date = await localToday(page);
  await stubLists(page, [{ title: 'Later', dueDate: date }]);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Today' })).toContainText(
    'Later',
  );
  await expect(page.getByRole('region', { name: 'Overdue' })).toHaveCount(0);
  await page.unroute('**/api/v1/tasks');
  const yesterday = Temporal.PlainDate.from(date)
    .subtract({ days: 1 })
    .toString();
  await stubLists(page, [{ title: 'Late one', dueDate: yesterday }]);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Overdue' })).toContainText(
    'Late one',
  );
});

test('Next 7 days and Unread reminders are collapsed with counts', async ({
  page,
}) => {
  await page.goto('/today');
  const date = await localToday(page);
  const soon = Temporal.PlainDate.from(date).add({ days: 2 }).toString();
  await stubLists(page, [{ title: 'Soon task', dueDate: soon }], 3);
  await page.reload();
  const week = page.getByRole('group', { name: 'Next 7 days · 1' });
  await expect(week.getByText('Soon task')).toBeHidden();
  await week.getByText('Next 7 days · 1').click();
  await expect(week.getByText('Soon task')).toBeVisible();
  const unread = page.getByRole('group', { name: 'Unread reminders · 3' });
  await expect(unread.getByText('Unread 0')).toBeHidden();
  await unread.getByText('Unread reminders · 3').click();
  await expect(unread.getByText('Unread 0')).toBeVisible();
});
