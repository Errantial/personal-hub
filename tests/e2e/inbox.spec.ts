import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authenticate } from './auth';
import { inboxRegion, open, showReminders } from './shell';

const headers = { Origin: 'http://127.0.0.1:5180' };

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

type ReminderRecord = {
  id: string;
  title: string;
  status: string;
  scheduledAt: string;
  version: number;
};

async function createReminder(page: Page, title: string, scheduledAt: string) {
  const reply = await page.request.post('/api/v1/reminders', {
    headers,
    data: { title, scheduledAt, operationId: crypto.randomUUID() },
  });
  expect(reply.status()).toBe(200);
  return (await reply.json()).reminder as ReminderRecord;
}

const uniqueTitle = (label: string) =>
  `${label} ${crypto.randomUUID().slice(0, 8)}`;

/** A reminder due in the past, waited on until the worker has delivered it. */
async function deliveredReminder(page: Page, label: string) {
  const created = await createReminder(
    page,
    uniqueTitle(label),
    '2020-01-01T10:00:00Z',
  );
  await expect
    .poll(
      async () => {
        const reply = await page.request.get(`/api/v1/reminders/${created.id}`);
        return (await reply.json()).reminder.status;
      },
      { timeout: 20000 },
    )
    .toBe('delivered');
  const reply = await page.request.get(`/api/v1/reminders/${created.id}`);
  return (await reply.json()).reminder as ReminderRecord;
}

test('notifications and reminders have their own addresses', async ({
  page,
}) => {
  await page.goto('/inbox');
  const sections = page.getByRole('navigation', { name: 'Inbox sections' });
  await expect(
    sections.getByRole('link', { name: /^Notifications/ }),
  ).toHaveAttribute('aria-current', 'page');
  await showReminders(page);
  await expect(page).toHaveURL('/inbox/reminders');
  await page.goto('/inbox/reminders/00000000-0000-4000-8000-000000000000');
  await expect(
    page.getByText('This reminder is not available.', { exact: false }),
  ).toBeVisible();
  // The old address still works.
  await page.goto('/reminders');
  await expect(page).toHaveURL('/inbox');
});

test('a delivered reminder can be snoozed, once', async ({ page }) => {
  const delivered = await deliveredReminder(page, 'Snooze me');
  await page.goto('/inbox');
  const view = inboxRegion(page);
  const note = view.getByRole('listitem').filter({ hasText: delivered.title });
  await expect(note).toContainText('Unread');
  await note.getByRole('link', { name: `Snooze ${delivered.title}` }).click();
  const form = view.getByRole('form', { name: 'Snooze reminder' });
  await form.getByRole('button', { name: 'Tomorrow 09:00' }).click();
  await expect(form.getByLabel('Snooze until')).toHaveValue(/T09:00$/);
  await form.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect(
    view
      .getByRole('listitem')
      .filter({ hasText: delivered.title })
      .filter({ hasText: 'Scheduled' }),
  ).toBeVisible();
  // The source notification is read and no longer offers Snooze.
  await open(page, 'Inbox');
  await expect(note.getByText('Read', { exact: true })).toBeVisible();
  await expect(note).toContainText('Snoozed');
  await expect(note.getByRole('link', { name: /^Snooze/ })).toHaveCount(0);
  const list = await page.request.get('/api/v1/reminders');
  const children = (
    (await list.json()).reminders as (ReminderRecord & {
      snoozedFromId: string | null;
    })[]
  ).filter((item) => item.snoozedFromId === delivered.id);
  expect(children).toHaveLength(1);
});

