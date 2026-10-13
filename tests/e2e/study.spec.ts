import { expect, test } from '@playwright/test';
import { authenticate } from './auth';

const headers = { Origin: 'http://127.0.0.1:5180' };

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('study settings save availability windows and keep edits through a conflict', async ({
  page,
}) => {
  await page.goto('/settings/study');
  const form = page.getByRole('form', { name: 'Study settings' });
  // Start from no windows, whatever an earlier run saved.
  while (await form.getByRole('button', { name: 'Remove window 1' }).count())
    await form.getByRole('button', { name: 'Remove window 1' }).click();
  await expect(form.getByText('No windows yet')).toBeVisible();
  await form.getByLabel('Study timezone').fill('UTC');
  await form.getByLabel('Session (minutes)').fill('30');

  // Overlapping windows on one day are refused before saving.
  await form.getByRole('button', { name: 'Add window' }).click();
  await form.getByLabel('Window 1 day').selectOption('Monday');
  await form.getByLabel('Window 1 start').fill('09:00');
  await form.getByLabel('Window 1 end').fill('11:00');
  await form.getByRole('button', { name: 'Add window' }).click();
  await form.getByLabel('Window 2 day').selectOption('Monday');
  await form.getByLabel('Window 2 start').fill('10:00');
  await form.getByLabel('Window 2 end').fill('00:00');
  await form.getByRole('button', { name: 'Save study settings' }).click();
  await expect(
    form.getByText('Monday window: Overlaps another window that day'),
  ).toBeVisible();
  await form.getByLabel('Window 2 day').selectOption('Tuesday');
  await expect(form.getByText('16 h available each week')).toBeVisible();
  await form.getByRole('button', { name: 'Save study settings' }).click();
  await expect(form.getByText('Study settings saved.')).toBeVisible();

  await page.reload();
  await expect(form.getByLabel('Window 2 end')).toHaveValue('00:00');
  await expect(form.getByLabel('Session (minutes)')).toHaveValue('30');

  // A change elsewhere blocks saving until the latest version is loaded.
  const saved = await (
    await page.request.get('/api/v1/study/preferences')
  ).json();
  const { version, updatedAt, ...settings } = saved;
  void updatedAt;
  const elsewhere = await page.request.put('/api/v1/study/preferences', {
    headers,
    data: {
      ...settings,
      breakMinutes: 10,
      expectedVersion: version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(elsewhere.status()).toBe(200);
  await form.getByLabel('Daily limit (minutes)').fill('90');
  await form.getByRole('button', { name: 'Save study settings' }).click();
  await expect(form.getByText('Changed elsewhere.')).toBeVisible();
  await form.getByRole('button', { name: 'Load latest version' }).click();
  await expect(form.getByLabel('Daily limit (minutes)')).toHaveValue('90');
  await form.getByRole('button', { name: 'Save study settings' }).click();
  await expect(form.getByText('Study settings saved.')).toBeVisible();
  const final = await (
    await page.request.get('/api/v1/study/preferences')
  ).json();
  expect(final.dailyMaximumMinutes).toBe(90);
});

test('a class weekly goal is saved from its study section', async ({
  page,
}) => {
  const name = `Goal class ${crypto.randomUUID().slice(0, 8)}`;
  const reply = await page.request.post('/api/v1/courses', {
    headers,
    data: { name, operationId: crypto.randomUUID() },
  });
  const course = (await reply.json()).course as { id: string };
  await page.goto(`/classes/${course.id}?section=study`);
  const form = page.getByRole('form', { name: 'Weekly goal' });
  await expect(form.getByLabel('Minutes per week')).toHaveValue('0');
  await form.getByLabel('Minutes per week').fill('-5');
  await form.getByRole('button', { name: 'Save weekly goal' }).click();
  await expect(
    form.getByText('Enter whole minutes from 0 to 2400'),
  ).toBeVisible();
  await form.getByLabel('Minutes per week').fill('150');
  await form.getByLabel('Study priority').selectOption('5');
  await form.getByLabel('Target date (optional)').fill('2028-05-01');
  await form.getByRole('button', { name: 'Save weekly goal' }).click();
  await expect(form.getByText('Goal saved: 2 h 30 min a week.')).toBeVisible();
  await page.reload();
  await expect(form.getByLabel('Minutes per week')).toHaveValue('150');
  await expect(form.getByLabel('Study priority')).toHaveValue('5');
});

test('a study plan is previewed, trimmed, approved into Calendar, cancelled and hidden', async ({
  page,
}) => {
  test.setTimeout(60000);
  // Known availability: every day 08:00–20:00 UTC, 30-minute sessions.
  const prefs = await (
    await page.request.get('/api/v1/study/preferences')
  ).json();
  const setPrefs = await page.request.put('/api/v1/study/preferences', {
    headers,
    data: {
      timeZone: 'UTC',
      sessionMinutes: 30,
      breakMinutes: 5,
      dailyMaximumMinutes: 480,
      windows: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
        day,
        startMinute: 480,
        endMinute: 1200,
      })),
      expectedVersion: prefs.version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(setPrefs.status()).toBe(200);
  const name = `Plan class ${crypto.randomUUID().slice(0, 8)}`;
  const course = (
    await (
      await page.request.post('/api/v1/courses', {
        headers,
        data: { name, operationId: crypto.randomUUID() },
      })
    ).json()
  ).course as { id: string };
  const goal = await page.request.put(`/api/v1/study/goals/${course.id}`, {
    headers,
    data: {
      minutesPerWeek: 90,
      priority: 5,
      targetDate: null,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
    },
  });
  expect(goal.status()).toBe(200);
  const ownBlocks = async () =>
    (
      (await (await page.request.get('/api/v1/calendar')).json()) as {
        events: { courseId: string | null; studyStatus: string }[];
      }
    ).events.filter((event) => event.courseId === course.id);

  const slotsOf = (scope: ReturnType<typeof page.locator>) =>
    scope.locator('.study-plan__slot').filter({ hasText: name });
  await page.goto('/classes');
  await page.getByRole('link', { name: 'Study plan', exact: true }).click();
  await expect(page).toHaveURL(/\/classes\/plan$/);
  const view = page.getByRole('region', { name: 'Study plan' });
  await view.getByLabel('Starting').fill('2028-03-06');
  await view.getByRole('button', { name: 'Preview plan' }).click();
  const preview = view.getByRole('region', { name: /^Preview/ });
  await expect(
    preview.getByText('Only your planner calendar was checked', {
      exact: false,
    }),
  ).toBeVisible();
  // 90 minutes a week in 30-minute sessions.
  await expect(
    preview.getByText(/^\d\d:\d\d–\d\d:\d\d$/).first(),
  ).toBeVisible();
  await expect(slotsOf(preview)).toHaveCount(3);
  await view.getByRole('button', { name: 'Save as draft' }).click();

  // The saved draft opens; removing a block needs a deliberate save.
  const plans = view.getByRole('region', { name: 'Plans' });
  const open = plans.locator('li[aria-current="true"]');
  await expect(
    open.getByRole('button', { name: 'Approve plan' }),
  ).toBeVisible();
  await open
    .getByRole('button', { name: new RegExp(`^Remove .* ${name}$`) })
    .first()
    .click();
  await expect(slotsOf(open)).toHaveCount(2);
  await expect(open.getByRole('button', { name: 'Approve plan' })).toHaveCount(
    0,
  );
  await open.getByRole('button', { name: 'Save draft changes' }).click();
  await expect(
    open.getByRole('button', { name: 'Approve plan' }),
  ).toBeVisible();
  expect(await ownBlocks()).toHaveLength(0);

  // Approval adds exactly the remaining blocks to Calendar.
  await open.getByRole('button', { name: 'Approve plan' }).click();
  await expect(open.getByText(/^Added \d+ study blocks to/)).toBeVisible();
  await expect.poll(async () => (await ownBlocks()).length).toBe(2);

  // Cancelling cancels unchanged planned blocks.
  await open.getByRole('button', { name: 'Cancel plan' }).click();
  await page
    .getByRole('dialog', { name: 'Cancel this plan?' })
    .getByRole('button', { name: 'Cancel plan' })
    .click();
  await expect(
    open.getByText('All of its planned blocks were cancelled.'),
  ).toBeVisible();
  expect(
    (await ownBlocks()).every((event) => event.studyStatus === 'cancelled'),
  ).toBe(true);
  const count = await plans.locator('.study-plan__open').count();
  await open.getByRole('button', { name: 'Hide plan' }).click();
  await expect(plans.locator('.study-plan__open')).toHaveCount(count - 1);
  await expect(open).toHaveCount(0);

  // Progress for the same dates shows the class target.
  await expect(
    view
      .getByRole('region', { name: 'Progress for these dates' })
      .getByText(name, { exact: true }),
  ).toBeVisible();
});
