import { expect, test } from '@playwright/test';
import { authenticate } from './auth';

const origin = 'http://127.0.0.1:5180';

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('an AI suggestion fills the capture form, and the deadline still needs confirmation', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const sentence = 'Please return the signed waiver by Friday.';
  const created = await page.request.post('/api/v1/email/connectors', {
    headers: { Origin: origin },
    data: {
      operationId: crypto.randomUUID(),
      name: `Suggest tasks ${suffix}`,
      sensitivity: 'unlabeled',
    },
  });
  const { token, connector } = await created.json();
  await page.request.post('/api/v1/email/connector/batch', {
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
          subject: `Waiver ${suffix}`,
          sentAt: null,
          receivedAt: new Date().toISOString(),
          body: `Hi,\n${sentence}\nThanks`,
          bodyTruncated: false,
          attachmentCount: 0,
        },
      ],
    },
  });
  const message = (
    await (await page.request.get('/api/v1/email/messages?limit=100')).json()
  ).messages.find(
    (item: { connectorId: string }) => item.connectorId === connector.id,
  );
  // Only the suggestion endpoint is simulated; no provider is called.
  await page.route('**/task-suggestions', (route) =>
    route.fulfill({
      json: {
        request: {
          id: crypto.randomUUID(),
          status: 'completed',
          reason: null,
          model: 'anthropic/claude-haiku-5.5',
          resultAvailable: true,
          suggestions: [
            {
              title: 'Return the signed waiver',
              quote: sentence,
              dueDate: '2036-03-07',
              notes: 'Signature needed.',
            },
          ],
          dropped: 1,
          costMicros: 90,
          heldMicros: 0,
          createdAt: new Date().toISOString(),
        },
        blocked: null,
      },
    }),
  );
  await page.goto(`/inbox/mail/${message.id}`);
  await page.getByText('Create task from mail', { exact: true }).click();
  await page.getByRole('button', { name: 'Suggest tasks with AI' }).click();
  const list = page.getByRole('list', { name: 'Suggested tasks' });
  await expect(list).toContainText(sentence);
  await expect(list).toContainText('check before confirming');
  await expect(
    page.getByText('1 suggestion without an exact quote left out', {
      exact: false,
    }),
  ).toBeVisible();
  await list
    .getByRole('button', { name: 'Use suggestion: Return the signed waiver' })
    .click();
  await expect(page.getByLabel('Task title', { exact: true })).toHaveValue(
    'Return the signed waiver',
  );
  await expect(
    page.getByRole('textbox', { name: 'Supporting quote', exact: true }),
  ).toHaveValue(sentence);
  await expect(page.getByLabel('Deadline', { exact: true })).toHaveValue(
    '2036-03-07',
  );
  const confirm = page.getByRole('checkbox', {
    name: 'I checked and confirm this deadline',
  });
  await expect(confirm).not.toBeChecked();
  const create = page.getByRole('button', { name: 'Create task', exact: true });
  await expect(create).toBeDisabled();
  await confirm.check();
  await create.click();
  await expect(page.getByText('Task created.')).toBeVisible();
  const tasks = (await (await page.request.get('/api/v1/tasks')).json())
    .tasks as { title: string; dueDate: string | null }[];
  expect(
    tasks.find((task) => task.title === 'Return the signed waiver')?.dueDate,
  ).toBe('2036-03-07');
});
