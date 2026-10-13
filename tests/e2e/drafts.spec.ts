import { expect, test } from '@playwright/test';
import { authenticate } from './auth';

const headers = { Origin: 'http://127.0.0.1:5180' };

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('an email draft is written, approved as an exact message, edited, deleted and restored without sending', async ({
  page,
}) => {
  const subject = `Project update ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto('/inbox');
  await page
    .getByRole('navigation', { name: 'Inbox sections' })
    .getByRole('link', { name: 'Email drafts' })
    .click();
  await expect(page).toHaveURL(/\/inbox\/drafts$/);
  const drafts = page.getByRole('region', { name: 'Email drafts' });
  await drafts.getByRole('link', { name: 'New draft' }).click();
  const form = drafts.getByRole('form', { name: 'New draft' });

  // Addresses are checked before saving.
  await form.getByRole('button', { name: 'Save draft' }).click();
  await expect(form.getByText('Enter the sender address')).toBeVisible();
  await form
    .getByRole('textbox', { name: 'From', exact: true })
    .fill('owner@example.com');
  await form
    .getByRole('textbox', { name: 'To', exact: true })
    .fill('a@example.com, b@example.com');
  await form
    .getByRole('textbox', { name: 'Cc', exact: true })
    .fill('A@example.com');
  await form.getByRole('button', { name: 'Save draft' }).click();
  await expect(form.getByText('Use each recipient once')).toBeVisible();
  await form.getByRole('textbox', { name: 'Cc', exact: true }).fill('');
  await form
    .getByRole('textbox', { name: 'Subject', exact: true })
    .fill(subject);
  await form
    .getByRole('textbox', { name: 'Body', exact: true })
    .fill('Line one\nLine two');
  await form.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/inbox\/drafts\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop()!;

  // The review shows the stored message and why sending is blocked.
  const review = drafts.getByRole('definition').filter({ hasText: 'Line one' });
  await expect(review).toContainText('Line two');
  await expect(
    drafts
      .getByRole('definition')
      .filter({ hasText: 'a@example.com, b@example.com' }),
  ).toBeVisible();
  const blocked = drafts.getByRole('list', { name: 'Why sending is blocked' });
  await expect(blocked).toContainText('This exact message is not approved.');
  await expect(blocked).toContainText(
    'Sending is not available in this app yet.',
  );

  // A change elsewhere blocks approval until the draft is reviewed again.
  const current = async () =>
    (await (await page.request.get(`/api/v1/email/drafts/${id}`)).json()).draft;
  const before = await current();
  const changed = await page.request.put(`/api/v1/email/drafts/${id}`, {
    headers,
    data: {
      message: { ...before.message, body: 'Changed elsewhere' },
      expectedVersion: before.version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(changed.status()).toBe(200);
  await drafts
    .getByRole('button', { name: 'Approve this exact message' })
    .click();
  await expect(drafts.getByRole('alert')).toContainText('Review it again');
  expect((await current()).status).toBe('pending');
  await drafts.getByRole('button', { name: 'Reload draft' }).click();
  await expect(
    drafts.getByRole('definition').filter({ hasText: 'Changed elsewhere' }),
  ).toBeVisible();
  await drafts
    .getByRole('button', { name: 'Approve this exact message' })
    .click();
  await expect(
    drafts.getByText('Approved this exact message. Nothing was sent.'),
  ).toBeVisible();
  expect((await current()).status).toBe('approved');
  await expect(blocked).toContainText('No mail connection can send yet.');

  // Editing removes the approval.
  await drafts.getByRole('button', { name: 'Edit draft' }).click();
  const edit = drafts.getByRole('form', { name: 'Edit draft' });
  await expect(
    edit.getByText('Saving changes removes the current approval.'),
  ).toBeVisible();
  await edit
    .getByRole('textbox', { name: 'Subject', exact: true })
    .fill(`${subject} v2`);
  const editedElsewhere = await current();
  expect(
    (
      await page.request.put(`/api/v1/email/drafts/${id}`, {
        headers,
        data: {
          message: { ...editedElsewhere.message, body: 'Another edit' },
          expectedVersion: editedElsewhere.version,
          operationId: crypto.randomUUID(),
        },
      })
    ).status(),
  ).toBe(200);
  await edit.getByRole('button', { name: 'Save draft' }).click();
  const loadLatest = edit.getByRole('button', { name: 'Load latest version' });
  await expect(loadLatest).toBeVisible();
  await page.route(`**/api/v1/email/drafts/${id}`, async (route) => {
    if (route.request().method() === 'GET') await route.abort();
    else await route.continue();
  });
  await loadLatest.click();
  await expect(
    drafts.getByRole('alert').filter({ hasText: 'needs a connection' }),
  ).toBeVisible();
  await expect(
    edit.getByRole('textbox', { name: 'Subject', exact: true }),
  ).toHaveValue(`${subject} v2`);
  await page.unroute(`**/api/v1/email/drafts/${id}`);
  await loadLatest.click();
  await expect(
    edit.getByText('Latest version loaded. Your edits are kept.'),
  ).toBeVisible();

  const operations: string[] = [];
  await page.route(`**/api/v1/email/drafts/${id}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    operations.push(route.request().postDataJSON().operationId);
    const response = await route.fetch();
    if (operations.length === 1) await route.abort();
    else await route.fulfill({ response });
  });
  await edit.getByRole('button', { name: 'Save draft' }).click();
  await expect(edit.getByRole('alert')).toBeVisible();
  await edit.getByRole('button', { name: 'Save draft' }).click();
  await expect(
    drafts.getByText('Draft saved. It needs a new approval.'),
  ).toBeVisible();
  expect((await current()).status).toBe('pending');
  expect(operations).toHaveLength(2);
  expect(operations[0]).toBe(operations[1]);
  expect((await current()).version).toBe(editedElsewhere.version + 2);
  await page.unroute(`**/api/v1/email/drafts/${id}`);

  // Deleting explains retention; restoring needs a new approval.
  await drafts.getByRole('button', { name: 'Delete draft' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this draft?' });
  await expect(dialog).toContainText('permanent erasure is not available');
  await dialog.getByRole('button', { name: 'Delete draft' }).click();
  await expect(drafts.getByText('Draft deleted.')).toBeVisible();
  await drafts.getByLabel('Show').selectOption('Deleted drafts');
  await expect(
    drafts.getByRole('link', { name: `${subject} v2` }),
  ).toBeVisible();
  await drafts.getByRole('button', { name: 'Restore draft' }).click();
  await expect(
    drafts.getByText('Draft restored. It needs a new approval.'),
  ).toBeVisible();
  expect((await current()).status).toBe('pending');
});
