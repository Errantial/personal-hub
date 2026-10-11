import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { authenticate } from './auth';

/* Guards docs/ui-guidelines.md §4/§9 on every view: WCAG 2.2 AA automated
   checks, no horizontal overflow, and touch targets (44 px standard, 48 px
   e-ink). Automated checks do not replace keyboard/screen-reader passes. */
const views = [
  'today',
  'calendar',
  'tasks',
  'classes',
  'inbox',
  'settings/account',
  'settings/appearance',
  'settings/connections',
  'settings/ai',
];
const configurations = [
  { theme: 'standard', width: 1280, target: 44 },
  { theme: 'eink', width: 320, target: 48 },
] as const;

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

for (const { theme, width, target } of configurations) {
  test(`views pass automated accessibility and target checks (${theme}, ${width}px)`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(
      (value) => localStorage.setItem('hub:eink', String(value === 'eink')),
      theme,
    );
    for (const view of views) {
      await page.goto(`/${view}`);
      await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(
        'Sign in',
      );
      await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        violations.map((item) => `${view}: ${item.id} ${item.nodes.length}`),
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
                `${element.tagName.toLowerCase()} "${(element.textContent || element.getAttribute('name') || '').trim().slice(0, 30)}" ${Math.round(element.getBoundingClientRect().height)}px`,
            ),
        target,
      );
      expect(undersized, `${view} controls below ${target}px`).toEqual([]);
    }
  });
}

test('keyboard focus is never hidden behind the fixed bottom bar (320px)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/settings/ai');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  const bar = page.getByRole('navigation', { name: 'Main navigation' });
  const barTop = (await bar.boundingBox())!.y;
  // Tab through the page; every focused control must end above the bar.
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('Tab');
    const box = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element.closest('nav')) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    if (box) expect(box.top).toBeLessThan(barTop);
  }
});
