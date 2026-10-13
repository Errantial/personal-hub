import { expect, test } from '@playwright/test';
import { authenticate } from './auth';

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('a lost connector response preserves one connector and gives token recovery instructions', async ({
  page,
}) => {
  const name = `Lost token ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto('/settings/connections');
  const panel = page.getByRole('region', { name: 'Email (Proton Bridge)' });
  await panel.getByRole('button', { name: 'Add connector' }).click();
  const form = panel.getByRole('form', { name: 'Add email connector' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  let lost = false;
  await page.route('**/api/v1/email/connectors', async (route) => {
    if (!lost && route.request().method() === 'POST') {
      lost = true;
      expect((await route.fetch()).status()).toBe(201);
      await route.abort();
    } else await route.continue();
  });
  await form.getByRole('button', { name: 'Add connector' }).click();
  await expect(form.getByRole('alert')).toBeVisible();
  await form.getByRole('button', { name: 'Add connector' }).click();
  await expect(form.getByRole('alert')).toContainText(
    'token cannot be shown again',
  );
  await panel.getByRole('button', { name: 'Reload connectors' }).click();
  await expect(panel.getByRole('article', { name })).toHaveCount(1);
  await expect(
    panel.getByRole('textbox', { name: 'Connector token' }),
  ).toHaveCount(0);
});

test('a connector token uploads mail that is read as plain text, and revoking stops it', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = `Bridge ${suffix}`;
  await page.goto('/settings/connections');
  const panel = page.getByRole('region', { name: 'Email (Proton Bridge)' });
  await panel.getByRole('button', { name: 'Add connector' }).click();
  const form = panel.getByRole('form', { name: 'Add email connector' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await form.getByRole('button', { name: 'Add connector' }).click();
  const token = await panel
    .getByRole('textbox', { name: 'Connector token' })
    .inputValue();
  expect(token).toMatch(/^hubc_/);
  await panel.getByRole('button', { name: 'I saved it' }).click();
  await expect(
    panel.getByRole('textbox', { name: 'Connector token' }),
  ).toHaveCount(0);
  const card = panel.getByRole('article', { name });
  await expect(card).toContainText('Waiting for first sync');
  await expect(card).toContainText('Label: Personal');

  // The local connector sends a bearer token and no browser origin.
  const upload = (payload: object) =>
    page.request.post('/api/v1/email/connector/batch', {
      headers: { Authorization: `Bearer ${token}` },
      data: payload,
    });
  const subject = `Advising ${suffix}`;
  const sent = await upload({
    path: 'INBOX',
    role: '\\Inbox',
    uidValidity: '1',
    exists: 40,
    inWindow: 2,
    lastUid: 2,
    messages: [
      {
        uid: 2,
        messageKey: `<${suffix}@example.test>`,
        from: { name: 'Advisor', address: 'advisor@example.test' },
        to: [{ name: null, address: 'owner@example.test' }],
        cc: [],
        subject,
        sentAt: null,
        receivedAt: new Date().toISOString(),
        body: 'Line one\n<b>not html</b>',
        bodyTruncated: false,
        attachmentCount: 1,
      },
    ],
  });
  expect(sent.status()).toBe(200);
  await page.reload();
  await expect(card).toContainText('Connected');
  const row = card.getByRole('row', { name: /INBOX/ });
  await expect(row).toContainText('40');
  await expect(row.getByRole('cell').last()).toHaveText('1 (incomplete)');

  await page.goto('/inbox');
  await page
    .getByRole('navigation', { name: 'Inbox sections' })
    .getByRole('link', { name: 'Mail', exact: true })
    .click();
  await expect(page).toHaveURL(/\/inbox\/mail$/);
  const mail = page.getByRole('region', { name: 'Mail' });
  await expect(
    mail.getByText('1 attachment (not imported)').first(),
  ).toBeVisible();
  await mail.getByRole('link', { name: subject }).click();
  const detail = mail.getByRole('article', { name: subject });
  // Bodies are plain text: markup is shown, never rendered.
  await expect(detail.locator('pre')).toHaveText('Line one\n<b>not html</b>');
  await expect(detail).toContainText('advisor@example.test');
  await expect(detail).toContainText('Personal');

  await page.goto('/settings/connections');
  await card.getByRole('button', { name: 'Revoke connector' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Revoke connector' })
    .click();
  await expect(card).toContainText('Revoked');
  expect(
    (
      await upload({
        path: 'INBOX',
        role: null,
        uidValidity: '1',
        exists: 0,
        inWindow: 0,
        lastUid: 2,
        messages: [],
      })
    ).status(),
  ).toBe(401);
});
