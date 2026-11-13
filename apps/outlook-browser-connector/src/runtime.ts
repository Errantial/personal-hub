import type { BrowserContext, Locator, Page, Response } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { OutlookBrowserConnectorConfig } from './config.js';
import {
  assessMessageList,
  canonicalMessageLinks,
  classifyOutlookPage,
  CollectionError,
  nextSettleState,
  isMailRoute,
  normalizeFolders,
  normalizeMessages,
  outlookMessageIdentity,
  uncertainFolderList,
} from './extract.js';
import type {
  Folder,
  Message,
  MessageDetail,
  MessageRow,
  OutlookOrigin,
} from './extract.js';
import {
  detectAuthState,
  domSelectors,
  readMessageList,
  readReadingPane,
  scrollMessageList,
} from './dom.js';
import type { MessageListSnapshot, MessageRowSnapshot } from './dom.js';
import { ensureDedicatedProfile } from './profile.js';

const maxRows = 200;
const maxSweepPasses = 14;
const loadingSelector = domSelectors.loading;
const folderLinkSelector = domSelectors.folderLinks;
const readingPaneSelector = domSelectors.readingPanes;

export type Discovery = { status: 'complete' | 'partial'; folders: Folder[] };
export type FolderObservation = {
  status: 'complete' | 'partial' | 'inaccessible';
  messages: Message[];
};

export type BrowserCollector = {
  discover: () => Promise<Discovery>;
  collectFolder: (folder: {
    providerId: string;
    canonicalUrl: string;
  }) => Promise<FolderObservation>;
  close: () => Promise<void>;
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const listExpression = `(${readMessageList.toString()})(document, ${JSON.stringify(domSelectors)})`;
const authExpression = `(${detectAuthState.toString()})(document)`;
const scrollExpression = (position: 'top' | 'next' | 'end') =>
  `(${scrollMessageList.toString()})(document, ${JSON.stringify(domSelectors)}, ${JSON.stringify(position)})`;

const readListSnapshot = (page: Page) =>
  page.evaluate(listExpression) as Promise<MessageListSnapshot>;
const readAuthState = (page: Page) =>
  page.evaluate(authExpression) as Promise<'sign-in' | 'mfa' | null>;
const scrollList = (page: Page, position: 'top' | 'next' | 'end') =>
  page.evaluate(scrollExpression(position));

async function settle(page: Page, selector: string) {
  let previous = -1;
  let stable = 0;
  for (let pass = 0; pass < 60; pass++) {
    const count = await page.locator(selector).count();
    const loading = await page.locator(loadingSelector).count();
    if (count > 0)
      await page
        .locator(selector)
        .last()
        .scrollIntoViewIfNeeded()
        .catch(() => undefined);
    const next = nextSettleState({
      count,
      loading: loading > 0,
      previous,
      stablePasses: stable,
    });
    stable = next.stablePasses;
    if (next.done) {
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
        return;
      } catch {
        throw new CollectionError('traversal-failed');
      }
    }
    previous = count;
    await page.waitForTimeout(500);
  }
  throw new CollectionError('traversal-failed');
}

async function settleMessageList(page: Page) {
  let previous = -1;
  let stable = 0;
  for (let pass = 0; pass < 60; pass++) {
    const snapshot = await readListSnapshot(page);
    if (snapshot.options > 0)
      await page
        .locator(domSelectors.list)
        .first()
        .locator('[role="option"]')
        .last()
        .scrollIntoViewIfNeeded()
        .catch(() => undefined);
    const next = nextSettleState({
      count: snapshot.options,
      loading: snapshot.loading,
      previous,
      stablePasses: stable,
    });
    stable = next.stablePasses;
    if (next.done) return;
    previous = snapshot.options;
    await page.waitForTimeout(500);
  }
  throw new CollectionError('traversal-failed');
}

function sameOriginSignIn(pathname: string) {
  return /^\/(?:owa\/auth|auth|login|logout|common)(?:\/|$)/i.test(pathname);
}

/**
 * Waits for the owner to finish normal interactive sign-in or MFA in the
 * dedicated headful profile. It never reads or retains credentials or page
 * text. A foreign origin fails closed immediately. An auth overlay on an
 * Outlook page is also detected instead of being projected as mail.
 */
