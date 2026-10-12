import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authenticate } from './auth';
import { classesRegion, open, openClass } from './shell';

const headers = { Origin: 'http://127.0.0.1:5180' };

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

/** Creates a class through the API with a unique name. */
async function createClass(page: Page, label: string) {
  const name = `${label} ${crypto.randomUUID().slice(0, 8)}`;
  const reply = await page.request.post('/api/v1/courses', {
    headers,
    data: { name, operationId: crypto.randomUUID() },
  });
  expect(reply.status()).toBe(200);
  return { name, ...(await reply.json()).course } as {
    name: string;
    id: string;
    version: number;
  };
}

test('classes, sections and unknown classes have their own addresses', async ({
  page,
}) => {
  const course = await createClass(page, 'Address class');
  await page.goto(`/classes/${course.id}?section=details`);
  await expect(
    page.getByRole('heading', { level: 2, name: course.name }),
  ).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Class sections' });
  await expect(
    sections.getByRole('link', { name: 'Details', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await sections.getByRole('link', { name: 'Study blocks' }).click();
  await expect(page).toHaveURL(`/classes/${course.id}?section=study`);
  await sections.getByRole('link', { name: 'Topics' }).click();
  await expect(page).toHaveURL(`/classes/${course.id}`);
  // Below 1024 px the class is shown alone, with a Back link.
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto('/classes/00000000-0000-4000-8000-000000000000');
  await expect(
    page.getByText('This class is not available.', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Back to classes', exact: true })
    .click();
  await expect(page).toHaveURL('/classes');
});

test('a class and its topics can be added, assessed, edited and deleted by keyboard', async ({
  page,
}) => {
  const name = `Keyboard class ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto('/classes/new');
  const view = classesRegion(page);
  await view.getByLabel('Class name').fill(name);
  await view.getByLabel('Class name').press('Enter');
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();

  const topics = view.getByRole('region', { name: 'Topics' });
  await topics.getByLabel('Topic name').fill('Limits');
  await topics.getByLabel('Topic name').press('Enter');
  // A new topic has not been assessed: no invented progress.
  const row = topics.getByRole('listitem').filter({ hasText: 'Limits' });
  await expect(row.getByText('Not assessed')).toBeVisible();
  await expect(row.getByRole('progressbar')).toHaveCount(0);

  await row.getByRole('button', { name: 'Edit topic Limits' }).click();
  const edit = topics.getByRole('form', { name: 'Edit topic' });
  await edit.getByLabel('Progress (%)').fill('55');
  await edit.getByLabel('Confidence').selectOption('medium');
  await edit.getByRole('button', { name: 'Save topic changes' }).click();
  await expect(
    topics.getByText('55% complete · confidence: medium'),
  ).toBeVisible();

  await row.getByRole('button', { name: 'Delete topic Limits' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Limits');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(topics.getByText('Limits', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Delete topic Limits' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete topic' })
    .click();
  await expect(topics.getByText('Limits', { exact: true })).toHaveCount(0);
});

test('a class edit keeps its draft when the class changed elsewhere', async ({
  page,
}) => {
  const course = await createClass(page, 'Conflict class');
  await page.goto(`/classes/${course.id}?section=details`);
  const details = classesRegion(page).getByRole('region', {
    name: 'Class details',
  });
  await details.getByLabel('Instructor').fill('Dr Local Draft');
  const other = await page.request.put(`/api/v1/courses/${course.id}`, {
    headers,
    data: {
      name: `${course.name} renamed`,
      expectedVersion: course.version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(other.status()).toBe(200);
  await details.getByRole('button', { name: 'Save class changes' }).click();
  const alert = details.getByRole('alert');
  await expect(alert).toContainText('Changed elsewhere');
  await expect(details.getByLabel('Instructor')).toHaveValue('Dr Local Draft');
  await expect(
    details.getByRole('button', { name: 'Save class changes' }),
  ).toBeDisabled();
  await alert.getByRole('button', { name: 'Load latest version' }).click();
  await expect(details.getByLabel('Instructor')).toHaveValue('Dr Local Draft');
  await details.getByRole('button', { name: 'Save class changes' }).click();
  await expect(details.getByRole('status')).toHaveText('Saved.');
});

test('a class lists its study blocks and explains what progress means', async ({
  page,
}) => {
  const course = await createClass(page, 'Study list class');
  const zone = 'America/New_York';
  for (const [title, startsAt, endsAt] of [
    ['Future block', '2099-03-08T15:00:00Z', '2099-03-08T16:00:00Z'],
    ['Past block', '2001-03-08T15:00:00Z', '2001-03-08T16:00:00Z'],
  ]) {
    const reply = await page.request.post('/api/v1/calendar', {
      headers,
      data: {
        title,
        startsAt,
        endsAt,
        timeZone: zone,
        courseId: course.id,
        operationId: crypto.randomUUID(),
      },
    });
    expect(reply.status()).toBe(200);
  }
  await page.goto('/');
  await open(page, 'Classes');
  await openClass(page, course.name, 'Study blocks');
  const study = classesRegion(page).getByRole('region', {
    name: 'Study blocks',
  });
  await expect(
    study.getByRole('region', { name: 'Upcoming' }).getByText('Future block'),
  ).toBeVisible();
  await expect(
    study.getByRole('region', { name: 'Earlier' }).getByText('Past block'),
  ).toBeVisible();
  // Blocks open in the Calendar editor.
  await study.getByRole('link', { name: 'Future block' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Calendar');

  await page.goto('/classes');
  await classesRegion(page)
    .getByRole('button', { name: 'Help: Classes' })
    .click();
  await expect(classesRegion(page)).toContainText(
    'Grades are not imported, and finishing study time does not mean a topic is mastered.',
  );
});

for (const { theme, width, target } of [
  { theme: 'standard', width: 1280, target: 44 },
  { theme: 'eink', width: 320, target: 48 },
] as const) {
  test(`class screens pass accessibility and target checks (${theme}, ${width}px)`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    const course = await createClass(page, 'Layout class');
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(
      (value) => localStorage.setItem('hub:eink', String(value === 'eink')),
      theme,
    );
    for (const path of [
      '/classes',
      '/classes/new',
      `/classes/${course.id}`,
      `/classes/${course.id}?section=study`,
      `/classes/${course.id}?section=canvas`,
      `/classes/${course.id}?section=details`,
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Classes' }),
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
      ).toBe(true);
      const undersized = await page.evaluate(
        (minimum) =>
          [
            ...document.querySelectorAll<HTMLElement>(
              'button, a[href], input, select, textarea, summary',
            ),
          ]
            .filter((element) => element.offsetParent !== null)
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
