import { expect, test } from '@playwright/test';
import { authenticate } from './auth';

const headers = { Origin: 'http://127.0.0.1:5180' };

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('AI suggestions are reviewed, then applied as owner categories', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const created = await page.request.post('/api/v1/email/connectors', {
    headers,
    data: {
      name: `Suggest ${suffix}`,
      sensitivity: 'unlabeled',
      operationId: crypto.randomUUID(),
    },
  });
  const { token } = await created.json();
  const subjects = [`Receipt ${suffix}`, `Restricted ${suffix}`];
  const uploaded = await page.request.post('/api/v1/email/connector/batch', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      path: 'INBOX',
      role: null,
      uidValidity: '1',
      exists: 2,
      inWindow: 2,
      lastUid: 2,
      messages: subjects.map((subject, index) => ({
        uid: index + 1,
        textOrigin: 'message-body-v1',
        messageKey: `<${suffix}-${index}@example.test>`,
        from: { name: null, address: 'shop@example.test' },
        to: [],
        cc: [],
        subject,
        sentAt: null,
        receivedAt: new Date(Date.now() - index * 60000).toISOString(),
        body: 'Order total 12.00',
        bodyTruncated: false,
        attachmentCount: 0,
      })),
    },
  });
  expect(uploaded.status()).toBe(200);
  const listed = (await (
    await page.request.get('/api/v1/email/messages?limit=100')
  ).json()) as {
    messages: { id: string; version: number; subject: string }[];
  };
  const [receipt, restricted] = subjects.map((subject) =>
    listed.messages.find((m) => m.subject === subject)!,
  );
  let asked: { messages?: { id: string }[] } = {};
  // Only the classify endpoint is simulated; no provider is called.
  await page.route('**/api/v1/email/classify', (route) => {
    asked = route.request().postDataJSON() as typeof asked;
    return route.fulfill({
      json: {
        request: {
          id: crypto.randomUUID(),
          status: 'completed',
          reason: null,
          model: 'anthropic/claude-haiku-5.5',
          resultAvailable: true,
          suggestions: [
            {
              id: receipt!.id,
              expectedVersion: receipt!.version,
              category: 'receipts',
              reason: 'Order total.',
            },
          ],
          dropped: 0,
          costMicros: 150,
          heldMicros: 0,
          createdAt: new Date().toISOString(),
        },
        blocked: [{ id: restricted!.id, reason: 'restricted' }],
      },
    });
  });

  await page.goto('/inbox/mail');
  const mail = page.getByRole('region', { name: 'Mail' });
  for (const subject of subjects)
    await mail.getByRole('checkbox', { name: new RegExp(subject) }).check();
  const panel = mail.getByRole('region', { name: 'AI suggestions' });
  await panel.getByRole('button', { name: 'Suggest categories for 2' }).click();
  expect(asked.messages?.map((m) => m.id).sort()).toEqual(
    [receipt!.id, restricted!.id].sort(),
  );
  await expect(panel).toContainText(
    `${subjects[1]}: labeled Restricted (never sent)`,
  );
  await expect(panel).toContainText('$0.00015');
  const suggestion = panel.getByRole('checkbox', {
    name: `${subjects[0]} → Receipts`,
  });
  await expect(suggestion).toBeChecked();
  await expect(panel).toContainText('Order total.');
  // Nothing is categorized before Apply.
  const category = async () =>
    (
      (await (
        await page.request.get('/api/v1/email/messages?limit=100')
      ).json()) as { messages: { id: string; category: string | null }[] }
    ).messages.find((m) => m.id === receipt!.id)?.category;
  expect(await category()).toBeNull();
  await panel.getByRole('button', { name: 'Apply 1 category' }).click();
  await expect(panel.getByText('Applied 1 category.')).toBeVisible();
  expect(await category()).toBe('receipts');
});

test('Personal mail needs an explicit setting', async ({ page }) => {
  await page.goto('/settings/ai');
  const settings = page.getByRole('region', { name: /^Assistant/ });
  const toggle = settings.getByRole('checkbox', {
    name: 'Allow Personal mail',
  });
  const before = await toggle.isChecked();
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: !before });
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/v1/assistant/settings')).json())
          .settings.allowPersonalMail,
    )
    .toBe(!before);
  // Restore the shared test owner's setting.
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: before });
});
