import { expect, it } from 'vitest';
import {
  canonicalMessageLinks,
  classifyOutlookPage,
  CollectionError,
  isMailRoute,
  nextSettleState,
  normalizeFolders,
  normalizeMessages,
  uncertainFolderList,
} from '../src/extract.js';
import type {
  MessageDetail,
  MessageRow,
  OutlookOrigin,
} from '../src/extract.js';
import { folderRows, listRows, readingPanes } from './fixtures.js';

const origin: OutlookOrigin = 'https://outlook.office.com';

function detailFor(row: MessageRow): MessageDetail | undefined {
  const match = /\/id\/([A-Za-z0-9_-]+)$/.exec(row.href);
  return match ? readingPanes.get(match[1]!) : undefined;
}

it('discovers only canonical same-origin folders and reserved links', () => {
  expect(normalizeFolders(origin, folderRows)).toEqual([
    {
      providerId: 'inbox',
      name: 'Inbox',
      canonicalUrl: 'https://outlook.office.com/mail/inbox',
    },
    {
      providerId: 'sentitems',
      name: 'Sent Items',
      canonicalUrl: 'https://outlook.office.com/mail/sentitems',
    },
    {
      providerId: 'syntheticFolder01',
      name: 'Course',
      canonicalUrl: 'https://outlook.office.com/mail/syntheticFolder01',
    },
  ]);
  expect(() =>
    normalizeFolders(origin, [
      { href: '/mail/inbox?view=compact', name: 'Ambiguous' },
    ]),
  ).toThrow(CollectionError);
  expect(() =>
    normalizeFolders(origin, [
      { href: '/mail/inbox', name: 'Inbox' },
      { href: '/mail/inbox', name: 'Different name' },
    ]),
  ).toThrow(CollectionError);
});

it('projects list and reading-pane fixtures into bounded plain text and de-duplicates rows', () => {
  const result = normalizeMessages(
    origin,
    'inbox',
    listRows.map((row) => ({ row, detail: detailFor(row) })),
  );
  expect(result.duplicates).toBe(1);
  expect(result.skipped).toBe(0);
  expect(result.messages).toEqual([
    {
      providerId: 'syntheticMessage0001',
      conversationId: 'syntheticConversation0001',
      canonicalUrl:
        'https://outlook.office.com/mail/inbox/id/syntheticMessage0001',
      subject: 'Synthetic welcome notice',
      senderDisplay: 'Synthetic Advisor',
      senderAddress: 'advisor@example.test',
      receivedAt: '2026-11-01T15:30:00.000Z',
      snippet: 'A short synthetic preview.',
      bodyText:
        'Hello from a synthetic message.\n\nThis body is plain text only.',
    },
    {
      providerId: 'syntheticMessage0002',
      conversationId: 'syntheticConversation0002',
      canonicalUrl:
        'https://outlook.office.com/mail/inbox/id/syntheticMessage0002',
      subject: 'Synthetic duplicate row',
      senderDisplay: 'Synthetic Advisor',
      senderAddress: 'advisor@example.test',
      receivedAt: '2026-11-02T09:00:00.000Z',
      snippet: 'Duplicate DOM row.',
      bodyText: 'Duplicate synthetic body.',
    },
  ]);
});

