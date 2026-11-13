import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { expect, it } from 'vitest';
import { assessMessageList, normalizeMessages } from '../src/extract.js';
import type { MessageDetail, OutlookOrigin } from '../src/extract.js';
import {
  detectAuthState,
  domSelectors,
  readMessageList,
  readReadingPane,
} from '../src/dom.js';

const origin: OutlookOrigin = 'https://outlook.office.com';
const expected = {
  providerId: 'syntheticMessage0001',
  folderProviderId: 'inbox',
};

async function documentFor(name: string) {
  const html = await readFile(
    new URL(`./fixtures/outlook-web/${name}`, import.meta.url),
    'utf8',
  );
  return parseHTML(html).document;
}

function paneFrom(document: Document, index = 0) {
  const panes = document.querySelectorAll(domSelectors.readingPanes);
  return panes[index]!;
}

it('marks a virtualized, unlinked or load-more list as partial instead of complete', async () => {
  const document = await documentFor('virtualized-list.html');
  const snapshot = readMessageList(document, domSelectors);
  expect(snapshot.options).toBe(3);
  expect(snapshot.unresolved).toBe(1);
  expect(snapshot.loadMore).toBe(true);
  expect(snapshot.totalCount).toBe(12);
  expect(snapshot.setSize).toBe(12);
  expect(snapshot.rows[0]?.senderAddress).toBe('advisor@example.test');
  const assessment = assessMessageList({
    identities: snapshot.rows.filter((row) => row.href).length,
    renderedOptions: 2,
    unresolved: snapshot.unresolved,
    loadMore: snapshot.loadMore,
    next: snapshot.next,
    collapsed: snapshot.collapsed,
    totalCount: snapshot.totalCount,
    setSize: snapshot.setSize,
    scrollable: false,
    reachedBottom: true,
    stable: true,
    recycledIndexes: true,
  });
  expect(assessment.complete).toBe(false);
  expect(assessment.reasons).toEqual(
    expect.arrayContaining([
      'unresolved-rows',
      'load-more',
      'recycled-rows',
      'virtualized-window',
      'total-count-gap',
    ]),
  );
});

it('accepts a proven stable full identity window and rejects a bounded overflow', () => {
  const stable = assessMessageList({
    identities: 3,
    renderedOptions: 3,
    unresolved: 0,
    loadMore: false,
    next: false,
    collapsed: false,
    totalCount: 3,
    setSize: 3,
    scrollable: false,
    reachedBottom: true,
    stable: true,
    recycledIndexes: false,
  });
  expect(stable).toEqual({ complete: true, reasons: [] });
  expect(
    assessMessageList({
      identities: 201,
      renderedOptions: 201,
      unresolved: 0,
      loadMore: false,
      next: false,
      collapsed: false,
      totalCount: 201,
      setSize: 201,
      scrollable: true,
      reachedBottom: true,
      stable: true,
      recycledIndexes: false,
    }),
  ).toMatchObject({ complete: false, reasons: ['bounded-window'] });
});

it('keeps malformed and duplicate list rows partial without inventing identities', async () => {
  const document = await documentFor('malformed-list.html');
  const snapshot = readMessageList(document, domSelectors);
  expect(snapshot.options).toBe(4);
  expect(snapshot.unresolved).toBe(1);
  const detail: MessageDetail = {
    subject: 'Synthetic duplicate row',
    sender: 'Synthetic Advisor',
    senderAddress: null,
    receivedAt: '2026-11-01T15:30:00Z',
    bodyText: 'Synthetic body.',
    conversationId: null,
  };
  const normalized = normalizeMessages(
    origin,
    'inbox',
    snapshot.rows.map((row) => ({ row, detail })),
  );
  expect(normalized.duplicates).toBe(1);
  expect(normalized.skipped).toBe(2);
  expect(normalized.messages).toHaveLength(1);
  expect(normalized.messages[0]!.providerId).toBe('syntheticMessage0002');
});

