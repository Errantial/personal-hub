import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authenticate } from './auth';

const origin = 'http://127.0.0.1:5180';
test.beforeEach(async ({ page }) => {
  await authenticate(page);
});
async function seed(page: Page) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const created = await page.request.post('/api/v1/email/connectors', {
    headers: { Origin: origin },
    data: {
      operationId: crypto.randomUUID(),
      name: `Organization ${suffix}`,
      sensitivity: 'restricted',
    },
  });
  expect(created.status()).toBe(201);
  const { token, connector } = await created.json();
  const subjects = [`${suffix} advising A`, `${suffix} advising B`];
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
        from: { name: 'Advisor', address: 'advisor@example.test' },
        to: [],
        cc: [],
        subject,
        sentAt: null,
        receivedAt: new Date().toISOString(),
        body: 'Synthetic text only',
        bodyTruncated: false,
        attachmentCount: 0,
      })),
    },
  });
  expect(uploaded.status()).toBe(200);
  const all = await (
    await page.request.get('/api/v1/email/messages?limit=100')
  ).json();
  const records = all.messages.filter(
    (item: { connectorId: string }) => item.connectorId === connector.id,
  );
  expect(records).toHaveLength(2);
  return {
    suffix,
    subjects,
    records,
    name: `Rule ${suffix} ${'n'.repeat(75)}`,
  };
}
const mailRegion = (page: Page) =>
  page.getByRole('region', { name: 'Mail', exact: true });
async function openRules(page: Page) {
  await mailRegion(page)
    .locator('summary')
    .filter({ hasText: 'Mail rules' })
    .click();
}
async function select(page: Page, subjects: string[]) {
  for (const subject of subjects)
    await mailRegion(page)
      .getByRole('checkbox', { name: `Select ${subject}`, exact: true })
      .check();
}

