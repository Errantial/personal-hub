import { test, expect } from '@playwright/test';
import { openSettings } from './shell';
import { authenticate } from './auth';
test('routing permissions retry once, keep drafts on conflict and preview inherited labels without fallback or provider calls', async ({
  page,
}) => {
  await authenticate(page);
  const headers = { Origin: 'http://127.0.0.1:5180' };
  const taskResponse = await page.request.post('/api/v1/tasks', {
    headers,
    data: {
      operationId: crypto.randomUUID(),
      title: 'Browser personal routing context',
      sensitivity: 'personal',
    },
  });
  expect(taskResponse.status()).toBe(200);
  const task = (await taskResponse.json()).task;
  const base = '/api/v1/ai/routing';
  let loseResponse = true;
  const operationIds: string[] = [];
  await page.route(`**${base}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    operationIds.push(route.request().postDataJSON().operationId);
    const response = await route.fetch();
    if (loseResponse) {
      loseResponse = false;
      return route.abort('failed');
    }
    return route.fulfill({ response });
  });
  await page.goto('/');
  await openSettings(page, 'AI');
  await page.setViewportSize({ width: 320, height: 900 });
  const panel = page.getByRole('region', {
    name: 'AI routing permissions',
    exact: true,
  });
  await expect(panel).toContainText('Preview only · Not used by the Assistant');
  const form = panel.getByRole('form', {
    name: 'Routing permissions',
    exact: true,
  });
  await form
    .getByLabel('unlabeled allowed providers')
    .fill('routine, private, vault');
  await form.getByLabel('unlabeled preferred provider').selectOption('routine');
  await form.getByLabel('personal allowed providers').fill('private, vault');
  await form.getByLabel('personal preferred provider').selectOption('private');
  await form.getByLabel('restricted allowed providers').fill('vault');
  await form.getByLabel('restricted preferred provider').selectOption('vault');
  await expect(
    panel.getByRole('button', { name: 'Preview route', exact: true }),
  ).toBeDisabled();
  await form
    .getByRole('button', { name: 'Save permissions', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await form
    .getByRole('button', { name: 'Save permissions', exact: true })
    .click();
  await expect(panel.getByRole('status')).toHaveText('Permissions saved.');
  expect(operationIds[0]).toBe(operationIds[1]);
  const preview = panel.getByRole('form', {
    name: 'Routing preview',
    exact: true,
  });
  await preview.getByLabel('Preview text').fill('Synthetic routing preview');
  await preview.getByLabel('Task context').selectOption(task.id);
  await preview
    .getByRole('checkbox', { name: 'Simulate routine available' })
    .check();
  await preview
    .getByRole('button', { name: 'Preview route', exact: true })
    .click();
  await expect(panel).toContainText('Blocked · Approved provider unavailable');
  await preview
    .getByRole('checkbox', { name: 'Simulate private available' })
    .check();
  await preview
    .getByRole('button', { name: 'Preview route', exact: true })
    .click();
  await expect(panel).toContainText('Selected private · Simulation');
  await expect(panel).toContainText('Labels: unlabeled, personal');
  const stored = await (await page.request.get(base)).json();
  const changed = await page.request.put(base, {
    headers,
    data: {
      operationId: crypto.randomUUID(),
      expectedVersion: stored.version,
      policy: { ...stored.policy, personal: { allowed: [], preferred: null } },
    },
  });
  expect(changed.status()).toBe(200);
  await preview
    .getByRole('button', { name: 'Preview route', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText('changed elsewhere');
  await panel
    .getByRole('button', { name: 'Reload permissions', exact: true })
    .click();
  await expect(form.getByLabel('personal allowed providers')).toHaveValue(
    'private, vault',
  );
  await expect(
    preview.getByRole('button', { name: 'Preview route', exact: true }),
  ).toBeDisabled();
  await form
    .getByRole('button', { name: 'Save permissions', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  const imported = await page.request.post(
    '/api/v1/connections/canvas/import',
    {
      headers,
      data: {
        operationId: crypto.randomUUID(),
        feed: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:routing-browser-file\r\nDTSTART:20270501T170000Z\r\nDTEND:20270501T170000Z\r\nSUMMARY:Browser routing file\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
      },
    },
  );
  expect(imported.status()).toBe(200);
  const item = (
    await (await page.request.get('/api/v1/connections/canvas')).json()
  ).items.find((row: { uid: string }) => row.uid === 'routing-browser-file');
  const created = await page.request.post('/api/v1/tasks', {
    headers,
    data: {
      operationId: crypto.randomUUID(),
      title: 'Browser file-derived routing context',
      canvasSourceRef: { itemId: item.id, expectedVersion: item.version },
    },
  });
  expect(created.status()).toBe(200);
  const fileTask = (await created.json()).task;
  await panel
    .getByRole('button', { name: 'Reload permissions', exact: true })
    .click();
  await preview.getByLabel('Task context').selectOption(fileTask.id);
  await preview
    .getByRole('button', { name: 'Preview route', exact: true })
    .click();
  await expect(panel).toContainText('Blocked · File-derived context');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