it('turns missing reading panes, missing senders and malformed DOM into partial observations', () => {
  const rows: MessageRow[] = [
    {
      href: '/mail/inbox/id/syntheticMissing0001',
      subject: 'Missing reading pane',
      sender: 'Synthetic Advisor',
      senderAddress: null,
      snippet: null,
      receivedAt: null,
      conversationId: null,
    },
    {
      href: '/mail/inbox/id/syntheticMissing0002',
      subject: 'Missing sender',
      sender: null,
      senderAddress: null,
      snippet: null,
      receivedAt: null,
      conversationId: null,
    },
    {
      href: '/mail/inbox/id/syntheticBroken0003?view=1',
      subject: 'Decorated URL',
      sender: 'Synthetic Advisor',
      senderAddress: null,
      snippet: null,
      receivedAt: null,
      conversationId: null,
    },
    {
      href: '/mail/other/id/syntheticWrongFolder04',
      subject: 'Wrong folder',
      sender: 'Synthetic Advisor',
      senderAddress: null,
      snippet: null,
      receivedAt: null,
      conversationId: null,
    },
  ];
  const missingPane = normalizeMessages(origin, 'inbox', [
    { row: rows[0]!, detail: undefined },
  ]);
  expect(missingPane.messages).toEqual([]);
  expect(missingPane.skipped).toBe(1);

  const missingSender = normalizeMessages(origin, 'inbox', [
    {
      row: rows[1]!,
      detail: {
        subject: 'Missing sender',
        sender: null,
        senderAddress: null,
        receivedAt: null,
        bodyText: 'Body',
        conversationId: null,
      },
    },
  ]);
  expect(missingSender.skipped).toBe(1);

  const decorated = normalizeMessages(origin, 'inbox', [
    {
      row: rows[2]!,
      detail: {
        subject: 'Decorated URL',
        sender: 'Synthetic Advisor',
        senderAddress: null,
        receivedAt: null,
        bodyText: 'Body',
        conversationId: null,
      },
    },
  ]);
  expect(decorated.skipped).toBe(1);

  expect(
    normalizeMessages(origin, 'inbox', [
      {
        row: rows[3]!,
        detail: {
          subject: 'Wrong folder',
          sender: 'Synthetic Advisor',
          senderAddress: null,
          receivedAt: null,
          bodyText: 'Body',
          conversationId: null,
        },
      },
    ]).skipped,
  ).toBe(1);
});

it('rejects invalid machine timestamps and oversized bodies instead of inventing fields', () => {
  const row: MessageRow = {
    href: '/mail/inbox/id/syntheticTimestamp01',
    subject: 'Synthetic',
    sender: 'Synthetic Advisor',
    senderAddress: null,
    snippet: null,
    receivedAt: null,
    conversationId: null,
  };
  expect(
    normalizeMessages(origin, 'inbox', [
      {
        row,
        detail: {
          subject: 'Synthetic',
          sender: 'Synthetic Advisor',
          senderAddress: null,
          receivedAt: '2026-11-01T09:00:00',
          bodyText: 'Body',
          conversationId: null,
        },
      },
    ]).skipped,
  ).toBe(1);
  expect(
    normalizeMessages(origin, 'inbox', [
      {
        row,
        detail: {
          subject: 'Synthetic',
          sender: 'Synthetic Advisor',
          senderAddress: null,
          receivedAt: null,
          bodyText: 'x'.repeat(20001),
          conversationId: null,
        },
      },
    ]).skipped,
  ).toBe(1);
});

it('builds exact canonical message coverage from list links', () => {
  expect(
    canonicalMessageLinks(origin, 'inbox', [
      '/mail/inbox/id/syntheticMessage0001',
      '/mail/inbox/id/syntheticMessage0001',
      'https://evil.example/mail/inbox/id/syntheticMessage0003',
    ]),
  ).toEqual(['https://outlook.office.com/mail/inbox/id/syntheticMessage0001']);
  expect(() =>
    canonicalMessageLinks(origin, 'inbox', [
      '/mail/sentitems/id/syntheticMessage0002',
    ]),
  ).toThrow(CollectionError);
  expect(() =>
    canonicalMessageLinks(origin, 'inbox', [
      '/mail/inbox/id/syntheticMessage0001?view=1',
    ]),
  ).toThrow(CollectionError);
});

it('classifies sign-in, MFA-adjacent login hosts and foreign navigation', () => {
  expect(classifyOutlookPage(origin, `${origin}/mail/inbox`)).toEqual({
    kind: 'outlook',
    pathname: '/mail/inbox',
  });
  expect(
    classifyOutlookPage(origin, 'https://login.microsoftonline.com/common'),
  ).toEqual({ kind: 'sign-in' });
  expect(
    classifyOutlookPage(origin, 'https://evil.example/mail/inbox'),
  ).toEqual({ kind: 'foreign' });
  expect(classifyOutlookPage(origin, 'about:blank')).toEqual({
    kind: 'blank',
  });
});

