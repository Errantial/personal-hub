import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authenticate } from './auth';
import {
  calendarDay,
  calendarRegion,
  eventEditor,
  newEvent,
  showCalendar,
} from './shell';

const headers = { Origin: 'http://127.0.0.1:5180' };

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

async function createEvent(
  page: Page,
  title: string,
  extra: Record<string, unknown> = {},
) {
  const reply = await page.request.post('/api/v1/calendar', {
    headers,
    data: {
      title,
      startsAt: '2028-01-03T14:00:00Z',
      endsAt: '2028-01-03T15:00:00Z',
      timeZone: 'UTC',
      operationId: crypto.randomUUID(),
      ...extra,
    },
  });
  expect(reply.status()).toBe(200);
  return ((await reply.json()) as { event: { id: string } }).event;
}

async function eventByTitle(page: Page, title: string) {
  const reply = await page.request.get('/api/v1/calendar');
  const events = (await reply.json()).events as {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
  }[];
  return events.find((event) => event.title === title);
}

test('agenda groups days, lists all-day first and has addressable windows', async ({
  page,
}) => {
  await createEvent(page, 'Agenda all-day', {
    allDay: true,
    startDate: '2028-01-03',
    endDate: '2028-01-04',
    startsAt: '2028-01-03T00:00:00Z',
    endsAt: '2028-01-04T00:00:00Z',
  });
  await createEvent(page, 'Agenda morning');
  await createEvent(page, 'Agenda later', {
    startsAt: '2028-01-05T16:00:00Z',
    endsAt: '2028-01-05T17:00:00Z',
  });
  await page.goto('/calendar?date=2028-01-03&view=agenda');
  await showCalendar(page, { zone: 'UTC' });
  const view = calendarRegion(page);
  await expect(calendarDay(page, '2028-01-03')).toBeVisible();
  // All-day entries come first, then timed entries by start.
  await expect(
    calendarDay(page, '2028-01-03').locator('.calendar-row__title'),
  ).toHaveText(['Agenda all-day', 'Agenda morning']);
  await expect(calendarDay(page, '2028-01-05')).toBeVisible();
  // Agenda skips days with nothing on them.
  await expect(calendarDay(page, '2028-01-04')).toHaveCount(0);
  await expect(
    view.getByRole('navigation', { name: 'Calendar views' }).getByRole('link', {
      name: 'Agenda',
    }),
  ).toHaveAttribute('aria-current', 'page');

  await view.getByRole('link', { name: 'Next 7 days', exact: true }).click();
  await expect(page).toHaveURL(/\/calendar\?date=2028-01-10&view=agenda$/);
  await expect(calendarDay(page, '2028-01-03')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/calendar\?date=2028-01-03&view=agenda$/);
  await expect(calendarDay(page, '2028-01-03')).toBeVisible();

  await showCalendar(page, { view: 'Week' });
  await expect(page).toHaveURL(/date=2028-01-03&view=week$/);
  await expect(view.getByRole('heading', { level: 2 }).first()).toHaveText(
    'Jan 3 – 9, 2028',
  );
  await view.getByRole('link', { name: 'Next week', exact: true }).click();
  await expect(view.getByRole('heading', { level: 2 }).first()).toHaveText(
    'Jan 10 – 16, 2028',
  );
  await view.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}&view=week$/);

  await page.goto('/calendar?date=2028-01-05&view=day');
  await expect(
    view.getByRole('link', { name: /^Agenda later, / }),
  ).toBeVisible();
  // An invalid date or view falls back to this week.
  await page.goto('/calendar?date=2028-13-40&view=year');
  await expect(
    view.getByRole('navigation', { name: 'Calendar views' }).getByRole('link', {
      name: 'Week',
    }),
  ).toHaveAttribute('aria-current', 'page');
});

