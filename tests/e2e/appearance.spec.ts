import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authenticate } from './auth';
import { openSettings } from './shell';

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

const root = (page: Page, name: string) =>
  page.evaluate(
    (property) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue(property)
        .trim(),
    name,
  );
const rootData = (page: Page, name: string) =>
  page.evaluate((key) => document.documentElement.dataset[key] ?? '', name);
const section = (page: Page, name: string) =>
  page.getByRole('region', { name, exact: true });

async function showAppearance(page: Page) {
  await page.goto('/');
  await openSettings(page, 'Appearance');
  await expect(section(page, 'Profiles')).toBeVisible();
}

const darkColors = {
  background: '#101418',
  surface: '#1a2027',
  text: '#eef2f5',
  accent: '#8fd0ff',
};

test('custom colors apply live, persist, and low contrast is refused', async ({
  page,
}) => {
  await showAppearance(page);
  const colors = section(page, 'Colors');
  await colors.getByLabel('Text', { exact: true }).fill('#aaaaaa');
  await expect(colors.getByRole('alert')).toContainText('Text on background');
  await expect(colors.getByRole('alert')).toContainText('needs 4.5:1');
  expect(await root(page, '--text')).toBe('#1f2d28');

  // Each color alone leaves the others as they were; the dark set applies once
  // every pair passes.
  await colors.getByLabel('Text', { exact: true }).fill(darkColors.text);
  await colors
    .getByLabel('Background', { exact: true })
    .fill(darkColors.background);
  await colors.getByLabel('Surface', { exact: true }).fill(darkColors.surface);
  await expect(colors.getByRole('alert')).toContainText('Accent on background');
  await colors.getByLabel('Accent', { exact: true }).fill(darkColors.accent);
  await expect(colors.getByRole('alert')).toHaveCount(0);
  expect(await root(page, '--bg')).toBe(darkColors.background);
  expect(await root(page, '--on-accent')).toBe('#000000');

  await page.reload();
  expect(await root(page, '--bg')).toBe(darkColors.background);
  await openSettings(page, 'Appearance');
  await expect(
    section(page, 'Colors').getByLabel('Accent', { exact: true }),
  ).toHaveValue(darkColors.accent);

  await section(page, 'Colors')
    .getByRole('button', { name: 'Reset appearance' })
    .click();
  expect(await root(page, '--bg')).toBe('#f4f5f0');
  await page.reload();
  expect(await root(page, '--bg')).toBe('#f4f5f0');
});

test('e-ink stays monochrome whatever colors are saved', async ({ page }) => {
  await showAppearance(page);
  const colors = section(page, 'Colors');
  await colors.getByLabel('Text', { exact: true }).fill(darkColors.text);
  await colors
    .getByLabel('Background', { exact: true })
    .fill(darkColors.background);
  await colors.getByLabel('Surface', { exact: true }).fill(darkColors.surface);
  await colors.getByLabel('Accent', { exact: true }).fill(darkColors.accent);
  await page.getByRole('checkbox', { name: 'Use e-ink mode' }).check();
  await expect(colors.getByRole('status')).toContainText('not applied');
  expect(await rootData(page, 'theme')).toBe('eink');
  expect(await root(page, '--bg')).toBe('#fff');
  expect(
    await page.evaluate(() => document.documentElement.style.cssText),
  ).not.toContain('--bg');
  // The saved colors come back with standard mode.
  await page.getByRole('checkbox', { name: 'Use e-ink mode' }).uncheck();
  expect(await root(page, '--bg')).toBe(darkColors.background);
});

test('the theme follows the device by default and can be fixed to light or dark', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await showAppearance(page);
  expect(await rootData(page, 'scheme')).toBe('dark');
  expect(await root(page, '--bg')).toBe('#121714');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => rootData(page, 'scheme')).toBe('light');
  const display = section(page, 'Display');
  await display.getByLabel('Theme').selectOption('dark');
  expect(await rootData(page, 'scheme')).toBe('dark');
  await page.reload();
  expect(await rootData(page, 'scheme')).toBe('dark');
  // E-ink has no light/dark palette and disables the choice.
  await page.getByRole('checkbox', { name: 'Use e-ink mode' }).check();
  await expect(display.getByLabel('Theme')).toBeDisabled();
  expect(await rootData(page, 'scheme')).toBe('');
});

