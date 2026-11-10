import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { Temporal } from '@hub/contracts';
import { authenticate } from './auth';
import { syncNow, syncState } from './shell';

const headers = { Origin: 'http://127.0.0.1:5180' };
test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

/** Today's short date: "Sun, Nov 8", with the year once it is not this year's. */
const shortDate = (date: string, today: string) =>
  new Date(date).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
const localToday = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
async function createTask(
  page: import('@playwright/test').Page,
  data: Record<string, unknown>,
) {
  const reply = await page.request.post('/api/v1/tasks', {
    headers,
    data: { operationId: crypto.randomUUID(), ...data },
  });
  expect(reply.status()).toBe(200);
  return (await reply.json()).task as { id: string; version: number };
}
const readTask = async (page: import('@playwright/test').Page, id: string) =>
  (
    (await (await page.request.get('/api/v1/tasks')).json()).tasks as {
      id: string;
      completed: boolean;
      dueDate: string | null;
      dueAt: string | null;
      version: number;
    }[]
  ).find((item) => item.id === id);
/** UTC `YYYYMMDDTHHMMSSZ` for a local wall time on a date in the page's zone. */
async function compactInstant(
  page: import('@playwright/test').Page,
  date: string,
  time: string,
) {
  const zone = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const instant = Temporal.PlainDate.from(date)
    .toZonedDateTime({ timeZone: zone, plainTime: time })
    .toInstant();
  return `${new Date(instant.epochMilliseconds)
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, '')}Z`;
}

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
  const unread = page.getByRole('group', { name: 'Unread notifications · 4' });
  await unread.getByText('Unread notifications · 4').click();
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
  await expect(attention).toContainText(`Due ${shortDate(yesterday, date)}`);
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

test('Today prefers a tracked Canvas deadline and opens its Personal Hub editor', async ({
  page,
}) => {
  await page.goto('/today');
  const date = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  const zone = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const instant = Temporal.PlainDate.from(date)
    .toZonedDateTime({ timeZone: zone, plainTime: '16:30' })
    .toInstant();
  const compact = `${new Date(instant.epochMilliseconds)
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, '')}Z`;
  const providerId = '991250';
  const title = 'Today tracked Canvas deadline';
  const imported = await page.request.post(
    '/api/v1/connections/canvas/import',
    {
      headers,
      data: {
        operationId: crypto.randomUUID(),
        feed: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:today-tracked-${providerId}\r\nDTSTART:${compact}\r\nDTEND:${compact}\r\nSUMMARY:${title}\r\nURL:https://canvas.colorado.edu/courses/1/assignments/${providerId}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
      },
    },
  );
  expect(imported.status()).toBe(200);
  const deadlines = (
    await (
      await page.request.get('/api/v1/deadlines?status=all&limit=200')
    ).json()
  ).deadlines as Array<{ id: string; canonicalKey: string }>;
  const deadline = deadlines.find((item) =>
    item.canonicalKey.endsWith(`/courses/1/assignments/${providerId}`),
  );
  expect(deadline).toBeDefined();

  await page.reload();
  const today = page.getByRole('region', { name: 'Today' });
  const rows = today.getByRole('listitem').filter({ hasText: title });
  await expect(rows).toHaveCount(1);
  const link = rows.getByRole('link', { name: title, exact: true });
  await expect(link).toHaveAttribute('href', `/tasks/deadline/${deadline!.id}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/deadline/${deadline!.id}$`));
  await expect(
    page.getByRole('region', { name: 'Edit imported deadline' }),
  ).toBeVisible();
});

