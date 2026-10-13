import { expect, test } from '@playwright/test';
import { authenticate } from './auth';

const headers = { Origin: 'http://127.0.0.1:5180' };

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('memories are added, searched, disabled, kept through a conflict and forgotten', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const title = `Morning study ${suffix}`;
  await page.goto('/settings/memory');
  const view = page.getByRole('region', { name: 'Memory' });
  const show = view.getByLabel('Show');

  // The storage switch is off by default and never implies AI use.
  const toggle = view.getByRole('checkbox', { name: 'Use memory' });
  if (!(await toggle.isChecked())) {
    await toggle.click();
    await expect(toggle).toBeChecked();
  }
  expect(
    (await (await page.request.get('/api/v1/memory/settings')).json()).enabled,
  ).toBe(true);

  await view.getByRole('button', { name: 'Add memory' }).click();
  const add = view.getByRole('form', { name: 'Add memory' });
  await add.getByRole('button', { name: 'Add memory' }).click();
  await expect(add.getByText('Enter a title')).toBeVisible();
  await add.getByLabel('Title').fill(title);
  await add
    .getByRole('textbox', { name: 'Memory', exact: true })
    .fill('I focus best before 10:00.');
  await add.getByLabel('Memory content label').selectOption('personal');
  await add.getByRole('button', { name: 'Add memory' }).click();
  await expect(view.getByText('Memory added.')).toBeVisible();
  await expect(view.getByText(title, { exact: true })).toBeVisible();

  // Literal search finds it; another term does not.
  await view.getByLabel('Search').fill(suffix);
  await view.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(view.getByRole('button', { name: /^Edit / })).toHaveCount(1);
  await view.getByLabel('Search').fill(`missing ${suffix}`);
  await view.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(view.getByText('No memories match.')).toBeVisible();
  await view.getByLabel('Search').fill(suffix);
  await view.getByRole('button', { name: 'Search', exact: true }).click();

  // A change elsewhere keeps the edit until the latest version is loaded.
  await view.getByRole('button', { name: `Edit ${title}` }).click();
  const edit = view.getByRole('form', { name: 'Edit memory' });
  await expect(
    edit.getByRole('textbox', { name: 'Memory', exact: true }),
  ).toHaveValue('I focus best before 10:00.');
  const { id } = (
    await (await page.request.get(`/api/v1/memory?q=${suffix}`)).json()
  ).memories[0];
  const detail = (await (await page.request.get(`/api/v1/memory/${id}`)).json())
    .memory;
  const changed = await page.request.put(`/api/v1/memory/${id}`, {
    headers,
    data: {
      kind: detail.kind,
      title: detail.title,
      content: 'Changed elsewhere',
      observedOn: null,
      enabled: true,
      sensitivity: 'personal',
      expectedVersion: detail.version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(changed.status()).toBe(200);
  await edit.getByRole('checkbox', { name: 'Enabled' }).uncheck();
  await edit.getByRole('button', { name: 'Save memory' }).click();
  await expect(edit.getByText('Changed elsewhere.')).toBeVisible();
  await edit.getByRole('button', { name: 'Load latest version' }).click();
  await expect(
    edit.getByRole('checkbox', { name: 'Enabled' }),
  ).not.toBeChecked();
  await edit.getByRole('button', { name: 'Save memory' }).click();
  await expect(view.getByText('Memory saved.')).toBeVisible();

  // Disabled memories leave the Active list but stay editable.
  await expect(view.getByText(title, { exact: true })).toHaveCount(0);
  await show.selectOption('disabled');
  await expect(view.getByText(title, { exact: true })).toBeVisible();

  // Forgetting clears the text and cannot be undone.
  await view.getByRole('button', { name: `Edit ${title}` }).click();
  await edit.getByRole('button', { name: 'Forget memory' }).click();
  const dialog = page.getByRole('dialog', { name: 'Forget this memory?' });
  await expect(dialog).toContainText('Earlier backups and exports');
  await dialog.getByRole('button', { name: 'Forget memory' }).click();
  await expect(view.getByText('Memory forgotten.')).toBeVisible();
  const forgotten = (
    await (await page.request.get(`/api/v1/memory/${id}`)).json()
  ).memory;
  expect(forgotten).toMatchObject({ title: null, content: null });
  await view.getByLabel('Search').fill('');
  await view.getByRole('button', { name: 'Search', exact: true }).click();
  await show.selectOption('forgotten');
  await expect(view.getByText('Forgotten memory').first()).toBeVisible();
});