test('size, spacing and corners apply and never shrink controls below 44 px', async ({
  page,
}) => {
  await showAppearance(page);
  const display = section(page, 'Display');
  await display.getByLabel('Text size').selectOption('small');
  await display.getByLabel('Spacing').selectOption('compact');
  await display.getByLabel('Corners').selectOption('square');
  expect(await rootData(page, 'textSize')).toBe('small');
  expect(await rootData(page, 'density')).toBe('compact');
  expect(await rootData(page, 'shape')).toBe('square');
  const smallest = await page.evaluate(() =>
    Math.min(
      ...[...document.querySelectorAll<HTMLElement>('main select, main button')]
        .filter((element) => element.offsetParent !== null)
        .map((element) => element.getBoundingClientRect().height),
    ),
  );
  expect(smallest).toBeGreaterThanOrEqual(43.5);
  await page.reload();
  expect(await rootData(page, 'textSize')).toBe('small');
  // E-ink keeps square corners and disables the control.
  await page.getByRole('checkbox', { name: 'Use e-ink mode' }).check();
  await expect(display.getByLabel('Corners')).toBeDisabled();
  expect(await rootData(page, 'shape')).toBe('');
});

test('profiles save, load, show modified, rename, replace and delete on this device', async ({
  page,
}) => {
  await showAppearance(page);
  const profiles = section(page, 'Profiles');
  const display = section(page, 'Display');
  const dialog = page.getByRole('dialog');
  await expect(
    profiles.getByRole('listitem').filter({ hasText: 'Standard' }),
  ).toBeVisible();
  await expect(
    profiles.getByRole('listitem').filter({ hasText: 'E-ink' }),
  ).toBeVisible();

  await display.getByLabel('Text size').selectOption('large');
  await display.getByLabel('Spacing').selectOption('compact');
  await profiles.getByLabel('Profile name').fill('Standard');
  await profiles.getByRole('button', { name: 'Save as profile' }).click();
  await expect(profiles.getByRole('alert')).toContainText('built-in');
  await profiles.getByLabel('Profile name').fill('Reading');
  await profiles.getByRole('button', { name: 'Save as profile' }).click();
  await expect(profiles.getByRole('status')).toHaveText('Saved “Reading”.');
  const reading = profiles.getByRole('listitem').filter({ hasText: 'Reading' });
  await expect(reading.getByText('Active', { exact: true })).toBeVisible();

  // A change after saving marks the profile Modified; Replace updates it.
  await display.getByLabel('Text size').selectOption('larger');
  await expect(reading.getByText('Modified', { exact: true })).toBeVisible();
  await display.getByLabel('Text size').selectOption('large');
  await expect(reading.getByText('Active', { exact: true })).toBeVisible();

  // Loading with unsaved changes asks first; Cancel keeps the appearance.
  await display.getByLabel('Text size').selectOption('small');
  await profiles.getByRole('button', { name: 'Load Standard' }).click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await rootData(page, 'textSize')).toBe('small');
  await profiles.getByRole('button', { name: 'Load Standard' }).click();
  await dialog.getByRole('button', { name: 'Load profile' }).click();
  expect(await rootData(page, 'textSize')).toBe('default');
  expect(await rootData(page, 'density')).toBe('comfortable');

  await profiles.getByRole('button', { name: 'Load Reading' }).click();
  expect(await rootData(page, 'textSize')).toBe('large');
  expect(await rootData(page, 'density')).toBe('compact');

  await display.getByLabel('Text size').selectOption('larger');
  await profiles
    .getByRole('button', { name: 'Replace Reading with current' })
    .click();
  await dialog.getByRole('button', { name: 'Replace profile' }).click();
  await expect(reading.getByText('Active', { exact: true })).toBeVisible();

  // Profiles survive a reload and Reset appearance does not delete them.
  await page.reload();
  await expect(
    section(page, 'Profiles')
      .getByRole('listitem')
      .filter({ hasText: 'Reading' }),
  ).toBeVisible();
  await section(page, 'Colors')
    .getByRole('button', { name: 'Reset appearance' })
    .click();
  expect(await rootData(page, 'textSize')).toBe('default');
  await expect(
    section(page, 'Profiles')
      .getByRole('listitem')
      .filter({ hasText: 'Reading' }),
  ).toBeVisible();

  // Same name asks before replacing; rename and delete are confirmed or explicit.
  await profiles.getByLabel('Profile name').fill('reading');
  await profiles.getByRole('button', { name: 'Save as profile' }).click();
  await dialog.getByRole('button', { name: 'Replace profile' }).click();
  await profiles.getByRole('button', { name: 'Rename Reading' }).click();
  await profiles.getByLabel('New name').fill('Evening');
  await profiles.getByRole('button', { name: 'Save name' }).click();
  await expect(
    profiles.getByRole('listitem').filter({ hasText: 'Evening' }),
  ).toBeVisible();
  await profiles.getByRole('button', { name: 'Delete Evening' }).click();
  await dialog.getByRole('button', { name: 'Delete profile' }).click();
  await expect(
    profiles.getByRole('listitem').filter({ hasText: 'Evening' }),
  ).toHaveCount(0);
  await expect(
    profiles.getByRole('listitem').filter({ hasText: 'Standard' }),
  ).toBeVisible();
});