test('a time skipped by daylight saving cannot be saved', async ({ page }) => {
  await page.goto('/calendar?date=2027-03-14');
  await showCalendar(page, { zone: 'UTC' });
  await newEvent(page);
  const editor = eventEditor(page);
  let writes = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/v1/calendar')
    )
      writes += 1;
  });
  await editor.getByLabel('Title', { exact: true }).fill('DST gap event');
  await editor
    .getByLabel('Event timezone', { exact: true })
    .fill('America/New_York');
  await editor.getByLabel('Starts', { exact: true }).fill('2027-03-14T02:30');
  await editor.getByLabel('Ends', { exact: true }).fill('2027-03-14T04:30');
  await expect(
    editor.getByText(/does not exist in the event timezone/),
  ).toBeVisible();
  // No repeated-time choice is offered for a skipped time.
  await expect(editor.getByRole('radio')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Save event' }).click();
  await expect(editor.getByLabel('Starts', { exact: true })).toBeFocused();
  expect(writes).toBe(0);
  await editor.getByLabel('Starts', { exact: true }).fill('2027-03-14T03:30');
  await expect(
    editor.getByText(/does not exist in the event timezone/),
  ).toHaveCount(0);
  await editor.getByRole('button', { name: 'Save event' }).click();
  await expect(
    calendarRegion(page).getByRole('link', { name: 'DST gap event' }),
  ).toBeVisible();
  // 03:30 on the day clocks go forward is Eastern Daylight Time (UTC-4).
  expect((await eventByTitle(page, 'DST gap event'))?.startsAt).toBe(
    '2027-03-14T07:30:00.000Z',
  );
});

test('a repeated time needs an earlier or later choice, and it is remembered', async ({
  page,
}) => {
  await page.goto('/calendar?date=2027-11-07');
  await showCalendar(page, { zone: 'UTC' });
  await newEvent(page);
  const editor = eventEditor(page);
  await editor.getByLabel('Title', { exact: true }).fill('DST fold event');
  await editor
    .getByLabel('Event timezone', { exact: true })
    .fill('America/New_York');
  // Unambiguous times show no choice.
  await editor.getByLabel('Starts', { exact: true }).fill('2027-11-07T00:30');
  await editor.getByLabel('Ends', { exact: true }).fill('2027-11-07T03:30');
  await expect(editor.getByRole('radio')).toHaveCount(0);
  await editor.getByLabel('Starts', { exact: true }).fill('2027-11-07T01:30');
  await expect(editor.getByRole('radio')).toHaveCount(2);
  await expect(
    editor.getByRole('group', { name: 'Starts at a repeated time' }),
  ).toBeVisible();
  const earlier = editor.getByRole('radio', { name: /^Earlier \(UTC-04:00\)/ });
  const later = editor.getByRole('radio', { name: /^Later \(UTC-05:00\)/ });
  await expect(earlier).not.toBeChecked();
  await expect(later).not.toBeChecked();
  await editor.getByRole('button', { name: 'Save event' }).click();
  await expect(earlier).toBeFocused();
  expect(await eventByTitle(page, 'DST fold event')).toBeUndefined();
  // Keyboard: arrow keys move between the two choices.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(later).toBeChecked();
  await editor.getByRole('button', { name: 'Save event' }).click();
  await expect(
    calendarRegion(page).getByRole('link', { name: 'DST fold event' }),
  ).toBeVisible();
  const saved = await eventByTitle(page, 'DST fold event');
  expect(saved?.startsAt).toBe('2027-11-07T06:30:00.000Z');

  await page.goto(`/calendar/${saved!.id}`);
  const reopened = eventEditor(page);
  await expect(reopened.getByLabel('Starts', { exact: true })).toHaveValue(
    '2027-11-07T01:30',
  );
  await expect(
    reopened.getByRole('radio', { name: /^Later \(UTC-05:00\)/ }),
  ).toBeChecked();
  // Changing the time makes a new choice necessary again.
  await reopened.getByLabel('Starts', { exact: true }).fill('2027-11-07T01:45');
  await expect(
    reopened.getByRole('radio', { name: /^Later \(UTC-05:00\)/ }),
  ).not.toBeChecked();
});

test('an event can be created and edited with the keyboard alone', async ({
  page,
}) => {
  await page.goto('/calendar?date=2028-02-07&view=agenda');
  const view = calendarRegion(page);
  await view.getByRole('link', { name: 'New event', exact: true }).focus();
  await page.keyboard.press('Enter');
  const editor = eventEditor(page);
  await expect(editor).toBeVisible();
  await editor.getByLabel('Title', { exact: true }).focus();
  await page.keyboard.type('Keyboard event');
  // Enter in a text field submits the form.
  await page.keyboard.press('Enter');
  const row = view.getByRole('link', { name: 'Keyboard event', exact: true });
  await expect(row).toBeVisible();
  await expect(page).toHaveURL(/\/calendar\?date=2028-02-07&view=agenda$/);

  await row.focus();
  await page.keyboard.press('Enter');
  await expect(editor).toBeVisible();
  await editor.getByLabel('Title', { exact: true }).focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Keyboard edited');
  await page.keyboard.press('Enter');
  await expect(editor.getByRole('status').first()).toHaveText('Saved.');
  await expect(
    view.getByRole('link', { name: 'Keyboard edited', exact: true }),
  ).toBeVisible();
  // The empty-title error moves focus to the field.
  await editor.getByLabel('Title', { exact: true }).focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Enter');
  await expect(editor.getByText('Enter a title')).toBeVisible();
  await expect(editor.getByLabel('Title', { exact: true })).toBeFocused();
});

