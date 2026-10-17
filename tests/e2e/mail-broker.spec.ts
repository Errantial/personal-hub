import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authenticate } from './auth';
import { openSettings, toggleEink } from './shell';

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

for (const width of [1280, 320]) {
  test(`broker approval stays separate, versioned and offline-safe at ${width}px`, async ({
    page,
  }) => {
    await authenticate(page);
    await page.setViewportSize({ width, height: 900 });
    const revision = 'a'.repeat(64);
    let approved = false,
      version = 1,
      conflict = false;
    const writes: Record<string, unknown>[] = [];
    const profile = {
      alias: 'mail-broker',
      adapter: 'openrouter',
      accessMode: 'api-key',
      upstreamProvider: 'google-vertex',
      model: 'google/gemini-2.5-flash-lite',
      configuration: 'configured',
      maxInputCharacters: 20480,
      maxOutputTokens: 2048,
      policyRevision: revision,
      pricing: {
        revision: 'synthetic-price',
        validUntil: '2099-01-01T00:00:00Z',
        inputTokenLimit: 32000,
        inputMicrosPerMillionTokens: 100000,
        outputMicrosPerMillionTokens: 400000,
      },
      retentionDisclosure: {
        revision: 'synthetic-terms',
        summary: 'Synthetic OpenRouter and Google Vertex zero-retention terms.',
      },
    };
    const consent = () => ({
      alias: 'mail-broker',
      version,
      approved,
      profileRevision: approved ? revision : null,
      updatedAt: null,
    });
    await page.route('**/api/v1/ai/providers', (route) =>
      route.fulfill({
        json: {
          revision,
          dispatchEnabled: false,
          health: 'not_checked',
          profiles: [profile],
        },
      }),
    );
    await page.route('**/api/v1/ai/provider-readiness', (route) =>
      route.fulfill({
        json: {
          registryRevision: revision,
          dispatchEnabled: false,
          profiles: [
            {
              alias: 'mail-broker',
              consent: consent(),
              consentCurrent: approved,
              blockers: [],
              quote: {
                basis: 'configured_token_allowance',
                currency: 'USD',
                priceRevision: 'synthetic-price',
                validUntil: '2099-01-01T00:00:00Z',
                inputTokenLimit: 32000,
                outputTokenLimit: 2048,
                inputMaximumMicros: 3200,
                outputMaximumMicros: 820,
                maximumChargeMicros: 4020,
              },
            },
          ],
        },
      }),
    );
    await page.route('**/api/v1/mail-broker/readiness', (route) =>
      route.fulfill({
        json: {
          status: approved ? 'ready' : 'blocked',
          blockers: approved ? [] : ['CONSENT_REQUIRED'],
          profileRevision: revision,
          approvalVersion: version,
          downstream: 'ready',
          dispatchConnectedToAgents: true,
          destination: {
            alias: 'mail-broker',
            model: profile.model,
            router: 'openrouter',
            upstream: 'google-vertex',
          },
          endpointStatus: 'unchecked',
        },
      }),
    );
    await page.route(
      '**/api/v1/ai/provider-consents/mail-broker',
      async (route) => {
        const body = route.request().postDataJSON();
        writes.push(body);
        if (conflict) {
          await route.fulfill({
            status: 409,
            json: {
              error: {
                code: 'VERSION_CONFLICT',
                message: 'Reload broker approval.',
              },
            },
          });
          return;
        }
        expect(body.expectedVersion).toBe(version);
        expect(body.expectedRegistryRevision).toBe(revision);
        expect(body.operationId).toMatch(/^[a-f0-9-]{36}$/);
        approved = body.approved;
        version++;
        await route.fulfill({ json: consent() });
      },
    );
    await page.goto('/');
    if (width === 320) await toggleEink(page);
    await openSettings(page, 'AI');
    const panel = page.getByRole('region', {
      name: 'Broker destination approval',
    });
    await expect(
      panel.getByText('Broker approval required', { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText(profile.retentionDisclosure.summary),
    ).toBeVisible();
    const approve = panel.getByRole('button', {
      name: 'Approve broker',
      exact: true,
    });
    await approve.click();
    await expect(
      panel.getByText('Broker approved', { exact: true }),
    ).toBeVisible();
    await expect(approve).toBeDisabled();
    expect(writes).toHaveLength(1);
    await panel
      .getByRole('button', { name: 'Revoke broker', exact: true })
      .click();
    await expect(
      panel.getByText('Broker approval required', { exact: true }),
    ).toBeVisible();
    conflict = true;
    await approve.click();
    await expect(
      panel.getByText('Broker approval changed. Reload before saving.'),
    ).toBeVisible();
    await panel
      .getByRole('button', { name: 'Reload broker approval', exact: true })
      .click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await page.context().setOffline(true);
    await expect(approve).toBeDisabled();
    await expect(
      panel.getByText('Offline · broker approval cannot be changed.'),
    ).toBeVisible();
    await page.context().setOffline(false);
    const help = panel.getByRole('button', {
      name: 'Help: Broker approval',
      exact: true,
    });
    await help.focus();
    await page.keyboard.press('Enter');
    await expect(help).toHaveAttribute('aria-expanded', 'true');
    const axe = await new AxeBuilder({ page })
      .include('[aria-label="Broker destination approval"]')
      .analyze();
    expect(axe.violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

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
              healthStatus: 'current',
              lastContactAt: '2026-01-05T09:05:00Z',
              lastCompleteAt: '2026-01-05T09:05:00Z',
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