test('invalid saved appearance falls back to safe defaults', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem(
      'hub:appearance',
      JSON.stringify({
        colors: { text: 'nope', accent: '#aaaaaa', background: '#ababab' },
        textSize: 'enormous',
        density: 4,
        shape: null,
      }),
    );
    localStorage.setItem('hub:appearance-profiles', '{broken');
    localStorage.setItem('hub:appearance-profile', 'missing');
  });
  await showAppearance(page);
  expect(await rootData(page, 'textSize')).toBe('default');
  expect(await rootData(page, 'density')).toBe('comfortable');
  // Contrast failures in saved colors also fall back instead of applying.
  expect(await root(page, '--text')).toBe('#1f2d28');
  await expect(section(page, 'Profiles').getByRole('listitem')).toHaveCount(2);
  expect(errors).toEqual([]);
});

for (const { theme, width, target } of [
  { theme: 'standard', width: 1280, target: 44 },
  { theme: 'eink', width: 320, target: 48 },
] as const) {
  test(`appearance settings pass accessibility, overflow and target checks (${theme}, ${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      ({ value, dark }) => {
        localStorage.setItem('hub:eink', String(value === 'eink'));
        localStorage.setItem(
          'hub:appearance',
          JSON.stringify({
            colors: dark,
            textSize: 'large',
            density: 'compact',
            shape: 'round',
          }),
        );
      },
      { value: theme, dark: darkColors },
    );
    await showAppearance(page);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      violations.map((item) => [
        item.id,
        ...item.nodes.map((node) => `${node.target} ${node.any[0]?.message}`),
      ]),
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
          .filter(
            (element) => (element as HTMLInputElement).type !== 'checkbox',
          )
          .filter(
            (element) => element.getBoundingClientRect().height < minimum - 0.5,
          )
          .map(
            (element) =>
              `${element.tagName.toLowerCase()} "${(element.textContent || '').trim().slice(0, 30)}"`,
          ),
      target,
    );
    expect(undersized).toEqual([]);
  });
}

test('the dark theme keeps text contrast across the main pages', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const path of [
    '/',
    '/assistant',
    '/tasks',
    '/calendar',
    '/inbox',
    '/settings',
  ]) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    expect(await rootData(page, 'scheme')).toBe('dark');
    const { violations } = await new AxeBuilder({ page })
      .withRules(['color-contrast'])
      .analyze();
    expect(
      violations.flatMap((item) =>
        item.nodes.map((node) => `${path} ${item.id} ${node.target}`),
      ),
    ).toEqual([]);
  }
});