test('deleting a recurring event asks for the scope and a series can be undone', async ({
  page,
}) => {
  const series = await createEvent(page, 'Scope series', {
    startsAt: '2028-03-06T10:00:00Z',
    endsAt: '2028-03-06T11:00:00Z',
    recurrence: { frequency: 'daily', interval: 1, count: 3, until: null },
  });
  await page.goto('/calendar?date=2028-03-06&view=agenda');
  await showCalendar(page, { zone: 'UTC' });
  const view = calendarRegion(page);
  await calendarDay(page, '2028-03-07')
    .getByRole('link', { name: 'Scope series', exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/calendar/${series.id}/occurrence/2028-03-07`),
  );
  const editor = eventEditor(page);
  await editor
    .getByRole('button', { name: 'Delete occurrence or series' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Scope series”?' });
  // Cancel leaves everything as it was.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(calendarDay(page, '2028-03-07')).toBeVisible();
  await editor
    .getByRole('button', { name: 'Delete occurrence or series' })
    .click();
  await dialog.getByRole('button', { name: 'This occurrence' }).click();
  await expect(
    view.getByText('Deleted 2028-03-07 of “Scope series”.', { exact: true }),
  ).toBeVisible();
  // One occurrence cannot be undone, so no Undo is offered.
  await expect(view.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await expect(calendarDay(page, '2028-03-07')).toHaveCount(0);
  await expect(calendarDay(page, '2028-03-06')).toBeVisible();
  await expect(calendarDay(page, '2028-03-08')).toBeVisible();

  // The whole series can be deleted from its own editor and undone.
  await page.goto(`/calendar/${series.id}?date=2028-03-06&view=agenda`);
  await expect(
    editor.getByRole('heading', { name: 'Edit series' }),
  ).toBeVisible();
  await editor.getByRole('button', { name: 'Delete series' }).click();
  await expect(
    view.getByText('Deleted “Scope series”.', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/calendar\?date=2028-03-06&view=agenda$/);
  await expect(calendarDay(page, '2028-03-06')).toHaveCount(0);
  await view.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(view.getByText('Restored “Scope series”.')).toBeVisible();
  await expect(calendarDay(page, '2028-03-06')).toBeVisible();

  // Without the Undo notice it is still restorable while online.
  await calendarDay(page, '2028-03-06')
    .getByRole('link', { name: 'Scope series', exact: true })
    .click();
  await editor.getByRole('link', { name: 'Edit entire series' }).click();
  await editor.getByRole('button', { name: 'Delete series' }).click();
  await expect(calendarDay(page, '2028-03-06')).toHaveCount(0);
  await page.reload();
  await view.getByText('Recently deleted', { exact: true }).click();
  await view.getByRole('button', { name: 'Restore Scope series' }).click();
  await expect(view.getByText(/^Restored “Scope series”\./)).toBeVisible();
  await expect(calendarDay(page, '2028-03-06')).toBeVisible();
  const reply = await page.request.get('/api/v1/calendar');
  const events = (await reply.json()).events as { title: string }[];
  expect(events.filter((event) => event.title === 'Scope series')).toHaveLength(
    1,
  );
});

test('selected events change together; study status is limited and series deletion is explicit', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const courseReply = await page.request.post('/api/v1/courses', {
    headers,
    data: { operationId: crypto.randomUUID(), name: `Batch class ${suffix}` },
  });
  expect(courseReply.status()).toBe(200);
  const courseId = (await courseReply.json()).course.id as string;
  const study = (name: string, hour: number) => ({
    title: `${name} ${suffix}`,
    startsAt: `2028-07-03T${hour}:00:00Z`,
    endsAt: `2028-07-03T${hour + 1}:00:00Z`,
    timeZone: 'UTC',
    courseId,
  });
  const first = await createEvent(page, '', study('Study A', 10));
  const second = await createEvent(page, '', study('Study B', 12));
  const series = await createEvent(page, `Series ${suffix}`, {
    startsAt: '2028-07-03T15:00:00Z',
    endsAt: '2028-07-03T16:00:00Z',
    recurrence: { frequency: 'daily', interval: 1, count: 3, until: null },
  });
  const current = async (id: string) =>
    (
      (await (await page.request.get('/api/v1/calendar')).json()) as {
        events: { id: string; version: number; studyStatus: string }[];
      }
    ).events.find((event) => event.id === id);
  await page.goto('/calendar?date=2028-07-03&view=agenda');
  await showCalendar(page, { zone: 'UTC' });
  const view = calendarRegion(page);
  const bar = view.getByRole('region', { name: 'Selected events' });
  // Agenda lists a series once per day; any of its boxes selects it.
  const select = (name: string) =>
    view
      .getByRole('checkbox', { name: `Select ${name}` })
      .first()
      .check();

  // Study status changes exactly the selected one-time study blocks.
  await view.getByRole('button', { name: 'Select', exact: true }).click();
  await select(`Study A ${suffix}`);
  await select(`Study B ${suffix}`);
  await expect(bar.getByText('2 events selected')).toBeVisible();
  await bar.getByRole('button', { name: 'Apply to 2 events' }).click();
  await expect(
    view.getByText('Mark study done: 2 events updated.', { exact: true }),
  ).toBeVisible();
  expect((await current(first.id))?.studyStatus).toBe('completed');
  expect((await current(second.id))?.studyStatus).toBe('completed');

  // A series cannot take a study status, and its deletion scope is shown.
  await view.getByRole('button', { name: 'Select', exact: true }).click();
  await select(`Study A ${suffix}`);
  await select(`Series ${suffix} (series)`);
  await expect(
    bar.getByText('1 selected event is not a one-time timed study block.'),
  ).toBeVisible();
  await expect(
    bar.getByRole('button', { name: 'Apply to 2 events' }),
  ).toBeDisabled();
  await bar.getByRole('combobox', { name: /^Change/ }).selectOption('Delete');
  await expect(
    bar.getByText('1 repeating series selected: every occurrence is deleted.'),
  ).toBeVisible();

  // A record changed after selection makes the whole batch fail unchanged.
  const changed = await page.request.put(`/api/v1/calendar/${first.id}`, {
    headers,
    data: {
      ...study('Study A', 10),
      studyStatus: 'completed',
      notes: 'Changed elsewhere',
      expectedVersion: (await current(first.id))!.version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(changed.status()).toBe(200);
  const dialog = page.getByRole('dialog', { name: 'Delete 2 events?' });
  await bar.getByRole('button', { name: 'Apply to 2 events' }).click();
  await expect(dialog).toContainText(
    'Includes 1 repeating series: every occurrence is deleted.',
  );
  await dialog.getByRole('button', { name: 'Delete 2 events' }).click();
  await expect(bar.getByRole('alert')).toContainText(
    'A selected event changed or was deleted elsewhere. Nothing was changed.',
  );
  expect(await current(series.id)).toBeDefined();
  await bar.getByRole('button', { name: 'Review latest versions' }).click();
  await bar.getByRole('button', { name: 'Apply to 2 events' }).click();
  await dialog.getByRole('button', { name: 'Delete 2 events' }).click();
  await expect(
    view.getByText('Deleted 2 events. Restore from Recently deleted.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(await current(series.id)).toBeUndefined();
  expect(await current(first.id)).toBeUndefined();
  expect(await current(second.id)).toBeDefined();
  await view.getByText('Recently deleted', { exact: true }).click();
  await expect(
    view.getByRole('button', { name: `Restore Series ${suffix}` }),
  ).toBeVisible();
});

test('changing a series start or repeat rule warns that occurrence edits reset', async ({
  page,
}) => {
  const series = await createEvent(page, 'Reset warning series', {
    startsAt: '2028-04-03T10:00:00Z',
    endsAt: '2028-04-03T11:00:00Z',
    recurrence: { frequency: 'weekly', interval: 1, count: 4, until: null },
  });
  await page.goto(`/calendar/${series.id}`);
  const editor = eventEditor(page);
  const warning = editor.getByText(/resets this series’ edited occurrences/);
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(
    'Reset warning series',
  );
  await expect(warning).toHaveCount(0);
  // Title, notes and end time are not part of the series pattern.
  await editor.getByLabel('Title', { exact: true }).fill('Renamed series');
  await editor.getByLabel('Notes (optional)').fill('Notes only');
  await expect(warning).toHaveCount(0);
  await editor.getByLabel('Every (1–52)').fill('2');
  await expect(warning).toBeVisible();
  await editor.getByLabel('Every (1–52)').fill('1');
  await expect(warning).toHaveCount(0);
  await editor
    .getByRole('combobox', { name: 'Repeat', exact: true })
    .selectOption('daily');
  await expect(warning).toBeVisible();
  await editor
    .getByRole('combobox', { name: 'Repeat', exact: true })
    .selectOption('weekly');
  await expect(warning).toHaveCount(0);
  // An occurrence edit has no repeat section and no reset.
  await page.goto(`/calendar/${series.id}/occurrence/2028-04-10`);
  await expect(
    editor.getByRole('heading', { name: 'Edit occurrence' }),
  ).toBeVisible();
  await expect(editor.getByRole('group', { name: 'Repeat' })).toHaveCount(0);
  await expect(warning).toHaveCount(0);
});

test('unknown event and occurrence addresses explain themselves and link back', async ({
  page,
}) => {
  await page.goto(`/calendar/${crypto.randomUUID()}`);
  const message = page.getByRole('region', { name: 'Event editor' });
  await expect(message).toContainText('This event is not available.');
  await message.getByRole('link', { name: 'Back to calendar' }).click();
  await expect(page).toHaveURL(/\/calendar$/);

  const series = await createEvent(page, 'Occurrence bounds', {
    recurrence: { frequency: 'daily', interval: 1, count: 2, until: null },
  });
  await page.goto(`/calendar/${series.id}/occurrence/2030-01-01`);
  await expect(message).toContainText('This occurrence is not available.');
  await message.getByRole('link', { name: 'Edit entire series' }).click();
  await expect(
    eventEditor(page).getByRole('heading', { name: 'Edit series' }),
  ).toBeVisible();
});

for (const { theme, width, target } of [
  { theme: 'standard', width: 1280, target: 44 },
  { theme: 'eink', width: 320, target: 48 },
] as const) {
  test(`calendar views and editor pass accessibility, overflow and target checks (${theme}, ${width}px)`, async ({
    page,
  }) => {
    // Eight addresses, each with an axe run.
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(
      (value) => localStorage.setItem('hub:eink', String(value === 'eink')),
      theme,
    );
    const title = `Layout ${theme}`;
    const event = await createEvent(page, title, {
      notes: 'Layout notes',
      sensitivity: 'personal',
      startsAt: '2028-05-01T14:00:00Z',
      endsAt: '2028-05-01T15:00:00Z',
      recurrence: { frequency: 'daily', interval: 1, count: 2, until: null },
    });
    await createEvent(page, `Layout all-day ${theme}`, {
      allDay: true,
      startDate: '2028-05-01',
      endDate: '2028-05-02',
      startsAt: '2028-05-01T00:00:00Z',
      endsAt: '2028-05-02T00:00:00Z',
    });
    // [path, whether Select mode is open with a series deletion pending]
    const paths = [
      ['/calendar?date=2028-05-01&view=agenda', false],
      ['/calendar?date=2028-05-01&view=agenda', true],
      ['/calendar?date=2028-05-01', false],
      ['/calendar?date=2028-05-01&view=day', false],
      ['/calendar?date=2028-05-01&view=month', false],
      ['/calendar/new?date=2028-05-01', false],
      [`/calendar/${event.id}?date=2028-05-01`, false],
      [`/calendar/${event.id}/occurrence/2028-05-01?date=2028-05-01`, false],
    ] as const;
    for (const [path, selecting] of paths) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Calendar',
      );
      await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
      await expect(
        calendarRegion(page).getByRole('heading', { level: 2 }).first(),
      ).toBeVisible();
      if (selecting) {
        const view = calendarRegion(page);
        await view.getByRole('button', { name: 'Select', exact: true }).click();
        await view
          .getByRole('checkbox', { name: `Select ${title} (series)` })
          .first()
          .check();
        await view
          .getByRole('combobox', { name: /^Change/ })
          .selectOption('Delete');
        await expect(
          view.getByText('1 repeating series selected', { exact: false }),
        ).toBeVisible();
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
            // A checkbox or radio's tap area is its label.
            .filter(
              (element) =>
                !['checkbox', 'radio'].includes(
                  (element as HTMLInputElement).type,
                ),
            )
            .filter((element) => {
              const box = element.getBoundingClientRect();
              // Grid chips and event blocks have full-size equivalents in
              // Agenda (WCAG 2.5.8 equivalent exception); they keep 24px.
              const floor = element.matches('.calendar-chip, .time-grid__block')
                ? 24
                : minimum;
              return box.height < floor - 0.5 || box.width < 24;
            })
            .map(
              (element) =>
                `${element.tagName.toLowerCase()} "${(element.textContent || element.getAttribute('name') || '').trim().slice(0, 30)}" ${Math.round(element.getBoundingClientRect().height)}px`,
            ),
        target,
      );
      expect(undersized, `${path} controls below ${target}px`).toEqual([]);
    }
    await page.goto('/calendar?date=2028-05-01&view=agenda');
    await expect(calendarDay(page, '2028-05-01')).toBeVisible();
    await page.getByRole('link', { name: title, exact: true }).first().click();
    if (width < 1024) {
      // Narrow screens show the editor alone, with a way back.
      await expect(calendarDay(page, '2028-05-01')).toBeHidden();
      await page.getByRole('link', { name: 'Back to calendar' }).click();
      await expect(page).toHaveURL(/\/calendar\?date=2028-05-01&view=agenda$/);
      await expect(calendarDay(page, '2028-05-01')).toBeVisible();
    } else {
      // Wide screens keep the agenda beside the editor.
      await expect(calendarDay(page, '2028-05-01')).toBeVisible();
    }
  });
}

/* Week, Day and Month grids (docs/superpowers/specs/2026-10-14-ui-rework-design.md). */

async function createTask(page: Page, title: string, dueDate: string) {
  const reply = await page.request.post('/api/v1/tasks', {
    headers,
    data: {
      title,
      dueDate,
      notes: '',
      priority: 'normal',
      completed: false,
      sensitivity: 'unlabeled',
      operationId: crypto.randomUUID(),
    },
  });
  expect(reply.status()).toBe(200);
}

test('the sidebar mini month moves to a date and keeps the view', async ({
  page,
}) => {
  await page.goto('/calendar?date=2029-01-10');
  const view = calendarRegion(page);
  await view
    .getByRole('button', { name: 'Wednesday, January 17, 2029', exact: true })
    .click();
  await expect(page).toHaveURL(/\/calendar\?date=2029-01-17$/);
  await expect(view.getByRole('heading', { level: 2 }).first()).toHaveText(
    'Jan 15 – 21, 2029',
  );
});

test('the all-day strip shows task due dates, and Show toggles hide a source and are remembered', async ({
  page,
}) => {
  const title = `Strip task ${crypto.randomUUID().slice(0, 8)}`;
  await createTask(page, title, '2029-01-24');
  await page.goto('/calendar?date=2029-01-24');
  const view = calendarRegion(page);
  const strip = view.getByRole('list', { name: /^All day, Wednesday/ });
  await expect(
    strip.getByRole('link', { name: new RegExp(title) }),
  ).toBeVisible();
  const toggle = view.getByRole('checkbox', { name: 'Task due dates' });
  await toggle.uncheck();
  await expect(
    strip.getByRole('link', { name: new RegExp(title) }),
  ).toHaveCount(0);
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await expect(
    strip.getByRole('link', { name: new RegExp(title) }),
  ).toHaveCount(0);
  await toggle.check();
  await expect(
    strip.getByRole('link', { name: new RegExp(title) }),
  ).toBeVisible();
});

test('below 1024 px the sidebar is behind a Calendars button', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/calendar?date=2029-01-10');
  const view = calendarRegion(page);
  const tools = view.getByRole('button', { name: 'Calendars', exact: true });
  const day = view.getByRole('button', {
    name: 'Wednesday, January 17, 2029',
    exact: true,
  });
  await expect(tools).toHaveAttribute('aria-expanded', 'false');
  await expect(day).toBeHidden();
  await expect(view.getByRole('link', { name: 'New event' })).toBeVisible();
  await tools.click();
  await expect(tools).toHaveAttribute('aria-expanded', 'true');
  await expect(day).toBeVisible();
});

test('week grid shows a timed event as a block at its time and opens the editor', async ({
  page,
}) => {
  const title = `Calculus ${crypto.randomUUID().slice(0, 8)}`;
  const event = await createEvent(page, title, {
    startsAt: '2029-02-07T09:00:00Z',
    endsAt: '2029-02-07T10:00:00Z',
  });
  await page.goto('/calendar?date=2029-02-07');
  await showCalendar(page, { zone: 'UTC' });
  const view = calendarRegion(page);
  const block = view.getByRole('link', { name: new RegExp(`^${title}, `) });
  await expect(block).toBeVisible();
  // Under the Wednesday column…
  const header = await view
    .getByRole('link', { name: 'Wednesday, February 7', exact: true })
    .boundingBox();
  const box = await block.boundingBox();
  const middle = box!.x + box!.width / 2;
  expect(middle).toBeGreaterThan(header!.x);
  expect(middle).toBeLessThan(header!.x + header!.width);
  // …starting at 9 of 24 hours down the day.
  const hour = await block.evaluate(
    (element) => element.offsetTop / (element.parentElement!.offsetHeight / 24),
  );
  expect(hour).toBeCloseTo(9, 1);
  await block.click();
  await expect(page).toHaveURL(new RegExp(`/calendar/${event.id}[?]`));
  await expect(eventEditor(page)).toBeVisible();
});

test('clicking an empty slot starts a new event at that hour', async ({
  page,
}) => {
  await page.goto('/calendar?date=2029-02-07');
  await showCalendar(page, { zone: 'UTC' });
  await calendarRegion(page)
    .getByRole('button', { name: 'New event Thu 1 PM', exact: true })
    .click();
  await expect(page).toHaveURL(/\/calendar\/new\?.*start=2029-02-08T13%3A00/);
  await expect(
    eventEditor(page).getByLabel('Starts', { exact: true }),
  ).toHaveValue('2029-02-08T13:00');
  await expect(
    eventEditor(page).getByLabel('Ends', { exact: true }),
  ).toHaveValue('2029-02-08T14:00');
});

test('day view is the default below 640 px, and the now line is on today only', async ({
  page,
}) => {
  await page.goto('/calendar');
  const view = calendarRegion(page);
  const views = view.getByRole('navigation', { name: 'Calendar views' });
  await expect(views.getByRole('link', { name: 'Week' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // One now line, in the column whose date is marked as today.
  const columns = view.locator('.time-grid__day');
  await expect(view.locator('.time-grid__now')).toHaveCount(1);
  const nowColumn = await columns.evaluateAll((items) =>
    items.findIndex((item) => item.querySelector('.time-grid__now')),
  );
  const todayColumn = await view
    .locator('.time-grid__date')
    .evaluateAll((items) =>
      items.findIndex((item) =>
        item.querySelector('.time-grid__daynum--today'),
      ),
    );
  expect(nowColumn).toBe(todayColumn);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await expect(views.getByRole('link', { name: 'Day' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(columns).toHaveCount(1);
});

test('month view shows up to three chips per day and +N more opens Day view', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  for (const hour of [9, 10, 11, 12, 13])
    await createEvent(page, `Month ${hour} ${suffix}`, {
      startsAt: `2029-03-14T${String(hour).padStart(2, '0')}:00:00Z`,
      endsAt: `2029-03-14T${String(hour).padStart(2, '0')}:30:00Z`,
    });
  await page.goto('/calendar?date=2029-03-14&view=month');
  await showCalendar(page, { zone: 'UTC' });
  const view = calendarRegion(page);
  await expect(view.getByRole('heading', { level: 2 }).first()).toHaveText(
    'March 2029',
  );
  const cell = view.getByRole('cell').filter({
    has: page.getByRole('link', { name: 'Wednesday, March 14', exact: true }),
  });
  await expect(cell.getByRole('listitem')).toHaveCount(3);
  await cell.getByText('+2 more').click();
  await expect(page).toHaveURL(/\/calendar\?date=2029-03-14&view=day$/);
  await expect(
    view.getByRole('link', { name: new RegExp(`^Month 13 ${suffix}, `) }),
  ).toBeVisible();
  await page.goto('/calendar?view=month');
  await expect(view.locator('td[aria-current="date"]')).toHaveCount(1);
});
