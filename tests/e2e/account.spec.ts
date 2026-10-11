import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { openSettings } from './shell';
import { plannerExportSchema } from '@hub/contracts';
import { authenticate } from './auth';

const headers = { Origin: 'http://127.0.0.1:5180' };
const original = 'synthetic-browser-password';
const replacement = 'synthetic-browser-replacement';
test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('Preferences changes password, rotates sign-ins, and retains planner access', async ({
  page,
  browser,
}) => {
  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:5180' });
  await other.request.post('/api/v1/auth/login', {
    headers,
    data: { email: 'browser@example.test', password: original },
  });
  let changed = false;
  try {
    await page.goto('/');
    await openSettings(page, 'Account');
    await page.getByLabel('Current password', { exact: true }).fill(original);
    await page.getByLabel('New password', { exact: true }).fill(replacement);
    await page
      .getByLabel('Confirm password', { exact: true })
      .fill(replacement);
    const result = page.waitForResponse(
      (response) =>
        response.url().endsWith('/auth/password') &&
        response.request().method() === 'POST',
    );
    await page
      .getByRole('button', { name: 'Change password', exact: true })
      .click();
    expect((await result).status()).toBe(200);
    changed = true;
    await expect(
      page.getByText('Password changed.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Other session', { exact: true })).toHaveCount(
      0,
    );
    expect((await other.request.get('/api/v1/tasks')).status()).toBe(401);
    expect((await page.request.get('/api/v1/tasks')).status()).toBe(200);
    await page.reload();
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: /^Settings/ }),
    ).toBeVisible();
  } finally {
    if (changed) {
      const account = await (
        await page.request.get('/api/v1/auth/account')
      ).json();
      const restored = await page.request.post('/api/v1/auth/password', {
        headers,
        data: {
          currentPassword: replacement,
          newPassword: original,
          expectedVersion: account.version,
        },
      });
      expect(restored.status()).toBe(200);
    }
    await other.close();
  }
});

test('Preferences revokes another session and downloads a planner export on a narrow screen', async ({
  page,
  browser,
}) => {
  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:5180' });
  try {
    expect(
      (
        await other.request.post('/api/v1/auth/login', {
          headers,
          data: { email: 'browser@example.test', password: original },
        })
      ).status(),
    ).toBe(200);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto('/');
    await openSettings(page, 'Account');
    await page
      .getByRole('button', { name: 'Revoke', exact: true })
      .first()
      .click();
    await expect(
      page.getByText('Session revoked.', { exact: true }),
    ).toBeVisible();
    expect((await other.request.get('/api/v1/tasks')).status()).toBe(401);
    const downloading = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Download JSON', exact: true })
      .click();
    const download = await downloading;
    const file = await download.path();
    expect(file).not.toBeNull();
    const data = plannerExportSchema.parse(
      JSON.parse(await readFile(file!, 'utf8')),
    );
    expect(data.owner.email).toBe('browser@example.test');
    expect(download.suggestedFilename()).toMatch(
      /^personal-hub-\d{4}-\d{2}-\d{2}\.json$/,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await other.close();
  }
});
