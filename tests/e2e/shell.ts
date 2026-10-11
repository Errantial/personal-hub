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