it('waits out delayed loading and never treats an early empty list as stable', () => {
  let previous = -1;
  let stable = 0;
  const decisions: boolean[] = [];
  for (const sample of [
    ...Array.from({ length: 8 }, () => ({ count: 0, loading: true })),
    ...Array.from({ length: 25 }, () => ({ count: 3, loading: false })),
  ]) {
    const next = nextSettleState({
      ...sample,
      previous,
      stablePasses: stable,
    });
    stable = next.stablePasses;
    previous = sample.count;
    decisions.push(next.done);
  }
  expect(decisions.slice(0, 8).every((done) => !done)).toBe(true);
  expect(decisions[28]).toBe(true);
});

it('marks active search, filters, loading and pagination as uncertain', () => {
  expect(
    uncertainFolderList({
      activeSearch: false,
      activeFilter: false,
      loading: false,
      pagination: false,
    }),
  ).toBe(false);
  expect(
    uncertainFolderList({
      activeSearch: true,
      activeFilter: false,
      loading: false,
      pagination: false,
    }),
  ).toBe(true);
  expect(
    uncertainFolderList({
      activeSearch: false,
      activeFilter: false,
      loading: true,
      pagination: false,
    }),
  ).toBe(true);
  expect(
    uncertainFolderList({
      activeSearch: false,
      activeFilter: false,
      loading: false,
      pagination: true,
    }),
  ).toBe(true);
});

it('rejects non-HTTPS or userinfo sign-in hosts and only accepts exact Outlook origins', () => {
  expect(
    classifyOutlookPage(origin, 'http://login.microsoftonline.com/common'),
  ).toEqual({ kind: 'foreign' });
  expect(
    classifyOutlookPage(
      origin,
      'https://user:secret@login.microsoftonline.com/common',
    ),
  ).toEqual({ kind: 'foreign' });
  expect(
    classifyOutlookPage(origin, 'https://login.microsoftonline.com/common'),
  ).toEqual({ kind: 'sign-in' });
});

it('strips query/hash from sender mailto addresses and requires body text proof', () => {
  const row: MessageRow = {
    href: '/mail/inbox/id/syntheticAddress001',
    subject: 'Synthetic subject',
    sender: 'Synthetic Advisor',
    senderAddress: null,
    snippet: null,
    receivedAt: null,
    conversationId: null,
  };
  const withQuery = normalizeMessages(origin, 'inbox', [
    {
      row,
      detail: {
        subject: 'Synthetic subject',
        sender: 'Synthetic Advisor',
        senderAddress: 'mailto:advisor@example.test?subject=ignored#fragment',
        receivedAt: null,
        bodyText: 'Synthetic body.',
        conversationId: null,
      },
    },
  ]);
  expect(withQuery.messages[0]?.senderAddress).toBe('advisor@example.test');
  expect(
    normalizeMessages(origin, 'inbox', [
      {
        row,
        detail: {
          subject: 'Synthetic subject',
          sender: 'Synthetic Advisor',
          senderAddress: null,
          receivedAt: null,
          bodyText: '',
          conversationId: null,
        },
      },
    ]).skipped,
  ).toBe(1);
  expect(
    normalizeMessages(origin, 'inbox', [
      {
        row,
        detail: {
          subject: 'Synthetic subject',
          sender: 'Synthetic Advisor',
          senderAddress: null,
          receivedAt: null,
          bodyText: '',
          bodyProvenEmpty: true,
          conversationId: null,
        },
      },
    ]).messages,
  ).toHaveLength(1);
});

it('requires the Outlook mail route for discovery and rejects other same-origin pages', () => {
  expect(isMailRoute('/mail')).toBe(true);
  expect(isMailRoute('/mail/')).toBe(true);
  expect(isMailRoute('/mail/inbox')).toBe(true);
  expect(isMailRoute('/owa/')).toBe(false);
  expect(isMailRoute('/calendar')).toBe(false);
});
