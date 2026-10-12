import { test, expect } from '@playwright/test';
import { openSettings } from './shell';
import { authenticate } from './auth';
const headers = { Origin: 'http://127.0.0.1:5180' };
test('server preflights retain input through retry/conflict and hide metadata with stable receipts', async ({
  page,
}) => {
  await authenticate(page);
  const routing = await (await page.request.get('/api/v1/ai/routing')).json();
  const rule = { allowed: [], preferred: null };
  expect(
    (
      await page.request.put('/api/v1/ai/routing', {
        headers,
        data: {
          operationId: crypto.randomUUID(),
          expectedVersion: routing.version,
          policy: { unlabeled: rule, personal: rule, restricted: rule },
        },
      })
    ).status(),
  ).toBe(200);
  let losePost = true;
  let loseHide = true;
  const postIds: string[] = [];
  const hideIds: string[] = [];
  await page.route('**/api/v1/ai/preflights', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    postIds.push(route.request().postDataJSON().operationId);
    const response = await route.fetch();
    if (losePost) {
      losePost = false;
      return route.abort('failed');
    }
    return route.fulfill({ response });
  });
  await page.route('**/api/v1/ai/preflights/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    hideIds.push(route.request().postDataJSON().operationId);
    const response = await route.fetch();
    if (loseHide) {
      loseHide = false;
      return route.abort('failed');
    }
    return route.fulfill({ response });
  });
  await page.goto('/');
  await openSettings(page, 'AI');
  await page.setViewportSize({ width: 320, height: 900 });
  const panel = page.getByRole('region', {
    name: 'AI request checks',
    exact: true,
  });
  await expect(
    page.getByRole('region', { name: 'AI providers', exact: true }),
  ).toContainText('No server profiles.');
  await expect(panel).toContainText('Provider health unchecked');
  const form = panel.getByRole('form', {
    name: 'AI request check',
    exact: true,
  });
  const text = 'Synthetic preflight text must never appear in receipts.';
  await form
    .getByRole('textbox', { name: 'Check text', exact: true })
    .fill(text);
  await form.getByRole('button', { name: 'Run check', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(
    form.getByRole('textbox', { name: 'Check text', exact: true }),
  ).toHaveValue(text);
  await form.getByRole('button', { name: 'Run check', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(
    'Blocked · No provider permitted for all context',
  );
  expect(postIds[0]).toBe(postIds[1]);
  const current = await (await page.request.get('/api/v1/ai/routing')).json();
  expect(
    (
      await page.request.put('/api/v1/ai/routing', {
        headers,
        data: {
          operationId: crypto.randomUUID(),
          expectedVersion: current.version,
          policy: current.policy,
        },
      })
    ).status(),
  ).toBe(200);
  await form.getByRole('button', { name: 'Run check', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('changed elsewhere');
  await panel
    .getByRole('button', { name: 'Reload checks', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(
    form.getByRole('textbox', { name: 'Check text', exact: true }),
  ).toHaveValue(text);
  await form.getByRole('button', { name: 'Run check', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(
    'Blocked · No provider permitted for all context',
  );
  expect(postIds.at(-1)).not.toBe(postIds[0]);
  const history = await (
    await page.request.get('/api/v1/ai/preflights')
  ).json();
  const receipt = history.preflights[0];
  expect(JSON.stringify(history)).not.toContain(text);
  const entry = panel.getByRole('article', {
    name: `Check ${receipt.id}`,
    exact: true,
  });
  await entry.getByRole('button', { name: 'Hide check', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await entry.getByRole('button', { name: 'Hide check', exact: true }).click();
  await expect(entry).toHaveCount(0);
  expect(hideIds[0]).toBe(hideIds[1]);
  const exported = await (
    await page.request.get('/api/v1/planner/export')
  ).json();
  expect(
    exported.records.aiPreflights.find(
      (row: { id: string }) => row.id === receipt.id,
    ),
  ).toMatchObject({ version: 2, deletedAt: expect.any(String) });
  expect(JSON.stringify(exported.records.aiPreflights)).not.toContain(text);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test('spending limits preserve exact amounts, retry identities and conflict drafts and invalidate preflight versions', async ({
  page,
}) => {
  await authenticate(page);
  await page.goto('/');
  await openSettings(page, 'AI');
  const panel = page.getByRole('region', {
    name: 'AI spending limits',
    exact: true,
  });
  const form = panel.getByRole('form', {
    name: 'AI spending limits form',
    exact: true,
  });
  const preflights = page.getByRole('region', {
    name: 'AI request checks',
    exact: true,
  });
  await preflights
    .getByRole('textbox', { name: 'Check text', exact: true })
    .fill('Keep this preflight draft');
  await form
    .getByLabel('Monthly limit (USD)', { exact: true })
    .fill('10.000001');
  await form
    .getByLabel('Request limit (USD)', { exact: true })
    .fill('0.123456');
  let loseResponse = true;
  const ids: string[] = [];
  await page.route('**/api/v1/ai/budget', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    ids.push(route.request().postDataJSON().operationId);
    const response = await route.fetch();
    if (loseResponse) {
      loseResponse = false;
      return route.abort('failed');
    }
    return route.fulfill({ response });
  });
  await form
    .getByRole('button', { name: 'Save spending limits', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await form
    .getByRole('button', { name: 'Save spending limits', exact: true })
    .click();
  await expect(panel.getByRole('status')).toHaveText('Spending limits saved.');
  expect(ids[0]).toBe(ids[1]);
  await expect(
    preflights.getByRole('button', { name: 'Run check', exact: true }),
  ).toBeDisabled();
  await expect(preflights).toContainText(
    'Reload checks after settings changes.',
  );
  await preflights
    .getByRole('button', { name: 'Reload checks', exact: true })
    .click();
  await expect(
    preflights.getByRole('button', { name: 'Run check', exact: true }),
  ).toBeEnabled();
  await expect(
    preflights.getByRole('textbox', { name: 'Check text', exact: true }),
  ).toHaveValue('Keep this preflight draft');
  const stored = await (await page.request.get('/api/v1/ai/budget')).json();
  expect(stored.policy).toEqual({
    monthlyLimitMicros: 10000001,
    perRequestLimitMicros: 123456,
  });
  expect(stored.dispatchEnabled).toBe(false);
  expect(
    (
      await page.request.put('/api/v1/ai/budget', {
        headers,
        data: {
          operationId: crypto.randomUUID(),
          expectedVersion: stored.version,
          policy: {
            monthlyLimitMicros: 20000000,
            perRequestLimitMicros: 200000,
          },
        },
      })
    ).status(),
  ).toBe(200);
  await form
    .getByRole('button', { name: 'Save spending limits', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText('changed elsewhere');
  await panel
    .getByRole('button', { name: 'Reload spending limits', exact: true })
    .click();
  await expect(
    form.getByLabel('Monthly limit (USD)', { exact: true }),
  ).toHaveValue('10.000001');
  await expect(
    form.getByLabel('Request limit (USD)', { exact: true }),
  ).toHaveValue('0.123456');
  await form
    .getByRole('button', { name: 'Save spending limits', exact: true })
    .click();
  await expect(panel.getByRole('status')).toHaveText('Spending limits saved.');
  const calls = ids.length;
  await form.getByLabel('Request limit (USD)', { exact: true }).fill('100');
  await form
    .getByRole('button', { name: 'Save spending limits', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText(
    'request limit within the monthly limit',
  );
  expect(ids).toHaveLength(calls);
});
test('a late preflight load cannot clear a newer settings-change warning', async ({
  page,
}) => {
  await authenticate(page);
  let release!: () => void;
  let held!: () => void;
  let holdProfiles = true;
  const ready = new Promise<void>((resolve) => {
    held = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/ai/providers', async (route) => {
    const response = await route.fetch();
    if (holdProfiles) {
      held();
      await gate;
    }
    return route.fulfill({ response });
  });
  await page.goto('/');
  await openSettings(page, 'AI');
  await ready;
  const preflights = page.getByRole('region', {
    name: 'AI request checks',
    exact: true,
  });
  const budget = page.getByRole('region', {
    name: 'AI spending limits',
    exact: true,
  });
  try {
    await preflights
      .getByRole('textbox', { name: 'Check text', exact: true })
      .fill('Retain this input while loading');
    await budget.getByLabel('Monthly limit (USD)', { exact: true }).fill('5');
    await budget.getByLabel('Request limit (USD)', { exact: true }).fill('0.1');
    await budget
      .getByRole('button', { name: 'Save spending limits', exact: true })
      .click();
    await expect(budget.getByRole('status')).toHaveText(
      'Spending limits saved.',
    );
    holdProfiles = false;
    release();
    await expect(
      page.getByRole('region', { name: 'AI providers', exact: true }),
    ).toContainText('No server profiles.');
    await expect(preflights).toContainText(
      'Reload checks after settings changes.',
    );
    await expect(
      preflights.getByRole('button', { name: 'Run check', exact: true }),
    ).toBeDisabled();
    await preflights
      .getByRole('button', { name: 'Reload checks', exact: true })
      .click();
    await expect(
      preflights.getByRole('button', { name: 'Run check', exact: true }),
    ).toBeEnabled();
    await expect(
      preflights.getByRole('textbox', { name: 'Check text', exact: true }),
    ).toHaveValue('Retain this input while loading');
  } finally {
    release();
  }
});