it('projects a loaded pane only from its scoped root and prefers the sender address attribute', async () => {
  const document = await documentFor('reading-pane-loaded.html');
  expect(document.querySelectorAll(domSelectors.readingPanes)).toHaveLength(1);
  const result = readReadingPane(paneFrom(document), {
    expected,
    selectors: domSelectors,
  });
  expect(result.status).toBe('ok');
  expect(result.detail).toMatchObject({
    subject: 'Synthetic subject',
    sender: 'Synthetic Advisor',
    senderAddress: 'advisor@example.test',
    receivedAt: '2026-11-01T15:30:00Z',
    conversationId: 'syntheticConversation0001',
  });
  expect(result.detail?.bodyText).toContain('Body link must not become');
  expect(result.detail?.senderAddress).not.toContain('body-link');
});

it('distinguishes delayed, empty, proven-empty, ambiguous and stale panes', async () => {
  const loading = await documentFor('reading-pane-loading.html');
  expect(
    readReadingPane(paneFrom(loading), {
      expected,
      selectors: domSelectors,
    }).status,
  ).toBe('loading');

  const empty = await documentFor('reading-pane-empty.html');
  expect(
    readReadingPane(paneFrom(empty), {
      expected,
      selectors: domSelectors,
    }).status,
  ).toBe('empty');

  const provenEmpty = await documentFor('reading-pane-empty-marker.html');
  const proven = readReadingPane(paneFrom(provenEmpty), {
    expected,
    selectors: domSelectors,
  });
  expect(proven.status).toBe('ok');
  expect(proven.detail?.bodyText).toBe('');

  const ambiguous = await documentFor('reading-pane-ambiguous.html');
  expect(
    readReadingPane(paneFrom(ambiguous), {
      expected,
      selectors: domSelectors,
    }).status,
  ).toBe('ambiguous');
  expect(ambiguous.querySelectorAll(domSelectors.readingPanes)).toHaveLength(2);

  const stale = await documentFor('reading-pane-stale.html');
  expect(
    readReadingPane(paneFrom(stale), {
      expected,
      selectors: domSelectors,
    }).status,
  ).toBe('mismatch');
});

it('does not project a foreign-origin message link as a folder record', async () => {
  const document = await documentFor('foreign-link-list.html');
  const snapshot = readMessageList(document, domSelectors);
  expect(snapshot.rows[0]?.href).toContain('https://evil.example/');
  const normalized = normalizeMessages(origin, 'inbox', [
    {
      row: snapshot.rows[0]!,
      detail: {
        subject: 'Foreign synthetic row',
        sender: 'Synthetic Advisor',
        senderAddress: null,
        receivedAt: null,
        bodyText: 'Synthetic body.',
        conversationId: null,
      },
    },
  ]);
  expect(normalized.messages).toEqual([]);
  expect(normalized.skipped).toBe(1);
});

it('detects sign-in and MFA overlays from static DOM', async () => {
  expect(detectAuthState(await documentFor('sign-in.html'))).toBe('sign-in');
  expect(detectAuthState(await documentFor('mfa.html'))).toBe('mfa');
  expect(detectAuthState(await documentFor('reading-pane-loaded.html'))).toBe(
    null,
  );
});

it('serializes list and reading-pane projections without module closures for browser evaluation', async () => {
  const listDocument = await documentFor('virtualized-list.html');
  const serializedList = (0, eval)(
    `(${readMessageList.toString()})`,
  ) as typeof readMessageList;
  expect(serializedList(listDocument, domSelectors).options).toBe(3);

  const paneDocument = await documentFor('reading-pane-loaded.html');
  const serializedPane = (0, eval)(
    `(${readReadingPane.toString()})`,
  ) as typeof readReadingPane;
  expect(
    serializedPane(paneFrom(paneDocument), {
      expected,
      selectors: domSelectors,
    }).status,
  ).toBe('ok');
});
