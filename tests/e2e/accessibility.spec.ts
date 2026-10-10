import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { authenticate } from './auth';

/* Guards docs/ui-guidelines.md §4/§9 on every view: WCAG 2.2 AA automated
   checks, no horizontal overflow, and touch targets (44 px standard, 48 px
   e-ink). Automated checks do not replace keyboard/screen-reader passes. */
const views = [
  'today',
  'calendar',
  'classes',
  'reminders',
  'connections',
  'preferences',
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
