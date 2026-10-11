import { expect, test } from '@playwright/test';
import { open, toggleEink } from './shell';
import { authenticate } from './auth';
test.beforeEach(async ({ page }) => {
  await authenticate(page);
});
test('calendar navigation preserves a stale draft until explicit reload', async ({
  page,
}) => {
  const original = {
    title: 'Calendar conflict original',
    startsAt: '2027-03-08T10:00:00Z',
    endsAt: '2027-03-08T11:00:00Z',
    timeZone: 'UTC',
  };
  const headers = { Origin: 'http://127.0.0.1:5180' };
  const response = await page.request.post('/api/v1/calendar', {
    headers,
    data: { ...original, operationId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(200);
  const item = (await response.json()).event as { id: string; version: number };
  await page.goto('/');
  await open(page, 'Calendar');
  const view = page.getByRole('region', { name: 'Calendar workspace' });
  await view.getByLabel('Calendar date', { exact: true }).fill('2027-03-08');
  const card = view.locator('article').filter({ hasText: original.title });
  await card.getByRole('button', { name: 'Edit event', exact: true }).click();
  await view
    .getByLabel('Calendar event title')
    .fill('Calendar preserved draft');
  const changed = await page.request.put(`/api/v1/calendar/${item.id}`, {
    headers,
    data: {
      ...original,
      title: 'Calendar changed elsewhere',
      expectedVersion: item.version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(changed.status()).toBe(200);
  await view.getByRole('button', { name: 'Day view', exact: true }).click();
  await expect(
    view.getByText('Calendar changed elsewhere', { exact: true }),
  ).toBeVisible();
  await view.getByRole('button', { name: 'Save calendar changes' }).click();
  await expect(view.getByRole('alert')).toContainText('changed elsewhere');
  await expect(view.getByLabel('Calendar event title')).toHaveValue(
    'Calendar preserved draft',
  );
  let releaseReload!: () => void;
  const heldReload = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  await page.route('**/api/v1/calendar', async (route) => {
    if (route.request().method() === 'GET') await heldReload;
    await route.continue();
  });
  await view.getByRole('button', { name: 'Reload calendar' }).click();
  await expect(
    view.getByRole('button', { name: 'Save calendar changes' }),
  ).toBeDisabled();
  await expect(view.getByRole('alert')).toContainText('changed elsewhere');
  releaseReload();
  await expect(view.getByRole('alert')).toHaveCount(0);
  await view.getByRole('button', { name: 'Save calendar changes' }).click();
  await expect(
    view.getByText('Calendar preserved draft', { exact: true }),
  ).toBeVisible();
});
test('calendar shows day/week navigation and edits an all-day recurring occurrence', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await open(page, 'Calendar');
  const view = page.getByRole('region', { name: 'Calendar workspace' });
  await view.getByLabel('Calendar date', { exact: true }).fill('2027-03-08');
  await view
    .getByLabel('Calendar event title')
    .fill('Recurring all-day browser event');
  await view.getByLabel('All-day event', { exact: true }).check();
  await view.getByLabel('First day').fill('2027-03-08');
  await view.getByLabel('Last day').fill('2027-03-08');
  await view
    .getByRole('combobox', { name: 'Repeat', exact: true })
    .selectOption('daily');
  await view.getByLabel('Occurrences (blank = ongoing)').fill('3');
  await view.getByRole('button', { name: 'Save calendar event' }).click();
  const monday = view.getByRole('region', {
    name: 'Agenda 2027-03-08',
    exact: true,
  });
  await expect(
    monday.getByText('Recurring all-day browser event', { exact: true }),
  ).toBeVisible();
  await expect(monday.getByText('All day', { exact: true })).toBeVisible();
  await monday
    .getByRole('button', { name: 'Edit occurrence', exact: true })
    .click();
  await view.getByLabel('Calendar event title').fill('Edited one occurrence');
  await view.getByRole('button', { name: 'Save calendar changes' }).click();
  await expect(
    monday.getByText('Edited one occurrence', { exact: true }),
  ).toBeVisible();
  await expect(
    view
      .getByRole('region', { name: 'Agenda 2027-03-09', exact: true })
      .getByText('Recurring all-day browser event', { exact: true }),
  ).toBeVisible();
  await view.getByRole('button', { name: 'Day view', exact: true }).click();
  await expect(view.getByRole('region', { name: /Agenda / })).toHaveCount(1);
  await view.getByRole('button', { name: 'Next day', exact: true }).click();
  await expect(
    view.getByRole('region', { name: 'Agenda 2027-03-09', exact: true }),
  ).toBeVisible();
  await page.reload();
  await open(page, 'Calendar');
  await view.getByLabel('Calendar date', { exact: true }).fill('2027-03-08');
  await expect(
    view.getByText('Edited one occurrence', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test('a class portfolio stores progress and schedules a linked study block', async ({
  page,
}) => {
  await page.goto('/');
  await open(page, 'Classes');
  const portfolio = page.getByRole('region', { name: 'Class portfolios' });
  await portfolio.getByLabel('Class name').fill('Browser chemistry');
  await portfolio.getByLabel('Term', { exact: true }).fill('Spring 2027');
  await portfolio.getByLabel('Class content label').selectOption('personal');
  await portfolio
    .getByRole('button', { name: 'Add class', exact: true })
    .click();
  await portfolio
    .getByRole('button', { name: 'Browser chemistry', exact: true })
    .click();
  const topics = portfolio.getByRole('region', { name: 'Class topics' });
  await topics.getByLabel('Topic name').fill('Atomic structure');
  await topics.getByLabel('Progress (%)').fill('40');
  await topics
    .getByRole('combobox', { name: 'Confidence', exact: true })
    .selectOption('low');
  await topics.getByRole('button', { name: 'Add topic', exact: true }).click();
  await expect(
    topics.getByText('40% complete · confidence: low'),
  ).toBeVisible();
  await topics
    .getByRole('button', { name: 'Schedule study', exact: true })
    .click();
  const calendar = page.getByRole('region', { name: 'Calendar workspace' });
  await expect(calendar.getByLabel('Calendar event title')).toHaveValue(
    'Study Atomic structure',
  );
  await calendar
    .getByLabel('Calendar date', { exact: true })
    .fill('2027-03-08');
  await calendar.getByLabel('Event starts').fill('2027-03-08T13:00');
  await calendar.getByLabel('Event ends').fill('2027-03-08T14:00');
  await calendar.getByRole('button', { name: 'Save calendar event' }).click();
  await expect(
    calendar.getByText('Study Atomic structure', { exact: true }),
  ).toBeVisible();
  await expect(
    calendar.getByText('Study · Browser chemistry · planned'),
  ).toBeVisible();
  await page.reload();
  await open(page, 'Classes');
  await portfolio
    .getByRole('button', { name: 'Browser chemistry', exact: true })
    .click();
  await expect(
    topics.getByText('40% complete · confidence: low'),
  ).toBeVisible();
});
test('server reminders deliver to the inbox after navigating away and support pause/resume', async ({
  page,
}) => {
  await page.goto('/');
  await open(page, 'Inbox');
  const view = page.getByRole('region', { name: 'Reminders workspace' });
  await expect(view.getByRole('status')).toHaveText(
    'Reminder worker is running.',
  );
  await view.getByLabel('Reminder title').fill('Browser durable reminder');
  await view.getByLabel('Remind at', { exact: true }).fill('2020-01-01T10:00');
  await view.getByRole('button', { name: 'Add reminder', exact: true }).click();
  await open(page, 'Today');
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/v1/notifications');
        const body = (await response.json()) as {
          notifications: { title: string }[];
        };
        return body.notifications.some(
          (value) => value.title === 'Browser durable reminder',
        );
      },
      { timeout: 15000 },
    )
    .toBe(true);
  await open(page, 'Inbox');
  const inbox = view.getByRole('region', { name: 'Reminder inbox' });
  await expect(
    inbox.getByText('Browser durable reminder', { exact: true }),
  ).toBeVisible();
  await inbox.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(inbox.getByText('Read', { exact: true })).toBeVisible();
  await view.getByLabel('Reminder title').fill('Paused browser reminder');
  await view.getByLabel('Remind at', { exact: true }).fill('2035-01-01T10:00');
  await view.getByRole('button', { name: 'Add reminder', exact: true }).click();
  const job = view.locator('li').filter({ hasText: 'Paused browser reminder' });
  await job.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(job).toContainText('Status: paused');
  await job.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(job).toContainText('Status: queued');
  await job
    .getByRole('button', { name: 'Cancel reminder', exact: true })
    .click();
  await expect(job).toContainText('Status: cancelled');
});
test('new screens fit monochrome on a narrow viewport and explain denied alert permission', async ({
  page,
  context,
}) => {
  await context.clearPermissions();
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', {
      configurable: true,
      get: () => 'denied',
    });
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await toggleEink(page);
  for (const name of ['Calendar', 'Classes', 'Inbox'] as const) {
    await open(page, name);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'eink');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(
    page.getByText(/Change this site’s notification setting/),
  ).toBeVisible();
});

test('a reminder whose save response is lost retries with the same operation and saves once', async ({
  page,
}) => {
  await page.goto('/reminders');
  const view = page.getByRole('region', { name: 'Reminders workspace' });
  await view.getByLabel('Reminder title').fill('Lost response reminder');
  await view.getByLabel('Remind at', { exact: true }).fill('2036-01-01T10:00');
  const operations: string[] = [];
  let interrupted = false;
  await page.route('**/api/v1/reminders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    operations.push(
      (route.request().postDataJSON() as { operationId: string }).operationId,
    );
    if (!interrupted) {
      interrupted = true;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      return route.abort();
    }
    return route.continue();
  });
  const add = view.getByRole('button', { name: 'Add reminder', exact: true });
  await add.click();
  await expect(view.getByRole('alert')).toBeVisible();
  // The form keeps the draft; an unchanged retry reuses the operation ID.
  await expect(view.getByLabel('Reminder title')).toHaveValue(
    'Lost response reminder',
  );
  await add.click();
  await expect(
    view.locator('li').filter({ hasText: 'Lost response reminder' }),
  ).toHaveCount(1);
  expect(operations).toHaveLength(2);
  expect(operations[1]).toBe(operations[0]);
  const response = await page.request.get('/api/v1/reminders');
  const data = (await response.json()) as { reminders: { title: string }[] };
  expect(
    data.reminders.filter((item) => item.title === 'Lost response reminder'),
  ).toHaveLength(1);
});