test('a reschedule keeps its draft when the reminder changed elsewhere', async ({
  page,
}) => {
  const reminder = await createReminder(
    page,
    uniqueTitle('Conflict'),
    '2036-05-05T12:00:00Z',
  );
  await page.goto(`/inbox/reminders/${reminder.id}`);
  const form = inboxRegion(page).getByRole('form', {
    name: 'Reschedule reminder',
  });
  await form.getByLabel('Reminder title').fill('Local draft title');
  const other = await page.request.put(`/api/v1/reminders/${reminder.id}`, {
    headers,
    data: {
      title: `${reminder.title} elsewhere`,
      scheduledAt: reminder.scheduledAt,
      expectedVersion: reminder.version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(other.status()).toBe(200);
  await form.getByRole('button', { name: 'Save reminder changes' }).click();
  const alert = form.getByRole('alert');
  await expect(alert).toContainText('Changed elsewhere');
  await expect(form.getByLabel('Reminder title')).toHaveValue(
    'Local draft title',
  );
  await expect(
    form.getByRole('button', { name: 'Save reminder changes' }),
  ).toBeDisabled();
  await alert.getByRole('button', { name: 'Load latest version' }).click();
  await expect(form.getByLabel('Reminder title')).toHaveValue(
    'Local draft title',
  );
  await form.getByRole('button', { name: 'Save reminder changes' }).click();
  await expect(
    inboxRegion(page).getByRole('listitem').filter({
      hasText: 'Local draft title',
    }),
  ).toBeVisible();
});

test('the add form names its errors and keeps a repeated time explicit', async ({
  page,
}) => {
  await page.goto('/inbox/reminders/new');
  const form = inboxRegion(page).getByRole('form', { name: 'Add reminder' });
  await form.getByRole('button', { name: 'Add reminder' }).click();
  await expect(form.getByText('Enter a reminder title')).toBeVisible();
  await expect(form.getByLabel('Reminder title')).toBeFocused();
  await form.getByLabel('Reminder title').fill('Zone check');
  await form.getByRole('button', { name: 'Add reminder' }).click();
  await expect(form.getByText('Choose a time')).toBeVisible();
});

test.describe('daylight saving time', () => {
  test.use({ timezoneId: 'America/New_York' });

  test('a skipped time is rejected and a repeated time needs a choice', async ({
    page,
  }) => {
    await page.goto('/inbox/reminders/new');
    const form = inboxRegion(page).getByRole('form', { name: 'Add reminder' });
    const title = uniqueTitle('Zone reminder');
    await form.getByLabel('Reminder title').fill(title);
    await form.getByLabel('Remind at').fill('2036-03-09T02:30');
    await expect(
      form.getByText(/does not exist in your timezone/),
    ).toBeVisible();
    await form.getByRole('button', { name: 'Add reminder' }).click();
    await expect(form.getByText('Choose a time')).toHaveCount(0);
    await expect(form.getByText(/does not exist/).first()).toBeVisible();

    await form.getByLabel('Remind at').fill('2036-11-02T01:30');
    await expect(form.getByText(/happens twice/)).toBeVisible();
    await form.getByRole('button', { name: 'Add reminder' }).click();
    await expect(form.getByText(/happens twice/).first()).toBeVisible();
    await form.getByRole('radio', { name: /^Later/ }).check();
    await form.getByRole('button', { name: 'Add reminder' }).click();
    await expect(
      inboxRegion(page).getByRole('listitem').filter({ hasText: title }),
    ).toBeVisible();
    const list = await page.request.get('/api/v1/reminders');
    const saved = ((await list.json()).reminders as ReminderRecord[]).find(
      (item) => item.title === title,
    );
    // 01:30 EST (the later one) is 06:30 UTC.
    expect(saved?.scheduledAt).toBe('2036-11-02T06:30:00.000Z');
  });
});

test('loaded notifications can be marked read together', async ({ page }) => {
  const first = await deliveredReminder(page, 'Bulk one');
  const second = await deliveredReminder(page, 'Bulk two');
  await page.goto('/inbox');
  const view = inboxRegion(page);
  for (const item of [first, second])
    await expect(
      view.getByRole('listitem').filter({ hasText: item.title }),
    ).toContainText('Unread');
  await view.getByRole('button', { name: 'Mark loaded read' }).click();
  for (const item of [first, second])
    await expect(
      view
        .getByRole('listitem')
        .filter({ hasText: item.title })
        .getByText('Read', { exact: true }),
    ).toBeVisible();
  await expect(
    view.getByRole('button', { name: 'Mark loaded read' }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Inbox sections' })
      .getByRole('link', { name: 'Notifications', exact: true }),
  ).toBeVisible();
});

test('reminder history pages and retries without duplicates, and ignores an older filter response', async ({
  page,
}) => {
  const created = await Promise.all(
    Array.from({ length: 26 }, (_, index) =>
      createReminder(
        page,
        uniqueTitle(`History ${index}`),
        '2036-06-06T12:00:00Z',
      ),
    ),
  );
  for (const item of created) {
    const reply = await page.request.post(
      `/api/v1/reminders/${item.id}/control`,
      {
        headers,
        data: {
          action: 'cancel',
          expectedVersion: item.version,
          operationId: crypto.randomUUID(),
        },
      },
    );
    expect(reply.status()).toBe(200);
  }
  await page.goto('/inbox/reminders');
  await page.getByText('Reminder history', { exact: true }).click();
  const history = page.getByRole('region', { name: 'Reminder history' });
  await expect(history.getByRole('listitem')).toHaveCount(25);
  await history
    .getByRole('combobox', { name: 'History status' })
    .selectOption('cancelled');
  await expect(history.getByRole('listitem')).toHaveCount(25);
  let failed = false;
  await page.route('**/api/v1/reminders/history?*', async (route) => {
    if (new URL(route.request().url()).searchParams.has('before') && !failed) {
      failed = true;
      return route.abort();
    }
    return route.continue();
  });
  await history.getByRole('button', { name: 'Load more reminders' }).click();
  await expect(history.getByRole('alert')).toContainText('Retry online');
  await expect(history.getByRole('listitem')).toHaveCount(25);
  await history
    .getByRole('button', { name: 'Retry loading more reminders' })
    .click();
  for (const item of created)
    await expect(history.getByText(item.title, { exact: true })).toHaveCount(1);
  await expect(history.getByRole('listitem').getByRole('button')).toHaveCount(
    0,
  );
  await expect(history.getByRole('listitem').getByRole('link')).toHaveCount(0);
  await page.unroute('**/api/v1/reminders/history?*');

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/reminders/history?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('status') !== 'queued')
      return route.continue();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  const pending = page.waitForRequest(
    (request) => new URL(request.url()).searchParams.get('status') === 'queued',
  );
  await history
    .getByRole('combobox', { name: 'History status' })
    .selectOption('queued');
  await pending;
  await history
    .getByRole('combobox', { name: 'History status' })
    .selectOption('cancelled');
  await expect(history.getByRole('listitem')).toHaveCount(25);
  const oldResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get('status') === 'queued',
  );
  release();
  await oldResponse;
  await expect(history.getByRole('listitem')).toHaveCount(25);
  await expect(history.getByRole('listitem').first()).toContainText(
    'Cancelled',
  );
  await page.unroute('**/api/v1/reminders/history?*');
  await history.getByRole('button', { name: 'Reload history' }).click();
  await expect(history.getByRole('listitem')).toHaveCount(25);
});

for (const { theme, width, target } of [
  { theme: 'standard', width: 1280, target: 44 },
  { theme: 'eink', width: 320, target: 48 },
] as const) {
  test(`inbox screens pass accessibility and target checks (${theme}, ${width}px)`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    const delivered = await deliveredReminder(page, 'Layout delivered');
    const queued = await createReminder(
      page,
      uniqueTitle('Layout queued'),
      '2036-06-06T12:00:00Z',
    );
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(
      (value) => localStorage.setItem('hub:eink', String(value === 'eink')),
      theme,
    );
    for (const path of [
      '/inbox',
      '/inbox/reminders',
      '/inbox/reminders/new',
      `/inbox/reminders/${queued.id}`,
      `/inbox/reminders/${delivered.id}`,
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Inbox' }),
      ).toBeVisible();
      await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
      if (path === '/inbox/reminders') {
        await page.getByText('Reminder history', { exact: true }).click();
        await expect(
          page.getByText('Loading history…', { exact: true }),
        ).toHaveCount(0);
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
              'button, a[href], input, select, textarea, summary',
            ),
          ]
            .filter((element) => element.offsetParent !== null)
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
                `${element.tagName.toLowerCase()} "${(element.textContent || '').trim().slice(0, 30)}"`,
            ),
        target,
      );
      expect(undersized, `${path} controls below ${target}px`).toEqual([]);
    }
  });
}