test('a failed Canvas section preserves planner content and retries independently', async ({
  page,
}) => {
  await page.route('**/api/v1/connections/canvas/calendar?**', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }),
  );
  await page.goto('/today');
  const title = unique('Beside failed Canvas');
  await createTask(page, { title, dueDate: await localToday(page) });
  await page.reload();
  const schedule = page.getByRole('region', { name: 'Today' });
  await expect(schedule.getByRole('alert')).toHaveText(
    'Canvas deadlines unavailable. Retry Canvas.',
  );
  // The other reads still load and stay refreshable beside the failed one.
  await expect(
    schedule.getByRole('link', { name: title, exact: true }),
  ).toBeVisible();
  await expect(
    schedule.getByRole('button', { name: 'Refresh', exact: true }),
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
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(/^Cached .*\bschedule\b.*: /)).toBeVisible();
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
  await page.route('**/api/v1/assistant/destination*', (route) =>
    route.fulfill({
      json: {
        destination: {
          status: 'ready',
          reason: null,
          approved: {
            model: 'anthropic/claude-haiku-5.5',
            upstream: 'google-vertex',
          },
          model: 'anthropic/claude-haiku-5.5',
          hosts: ['google-vertex'],
          personalMail: false,
          version: 1,
        },
      },
    }),
  );
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
  // Other suites leave imported deadlines and class work in the shared
  // database; exact counts here need every due source to be the stub.
  await page.route('**/api/v1/deadlines?**', (route) =>
    route.fulfill({ json: { deadlines: [], nextAfter: null } }),
  );
  await page.route('**/api/v1/connections/canvas/calendar?**', (route) =>
    route.fulfill({ json: { items: [], lastImportedAt: null } }),
  );
  await page.route('**/api/v1/academic-work/browse?**', (route) =>
    route.fulfill({
      json: {
        courseId: null,
        courseState: 'active',
        status: 'open',
        kind: 'all',
        deadline: 'dated',
        summary: {
          totalCount: 0,
          openCount: 0,
          plannedCount: 0,
          inProgressCount: 0,
          submittedCount: 0,
          cancelledCount: 0,
          missingDeadlineCount: 0,
          missingEstimateCount: 0,
          estimatedOpenMinutes: 0,
        },
        work: [],
        nextAfter: null,
      },
    }),
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

test('Next 7 days and Unread notifications are collapsed with counts', async ({
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
  const unread = page.getByRole('group', { name: 'Unread notifications · 3' });
  await expect(unread.getByText('Unread 0')).toBeHidden();
  await unread.getByText('Unread notifications · 3').click();
  await expect(unread.getByText('Unread 0')).toBeVisible();
});

test('a task is completed from Today in place and Undo reopens it', async ({
  page,
}) => {
  await page.goto('/today');
  const date = await localToday(page);
  const title = unique('Today check off');
  const task = await createTask(page, {
    title,
    dueDate: date,
    notes: 'Kept through completion',
    priority: 'high',
  });
  await page.reload();
  const list = page.getByRole('region', { name: 'Today' });
  const row = list.getByRole('listitem').filter({ hasText: title });
  await expect(row).toContainText('Due today');
  // Keyboard path: the checkbox is reachable and Space completes the task.
  const box = row.getByRole('checkbox', { name: `Complete ${title}` });
  await box.focus();
  await page.keyboard.press('Space');
  const done = list
    .getByRole('listitem')
    .filter({ hasText: `Completed “${title}”.` });
  await expect(done).toBeVisible();
  await expect(
    list.getByRole('link', { name: title, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: title })).toHaveText(
    `Completed “${title}”. Undo is available.`,
  );
  const undo = done.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeFocused();
  await expect
    .poll(async () => (await readTask(page, task.id))?.completed)
    .toBe(true);
  expect((await readTask(page, task.id))?.version).toBe(task.version + 1);
  await undo.click();
  await expect(done).toHaveCount(0);
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await expect(box).toBeFocused();
  const reopened = await readTask(page, task.id);
  expect(reopened).toMatchObject({ completed: false, dueDate: date });
  expect(reopened?.version).toBe(task.version + 2);
  const detail = (
    await (await page.request.get('/api/v1/tasks')).json()
  ).tasks.find((item: { id: string }) => item.id === task.id);
  expect(detail).toMatchObject({
    notes: 'Kept through completion',
    priority: 'high',
  });
});

test('completing an overdue task offline queues it once, with Undo, and replays after reconnect', async ({
  page,
  context,
}) => {
  await page.goto('/today');
  const date = await localToday(page);
  const yesterday = Temporal.PlainDate.from(date)
    .subtract({ days: 1 })
    .toString();
  const kept = unique('Offline overdue kept');
  const finished = unique('Offline overdue done');
  const keptTask = await createTask(page, { title: kept, dueDate: yesterday });
  const doneTask = await createTask(page, {
    title: finished,
    dueDate: yesterday,
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  const overdue = page.getByRole('region', { name: 'Overdue' });
  await expect(
    overdue.getByRole('link', { name: finished, exact: true }),
  ).toHaveAttribute('href', `/tasks/${doneTask.id}`);
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(/^Cached tasks\b.*: /)).toBeVisible();
  // Complete one, undo it, then complete the other: all three are queued.
  await overdue.getByRole('checkbox', { name: `Complete ${kept}` }).click();
  await overdue.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    overdue.getByRole('checkbox', { name: `Complete ${kept}` }),
  ).not.toBeChecked();
  await overdue.getByRole('checkbox', { name: `Complete ${finished}` }).click();
  await expect(
    overdue.getByRole('listitem').filter({
      hasText: `Completed “${finished}”.`,
    }),
  ).toBeVisible();
  await expect(syncState(page)).toContainText('3 queued');
  await expect(
    overdue.getByRole('listitem').filter({ hasText: kept }),
  ).toContainText('Queued');
  expect((await readTask(page, doneTask.id))?.completed).toBe(false);
  await context.setOffline(false);
  await syncNow(page);
  await expect(syncState(page)).toContainText('All saved');
  expect(await readTask(page, doneTask.id)).toMatchObject({
    completed: true,
    version: doneTask.version + 1,
  });
  expect(await readTask(page, keptTask.id)).toMatchObject({
    completed: false,
    version: keptTask.version + 2,
  });
});

test('Today shows imported deadlines and class work when overdue or due this week, and a completed deadline never returns as a Canvas row', async ({
  page,
}) => {
  await page.goto('/today');
  const date = await localToday(page);
  const day = (offset: number) =>
    Temporal.PlainDate.from(date).add({ days: offset }).toString();
  const tag = crypto.randomUUID().slice(0, 8);
  const names = {
    late: `Late essay ${tag}`,
    now: `Quiz today ${tag}`,
    soon: `Problem set soon ${tag}`,
    raw: `Review session ${tag}`,
    far: `Beyond the week ${tag}`,
  };
  const number = () => String(Math.floor(1e6 + Math.random() * 8e6));
  const entry = async (title: string, offset: number, url: string | null) => {
    const at = await compactInstant(page, day(offset), '16:30');
    return `BEGIN:VEVENT\r\nUID:${crypto.randomUUID()}\r\nDTSTART:${at}\r\nDTEND:${at}\r\nSUMMARY:${title}\r\n${url ? `URL:${url}\r\n` : ''}END:VEVENT\r\n`;
  };
  const assignment = () =>
    `https://canvas.colorado.edu/courses/77/assignments/${number()}`;
  const imported = await page.request.post(
    '/api/v1/connections/canvas/import',
    {
      headers,
      data: {
        operationId: crypto.randomUUID(),
        feed: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${await entry(names.late, -2, assignment())}${await entry(names.now, 0, assignment())}${await entry(names.soon, 3, assignment())}${await entry(names.raw, 2, null)}${await entry(names.far, 9, assignment())}END:VCALENDAR\r\n`,
      },
    },
  );
  expect(imported.status()).toBe(200);
  const courseName = `Today class ${tag}`;
  const course = (
    await (
      await page.request.post('/api/v1/courses', {
        headers,
        data: { name: courseName, operationId: crypto.randomUUID() },
      })
    ).json()
  ).course as { id: string };
  const works = {
    late: `Late lab ${tag}`,
    soon: `Midterm ${tag}`,
    submitted: `Handed in ${tag}`,
  };
  for (const [title, dueDate, extra] of [
    [works.late, day(-3), {}],
    [works.soon, day(1), { kind: 'exam' }],
    [works.submitted, day(-1), { status: 'submitted' }],
  ] as const)
    expect(
      (
        await page.request.post('/api/v1/academic-work', {
          headers,
          data: {
            courseId: course.id,
            title,
            dueDate,
            operationId: crypto.randomUUID(),
            ...extra,
          },
        })
      ).status(),
    ).toBe(200);

  await page.reload();
  const overdue = page.getByRole('region', { name: 'Overdue' });
  const lateRow = overdue.getByRole('listitem').filter({ hasText: names.late });
  await expect(lateRow).toContainText(`Due ${shortDate(day(-2), date)}`);
  await expect(lateRow).toContainText('Deadline');
  await expect(
    lateRow.getByRole('checkbox', {
      name: `Complete ${names.late} in Personal Hub`,
    }),
  ).toBeEnabled();
  const lateWork = overdue
    .getByRole('listitem')
    .filter({ hasText: works.late });
  await expect(lateWork).toContainText(courseName);
  await expect(lateWork).toContainText('Class work');
  await expect(lateWork.getByRole('checkbox')).toHaveCount(0);
  await expect(overdue.getByText(works.submitted)).toHaveCount(0);

  const week = page.getByRole('group', { name: /^Next 7 days · \d+$/ });
  await week.getByText(/^Next 7 days/).click();
  const tomorrow = week.getByRole('list', {
    name: `Tomorrow · ${shortDate(day(1), date)}`,
  });
  await expect(
    tomorrow.getByRole('listitem').filter({ hasText: works.soon }),
  ).toContainText(`Exam · ${courseName}`);
  await expect(
    week
      .getByRole('list', { name: shortDate(day(3), date), exact: true })
      .getByRole('listitem')
      .filter({ hasText: names.soon }),
  ).toContainText('Deadline');
  // A Canvas entry that is not an assignment or quiz stays a read-only row.
  const raw = week
    .getByRole('list', { name: shortDate(day(2), date), exact: true })
    .getByRole('listitem')
    .filter({ hasText: names.raw });
  await expect(raw).toBeVisible();
  await expect(raw.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByText(names.far)).toHaveCount(0);

  // Class work opens its class on the Work section.
  await expect(
    tomorrow.getByRole('link', { name: works.soon, exact: true }),
  ).toHaveAttribute('href', `/classes/${course.id}?section=work`);

  // Complete today's imported deadline, undo, complete again.
  const list = page.getByRole('region', { name: 'Today' });
  const check = list.getByRole('checkbox', {
    name: `Complete ${names.now} in Personal Hub`,
  });
  await check.click();
  const done = list
    .getByRole('listitem')
    .filter({ hasText: `Completed “${names.now}”.` });
  await done.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    list.getByRole('link', { name: names.now, exact: true }),
  ).toHaveAttribute('href', /\/tasks\/deadline\/[0-9a-f-]{36}$/);
  await check.click();
  await expect(done).toBeVisible();
  const completed = (
    await (
      await page.request.get('/api/v1/deadlines?status=completed&limit=200')
    ).json()
  ).deadlines as { title: string }[];
  expect(completed.some((item) => item.title === names.now)).toBe(true);
  // After a reload the raw Canvas entry of the completed deadline stays hidden.
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  await expect(
    list.getByRole('listitem').filter({ hasText: names.late }),
  ).toHaveCount(0);
  await expect(page.getByText(names.now)).toHaveCount(0);
});

test('the Today bar keeps a chosen due date readable while its fields are closed', async ({
  page,
}) => {
  await page.goto('/today');
  const bar = page.getByRole('region', { name: 'Add or ask' });
  const toggle = bar.getByRole('button', { name: 'Due date', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(bar.getByLabel('Due date (optional)')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await bar.getByLabel('Due date (optional)').fill('2031-03-07');
  await bar.getByLabel('Due time (optional)').fill('15:00');
  // The formatted time may use a narrow no-break space before PM.
  const chosen = bar.getByRole('button', {
    name: /^Due Fri, Mar 7, 2031, 3:00\sPM$/,
  });
  await chosen.click();
  await expect(chosen).toHaveAttribute('aria-expanded', 'false');
  await expect(bar.getByLabel('Due date (optional)')).toBeHidden();
  const title = unique('Today dated capture');
  await bar.getByRole('textbox', { name: 'Add a task' }).fill(title);
  await bar.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(bar.getByRole('status')).toHaveText('Task saved.');
  // The bar returns to its short form for the next task.
  await expect(
    bar.getByRole('button', { name: 'Due date', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  const saved = (
    (await (await page.request.get('/api/v1/tasks')).json()).tasks as {
      title: string;
      dueDate: string | null;
      dueAt: string | null;
    }[]
  ).find((item) => item.title === title);
  expect(saved?.dueDate).toBe('2031-03-07');
  expect(saved?.dueAt).not.toBeNull();
});

test('more than five overdue items collapse behind a count and the first row is in view on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/today');
  const date = await localToday(page);
  const past = (days: number) =>
    Temporal.PlainDate.from(date).subtract({ days }).toString();
  await stubLists(page, [
    ...Array.from({ length: 7 }, (_, index) => ({
      title: `Late ${index + 1}`,
      dueDate: past(index + 1),
    })),
    { title: 'Due now', dueDate: date },
  ]);
  await page.reload();
  const overdue = page.getByRole('region', { name: 'Overdue' });
  const shown = overdue.getByRole('list', { name: 'Overdue', exact: true });
  // Most recently due first; the oldest two wait behind the disclosure.
  await expect(shown.getByRole('listitem')).toHaveText([
    /Late 1/,
    /Late 2/,
    /Late 3/,
    /Late 4/,
    /Late 5/,
  ]);
  await expect(overdue.getByText('Late 6')).toBeHidden();
  await overdue.getByText('2 more overdue').click();
  await expect(
    overdue.getByRole('list', { name: 'More overdue' }).getByRole('listitem'),
  ).toHaveText([/Late 6/, /Late 7/]);
  await page.unroute('**/api/v1/tasks');
  await stubLists(page, [{ title: 'Due now', dueDate: date }]);
  await page.reload();
  // With nothing overdue, what is due today starts on the first screen.
  const first = page
    .getByRole('region', { name: 'Today' })
    .getByRole('link', { name: 'Due now', exact: true });
  await expect(first).toBeVisible();
  const box = await first.boundingBox();
  expect(box!.y + box!.height).toBeLessThan(640 - 64);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('an imported deadline moved out of range by a Personal Hub due date is not replaced by its Canvas entry', async ({
  page,
}) => {
  await page.goto('/today');
  const date = await localToday(page);
  const title = unique('Moved imported deadline');
  const providerId = String(Math.floor(1e6 + Math.random() * 8e6));
  const at = await compactInstant(page, date, '17:15');
  expect(
    (
      await page.request.post('/api/v1/connections/canvas/import', {
        headers,
        data: {
          operationId: crypto.randomUUID(),
          feed: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${crypto.randomUUID()}\r\nDTSTART:${at}\r\nDTEND:${at}\r\nSUMMARY:${title}\r\nURL:https://canvas.colorado.edu/courses/78/assignments/${providerId}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
        },
      })
    ).status(),
  ).toBe(200);
  const tracked = (
    (
      await (
        await page.request.get('/api/v1/deadlines?status=all&limit=200')
      ).json()
    ).deadlines as {
      id: string;
      version: number;
      canonicalKey: string;
      priority: string;
      notes: string;
      sensitivity: string;
    }[]
  ).find((item) =>
    item.canonicalKey.endsWith(`/courses/78/assignments/${providerId}`),
  )!;
  await page.reload();
  const list = page.getByRole('region', { name: 'Today' });
  await expect(
    list.getByRole('link', { name: title, exact: true }),
  ).toBeVisible();
  // The owner gives it a Personal Hub due date a month away.
  const moved = await page.request.put(`/api/v1/deadlines/${tracked.id}`, {
    headers,
    data: {
      operationId: crypto.randomUUID(),
      expectedVersion: tracked.version,
      titleOverride: null,
      priority: tracked.priority,
      notes: tracked.notes,
      sensitivity: tracked.sensitivity,
      dueOverride: {
        kind: 'date',
        dueDate: Temporal.PlainDate.from(date).add({ days: 30 }).toString(),
      },
    },
  });
  expect(moved.status()).toBe(200);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  await expect(list.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(title)).toHaveCount(0);
});

test('dated cache windows are pruned so the offline store stays bounded', async ({
  page,
}) => {
  await page.goto('/today');
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  const date = await localToday(page);
  const past = (days: number) =>
    Temporal.PlainDate.from(date).subtract({ days }).toString();
  const seeded = {
    oldSchedule: `/api/v1/calendar/occurrences?from=${past(90)}&to=${past(89)}&timeZone=UTC`,
    oldCanvas: `/api/v1/connections/canvas/calendar?from=${past(60)}&to=${past(52)}&timeZone=UTC`,
    recentSchedule: `/api/v1/calendar/occurrences?from=${past(8)}&to=${past(7)}&timeZone=UTC`,
    oldDeadlines: `/api/v1/deadlines?status=all&from=${past(16)}&to=${past(-8)}&limit=200`,
  };
  const keys = (paths?: Record<string, string>) =>
    page.evaluate(
      (add) =>
        new Promise<string[]>((resolve, reject) => {
          const open = indexedDB.open('hub-offline', 1);
          open.onerror = () => reject(new Error('open failed'));
          open.onsuccess = () => {
            const tx = open.result.transaction('local', 'readwrite');
            const store = tx.objectStore('local');
            const read = store.get('state');
            let result: string[] = [];
            read.onsuccess = () => {
              const value = read.result as {
                cache: Record<string, { data: unknown; savedAt: string }>;
              };
              for (const path of Object.values(add ?? {}))
                value.cache[path] = {
                  data: path.includes('/deadlines?')
                    ? { deadlines: [], nextAfter: null }
                    : path.includes('/canvas/')
                      ? { items: [], lastImportedAt: null }
                      : { occurrences: [] },
                  savedAt: new Date().toISOString(),
                };
              if (add) store.put(value, 'state');
              result = Object.keys(value.cache);
            };
            tx.oncomplete = () => {
              open.result.close();
              resolve(result);
            };
            tx.onerror = () => reject(new Error('transaction failed'));
          };
        }),
      paths ?? null,
    );
  expect(await keys(seeded)).toEqual(
    expect.arrayContaining(Object.values(seeded)),
  );
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  await expect
    .poll(async () => (await keys()).includes(seeded.oldSchedule))
    .toBe(false);
  const after = await keys();
  expect(after).not.toContain(seeded.oldCanvas);
  expect(after).not.toContain(seeded.oldDeadlines);
  // A window that ended last week is still readable offline.
  expect(after).toContain(seeded.recentSchedule);
  // Exactly one dated imported-deadline window remains: today's.
  expect(
    after.filter(
      (path) => path.startsWith('/api/v1/deadlines?') && path.includes('from='),
    ),
  ).toHaveLength(1);
  expect(after).toContain('/api/v1/tasks');
});

for (const { theme, width, target } of [
  { theme: 'standard', width: 1280, target: 44 },
  { theme: 'dark', width: 360, target: 44 },
  { theme: 'eink', width: 320, target: 48 },
] as const) {
  test(`Today with rows, an Undo row and open sections passes accessibility, overflow and target checks (${theme}, ${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({
      colorScheme: theme === 'dark' ? 'dark' : 'light',
    });
    await page.addInitScript(
      (value) => localStorage.setItem('hub:eink', String(value === 'eink')),
      theme,
    );
    await page.goto('/today');
    const date = await localToday(page);
    const day = (offset: number) =>
      Temporal.PlainDate.from(date).add({ days: offset }).toString();
    const tag = `${theme} ${crypto.randomUUID().slice(0, 6)}`;
    const finished = `Layout overdue done ${tag}`;
    await createTask(page, { title: finished, dueDate: day(-1) });
    await createTask(page, {
      title: `Layout overdue with a long title that wraps on narrow screens ${tag}`,
      dueDate: day(-2),
      priority: 'high',
    });
    await createTask(page, {
      title: `Layout today ${tag}`,
      dueDate: date,
      priority: 'high',
    });
    await createTask(page, { title: `Layout later ${tag}`, dueDate: day(2) });
    const course = (
      await (
        await page.request.post('/api/v1/courses', {
          headers,
          data: {
            name: `Layout class with a long name ${tag}`,
            operationId: crypto.randomUUID(),
          },
        })
      ).json()
    ).course as { id: string };
    for (const [title, dueDate] of [
      [`Layout work today ${tag}`, date],
      [`Layout work later ${tag}`, day(2)],
    ] as const)
      expect(
        (
          await page.request.post('/api/v1/academic-work', {
            headers,
            data: {
              courseId: course.id,
              title,
              dueDate,
              kind: 'exam',
              operationId: crypto.randomUUID(),
            },
          })
        ).status(),
      ).toBe(200);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Today');
    await expect(
      page.getByRole('button', { name: 'Refresh', exact: true }),
    ).toBeEnabled();
    // Widest states: open due fields, an Undo row and the expanded week.
    // On a phone the Due date button appears once the field is in use.
    const bar = page.getByRole('region', { name: 'Add or ask' });
    const dueToggle = bar.getByRole('button', {
      name: 'Due date',
      exact: true,
    });
    if (width < 480) await expect(dueToggle).toBeHidden();
    await bar.getByRole('textbox', { name: 'Add a task' }).focus();
    await dueToggle.click();
    const overdue = page.getByRole('region', { name: 'Overdue' });
    await overdue
      .getByRole('checkbox', { name: `Complete ${finished}` })
      .click();
    await expect(
      overdue.getByRole('button', { name: 'Undo', exact: true }),
    ).toBeVisible();
    await page.getByText(/^Next 7 days · \d+$/).click();
    await expect(page.getByText(`Layout work later ${tag}`)).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.dataset),
    ).toMatchObject(
      theme === 'eink'
        ? { theme: 'eink' }
        : { scheme: theme === 'dark' ? 'dark' : 'light' },
    );
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      violations.flatMap((item) =>
        item.nodes.map((node) => `${item.id} ${node.target}`),
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const undersized = await page.evaluate(
      (minimum) =>
        [
          ...document.querySelectorAll<HTMLElement>(
            'main button, main a[href], main input, main select, main summary',
          ),
        ]
          .filter((element) => element.offsetParent !== null)
          .filter((element) => {
            const box = element.getBoundingClientRect();
            // Completion checkboxes are full-size targets of their own.
            return (
              (element as HTMLInputElement).type !== 'radio' &&
              (box.height < minimum - 0.5 || box.width < 24)
            );
          })
          .map(
            (element) =>
              `${element.tagName.toLowerCase()} "${(element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(element.getBoundingClientRect().height)}px`,
          ),
      target,
    );
    expect(undersized, `Today controls below ${target}px`).toEqual([]);
    // Rows never overlap: each list row starts at or below the previous one's end.
    const overlaps = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.today-rows')].flatMap(
        (list) => {
          const boxes = [...list.children]
            .map((row) => row.getBoundingClientRect())
            .filter((box) => box.height > 0);
          return boxes.flatMap((box, index) =>
            index > 0 && box.top < boxes[index - 1]!.bottom - 0.5
              ? [`row ${index} overlaps the row above`]
              : [],
          );
        },
      ),
    );
    expect(overlaps).toEqual([]);
    // A row's meta line stays inside its own row, below the title text.
    const escaped = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.today-row__meta')].flatMap(
        (meta) => {
          const row = meta.closest('.today-row')!.getBoundingClientRect();
          const box = meta.getBoundingClientRect();
          return box.height > 0 &&
            (box.top < row.top - 0.5 || box.bottom > row.bottom + 0.5)
            ? [meta.textContent ?? '']
            : [];
        },
      ),
    );
    expect(escaped).toEqual([]);
    if (theme === 'eink') {
      // E-ink: only black/white fills, no shadows or transitions.
      const styling = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('main *')]
          .filter((element) => element.offsetParent !== null)
          .flatMap((element) => {
            const style = getComputedStyle(element);
            const issues: string[] = [];
            if (
              ![
                'rgba(0, 0, 0, 0)',
                'rgb(255, 255, 255)',
                'rgb(0, 0, 0)',
              ].includes(style.backgroundColor)
            )
              issues.push(`fill ${style.backgroundColor}`);
            if (style.boxShadow !== 'none') issues.push('shadow');
            if (
              style.transitionDuration
                .split(',')
                .some((value) => parseFloat(value) > 0)
            )
              issues.push('transition');
            return issues.map(
              (issue) =>
                `${element.tagName.toLowerCase()}.${element.className} ${issue}`,
            );
          }),
      );
      expect(styling).toEqual([]);
    }
  });
}
