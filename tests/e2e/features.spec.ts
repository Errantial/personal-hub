import { expect, test } from '@playwright/test';
import {
  calendarDay,
  calendarRegion,
  eventEditor,
  newEvent,
  classesRegion,
  open,
  openClass,
  showCalendar,
  toggleEink,
} from './shell';
import { authenticate } from './auth';
test.beforeEach(async ({ page }) => {
  await authenticate(page);
});
test('rescheduling an academic-work reminder preserves its source link', async ({
  page,
}) => {
  const headers = { Origin: 'http://127.0.0.1:5180' };
  const course = await page.request.post('/api/v1/courses', {
    headers,
    data: { name: 'Reminder source class', operationId: crypto.randomUUID() },
  });
  expect(course.status()).toBe(200);
  const work = await page.request.post('/api/v1/academic-work', {
    headers,
    data: {
      courseId: (await course.json()).course.id,
      title: 'Reminder source assignment',
      operationId: crypto.randomUUID(),
    },
  });
  expect(work.status()).toBe(200);
  const workId = (await work.json()).work.id;
  const reminder = await page.request.post('/api/v1/reminders', {
    headers,
    data: {
      title: 'Academic source reminder',
      targetKind: 'academic-work',
      targetId: workId,
      scheduledAt: '2035-04-04T12:00:00Z',
      operationId: crypto.randomUUID(),
    },
  });
  expect(reminder.status()).toBe(200);
  const reminderId = (await reminder.json()).reminder.id;
  await page.goto('/');
  await open(page, 'Inbox');
  const view = page.getByRole('region', { name: 'Reminders workspace' });
  await view
    .getByRole('button', {
      name: 'Reschedule Academic source reminder',
      exact: true,
    })
    .click();
  await expect(
    view.getByRole('combobox', { name: /^Linked item/ }),
  ).toHaveValue(`academic-work:${workId}`);
  await view.getByLabel('Reminder title').fill('Rescheduled academic source');
  await view
    .getByRole('button', { name: 'Save reminder changes', exact: true })
    .click();
  await expect(
    view.locator('li').filter({ hasText: 'Rescheduled academic source' }),
  ).toBeVisible();
  const current = await page.request.get('/api/v1/reminders');
  expect(current.status()).toBe(200);
  expect(
    (await current.json()).reminders.find(
      (item: { id: string }) => item.id === reminderId,
    ),
  ).toMatchObject({
    targetKind: 'academic-work',
    targetId: workId,
    version: 2,
  });
});
test('calendar navigation preserves a stale draft until the latest version is loaded', async ({
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
  const view = calendarRegion(page);
  await showCalendar(page, { date: '2027-03-08', zone: 'UTC' });
  await view.getByRole('link', { name: original.title, exact: true }).click();
  const editor = eventEditor(page);
  await editor
    .getByLabel('Title', { exact: true })
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
  // Browsing to another view keeps the open draft and refreshes the list.
  await showCalendar(page, { view: 'Day' });
  await expect(
    view.getByRole('link', { name: 'Calendar changed elsewhere', exact: true }),
  ).toBeVisible();
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(
    'Calendar preserved draft',
  );
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('alert')).toContainText('Changed elsewhere');
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(
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
  await editor.getByRole('button', { name: 'Load latest version' }).click();
  await expect(
    editor.getByRole('button', { name: 'Save changes' }),
  ).toBeDisabled();
  await expect(editor.getByRole('alert')).toContainText('Changed elsewhere');
  releaseReload();
  await expect(editor.getByRole('alert')).toHaveCount(0);
  await expect(
    editor.getByText('Latest: Calendar changed elsewhere'),
  ).toBeVisible();
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(
    'Calendar preserved draft',
  );
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByRole('status').first()).toHaveText('Saved.');
  await expect(
    view.getByRole('link', { name: 'Calendar preserved draft', exact: true }),
  ).toBeVisible();
});
test('calendar shows agenda, week and day windows and edits an all-day recurring occurrence', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await open(page, 'Calendar');
  await showCalendar(page, { date: '2027-03-08' });
  await newEvent(page);
  const editor = eventEditor(page);
  await editor
    .getByLabel('Title', { exact: true })
    .fill('Recurring all-day browser event');
  await editor.getByLabel('All-day', { exact: true }).check();
  await editor.getByLabel('First day').fill('2027-03-08');
  await editor.getByLabel('Last day').fill('2027-03-08');
  await editor
    .getByRole('combobox', { name: 'Repeat', exact: true })
    .selectOption('daily');
  await editor.getByLabel('Occurrences (blank = ongoing)').fill('3');
  await editor.getByRole('button', { name: 'Save event' }).click();
  const monday = calendarDay(page, '2027-03-08');
  await expect(
    monday.getByText('Recurring all-day browser event', { exact: true }),
  ).toBeVisible();
  await expect(monday.getByText('All day', { exact: true })).toBeVisible();
  await expect(monday.getByText('Repeats daily')).toBeVisible();
  await monday
    .getByRole('link', { name: 'Recurring all-day browser event', exact: true })
    .click();
  await expect(page).toHaveURL(
    /\/calendar\/[0-9a-f-]{36}\/occurrence\/2027-03-08/,
  );
  await expect(eventEditor(page)).toContainText('Only 2027-03-08 changes.');
  await eventEditor(page)
    .getByLabel('Title', { exact: true })
    .fill('Edited one occurrence');
  await eventEditor(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(
    monday.getByText('Edited one occurrence', { exact: true }),
  ).toBeVisible();
  await expect(monday.getByText('Edited occurrence')).toBeVisible();
  await expect(
    calendarDay(page, '2027-03-09').getByText(
      'Recurring all-day browser event',
      { exact: true },
    ),
  ).toBeVisible();
  // Week starts on Monday and lists every day, with or without entries (the 11th is empty).
  await showCalendar(page, { view: 'Week' });
  await expect(calendarRegion(page).locator('section[data-date]')).toHaveCount(
    7,
  );
  await expect(
    calendarDay(page, '2027-03-11').getByText('Nothing scheduled.'),
  ).toBeVisible();
  await showCalendar(page, { view: 'Day' });
  await expect(calendarRegion(page).locator('section[data-date]')).toHaveCount(
    1,
  );
  await calendarRegion(page)
    .getByRole('link', { name: 'Next day', exact: true })
    .click();
  await expect(calendarDay(page, '2027-03-09')).toBeVisible();
  await page.goto('/calendar?date=2027-03-08');
  await expect(
    calendarRegion(page).getByText('Edited one occurrence', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test('a class portfolio stores progress and schedules a linked study block', async ({
  page,
}) => {
  await page.goto('/');
  await open(page, 'Classes');
  await classesRegion(page)
    .getByRole('link', { name: 'Add class', exact: true })
    .click();
  const form = classesRegion(page).locator('form');
  await form.getByLabel('Class name').fill('Browser chemistry');
  await form.getByLabel('Term', { exact: true }).fill('Spring 2027');
  await form.getByLabel('Class content label').selectOption('personal');
  await form.getByRole('button', { name: 'Add class', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Browser chemistry' }),
  ).toBeVisible();
  const topics = classesRegion(page).getByRole('region', { name: 'Topics' });
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
    .getByRole('button', { name: 'Plan study for Atomic structure' })
    .click();
  const editor = eventEditor(page);
  await expect(
    editor.getByRole('heading', { name: 'Schedule study time' }),
  ).toBeVisible();
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(
    'Study Atomic structure',
  );
  await expect(
    editor.getByRole('combobox', { name: 'Class', exact: true }),
  ).toHaveValue(/.+/);
  await editor.getByLabel('Starts').fill('2027-03-08T13:00');
  await editor.getByLabel('Ends').fill('2027-03-08T14:00');
  await editor.getByRole('button', { name: 'Save event' }).click();
  const calendar = calendarRegion(page);
  await expect(
    calendar.getByText('Study Atomic structure', { exact: true }),
  ).toBeVisible();
  await expect(
    calendar.getByText('Study · Browser chemistry · planned'),
  ).toBeVisible();
  await page.reload();
  await open(page, 'Classes');
  await openClass(page, 'Browser chemistry');
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
