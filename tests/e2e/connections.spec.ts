import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { authenticate } from './auth';
import { openCanvas, openSettings } from './shell';

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('Canvas pages have their own addresses and a way back', async ({
  page,
}) => {
  await page.goto('/');
  await openSettings(page, 'Connections');
  await expect(page).toHaveURL('/settings/connections');
  await openCanvas(page, 'Canvas API');
  await expect(page).toHaveURL('/settings/connections/canvas?tab=api');
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Canvas API connection' }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Canvas sections' })
    .getByRole('link', { name: 'Matching', exact: true })
    .click();
  await expect(page).toHaveURL('/settings/connections/canvas?tab=matching');
  await page.goBack();
  await expect(page).toHaveURL('/settings/connections/canvas?tab=api');
  await page.getByRole('link', { name: 'Back to connections' }).click();
  await expect(page).toHaveURL('/settings/connections');
  // Providers that cannot be connected say so instead of "Not connected".
  await expect(
    page.getByText('Not available yet', { exact: true }).first(),
  ).toBeVisible();
});

test('Outlook access gate records feasibility without offering mailbox connection', async ({
  page,
}) => {
  await page.goto('/');
  await openSettings(page, 'Connections');
  await page.getByRole('link', { name: 'Review Outlook access' }).click();
  await expect(page).toHaveURL('/settings/connections/outlook');
  const gate = page.getByRole('region', { name: 'Outlook access gate' });
  await expect(gate).toContainText('Access not established');
  await gate.getByRole('button', { name: 'Help: Outlook access gate' }).click();
  await expect(gate).toContainText('does not sign in to Microsoft');
  const form = gate.getByRole('form', { name: 'Outlook access findings' });
  await form.getByLabel('Mailbox backend').selectOption('exchange-online');
  await form.getByLabel('Microsoft tenant').selectOption('school-managed');
  await form.getByLabel('Required mailbox scope').selectOption('primary-only');
  await form.getByLabel('App registration').selectOption('admin-must-register');
  await form
    .getByLabel('Delegated Mail.Read consent')
    .selectOption('admin-consent-required');
  await form.getByRole('button', { name: 'Save findings' }).click();
  await expect(gate.getByRole('status')).toHaveText(
    'Outlook access findings saved.',
  );
  await expect(gate).toContainText('Admin action required');
  await expect(gate).toContainText(
    'Do not replace this with tenant-wide application mail permissions.',
  );
  await form.getByLabel('App registration').selectOption('owner-can-register');
  await form
    .getByLabel('Delegated Mail.Read consent')
    .selectOption('user-can-consent');
  await page.evaluate(async () => {
    const current = await fetch('/api/v1/connections/outlook/access').then(
      (value) => value.json(),
    );
    await fetch('/api/v1/connections/outlook/access', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        expectedVersion: current.version,
        backend: current.backend,
        tenant: current.tenant,
        mailboxScope: current.mailboxScope,
        appRegistration: 'admin-must-register',
        consent: 'user-can-consent',
      }),
    });
  });
  await form.getByRole('button', { name: 'Save findings' }).click();
  await expect(gate.getByRole('alert')).toContainText('changed elsewhere');
  await expect(form.getByLabel('App registration')).toHaveValue(
    'owner-can-register',
  );
  await form.getByRole('button', { name: 'Reload current version' }).click();
  await expect(form.getByLabel('App registration')).toHaveValue(
    'owner-can-register',
  );
  await expect(form.getByLabel('Delegated Mail.Read consent')).toHaveValue(
    'user-can-consent',
  );
  await form.getByRole('button', { name: 'Discard changes' }).click();
  await expect(form.getByLabel('App registration')).toHaveValue(
    'admin-must-register',
  );
  await page.reload();
  await expect(gate).toContainText('Admin action required');
  await expect(form.getByLabel('Mailbox backend')).toHaveValue(
    'exchange-online',
  );
  await expect(form.getByLabel('Microsoft tenant')).toHaveValue(
    'school-managed',
  );
  await expect(form.getByLabel('App registration')).toHaveValue(
    'admin-must-register',
  );
  await expect(
    page.getByRole('button', { name: /connect|sign in/i }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to connections' }).click();
  await expect(page).toHaveURL('/settings/connections');
  await expect(
    page.getByRole('article', { name: 'School Outlook' }),
  ).toContainText('Admin action required');
});

for (const { theme, width, target } of [
  { theme: 'standard', width: 1280, target: 44 },
  { theme: 'eink', width: 320, target: 48 },
] as const) {
  test(`connection screens pass accessibility and target checks (${theme}, ${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(
      (value) => localStorage.setItem('hub:eink', String(value === 'eink')),
      theme,
    );
    for (const path of [
      '/settings/connections',
      '/settings/connections/canvas',
      '/settings/connections/canvas?tab=api',
      '/settings/connections/canvas?tab=browser',
      '/settings/connections/canvas?tab=matching',
      '/settings/connections/outlook',
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Settings' }),
      ).toBeVisible();
      await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(violations.map((item) => `${path}: ${item.id}`)).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${path} overflows`,
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
