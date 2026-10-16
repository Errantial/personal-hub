import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authenticate } from './auth';
import { openSettings } from './shell';

const origin = 'http://127.0.0.1:5180';

/** A connector with one imported message, so grants have something to allow. */
async function connector(page: Page, name: string) {
  const created = await page.request.post('/api/v1/email/connectors', {
    headers: { Origin: origin },
    data: {
      operationId: crypto.randomUUID(),
      name,
      sensitivity: 'unlabeled',
    },
  });
  expect(created.status()).toBe(201);
  const { token, connector: saved } = await created.json();
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
          messageKey: `<${name}@example.test>`,
          from: { name: 'School Office', address: 'office@example.test' },
          to: [],
          cc: [],
          subject: `${name} subject`,
          sentAt: null,
          receivedAt: '2026-01-05T09:00:00Z',
          body: 'The deadline is Friday.',
          bodyTruncated: false,
          attachmentCount: 0,
        },
      ],
    },
  });
  expect(uploaded.status()).toBe(200);
  return saved;
}

const ownerForm = (page: Page) =>
  page.getByRole('form', { name: 'Mail access for Assistant asks' });

test('mail access grants save per owner, report blocked dispatch and never invent a grant', async ({
  page,
}) => {
  await authenticate(page);
  const name = `Broker ${crypto.randomUUID().slice(0, 8)}`;
  await connector(page, name);
  await page.goto('/');
  await openSettings(page, 'AI');
  const panel = page.getByRole('region', { name: 'Brokered mail access' });
  // No broker profile exists on the test server, and that must be visible.
  await expect(panel.getByText('Mail asks are blocked:')).toBeVisible();
  await expect(
    panel.getByText('The broker profile is not configured on the server.'),
  ).toBeVisible();
  const form = ownerForm(page);
  await expect(form.getByRole('status')).toHaveText('Off');
  await expect(
    form.getByRole('button', { name: 'Save mail access', exact: true }),
  ).toBeDisabled();

  await form.getByRole('checkbox', { name }).check();
  await form.getByRole('checkbox', { name: 'Allow brokered mail' }).check();
  await form.getByLabel('From').fill('2026-01-01');
  await form.getByLabel('To').fill('2026-01-31');
  await form
    .getByRole('button', { name: 'Save mail access', exact: true })
    .click();
  await expect(form.getByRole('status')).toHaveText(
    `On · 1 source · 2026-01-01 to 2026-01-31`,
  );
  // The saved window keeps whole days, and the grant survives a reload.
  const saved = await (
    await page.request.get('/api/v1/mail-broker/grants', {
      headers: { Origin: origin },
    })
  ).json();
  expect(saved.grants).toHaveLength(1);
  expect(saved.grants[0]).toMatchObject({
    agentId: null,
    enabled: true,
    scope: {
      receivedAfter: '2026-01-01T00:00:00.000Z',
      receivedBefore: '2026-01-31T23:59:59.999Z',
    },
  });
  await page.reload();
  await expect(ownerForm(page).getByRole('status')).toContainText(
    'On · 1 source',
  );

  // A conflicting write is reported and keeps the owner's draft.
  await page.route('**/api/v1/mail-broker/grants/owner', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'VERSION_CONFLICT', message: 'Reload mail access.' },
      }),
    });
  });
  await ownerForm(page).getByLabel('From').fill('2025-12-01');
  await ownerForm(page)
    .getByRole('button', { name: 'Save mail access', exact: true })
    .click();
  await expect(ownerForm(page).getByRole('alert')).toBeVisible();
  await expect(ownerForm(page).getByLabel('From')).toHaveValue('2025-12-01');
  await ownerForm(page)
    .getByRole('button', { name: 'Reload mail access', exact: true })
    .click();
  await expect(ownerForm(page).getByLabel('From')).toHaveValue('2026-01-01');

  // Turning access off needs a source in scope but blocks every mail ask.
  await page.unroute('**/api/v1/mail-broker/grants/owner');
  await ownerForm(page)
    .getByRole('checkbox', { name: 'Allow brokered mail' })
    .uncheck();
  await ownerForm(page)
    .getByRole('button', { name: 'Save mail access', exact: true })
    .click();
  await expect(ownerForm(page).getByRole('status')).toHaveText('Off');
});

test('a revoked source is reported instead of silently dropped from a saved scope', async ({
  page,
}) => {
  await authenticate(page);
  const name = `Revoked ${crypto.randomUUID().slice(0, 8)}`;
  const saved = await connector(page, name);
  await page.goto('/');
  await openSettings(page, 'AI');
  await ownerForm(page).getByRole('checkbox', { name }).check();
  await ownerForm(page)
    .getByRole('checkbox', { name: 'Allow brokered mail' })
    .check();
  await ownerForm(page)
    .getByRole('button', { name: 'Save mail access', exact: true })
    .click();
  await expect(ownerForm(page).getByRole('status')).toHaveText(
    /^On · \d+ sources?/,
  );
  const revoked = await page.request.post(
    `/api/v1/email/connectors/${saved.id}/revoke`,
    {
      headers: { Origin: origin },
      data: {
        operationId: crypto.randomUUID(),
        expectedVersion: saved.version,
      },
    },
  );
  expect(revoked.status()).toBe(200);
  await page.reload();
  await openSettings(page, 'AI');
  const form = ownerForm(page);
  await expect(form.getByRole('status')).toContainText(
    '1 chosen source revoked or missing',
  );
  await expect(
    form.getByRole('checkbox', { name: `${name} (revoked)` }),
  ).toBeDisabled();
});

