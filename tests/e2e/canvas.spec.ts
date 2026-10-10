import { expect, test } from '@playwright/test';
import { authenticate } from './auth';
const headers = { Origin: 'http://127.0.0.1:5180' };
const feed = (title: string, date = '20270301T170000Z') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:browser-canvas-entry\r\nDTSTART:${date}\r\nDTEND:${date}\r\nSUMMARY:${title}\r\nDESCRIPTION:<script>window.privateLeak=true</script>\r\nURL:https://canvas.colorado.edu/courses/1/assignments/2\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('Canvas planning creates editable tasks and study blocks, retaining provenance through offline edits and refreshes', async ({
  page,
  context,
}) => {
  const importFeed = async (title: string) => {
    const reply = await page.request.post('/api/v1/connections/canvas/import', {
      headers,
      data: {
        operationId: crypto.randomUUID(),
        feed: feed(title, '20270415T170000Z').replace(
          'browser-canvas-entry',
          'planning-browser-source',
        ),
      },
    });
    expect(reply.status()).toBe(200);
  };
  await importFeed('Planning browser deadline');
  const courseReply = await page.request.post('/api/v1/courses', {
    headers,
    data: { operationId: crypto.randomUUID(), name: 'Planning browser class' },
  });
  expect(courseReply.status()).toBe(200);
  const course = (await courseReply.json()).course;
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const connection = page.getByRole('region', { name: 'Canvas connection' });
  const entry = connection.locator('article').filter({
    has: page.getByRole('heading', {
      name: /^Planning browser (refreshed )?deadline$/,
    }),
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await entry.getByRole('button', { name: 'Create task', exact: true }).click();
  const form = entry.getByRole('form', { name: 'Canvas planning' });
  await form.getByLabel('Planner title').fill('Canvas planned browser task');
  await form.getByLabel('Task deadline').fill('2027-04-16');
  // A refresh must produce a conflict while preserving the owner's draft.
  await importFeed('Planning browser refreshed deadline');
  await form.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(entry.getByRole('alert')).toContainText('Canvas entry changed');
  await connection
    .getByRole('button', { name: 'Reload Canvas', exact: true })
    .click();
  await form
    .getByRole('button', { name: 'Reload source version', exact: true })
    .click();
  await expect(form.getByLabel('Planner title')).toHaveValue(
    'Canvas planned browser task',
  );
  await form.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(entry.getByRole('status')).toHaveText('Task created.');
  await entry.getByRole('button', { name: 'Plan study', exact: true }).click();
  await form.getByLabel('Planner title').fill('Canvas planned browser study');
  await form.getByLabel('Study class').selectOption(course.id);
  await form.getByLabel('Study timezone').fill('UTC');
  await form.getByLabel('Study starts').fill('2027-04-14T15:00');
  await form.getByLabel('Study ends').fill('2027-04-14T16:00');
  await form
    .getByRole('button', { name: 'Save study block', exact: true })
    .click();
  await expect(entry.getByRole('status')).toHaveText('Study block created.');
  await entry.getByRole('button', { name: 'Create task', exact: true }).click();
  await form.getByLabel('Planner title').fill('Unqueued Canvas task');
  await context.setOffline(true);
  await form.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(entry.getByRole('alert')).toContainText(
    'Connect to create a task from Canvas',
  );
  await expect(form.getByLabel('Planner title')).toHaveValue(
    'Unqueued Canvas task',
  );
  await expect(
    page.getByRole('region', { name: 'Task sync' }).getByRole('status'),
  ).toContainText('0 pending changes');
  await context.setOffline(false);
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  const tasks = page.getByRole('region', { name: 'Tasks', exact: true });
  const task = tasks.locator('li').filter({
    has: page.getByText('Canvas planned browser task', { exact: true }),
  });
  await expect(task).toContainText('Due 2027-04-16');
  await task.getByText('Canvas source', { exact: true }).click();
  await expect(task).toContainText('calendar-file');
  await context.setOffline(true);
  await task
    .getByRole('checkbox', { name: 'Complete Canvas planned browser task' })
    .check();
  await expect(task.getByRole('checkbox')).toBeChecked();
  await expect(task).toContainText('calendar-file');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect
    .poll(async () => {
      const reply = await page.request.get('/api/v1/tasks');
      return (await reply.json()).tasks.find(
        (item: { title: string }) =>
          item.title === 'Canvas planned browser task',
      )?.completed;
    })
    .toBe(true);
  await importFeed('Planning final browser deadline');
  await tasks.getByRole('button', { name: 'Reload list', exact: true }).click();
  await expect(task.getByRole('checkbox')).toBeChecked();
  await expect(task).toContainText('Due 2027-04-16');
  await expect(task).toContainText('Canvas source · Changed');
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.getByLabel('Viewing timezone', { exact: true }).fill('UTC');
  await page
    .getByRole('button', { name: 'Apply timezone', exact: true })
    .click();
  await page.getByLabel('Calendar date', { exact: true }).fill('2027-04-14');
  await page.getByRole('button', { name: 'Day view', exact: true }).click();
  const agenda = page.getByRole('region', {
    name: 'Agenda 2027-04-14',
    exact: true,
  });
  const study = agenda.locator('article').filter({
    has: page.getByText('Canvas planned browser study', { exact: true }),
  });
  await expect(study).toContainText('Planning browser class');
  await study.getByText('Canvas source · Changed', { exact: true }).click();
  await expect(study).toContainText('Planning final browser deadline');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
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
