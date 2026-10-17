import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/* Shell helpers: navigate as an owner would at any width. Below 1024 px,
   Inbox, Settings and the e-ink toggle live behind More. */
type Destination =
  'Today' | 'Calendar' | 'Tasks' | 'Classes' | 'Inbox' | 'Settings';
type Section = 'Account' | 'Appearance' | 'Connections' | 'AI';

const nav = (page: Page) =>
  page.getByRole('navigation', { name: 'Main navigation' });

async function revealSecondary(
  page: Page,
  target: ReturnType<Page['locator']>,
) {
  // The shell renders after the session check; only then is count() meaningful.
  await expect(nav(page)).toBeVisible();
  if ((await target.count()) === 0)
    await nav(page).getByRole('button', { name: /^More/ }).click();
}

export async function open(page: Page, destination: Destination) {
  const link = nav(page).getByRole('link', {
    name: new RegExp(`^${destination}\\b`),
  });
  await revealSecondary(page, link);
  await link.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(destination);
}

export async function openSettings(page: Page, section: Section) {
  await open(page, 'Settings');
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: section, exact: true })
    .click();
}

/** Opens a Canvas page (calendar feed by default) under Settings › Connections. */
export async function openCanvas(
  page: Page,
  tab:
    | 'Calendar feed'
    | 'Canvas API'
    | 'Browser collector'
    | 'Matching' = 'Calendar feed',
) {
  await openSettings(page, 'Connections');
  await page.getByRole('link', { name: 'Manage Canvas', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Canvas sections' })
    .getByRole('link', { name: tab, exact: true })
    .click();
  await expect(
    page
      .getByRole('navigation', { name: 'Canvas sections' })
      .getByRole('link', { name: tab, exact: true }),
  ).toHaveAttribute('aria-current', 'page');
}

/* Inbox screen helpers. */
export const inboxRegion = (page: Page) =>
  page.getByRole('region', { name: 'Inbox', exact: true });

/** Shows the Reminders section of Inbox (the list, or its editor). */
export async function showReminders(page: Page) {
  await page
    .getByRole('navigation', { name: 'Inbox sections' })
    .getByRole('link', { name: 'Reminders', exact: true })
    .click();
  await expect(
    inboxRegion(page).getByRole('region', { name: 'Reminders' }),
  ).toBeVisible();
}

/** Opens the add-reminder form from the Reminders section. */
export async function newReminder(page: Page) {
  await showReminders(page);
  await inboxRegion(page)
    .getByRole('link', { name: 'Add reminder', exact: true })
    .click();
  await expect(
    inboxRegion(page).getByRole('form', { name: 'Add reminder' }),
  ).toBeVisible();
}

/* Classes screen helpers. */
export const classesRegion = (page: Page) =>
  page.getByRole('region', { name: 'Classes', exact: true });

/** Opens a class from the list, optionally on one of its sections. */
export async function openClass(
  page: Page,
  name: string,
  section?: 'Topics' | 'Study blocks' | 'Canvas' | 'Details',
) {
  await classesRegion(page).getByRole('link', { name, exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 2, name, exact: true }),
  ).toBeVisible();
  if (section)
    await page
      .getByRole('navigation', { name: 'Class sections' })
      .getByRole('link', { name: section, exact: true })
      .click();
}

/* Tasks screen helpers. */
export const tasksRegion = (page: Page) =>
  page.getByRole('region', { name: 'Tasks', exact: true });
export const taskEditor = (page: Page) =>
  page.getByRole('region', { name: 'Edit task', exact: true });

/** Adds a task through the quick-capture form and waits for it in the list. */
export async function addTask(page: Page, title: string, dueDate?: string) {
  const region = tasksRegion(page);
  const toggle = region.getByRole('button', { name: 'Add task', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click();
  const form = region.getByRole('region', { name: 'Quick task capture' });
  await form.getByLabel('Task title').fill(title);
  if (dueDate) await form.getByLabel('Due date').fill(dueDate);
  await form.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(
    region.getByRole('link', { name: title, exact: true }),
  ).toBeVisible();
}

/** Opens a task's editor from the list. */
export async function openTask(page: Page, title: string) {
  await tasksRegion(page)
    .getByRole('link', { name: title, exact: true })
    .click();
  await expect(taskEditor(page)).toBeVisible();
}

/** Switches the Tasks list filter, e.g. 'Done'. */
export async function showTasks(page: Page, filter: string) {
  await page
    .getByRole('navigation', { name: 'Task filters' })
    .getByRole('link', { name: new RegExp(`^${filter}\\b`) })
    .click();
}

/* Calendar screen helpers. */
export const calendarRegion = (page: Page) =>
  page.getByRole('region', { name: 'Calendar', exact: true });
export const eventEditor = (page: Page) =>
  page.getByRole('region', {
    name: /^(New event|Edit event|Edit series|Edit occurrence|Schedule study time)$/,
  });
/** The agenda section for one calendar day (YYYY-MM-DD). */
export const calendarDay = (page: Page, date: string) =>
  calendarRegion(page).locator(`section[data-date="${date}"]`);

/** Sets the viewing timezone (optional), the date and the view, as an owner would. */
export async function showCalendar(
  page: Page,
  options: {
    date?: string;
    view?: 'Agenda' | 'Week' | 'Day' | 'Month';
    zone?: string;
  },
) {
  const region = calendarRegion(page);
  await expect(
    region.getByRole('navigation', { name: 'Calendar views' }),
  ).toBeVisible();
  // Narrow screens keep the date and zone behind the Calendars button.
  const tools = region.getByRole('button', { name: 'Calendars', exact: true });
  if (
    (options.zone || options.date) &&
    (await tools.isVisible()) &&
    (await tools.getAttribute('aria-expanded')) === 'false'
  )
    await tools.click();
  if (options.zone) {
    const zone = region.getByLabel('Viewing timezone', { exact: true });
    if (!(await zone.isVisible()))
      await region.getByText(/^Viewing timezone:/).click();
    await zone.fill(options.zone);
    await region
      .getByRole('button', { name: 'Apply timezone', exact: true })
      .click();
  }
  if (options.date)
    await region.getByLabel('Date', { exact: true }).fill(options.date);
  if (options.view)
    await region
      .getByRole('navigation', { name: 'Calendar views' })
      .getByRole('link', { name: options.view, exact: true })
      .click();
}

/** Opens the new-event form from the calendar. */
export async function newEvent(page: Page) {
  await calendarRegion(page)
    .getByRole('link', { name: 'New event', exact: true })
    .click();
  await expect(eventEditor(page)).toBeVisible();
}

export async function toggleEink(page: Page) {
  const button = nav(page).getByRole('button', { name: /E-ink mode/ });
  await revealSecondary(page, button);
  await button.click();
}

/** One-line task sync summary in the header, e.g. "Offline · 2 queued". */
export const syncState = (page: Page) =>
  page.getByRole('banner').getByRole('status');

export async function syncNow(page: Page) {
  const details = page.getByRole('region', { name: 'Task sync' });
  if (!(await details.isVisible()))
    await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await details.getByRole('button', { name: 'Sync now' }).click();
}

export async function signOut(page: Page) {
  await openSettings(page, 'Account');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
}

export async function expectConnected(page: Page) {
  await expect(syncState(page)).toContainText('Online');
  await expect(page.getByText('The hub server is unavailable.')).toHaveCount(0);
}