test('mail access stays usable at 320px and its Help opens by keyboard', async ({
  page,
}) => {
  await authenticate(page);
  await connector(page, `Narrow ${crypto.randomUUID().slice(0, 8)}`);
  await page.goto('/');
  await openSettings(page, 'AI');
  await page.setViewportSize({ width: 320, height: 900 });
  const panel = page.getByRole('region', { name: 'Brokered mail access' });
  const help = panel.getByRole('button', { name: 'Help: Mail access' });
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByText(/A broker judges imported mail/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel.getByText(/A broker judges imported mail/)).toBeHidden();
  await help.focus();
  await page.keyboard.press('Space');
  await expect(panel.getByText(/A broker judges imported mail/)).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('a brokered answer shows real coverage and searches older mail on request', async ({
  page,
}) => {
  await authenticate(page);
  // The browser server has no provider key; the ask itself is stubbed here.
  await page.route('**/api/v1/assistant/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      json: {
        settings: {
          model: 'anthropic/claude-haiku-5.5',
          version: 1,
          configured: true,
          allowPersonalMail: false,
          useMail: false,
        },
      },
    });
  });
  await page.route('**/api/v1/assistant/destination*', (route) =>
    route.fulfill({
      json: {
        destination: {
          status: 'ready',
          reason: null,
          approved: {
            model: 'anthropic/claude-haiku-5.5',
            upstream: 'google-vertex',
          },
          model: 'anthropic/claude-haiku-5.5',
          hosts: ['anthropic', 'google-vertex', 'amazon-bedrock'],
          personalMail: false,
          version: 1,
        },
      },
    }),
  );
  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const turn = {
    id: crypto.randomUUID(),
    conversationId,
    ask: 'Any deadlines in mail?',
    version: 1,
    items: [],
    useMail: true,
    mail: [
      {
        id: crypto.randomUUID(),
        subject: 'Field trip waiver',
        from: 'School Office',
        receivedAt: '2026-01-05T09:00:00Z',
        read: true,
        truncated: false,
      },
    ],
    mailWithheld: 0,
    mailNote: null,
    mailBroker: {
      receipt: {
        id: crypto.randomUUID(),
        status: 'partial',
        coverage: {
          scope: 'imported-mail',
          externalCompleteness: 'unverified',
          snapshotAt: now,
          connectors: [
            {
              id: crypto.randomUUID(),
              lastSeenAt: '2026-01-05T09:05:00Z',
              importedSince: '2025-09-01',
            },
          ],
          inspected: 120,
          judged: 120,
          eligible: 120,
          selected: 1,
          clipped: 2,
          hasMore: true,
          stopReason: 'result-limit',
        },
      },
      continuation: crypto.randomUUID(),
    },
    academic: [],
    trigger: 'owner',
    notAllowed: 0,
    inferenceHistory: 'bound',
    proposalAccess: 'read-only',
    request: {
      id: crypto.randomUUID(),
      model: 'anthropic/claude-haiku-5.5',
      status: 'completed',
      reason: null,
      reply: 'One waiver is due Friday.',
      createdAt: now,
      resultAvailable: true,
      proposals: [],
      dropped: 0,
      withheld: 0,
      costMicros: 123,
      heldMicros: 0,
    },
  };
  let asked: Record<string, unknown> | null = null;
  const conversation = {
    id: conversationId,
    title: 'Deadlines',
    turnCount: 1,
    version: 1,
    createdAt: now,
    updatedAt: now,
    agent: null,
  };
  await page.route('**/api/v1/assistant/conversations/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { conversation, turns: [turn] } });
  });
  await page.route('**/api/v1/assistant/requests', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    asked = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      json: { turn: { ...turn, id: crypto.randomUUID() } },
    });
  });
  await page.goto(`/assistant/${conversationId}`);
  const coverage = page.getByText(
    'Mail search stopped early. 120 messages judged · 1 message sent · 2 messages cut. Stopped after the message limit, so older mail was not searched.',
  );
  await expect(coverage).toBeVisible();
  await page.getByRole('button', { name: 'Help: Mail coverage' }).click();
  await expect(
    page.getByText(/Completeness of the mailbox itself is unverified/),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Search older mail' }).click();
  await expect(
    page.getByText(/The next ask searches older imported mail/),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Ask' })
    .fill('Look for the earlier waiver reminder');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect.poll(() => asked).toBeTruthy();
  expect(asked).toMatchObject({
    useMail: true,
    mailContinuation: turn.mailBroker.continuation,
  });
  expect(String(asked!.text)).toContain('earlier waiver');
});
