import { expect, test } from '@playwright/test';
import { openSettings } from './shell';
import { authenticate } from './auth';

const checkedAt = '2026-11-13T12:00:00.000Z';
const androidAsset = {
  url: 'https://github.com/Errantial/personal-hub/releases/download/android-0.1.0-300/personal-hub-0.1.0+abc1234.apk',
  sha256: 'a'.repeat(64),
  size: 2 * 1024 * 1024,
};
const latest = {
  versionName: '0.1.0+abc1234',
  versionCode: 300,
  channel: 'stable',
  notes: 'Synthetic release notes.\nSecond synthetic line.',
  android: androidAsset,
  desktop: [],
};
const response = {
  platform: 'android',
  installedVersionCode: 0,
  state: 'update-available',
  checkedAt,
  latest,
  reason: null,
};

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('Account shows a synthetic Android update at 320 px without offering a web install', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/');
  await openSettings(page, 'Account');
  await page.route('**/api/v1/app/update**', async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('platform')).toBe('android');
    expect(url.searchParams.get('versionCode')).toBe('0');
    await route.fulfill({ json: response });
  });

  await expect(
    page.getByRole('heading', { name: 'App updates', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Website (no Android app installed)', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Version 0.1.0+abc1234 available',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/Synthetic release notes/)).toBeVisible();
  await expect(
    page.getByText(
      'Open Personal Hub on Android to download and install this update.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download and install', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Desktop: no build is published for this release.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText('Not checked yet', { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Help: App updates' }).click();
  await expect(
    page.getByText(/Personal Hub never installs silently/),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('Account reports an up-to-date server state without offering a downgrade', async ({
  page,
}) => {
  await page.goto('/');
  await openSettings(page, 'Account');
  await page.route('**/api/v1/app/update**', (route) =>
    route.fulfill({
      json: {
        ...response,
        state: 'current',
        latest: { ...latest, versionCode: 254, versionName: '0.1.0+254' },
      },
    }),
  );
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(
    page.getByText(/Up to date\..*Latest release 0\.1\.0\+254/, {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /available/, exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Download and install', exact: true }),
  ).toHaveCount(0);
});

test('Account shows a malformed-manifest state and an offline check failure', async ({
  page,
}) => {
  await page.goto('/');
  await openSettings(page, 'Account');
  await page.route('**/api/v1/app/update**', (route) =>
    route.fulfill({
      json: {
        ...response,
        state: 'unavailable',
        latest: null,
        reason: 'MANIFEST_INVALID',
      },
    }),
  );
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(
    page.getByText(
      'The latest release has no usable update manifest. Nothing was installed.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download and install', exact: true }),
  ).toHaveCount(0);

  await page.unroute('**/api/v1/app/update**');
  await page.route('**/api/v1/app/update**', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(
    page.getByText('Connect to check for updates.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'The latest release has no usable update manifest. Nothing was installed.',
      { exact: true },
    ),
  ).toHaveCount(0);
});
