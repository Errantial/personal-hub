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