test('local rules preview, owner corrections, category filters and retained explanations work at 320px', async ({
  page,
}) => {
  const data = await seed(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.addInitScript(() => localStorage.setItem('hub:eink', 'true'));
  await page.goto('/inbox/mail');
  const mail = mailRegion(page);
  await openRules(page);
  await mail.getByRole('button', { name: 'Add rule', exact: true }).click();
  const form = mail.getByRole('form', { name: 'Add mail rule' });
  await form.getByLabel('Name', { exact: true }).fill(data.name);
  await form
    .getByRole('combobox', { name: 'Field', exact: true })
    .selectOption('subject');
  await form.getByLabel('Match', { exact: true }).fill(data.suffix);
  await form
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption('receipts');
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await form.getByRole('button', { name: 'Save rule' }).click();
  await expect(form).toHaveCount(0);
  await select(page, data.subjects);
  await mail.getByRole('button', { name: 'Preview rules (2)' }).click();
  const preview = mail.getByRole('region', { name: 'Rule preview' });
  await expect(preview).toContainText('Uncategorized → Receipts');
  await preview.getByRole('button', { name: 'Apply preview' }).click();
  await expect(mail.getByText('2/100 selected', { exact: true })).toHaveCount(
    0,
  );
  await mail.getByRole('link', { name: data.subjects[0], exact: true }).click();
  const detail = mail.getByRole('article', {
    name: data.subjects[0],
    exact: true,
  });
  const category = detail.getByRole('region', { name: 'Mail category' });
  await expect(category).toContainText(`Rule “${data.name}” (version 1)`);
  await category
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption('personal');
  await category.getByRole('button', { name: 'Save category' }).click();
  await expect(category).toContainText('Owner choice · Protected from rules');
  await expect(detail.getByText('Restricted', { exact: true })).toBeVisible();
  await detail.getByRole('link', { name: 'Back to mail' }).click();
  await select(page, data.subjects);
  await mail.getByRole('button', { name: 'Preview rules (2)' }).click();
  await expect(preview).toContainText('Owner choice preserved');
  await expect(
    preview.getByRole('button', { name: 'Apply preview' }),
  ).toBeDisabled();
  await mail
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption('personal');
  await expect(
    mail.getByRole('link', { name: data.subjects[0], exact: true }),
  ).toBeVisible();
  await expect(
    mail.getByRole('link', { name: data.subjects[1], exact: true }),
  ).toHaveCount(0);
  await mail
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption('receipts');
  await mail.getByRole('link', { name: data.subjects[1], exact: true }).click();
  await mail
    .getByRole('button', { name: `Delete ${data.name}`, exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete rule', exact: true })
    .click();
  await expect(
    mail.getByRole('button', { name: `Delete ${data.name}`, exact: true }),
  ).toHaveCount(0);
  const second = mail.getByRole('article', {
    name: data.subjects[1],
    exact: true,
  });
  await second.getByRole('button', { name: 'Reload latest message' }).click();
  await expect(second).toContainText(`Rule “${data.name}” (version 1)`);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
});

test('stale apply changes nothing else, and an older preview cannot replace a newer selection', async ({
  page,
}) => {
  const data = await seed(page);
  const state = await (await page.request.get('/api/v1/email/rules')).json();
  expect(
    (
      await page.request.post('/api/v1/email/rules', {
        headers: { Origin: origin },
        data: {
          operationId: crypto.randomUUID(),
          expectedRevision: state.revision,
          name: data.name,
          field: 'subject',
          match: data.suffix,
          category: 'academic',
          enabled: true,
        },
      })
    ).status(),
  ).toBe(201);
  await page.goto('/inbox/mail');
  const mail = mailRegion(page);
  await openRules(page);
  await select(page, data.subjects);
  await mail.getByRole('button', { name: 'Preview rules (2)' }).click();
  await expect(
    mail.getByRole('region', { name: 'Rule preview' }),
  ).toBeVisible();
  const first = data.records.find(
    (item: { subject: string }) => item.subject === data.subjects[0],
  );
  expect(
    (
      await page.request.put(`/api/v1/email/messages/${first.id}/category`, {
        headers: { Origin: origin },
        data: {
          operationId: crypto.randomUUID(),
          expectedVersion: first.version,
          mode: 'owner',
          category: 'receipts',
        },
      })
    ).status(),
  ).toBe(200);
  await mail.getByRole('button', { name: 'Apply preview' }).click();
  await expect(mail.getByRole('alert')).toContainText(
    'This item changed elsewhere',
  );
  const second = data.records.find(
    (item: { subject: string }) => item.subject === data.subjects[1],
  );
  expect(
    (
      await (
        await page.request.get(`/api/v1/email/messages/${second.id}`)
      ).json()
    ).message.category,
  ).toBeNull();
  await mail.getByRole('button', { name: 'Reload mail', exact: true }).click();
  await select(page, data.subjects);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/v1/email/rules/preview', async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  await mail.getByRole('button', { name: 'Preview rules (2)' }).click();
  await ready;
  await mail
    .getByRole('checkbox', { name: `Select ${data.subjects[0]}`, exact: true })
    .uncheck();
  release();
  await expect(
    mail.getByRole('button', { name: 'Preview rules (1)' }),
  ).toBeVisible();
  await expect(mail.getByRole('region', { name: 'Rule preview' })).toHaveCount(
    0,
  );
  await page.unroute('**/api/v1/email/rules/preview');
  await mail.getByRole('button', { name: 'Preview rules (1)' }).click();
  await expect(
    mail.getByRole('region', { name: 'Rule preview' }),
  ).not.toContainText(data.subjects[0]!);
  let releaseApply!: () => void, beginApply!: () => void;
  const applyGate = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  const applyReady = new Promise<void>((resolve) => {
    beginApply = resolve;
  });
  await page.route('**/api/v1/email/rules/apply', async (route) => {
    const response = await route.fetch();
    beginApply();
    await applyGate;
    await route.fulfill({ response });
  });
  await mail.getByRole('button', { name: 'Apply preview' }).click();
  await applyReady;
  await expect(
    mail.getByRole('checkbox', {
      name: `Select ${data.subjects[1]}`,
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    mail.getByRole('combobox', { name: 'Category', exact: true }),
  ).toBeDisabled();
  releaseApply();
  await expect(mail.getByRole('button', { name: 'Apply preview' })).toHaveCount(
    0,
  );
});
