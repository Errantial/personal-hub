import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { authenticate } from './auth';
import { openSettings } from './shell';

test('Outlook browser collection stays read-only, separate from the access gate and usable at 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await authenticate(page);
  const stamp = '2026-11-13T19:00:00.000Z';
  const inbox = {
    id: crypto.randomUUID(),
    providerId: 'inbox',
    name: 'Inbox',
    canonicalUrl: 'https://outlook.office.com/mail/inbox',
    availability: 'available' as const,
    selected: false,
    notes: '',
    sensitivity: 'unlabeled' as const,
    effectiveSensitivity: 'personal' as const,
    lastContactAt: stamp,
    lastImportAt: stamp,
    lastCompleteAt: null,
    lastObservationStatus: 'partial' as const,
    lastObservedCount: 1,
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const sent = {
    ...inbox,
    id: crypto.randomUUID(),
    providerId: 'sentitems',
    name: 'Sent Items',
    canonicalUrl: 'https://outlook.office.com/mail/sentitems',
  };
  const message = {
    id: crypto.randomUUID(),
    browserFolderId: inbox.id,
    providerId: 'syntheticMessage0001',
    conversationId: 'syntheticConversation0001',
    canonicalUrl:
      'https://outlook.office.com/mail/inbox/id/syntheticMessage0001',
    subject: 'Synthetic browser message',
    senderDisplay: 'Synthetic Advisor',
    senderAddress: 'advisor@example.test',
    receivedAt: stamp,
    snippet: 'Synthetic preview text.',
    capturedAt: stamp,
    availability: 'available' as const,
    notes: '',
    sensitivity: 'unlabeled' as const,
    effectiveSensitivity: 'personal' as const,
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const data = {
    configured: false,
    version: 1,
    sensitivity: 'personal' as const,
    healthStatus: 'partial' as const,
    lastAttemptAt: stamp,
    lastContactAt: stamp,
    lastImportAt: stamp,
    lastCompleteAt: null,
    lastAttemptOutcome: 'partial' as const,
    lastErrorCode: 'traversal-limit' as const,
    folders: [inbox, sent],
    messages: [message],
    messagesTruncated: true,
    attempts: [
      {
        id: crypto.randomUUID(),
        sourceVersion: 1,
        outcome: 'partial' as const,
        errorCode: 'traversal-limit' as const,
        discoveryStatus: 'complete' as const,
        selectedCount: 1,
        completeCount: 0,
        startedAt: stamp,
        finishedAt: stamp,
      },
    ],
  };
  await page.route('**/api/v1/connections/outlook/browser**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.includes('/messages/') && request.method() === 'GET') {
      message.version++;
      return route.fulfill({
        json: {
          message: {
            ...message,
            bodyText:
              'Synthetic plain-text body.\n\nSecond synthetic paragraph.',
          },
          captures: [
            {
              id: crypto.randomUUID(),
              attemptId: crypto.randomUUID(),
              browserMessageId: message.id,
              snapshot: {
                providerId: message.providerId,
                conversationId: message.conversationId,
                canonicalUrl: message.canonicalUrl,
                subject: message.subject,
                senderDisplay: message.senderDisplay,
                senderAddress: message.senderAddress,
                receivedAt: message.receivedAt,
                snippet: message.snippet,
              },
              effectiveSensitivity: 'personal',
              capturedAt: stamp,
              createdAt: stamp,
            },
          ],
        },
      });
    }
    if (path.includes('/messages/')) {
      const body = request.postDataJSON();
      Object.assign(message, {
        notes: body.notes,
        sensitivity: body.sensitivity,
        version: message.version + 1,
      });
      return route.fulfill({ json: { message } });
    }
    if (request.method() === 'GET') return route.fulfill({ json: data });
    if (path.endsWith('/token')) {
      data.configured = true;
      data.version++;
      return route.fulfill({
        json: {
          token: `hubob_${'A'.repeat(43)}`,
          connection: data,
        },
      });
    }
    if (path.endsWith('/revoke')) {
      data.configured = false;
      data.version++;
      return route.fulfill({ json: data });
    }
    if (path === '/api/v1/connections/outlook/browser') {
      const body = request.postDataJSON();
      data.sensitivity = body.sensitivity;
      data.version++;
      return route.fulfill({ json: data });
    }
    if (path.includes('/folders/')) {
      const body = request.postDataJSON();
      Object.assign(inbox, {
        selected: body.selected,
        notes: body.notes,
        sensitivity: body.sensitivity,
        version: inbox.version + 1,
      });
      data.version++;
      return route.fulfill({
        json: { folder: inbox, sourceVersion: data.version },
      });
    }
    return route.fulfill({
      status: 500,
      json: { error: { code: 'TEST_ROUTE' } },
    });
  });

  await page.goto('/');
  await openSettings(page, 'Connections');
  await page.getByRole('link', { name: 'Review Outlook access' }).click();
  await expect(page).toHaveURL('/settings/connections/outlook');
  await expect(
    page.getByRole('region', { name: 'Outlook access gate' }),
  ).toBeVisible();
  const region = page.getByRole('region', {
    name: 'Outlook browser connection',
  });
  await expect(region).toContainText('Browser collector (read-only)');
  await expect(region).toContainText('Partial');
  await expect(region).toContainText('traversal-limit');
  await expect(region).toContainText('Complete through: Never');
  await expect(region).toContainText('Showing the 200 most recent messages');
  await region
    .getByRole('button', { name: 'Help: Outlook browser collector' })
    .click();
  await expect(region).toContainText('does not use Microsoft Graph');
  await expect(region).toContainText('read/unread');
  await expect(region).toContainText('read-receipt');
  await expect(region).toContainText('raw headers');

  await region.getByRole('button', { name: 'Create collector token' }).click();
  await expect(
    region.getByRole('textbox', { name: 'Outlook browser collector token' }),
  ).toHaveValue(/^hubob_/);
  await region.getByRole('button', { name: 'I saved it' }).click();
  await expect(
    region.getByRole('textbox', { name: 'Outlook browser collector token' }),
  ).toHaveCount(0);

  const inboxRegion = region.getByRole('region', {
    name: 'Outlook browser folder Inbox',
  });
  await expect(inboxRegion).toContainText('Not selected');
  await expect(inboxRegion).toContainText('Coverage: partial');
  await inboxRegion
    .getByRole('button', { name: 'Edit browser folder' })
    .click();
  const folderForm = inboxRegion.getByRole('form', {
    name: 'Outlook browser folder editor',
  });
  await folderForm
    .getByRole('checkbox', { name: 'Collect this folder' })
    .check();
  await folderForm
    .getByLabel('Personal notes')
    .fill('Selected for synthetic coverage.');
  await folderForm.getByRole('button', { name: 'Save browser folder' }).click();
  await expect(region).toContainText('Outlook browser folder saved.');
  await expect(inboxRegion).toContainText('Selected');

  const messageRegion = region.getByRole('region', {
    name: 'Outlook browser message Synthetic browser message',
  });
  await expect(messageRegion).toContainText('Synthetic Advisor');
  await messageRegion.getByRole('button', { name: 'Open message' }).click();
  await expect(
    messageRegion.getByRole('region', {
      name: 'Outlook browser message detail',
    }),
  ).toContainText('Synthetic plain-text body.');
  await expect(messageRegion).toContainText('Captures: 1');
  await messageRegion.getByRole('button', { name: 'Close message' }).click();
  await expect(
    messageRegion.getByRole('region', {
      name: 'Outlook browser message detail',
    }),
  ).toHaveCount(0);

  await messageRegion
    .getByRole('button', { name: 'Edit message notes' })
    .click();
  const messageForm = messageRegion.getByRole('form', {
    name: 'Outlook browser message editor',
  });
  await messageForm
    .getByLabel('Personal notes')
    .fill('Synthetic owner note only.');
  await messageForm.getByRole('button', { name: 'Save message notes' }).click();
  await expect(region).toContainText('Outlook browser message notes saved.');
  await expect(messageRegion).toContainText('Synthetic owner note only.');

  const { violations } = await new AxeBuilder({ page })
    .include('[aria-label="Outlook browser connection"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((item) => `${item.id} ${item.nodes.length}`)).toEqual(
    [],
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