async function waitForInteractiveSignIn(
  page: Page,
  config: OutlookBrowserConnectorConfig,
) {
  const origin = config.outlookOrigin as OutlookOrigin;
  let current = classifyOutlookPage(origin, page.url());
  if (current.kind === 'blank') return;
  if (current.kind === 'foreign') throw new CollectionError('foreign-origin');
  let auth = await readAuthState(page).catch(
    () => null as 'sign-in' | 'mfa' | null,
  );
  if (
    current.kind === 'outlook' &&
    !sameOriginSignIn(current.pathname) &&
    !auth
  )
    return;

  let sawMfa = auth === 'mfa';
  const deadline = Date.now() + config.signInWaitSeconds * 1000;
  while (Date.now() < deadline) {
    await delay(2000);
    current = classifyOutlookPage(origin, page.url());
    if (current.kind === 'foreign') throw new CollectionError('foreign-origin');
    auth = await readAuthState(page).catch(
      () => null as 'sign-in' | 'mfa' | null,
    );
    if (auth === 'mfa') sawMfa = true;
    if (
      current.kind === 'outlook' &&
      !sameOriginSignIn(current.pathname) &&
      !auth
    )
      return;
  }
  throw new CollectionError(sawMfa ? 'mfa-required' : 'sign-in-required');
}

async function openPage(
  page: Page,
  config: OutlookBrowserConnectorConfig,
  url: string,
) {
  let response: Response | null;
  try {
    response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  } catch {
    throw new CollectionError('outlook-unavailable');
  }
  await waitForInteractiveSignIn(page, config);
  return response;
}

function currentPath(page: Page, config: OutlookBrowserConnectorConfig) {
  const current = classifyOutlookPage(
    config.outlookOrigin as OutlookOrigin,
    page.url(),
  );
  return current.kind === 'outlook' ? current.pathname : null;
}

function requireOutlookPath(
  page: Page,
  config: OutlookBrowserConnectorConfig,
  expectedPath: string | null,
) {
  const current = classifyOutlookPage(
    config.outlookOrigin as OutlookOrigin,
    page.url(),
  );
  if (current.kind === 'sign-in') throw new CollectionError('sign-in-required');
  if (current.kind !== 'outlook') throw new CollectionError('foreign-origin');
  if (expectedPath) {
    const path = current.pathname.replace(/\/+$/, '');
    const expected = expectedPath.replace(/\/+$/, '');
    if (path !== expected) return false;
  }
  return true;
}

function statusKind(response: Response | null) {
  if (!response) return 'ok';
  if (response.status() === 401) return 'sign-in';
  if ([403, 404].includes(response.status())) return 'inaccessible';
  if (response.status() >= 400) return 'partial';
  return 'ok';
}

async function folderRows(page: Page) {
  return page.locator(folderLinkSelector).evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: anchor.getAttribute('href') ?? '',
      name: (anchor.textContent ?? '').trim(),
    })),
  );
}

async function listUncertain(page: Page) {
  const activeSearch = await page
    .locator(
      'input[type="search"], input[name*="search" i], input[id*="search" i], [role="searchbox"]',
    )
    .evaluateAll((inputs) =>
      inputs.some(
        (input) => (input as HTMLInputElement).value?.trim().length > 0,
      ),
    );
  const activeFilter = await page
    .locator(
      '[role="listbox"] [aria-pressed="true"], [data-testid="message-list"] [aria-pressed="true"]',
    )
    .count();
  const pagination = await page
    .locator(
      '[data-testid="message-list"] a[rel="next"], [data-testid="pagination-next"]',
    )
    .count();
  const loading = await page.locator(loadingSelector).count();
  return uncertainFolderList({
    activeSearch,
    activeFilter: activeFilter > 0,
    loading: loading > 0,
    pagination: pagination > 0,
  });
}

function rowKey(origin: OutlookOrigin, href: string) {
  try {
    const url = new URL(href, `${origin}/`);
    if (url.origin === origin) return `${url.origin}${url.pathname}`;
  } catch {
    // Invalid rows remain unresolved/skipped below.
  }
  return href;
}

