import { expect, test } from '@playwright/test';
import { authenticate } from './auth';
const headers = { Origin: 'http://127.0.0.1:5180' };
const feed = (title: string, date = '20270301T170000Z') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:browser-canvas-entry\r\nDTSTART:${date}\r\nDTEND:${date}\r\nSUMMARY:${title}\r\nDESCRIPTION:<script>window.privateLeak=true</script>\r\nURL:https://canvas.colorado.edu/courses/1/assignments/2\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('Canvas class links survive refreshes and appear as read-only entries in portfolios and cached agendas', async ({
  page,
  context,
}) => {
  const courseReply = await page.request.post('/api/v1/courses', {
    headers,
    data: {
      name: 'Canvas linked browser class',
      sensitivity: 'personal',
      operationId: crypto.randomUUID(),
    },
  });
  expect(courseReply.status()).toBe(200);
  const course = (await courseReply.json()).course;
  const linkedFeed = (title: string) =>
    feed(title, '20270321T003000Z')
      .replace('browser-canvas-entry', 'linked-browser-entry')
      .replace(
        'END:VCALENDAR',
        'BEGIN:VEVENT\r\nUID:linked-all-day\r\nDTSTART;VALUE=DATE:20270320\r\nDTEND;VALUE=DATE:20270321\r\nSUMMARY:Canvas all-day browser\r\nEND:VEVENT\r\nEND:VCALENDAR',
      );
  expect(
    (
      await page.request.post('/api/v1/connections/canvas/import', {
        headers,
        data: {
          feed: linkedFeed('Canvas linked deadline'),
          operationId: crypto.randomUUID(),
        },
      })
    ).status(),
  ).toBe(200);
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const connection = page.getByRole('region', { name: 'Canvas connection' });
  const entry = connection
    .locator('article')
    .filter({ hasText: 'Canvas linked deadline' });
  await entry.getByRole('button', { name: 'Edit notes', exact: true }).click();
  await entry
    .getByLabel('Linked class', { exact: true })
    .selectOption(course.id);
  await entry
    .getByLabel('Personal notes', { exact: true })
    .fill('Linked personal browser note');
  await entry.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(
    connection.getByText('Notes saved.', { exact: true }),
  ).toBeVisible();
  expect(
    (
      await page.request.post('/api/v1/connections/canvas/import', {
        headers,
        data: {
          feed: linkedFeed('Canvas refreshed deadline'),
          operationId: crypto.randomUUID(),
        },
      })
    ).status(),
  ).toBe(200);
  await page.getByRole('button', { name: 'Classes', exact: true }).click();
  await page
    .getByRole('button', { name: 'Canvas linked browser class', exact: true })
    .click();
  const portfolio = page.getByRole('region', { name: 'Class Canvas entries' });
  await expect(
    portfolio.getByText('Canvas refreshed deadline', { exact: true }),
  ).toBeVisible();
  await portfolio.getByText('Personal notes', { exact: true }).click();
  await expect(
    portfolio.getByText('Linked personal browser note', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  const calendarView = page.getByRole('region', { name: 'Calendar workspace' });
  await calendarView
    .getByLabel('Viewing timezone', { exact: true })
    .fill('America/Denver');
  await calendarView
    .getByRole('button', { name: 'Apply timezone', exact: true })
    .click();
  await calendarView
    .getByLabel('Calendar date', { exact: true })
    .fill('2027-03-20');
  await calendarView
    .getByRole('button', { name: 'Day view', exact: true })
    .click();
  const agenda = page.getByRole('region', {
    name: 'Agenda 2027-03-20',
    exact: true,
  });
  const point = agenda.getByRole('article', {
    name: 'Canvas entry Canvas refreshed deadline',
    exact: true,
  });
  await expect(point).toContainText('Deadline');
  await expect(point).toContainText('Read only');
  await expect(point).toContainText('Canvas linked browser class');
  await expect(point.getByRole('button')).toHaveCount(0);
  await expect(
    agenda.getByText('Canvas all-day browser', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Classes', exact: true }).click();
  await page
    .getByRole('button', { name: 'Canvas linked browser class', exact: true })
    .click();
  await expect(
    portfolio.getByText('Canvas refreshed deadline', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await calendarView
    .getByLabel('Viewing timezone', { exact: true })
    .fill('America/Denver');
  await calendarView
    .getByRole('button', { name: 'Apply timezone', exact: true })
    .click();
  await calendarView
    .getByLabel('Calendar date', { exact: true })
    .fill('2027-03-20');
  await calendarView
    .getByRole('button', { name: 'Day view', exact: true })
    .click();
  await expect(point).toBeVisible();
  await context.setOffline(false);
});

test('Canvas imports deduplicate, retain notes, show source changes and fit a narrow e-ink screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'E-ink mode' }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Canvas connection' });
  await expect(
    panel.getByRole('button', { name: 'Sync Canvas', exact: true }),
  ).toBeDisabled();
  await panel.getByLabel('Import ICS', { exact: true }).setInputFiles({
    name: 'synthetic.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from(feed('Synthetic Canvas deadline')),
  });
  await expect(
    panel.getByText('Calendar imported.', { exact: true }),
  ).toBeVisible();
  const entry = panel
    .locator('article')
    .filter({ hasText: 'Synthetic Canvas deadline' });
  await entry.getByRole('button', { name: 'Edit notes', exact: true }).click();
  await entry
    .getByLabel('Personal notes', { exact: true })
    .fill('Personal browser note');
  await entry
    .getByLabel('Entry label', { exact: true })
    .selectOption('personal');
  await entry.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(panel.getByText('Notes saved.', { exact: true })).toBeVisible();
  await panel
    .getByLabel('Source label', { exact: true })
    .selectOption('restricted');
  await panel
    .getByRole('button', { name: 'Save Canvas settings', exact: true })
    .click();
  await expect(
    panel.getByText('Canvas settings saved.', { exact: true }),
  ).toBeVisible();
  await panel.getByLabel('Import ICS', { exact: true }).setInputFiles({
    name: 'synthetic.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from(feed('Changed Canvas deadline', '20270302T180000Z')),
  });
  await expect(
    panel.getByText('Calendar imported.', { exact: true }),
  ).toBeVisible();
  const changed = panel
    .locator('article')
    .filter({ hasText: 'Changed Canvas deadline' });
  await expect(
    changed.getByText('Personal browser note', { exact: true }),
  ).toBeVisible();
  await expect(changed).toContainText('restricted');
  expect(
    await changed
      .getByRole('link', { name: 'Open in Canvas' })
      .getAttribute('href'),
  ).toBe('https://canvas.colorado.edu/courses/1/assignments/2');
  await changed.getByText('Source description', { exact: true }).click();
  await expect(changed).toContainText('<script>');
  expect(await page.evaluate(() => 'privateLeak' in window)).toBe(false);
  expect(
    await panel
      .locator('article')
      .filter({ hasText: 'Changed Canvas deadline' })
      .count(),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('Canvas conflict retains a note draft and malformed input leaves imported entries intact', async ({
  page,
}) => {
  expect(
    (
      await page.request.post('/api/v1/connections/canvas/import', {
        headers,
        data: {
          feed: feed('Changed Canvas deadline', '20270302T180000Z'),
          operationId: crypto.randomUUID(),
        },
      })
    ).status(),
  ).toBe(200);
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Canvas connection' });
  const card = panel
    .locator('article')
    .filter({ hasText: 'Changed Canvas deadline' });
  await card.getByRole('button', { name: 'Edit notes', exact: true }).click();
  await card
    .getByLabel('Personal notes', { exact: true })
    .fill('Retained conflicted draft');
  const update = await page.request.post('/api/v1/connections/canvas/import', {
    headers,
    data: {
      feed: feed('Changed Canvas deadline', '20270303T180000Z'),
      operationId: crypto.randomUUID(),
    },
  });
  expect(update.status()).toBe(200);
  await card.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('changed elsewhere');
  await expect(card.getByLabel('Personal notes', { exact: true })).toHaveValue(
    'Retained conflicted draft',
  );
  await card
    .getByRole('button', { name: 'Reload entry version', exact: true })
    .click();
  await card.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(panel.getByText('Notes saved.', { exact: true })).toBeVisible();
  await panel.getByLabel('Import ICS', { exact: true }).setInputFiles({
    name: 'invalid.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from('<html>login page</html>'),
  });
  await expect(panel.getByRole('alert')).toContainText(
    'Previous records are unchanged',
  );
  await expect(
    panel.getByText('Retained conflicted draft', { exact: true }),
  ).toBeVisible();
});
