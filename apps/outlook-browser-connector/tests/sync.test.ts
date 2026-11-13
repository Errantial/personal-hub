import { expect, it, vi } from 'vitest';
import type { Hub } from '../src/hub.js';
import type { BrowserCollector } from '../src/runtime.js';
import { CollectionError } from '../src/extract.js';
import { syncBrowser, syncWithBrowserFactory } from '../src/sync.js';

function hub(selected = true) {
  let reads = 0;
  return {
    state: vi.fn<Hub['state']>(async () => ({
      sourceVersion: 4,
      folders:
        reads++ === 0 || !selected
          ? []
          : [
              {
                id: '11111111-1111-4111-8111-111111111111',
                providerId: 'inbox',
                canonicalUrl: 'https://outlook.office.com/mail/inbox',
                version: 2,
              },
            ],
    })),
    begin: vi.fn<Hub['begin']>(async () => undefined),
    discovery: vi.fn<Hub['discovery']>(async () => undefined),
    folder: vi.fn<Hub['folder']>(async () => undefined),
    finish: vi.fn<Hub['finish']>(async () => undefined),
  };
}

const folder = {
  providerId: 'inbox',
  name: 'Inbox',
  canonicalUrl: 'https://outlook.office.com/mail/inbox',
};
const message = {
  providerId: 'syntheticMessage0001',
  conversationId: 'syntheticConversation0001',
  canonicalUrl: 'https://outlook.office.com/mail/inbox/id/syntheticMessage0001',
  subject: 'Synthetic welcome notice',
  senderDisplay: 'Synthetic Advisor',
  senderAddress: 'advisor@example.test',
  receivedAt: '2026-11-01T15:30:00.000Z',
  snippet: 'A short synthetic preview.',
  bodyText: 'Hello from a synthetic message.',
};

function browser(overrides: Partial<BrowserCollector> = {}): BrowserCollector {
  return {
    discover: async () => ({ status: 'complete', folders: [folder] }),
    collectFolder: async () => ({ status: 'complete', messages: [message] }),
    close: async () => undefined,
    ...overrides,
  };
}

it('finishes complete only after discovery and every selected folder complete', async () => {
  const target = hub();
  expect(
    await syncBrowser(target, browser(), () => '2026-11-13T19:00:00.000Z'),
  ).toEqual({ outcome: 'complete', folders: 1, complete: 1 });
  expect(target.discovery).toHaveBeenCalledWith(
    expect.any(String),
    'complete',
    '2026-11-13T19:00:00.000Z',
    [folder],
  );
  expect(target.folder).toHaveBeenCalledWith(
    expect.any(String),
    '11111111-1111-4111-8111-111111111111',
    'complete',
    '2026-11-13T19:00:00.000Z',
    [message],
  );
  expect(target.finish).toHaveBeenLastCalledWith(
    expect.any(String),
    'complete',
    undefined,
  );
});

it('reports partial for a partial folder, uncertain discovery or no selected folder', async () => {
  const target = hub();
  const result = await syncBrowser(
    target,
    browser({
      collectFolder: async () => ({ status: 'partial', messages: [message] }),
    }),
  );
  expect(result.outcome).toBe('partial');
  expect(target.finish).toHaveBeenLastCalledWith(
    expect.any(String),
    'partial',
    'traversal-failed',
  );

  const partialDiscovery = hub();
  expect(
    (
      await syncBrowser(
        partialDiscovery,
        browser({
          discover: async () => ({ status: 'partial', folders: [folder] }),
        }),
      )
    ).outcome,
  ).toBe('partial');

  const noSelection = hub(false);
  expect((await syncBrowser(noSelection, browser())).outcome).toBe('partial');
});

it('turns sign-in, MFA and foreign-origin states into bounded failed receipts', async () => {
  for (const code of [
    'sign-in-required',
    'mfa-required',
    'foreign-origin',
  ] as const) {
    const target = hub();
    await expect(
      syncBrowser(
        target,
        browser({
          discover: async () => {
            throw new CollectionError(code);
          },
        }),
      ),
    ).rejects.toMatchObject({ code });
    expect(target.finish).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      code,
    );
  }
});

it('records browser launch failure after attempt admission and before any DOM work', async () => {
  const target = hub();
  await expect(
    syncWithBrowserFactory(target, async () => {
      throw new CollectionError('browser-unavailable');
    }),
  ).rejects.toMatchObject({ code: 'browser-unavailable' });
  expect(target.begin).toHaveBeenCalledTimes(1);
  expect(target.finish).toHaveBeenCalledWith(
    expect.any(String),
    'failed',
    'browser-unavailable',
  );
});