function firstText(...values: (string | null | undefined)[]) {
  for (const value of values) {
    const text = (value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function mergeRow(previous: MessageRowSnapshot, row: MessageRowSnapshot) {
  return {
    href: firstText(previous.href, row.href),
    subject: firstText(previous.subject, row.subject) || null,
    sender: firstText(previous.sender, row.sender) || null,
    senderAddress: firstText(previous.senderAddress, row.senderAddress) || null,
    snippet: firstText(previous.snippet, row.snippet) || null,
    receivedAt: firstText(previous.receivedAt, row.receivedAt) || null,
    conversationId:
      firstText(previous.conversationId, row.conversationId) || null,
    ariaPosition: firstText(previous.ariaPosition, row.ariaPosition) || null,
    ariaSetSize: firstText(previous.ariaSetSize, row.ariaSetSize) || null,
    rowIndex: firstText(previous.rowIndex, row.rowIndex) || null,
  };
}

export type SweepResult = {
  rows: Map<string, MessageRowSnapshot>;
  unresolved: number;
  loadMore: boolean;
  next: boolean;
  collapsed: boolean;
  totalCount: number | null;
  setSize: number | null;
  recycledIndexes: boolean;
  reachedBottom: boolean;
  scrollable: boolean;
  maxOptions: number;
};

function atBottom(snapshot: MessageListSnapshot) {
  return (
    !snapshot.scrollable ||
    snapshot.scrollTop + snapshot.clientHeight >= snapshot.scrollHeight - 4
  );
}

function mergeSnapshot(
  result: SweepResult,
  snapshot: MessageListSnapshot,
  origin: OutlookOrigin,
  indexMap: Map<string, string>,
) {
  result.unresolved = Math.max(result.unresolved, snapshot.unresolved);
  result.maxOptions = Math.max(result.maxOptions, snapshot.options);
  result.loadMore ||= snapshot.loadMore;
  result.next ||= snapshot.next;
  result.collapsed ||= snapshot.collapsed;
  result.scrollable ||= snapshot.scrollable;
  if (snapshot.totalCount !== null)
    result.totalCount = Math.max(result.totalCount ?? 0, snapshot.totalCount);
  if (snapshot.setSize !== null)
    result.setSize = Math.max(result.setSize ?? 0, snapshot.setSize);
  for (const row of snapshot.rows) {
    if (!row.href) continue;
    const key = rowKey(origin, row.href);
    if (row.rowIndex) {
      const previous = indexMap.get(row.rowIndex);
      if (previous && previous !== key) result.recycledIndexes = true;
      else indexMap.set(row.rowIndex, key);
    }
    const existing = result.rows.get(key);
    result.rows.set(key, existing ? mergeRow(existing, row) : row);
  }
  return atBottom(snapshot);
}

async function sweepOnce(page: Page, origin: OutlookOrigin) {
  const result: SweepResult = {
    rows: new Map(),
    unresolved: 0,
    loadMore: false,
    next: false,
    collapsed: false,
    totalCount: null,
    setSize: null,
    recycledIndexes: false,
    reachedBottom: false,
    scrollable: false,
    maxOptions: 0,
  };
  const indexMap = new Map<string, string>();
  await scrollList(page, 'top');
  for (let pass = 0; pass < maxSweepPasses; pass++) {
    const snapshot = await readListSnapshot(page);
    const bottom = mergeSnapshot(result, snapshot, origin, indexMap);
    if (bottom) {
      result.reachedBottom = true;
      break;
    }
    if (pass === maxSweepPasses - 1) break;
    const before = snapshot.scrollTop;
    await scrollList(page, 'next');
    await page.waitForTimeout(250);
    const after = await readListSnapshot(page);
    if (mergeSnapshot(result, after, origin, indexMap)) {
      result.reachedBottom = true;
      break;
    }
    if (after.scrollTop === before && !atBottom(after)) break;
  }
  return result;
}

function sameKeys(left: Map<string, unknown>, right: Map<string, unknown>) {
  if (left.size !== right.size) return false;
  for (const key of left.keys()) if (!right.has(key)) return false;
  return true;
}

export function mergeSweeps(
  first: SweepResult,
  second: SweepResult,
): SweepResult {
  const merged: SweepResult = {
    ...first,
    rows: new Map(first.rows),
    unresolved: Math.max(first.unresolved, second.unresolved),
    loadMore: first.loadMore || second.loadMore,
    next: first.next || second.next,
    collapsed: first.collapsed || second.collapsed,
    recycledIndexes: first.recycledIndexes || second.recycledIndexes,
    reachedBottom: first.reachedBottom && second.reachedBottom,
    scrollable: first.scrollable || second.scrollable,
    maxOptions: Math.max(first.maxOptions, second.maxOptions),
  };
  for (const [key, row] of second.rows) {
    const previous = merged.rows.get(key);
    merged.rows.set(key, previous ? mergeRow(previous, row) : row);
  }
  if (second.totalCount !== null)
    merged.totalCount = Math.max(merged.totalCount ?? 0, second.totalCount);
  if (second.setSize !== null)
    merged.setSize = Math.max(merged.setSize ?? 0, second.setSize);
  return merged;
}

async function readingPane(
  page: Page,
  config: OutlookBrowserConnectorConfig,
  expected: {
    providerId: string;
    folderProviderId: string;
    subject?: string | null;
    sender?: string | null;
    conversationId?: string | null;
  },
) {
  const panes = page.locator(readingPaneSelector);
  const count = await panes.count();
  let pane: Locator | null = null;
  let visible = 0;
  for (let index = 0; index < count; index++) {
    const candidate = panes.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      visible++;
      pane = candidate;
    }
  }
  if (visible === 0) {
    const first = panes.first();
    await first.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
    for (let index = 0; index < (await panes.count()); index++) {
      const candidate = panes.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        visible++;
        pane = candidate;
      }
    }
  }
  if (visible !== 1 || !pane) return null;
  let lastFingerprint = '';
  let stable = 0;
  for (let pass = 0; pass < 12; pass++) {
    let current: ReturnType<typeof outlookMessageIdentity>;
    try {
      current = outlookMessageIdentity(config.outlookOrigin, page.url());
    } catch {
      return null;
    }
    if (
      !current ||
      current.providerId !== expected.providerId ||
      (current.folderProviderId !== null &&
        current.folderProviderId !== expected.folderProviderId)
    )
      return null;
    const result = await pane.evaluate(readReadingPane, {
      expected,
      selectors: domSelectors,
    });
    if (result.status === 'mismatch' || result.status === 'ambiguous')
      return null;
    if (result.status === 'ok') {
      if (result.fingerprint === lastFingerprint) stable++;
      else {
        stable = 0;
        lastFingerprint = result.fingerprint;
      }
      if (stable >= 2) return result.detail;
    } else {
      stable = 0;
      lastFingerprint = '';
    }
    await delay(250);
  }
  return null;
}

async function detailFor(
  page: Page,
  config: OutlookBrowserConnectorConfig,
  folderProviderId: string,
  row: MessageRow,
): Promise<MessageDetail | null> {
  let requested: ReturnType<typeof outlookMessageIdentity>;
  try {
    requested = outlookMessageIdentity(config.outlookOrigin, row.href);
  } catch {
    return null;
  }
  if (
    !requested ||
    (requested.folderProviderId !== null &&
      requested.folderProviderId !== folderProviderId)
  )
    return null;
  const response = await openPage(
    page,
    config,
    `${config.outlookOrigin}${new URL(requested.canonicalUrl).pathname}`,
  );
  if (!requireOutlookPath(page, config, null)) return null;
  let identity: ReturnType<typeof outlookMessageIdentity>;
  try {
    identity = outlookMessageIdentity(config.outlookOrigin, page.url());
  } catch {
    return null;
  }
  if (
    !identity ||
    identity.providerId !== requested.providerId ||
    (identity.folderProviderId !== null &&
      identity.folderProviderId !== folderProviderId)
  )
    return null;
  if (statusKind(response) !== 'ok') return null;
  return readingPane(page, config, {
    providerId: requested.providerId,
    folderProviderId,
    subject: row.subject,
    sender: row.sender,
    conversationId: row.conversationId,
  });
}

export async function openBrowserCollector(
  config: OutlookBrowserConnectorConfig,
): Promise<BrowserCollector> {
  const origin = config.outlookOrigin as OutlookOrigin;
  try {
    await ensureDedicatedProfile(config.profilePath);
  } catch {
    throw new CollectionError('browser-unavailable');
  }
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.profilePath, {
      channel: config.browserChannel,
      headless: false,
    });
  } catch {
    throw new CollectionError('browser-unavailable');
  }
  const page = context.pages()[0] ?? (await context.newPage());
  // tsx/esbuild keepNames can inject a __name helper into serialized function
  // sources. The compiled sync path does not need it, but a user invoking the
  // source loader must not fail in the browser scope. This must run on every
  // document because navigation replaces the page global.
  await page.addInitScript(
    'globalThis.__name = globalThis.__name || ((target) => target)',
  );
  return {
    discover: async () => {
      const response = await openPage(page, config, `${origin}/mail/`);
      const path = currentPath(page, config);
      if (!path || !isMailRoute(path))
        throw new CollectionError('outlook-unavailable');
      const status = statusKind(response);
      if (status === 'sign-in') throw new CollectionError('sign-in-required');
      if (status === 'inaccessible')
        throw new CollectionError('outlook-unavailable');
      try {
        await page
          .locator(folderLinkSelector)
          .first()
          .waitFor({ state: 'attached', timeout: 15000 });
      } catch {
        throw new CollectionError('traversal-failed');
      }
      await settle(page, folderLinkSelector);
      const folders = normalizeFolders(origin, await folderRows(page));
      const uncertain = await listUncertain(page);
      return {
        status:
          folders.length === 0 ||
          folders.length >= 200 ||
          uncertain ||
          status === 'partial'
            ? 'partial'
            : 'complete',
        folders,
      };
    },
    collectFolder: async (folder) => {
      const expectedPath = `/mail/${folder.providerId}`;
      const response = await openPage(page, config, `${origin}${expectedPath}`);
      if (!requireOutlookPath(page, config, expectedPath))
        return { status: 'inaccessible', messages: [] };
      const status = statusKind(response);
      if (status === 'sign-in') throw new CollectionError('sign-in-required');
      if (status === 'inaccessible')
        return { status: 'inaccessible', messages: [] };
      if (status === 'partial') return { status: 'partial', messages: [] };
      try {
        await page
          .locator(domSelectors.list)
          .first()
          .locator('[role="option"]')
          .first()
          .waitFor({ state: 'attached', timeout: 15000 });
      } catch {
        return { status: 'partial', messages: [] };
      }
      await settleMessageList(page);
      const before = await readListSnapshot(page);
      if (before.options === 0) return { status: 'partial', messages: [] };

      const firstSweep = await sweepOnce(page, origin);
      const secondSweep = await sweepOnce(page, origin);
      const merged = mergeSweeps(firstSweep, secondSweep);
      const pathAfter = currentPath(page, config);
      if (
        !pathAfter ||
        pathAfter.replace(/\/+$/, '') !== expectedPath.replace(/\/+$/, '')
      )
        return { status: 'inaccessible', messages: [] };

      const rows = [...merged.rows.values()].filter((row) => row.href);
      let links: string[];
      try {
        links = canonicalMessageLinks(
          origin,
          folder.providerId,
          rows.map((row) => row.href),
        );
      } catch {
        return { status: 'partial', messages: [] };
      }
      const boundedRows = rows.slice(0, maxRows);
      const entries: { row: MessageRow; detail: MessageDetail | undefined }[] =
        [];
      for (const row of boundedRows) {
        let detail: MessageDetail | null = null;
        try {
          detail = await detailFor(
            page,
            config,
            folder.providerId,
            row as MessageRow,
          );
        } catch (error) {
          if (
            error instanceof CollectionError &&
            ['sign-in-required', 'mfa-required', 'foreign-origin'].includes(
              error.code,
            )
          )
            throw error;
        }
        entries.push({
          row: row as MessageRow,
          detail: detail ?? undefined,
        });
      }
      const normalized = normalizeMessages(origin, folder.providerId, entries);
      const messageLinks = new Set(
        normalized.messages.map((message) => message.canonicalUrl),
      );
      const exactCoverage =
        links.length === messageLinks.size &&
        links.every((link) => messageLinks.has(link));
      const assessment = assessMessageList({
        identities: merged.rows.size,
        renderedOptions: merged.maxOptions,
        unresolved: merged.unresolved,
        loadMore: merged.loadMore,
        next: merged.next,
        collapsed: merged.collapsed,
        totalCount: merged.totalCount,
        setSize: merged.setSize,
        scrollable: merged.scrollable,
        reachedBottom: merged.reachedBottom,
        stable:
          firstSweep.reachedBottom &&
          secondSweep.reachedBottom &&
          sameKeys(firstSweep.rows, secondSweep.rows),
        recycledIndexes: merged.recycledIndexes,
      });
      return {
        status:
          assessment.complete &&
          normalized.skipped === 0 &&
          exactCoverage &&
          !merged.loadMore &&
          !merged.next &&
          !merged.collapsed
            ? 'complete'
            : 'partial',
        messages: normalized.messages,
      };
    },
    close: () => context.close(),
  };
}
