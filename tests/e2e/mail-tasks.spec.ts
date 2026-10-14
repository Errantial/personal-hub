import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authenticate } from './auth';

const origin = 'http://127.0.0.1:5180';
const quote = `Please submit the form by October 20. 📨\nReference: ${'x'.repeat(240)}`;
async function seed(page: Page) {
  const suffix = crypto.randomUUID();
  const created = await page.request.post('/api/v1/email/connectors', {
    headers: { Origin: origin },
    data: {
      operationId: crypto.randomUUID(),
      name: `Task capture ${suffix}`,
      sensitivity: 'restricted',
    },
  });
  expect(created.status()).toBe(201);
  const { token, connector } = await created.json();
  const uploaded = await page.request.post('/api/v1/email/connector/batch', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      path: 'INBOX',
      role: null,
      uidValidity: '1',
      exists: 1,
      inWindow: 1,
      lastUid: 1,
      messages: [
        {
          uid: 1,
          textOrigin: 'message-body-v1',
          messageKey: `<${suffix}@example.test>`,
          from: null,
          to: [],
          cc: [],
          subject: `Capture ${suffix}`,
          sentAt: null,
          receivedAt: new Date().toISOString(),
          body: `Hello.\n${quote}\nThank you.`,
          bodyTruncated: false,
          attachmentCount: 0,
        },
      ],
    },
  });
  expect(uploaded.status()).toBe(200);
  const all = await (
    await page.request.get('/api/v1/email/messages?limit=100')
  ).json();
  const message = all.messages.find(
    (item: { connectorId: string }) => item.connectorId === connector.id,
  );
  expect(message).toBeTruthy();
  await page.goto(`/inbox/mail/${message.id}`);
  await page.getByText(message.subject, { exact: true }).last().waitFor();
  await page.getByText('Create task from mail', { exact: true }).click();
  await page.getByLabel('Task title', { exact: true }).fill(`Form ${suffix}`);
  await page
    .getByRole('textbox', { name: 'Supporting quote', exact: true })
    .fill(quote);
  return { message, title: `Form ${suffix}` };
}
test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('confirms the deadline, creates a grounded task and retains its source at 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const { message, title } = await seed(page);
  await page.getByLabel('Deadline', { exact: true }).fill('2026-10-20');
  await expect(
    page.getByRole('button', { name: 'Create task', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('checkbox', { name: 'I checked and confirm this deadline' })
    .check();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByText('Task created.', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Open task', exact: true }).click();
  // A task deep link loads without Inbox's lazily loaded stylesheet.
  await page.reload();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(title);
  await page.locator('summary').filter({ hasText: 'Mail source' }).click();
  await expect(page.getByRole('blockquote')).toHaveText(quote);
  await expect(
    page.getByText('Confirmed at creation: 2026-10-20'),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'eink'),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('link', { name: 'Open source message' }).click();
  await expect(page).toHaveURL(new RegExp(`/inbox/mail/${message.id}$`));
});

test('retains a draft after a stale message failure and requires deliberate source review', async ({
  page,
}) => {
  const { message, title } = await seed(page);
  const changed = await page.request.put(
    `/api/v1/email/messages/${message.id}/category`,
    {
      headers: { Origin: origin },
      data: {
        operationId: crypto.randomUUID(),
        expectedVersion: message.version,
        mode: 'owner',
        category: 'academic',
      },
    },
  );
  expect(changed.status()).toBe(200);
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('alert').last()).toContainText('draft is kept');
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue(
    title,
  );
  await page.route(
    `**/api/v1/email/messages/${message.id}`,
    (route) => route.abort(),
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Reload latest message' }).click();
  await expect(
    page.getByRole('button', { name: 'Retry message', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Supporting quote', exact: true }),
  ).toHaveValue(quote);
  await expect(
    page.getByRole('button', { name: 'Create task', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Retry message', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Use reviewed message version' }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Supporting quote', exact: true }),
  ).toHaveValue(quote);
  await expect(
    page.getByRole('button', { name: 'Create task', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Use reviewed message version' })
    .click();
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Open task', exact: true }),
  ).toBeVisible();
  const tasks = await (await page.request.get('/api/v1/tasks')).json();
  expect(
    tasks.tasks.filter((task: { title: string }) => task.title === title),
  ).toHaveLength(1);
});

test('retries a lost committed response without creating a second task', async ({
  page,
}) => {
  const { message, title } = await seed(page);
  await page.route(
    `**/api/v1/email/messages/${message.id}/tasks`,
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort();
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('alert').last()).toContainText('draft is kept');
  await expect(
    page.getByRole('textbox', { name: 'Supporting quote', exact: true }),
  ).toHaveValue(quote);
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Open task', exact: true }),
  ).toBeVisible();
  const tasks = await (await page.request.get('/api/v1/tasks')).json();
  expect(
    tasks.tasks.filter((task: { title: string }) => task.title === title),
  ).toHaveLength(1);
});
