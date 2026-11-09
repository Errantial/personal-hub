import { expect, test } from '@playwright/test';
import { authenticate } from './auth';

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('saves action settings and preserves the fixed email policy', async ({
  page,
}) => {
  await page.goto('/settings/ai');
  const panel = page.getByRole('region', { name: 'AI actions', exact: true });
  const tasks = panel.getByRole('group', { name: 'Tasks', exact: true });
  const calendar = panel.getByRole('group', { name: 'Calendar', exact: true });
  const reminders = panel.getByRole('group', {
    name: 'Task reminders',
    exact: true,
  });
  await expect(tasks.getByRole('radio', { name: 'Ask first' })).toBeChecked();
  await expect(
    reminders.getByRole('radio', { name: 'Ask first' }),
  ).toBeChecked();
  await expect(
    calendar.getByRole('radio', { name: 'Automatic', exact: true }),
  ).toBeChecked();
  await tasks.getByRole('radio', { name: 'Off' }).check();
  await reminders.getByRole('radio', { name: 'Automatic' }).check();
  const saved = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/v1/ai/actions') &&
      request.method() === 'PUT',
  );
  await panel.getByRole('button', { name: 'Save action settings' }).click();
  expect((await saved).postDataJSON()).toMatchObject({
    policy: {
      tasks: 'blocked',
      calendar: 'automatic',
      reminders: 'automatic',
      email: 'approval-required',
    },
  });
  await expect(panel.getByRole('status')).toHaveText('Action settings saved.');
  await page.reload();
  await expect(tasks.getByRole('radio', { name: 'Off' })).toBeChecked();
  await expect(
    reminders.getByRole('radio', { name: 'Automatic' }),
  ).toBeChecked();
  await expect(panel.getByText('Email always asks first')).toBeVisible();
  // Restore the synthetic owner's default for later suites.
  await tasks.getByRole('radio', { name: 'Ask first' }).check();
  await reminders.getByRole('radio', { name: 'Ask first' }).check();
  await panel.getByRole('button', { name: 'Save action settings' }).click();
  await expect(panel.getByRole('status')).toHaveText('Action settings saved.');
});

test('conflicting action settings preserve choices until reload', async ({
  page,
}) => {
  await page.route('**/api/v1/ai/actions', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 409,
          json: { error: { code: 'VERSION_CONFLICT' } },
        })
      : route.continue(),
  );
  await page.goto('/settings/ai');
  const panel = page.getByRole('region', { name: 'AI actions', exact: true });
  const off = panel
    .getByRole('group', { name: 'Tasks', exact: true })
    .getByRole('radio', { name: 'Off' });
  await off.check();
  await panel.getByRole('button', { name: 'Save action settings' }).click();
  await expect(panel.getByRole('alert')).toHaveText('Reload action settings.');
  await expect(off).toBeChecked();
  await panel.getByRole('button', { name: 'Reload action settings' }).click();
  await expect(
    panel
      .getByRole('group', { name: 'Tasks', exact: true })
      .getByRole('radio', { name: 'Ask first' }),
  ).toBeChecked();
});

test('auto-approve toggle warns, saves and can be turned off', async ({
  page,
}) => {
  await page.goto('/settings/ai');
  const panel = page.getByRole('region', { name: 'AI actions', exact: true });
  const toggle = panel.getByRole('checkbox', {
    name: 'Auto-approve agent changes',
  });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(panel.getByRole('alert')).toContainText(
    'Tier 1 and Tier 2 agent changes apply without a prompt',
  );
  const saved = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/v1/ai/actions') &&
      request.method() === 'PUT',
  );
  await panel.getByRole('button', { name: 'Save action settings' }).click();
  expect((await saved).postDataJSON()).toMatchObject({ autoApprove: true });
  await expect(panel.getByRole('status')).toHaveText('Action settings saved.');
  await page.reload();
  const reloaded = panel.getByRole('checkbox', {
    name: 'Auto-approve agent changes',
  });
  await expect(reloaded).toBeChecked();
  await reloaded.uncheck();
  await panel.getByRole('button', { name: 'Save action settings' }).click();
  await expect(panel.getByRole('status')).toHaveText('Action settings saved.');
  await expect(reloaded).not.toBeChecked();
});
