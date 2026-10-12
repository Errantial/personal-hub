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
  await expect(
    page.getByRole('region', { name: 'Needs attention' }),
  ).toContainText('Today failed delivery');
  const unread = page.getByRole('region', {
    name: 'Unread reminders (4)',
    exact: true,
  });
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

test('Today groups deadlines without changing them and keeps Canvas separate from study time', async ({
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
  const attention = page.getByRole('region', { name: 'Needs attention' });
  await expect(
    attention.getByText('Today overdue', { exact: true }),
  ).toBeVisible();
  await expect(attention).toContainText(`Due ${yesterday}`);
  await expect(page.getByText('Today finished', { exact: true })).toHaveCount(
    0,
  );
  const due = page.getByRole('region', { name: 'Due today' });
  await expect(due.getByText('Today due', { exact: true })).toBeVisible();
  await expect(due.getByText('Today upcoming', { exact: true })).toBeVisible();
  const schedule = page.getByRole('region', { name: "Today's schedule" });
  await expect(
    schedule.locator('article').filter({ hasText: 'Today reserved study' }),
  ).toContainText('Study time · planned');
  await expect(
    schedule.locator('article').filter({ hasText: 'Today Canvas deadline' }),
  ).toContainText('Deadline');
  await expect(
    schedule.locator('article').filter({ hasText: 'Today Canvas deadline' }),
  ).toContainText('Read only');
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
  const schedule = page.getByRole('region', { name: "Today's schedule" });
  await expect(schedule.getByRole('alert')).toHaveText(
    'Canvas deadlines unavailable. Retry Canvas.',
  );
  await expect(
    page
      .getByRole('region', { name: 'Due today' })
      .getByRole('button', { name: 'Reload tasks' }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Add task', exact: true }),
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
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const capture = page.getByRole('region', { name: 'Quick task capture' });
  await expect(capture.getByLabel('Task title')).toBeFocused();
  await capture.getByLabel('Task title').fill('Today offline capture');
  await capture.getByRole('button', { name: 'Save task', exact: true }).click();
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
