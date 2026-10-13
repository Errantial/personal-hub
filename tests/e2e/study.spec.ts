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
