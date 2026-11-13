import type { BrowserContext, Page, Response } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { OutlookBrowserConnectorConfig } from './config.js';
import {
  canonicalMessageLinks,
  classifyOutlookPage,
  CollectionError,
  nextSettleState,
  normalizeFolders,
  normalizeMessages,
  uncertainFolderList,
} from './extract.js';
import type {
  Folder,
  Message,
  MessageDetail,
  MessageRow,
  OutlookOrigin,
} from './extract.js';
import { ensureDedicatedProfile } from './profile.js';

const maxRows = 200;
const loadingSelector =
  '[aria-busy="true"], [role="progressbar"], .loading, .spinner, [data-testid*="loading" i]';
const folderLinkSelector =
  '[data-app-section="folder-list"] a[href*="/mail/"], [role="treeitem"] a[href*="/mail/"], nav[aria-label*="folder" i] a[href*="/mail/"], [role="navigation"] a[href*="/mail/"]';
const messageRowSelector =
  '[data-testid="message-list"] [role="option"], [data-app-section="message-list"] [role="option"], [role="listbox"] [role="option"]';
const messageLinkSelector = `${messageRowSelector} a[href*="/id/"]`;

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

async function mfaVisible(page: Page) {
  return (
    (await page
      .locator(
        '#idDiv_SAOTCC_Description, #idTxtBx_SAOTCC_OTC, [data-testid="proofList"], [data-testid="mfa"], [data-testid="codeVerification"]',
      )
      .count()) > 0
  );
}

function sameOriginSignIn(pathname: string) {
  return /^\/(?:owa\/auth|auth|login|logout|common)(?:\/|$)/i.test(pathname);
}

/**
 * Waits for the owner to finish normal interactive sign-in or MFA in the
 * dedicated headful profile. It never reads or retains credentials or page
 * text. A foreign origin fails closed immediately.
 */
async function waitForInteractiveSignIn(
  page: Page,
  config: OutlookBrowserConnectorConfig,
) {
  const origin = config.outlookOrigin as OutlookOrigin;
  let current = classifyOutlookPage(origin, page.url());
  if (current.kind === 'outlook' && !sameOriginSignIn(current.pathname)) return;
  if (current.kind === 'blank') return;
  if (current.kind === 'foreign') throw new CollectionError('foreign-origin');

  let sawMfa = false;
  const deadline = Date.now() + config.signInWaitSeconds * 1000;
  while (Date.now() < deadline) {
    if (await mfaVisible(page)) sawMfa = true;
    await delay(2000);
    current = classifyOutlookPage(origin, page.url());
    if (current.kind === 'outlook' && !sameOriginSignIn(current.pathname))
      return;
    if (current.kind === 'foreign') throw new CollectionError('foreign-origin');
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
      href: (anchor as HTMLAnchorElement).href,
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

async function messageRows(page: Page) {
  return page.locator(messageRowSelector).evaluateAll((nodes) => {
    const text = (node: Element, selector: string) =>
      node.querySelector(selector)?.textContent?.trim() ?? null;
    const attr = (node: Element, selector: string, name: string) =>
      node.querySelector(selector)?.getAttribute(name) ?? null;
    return nodes.map((node) => {
      const anchor = node.querySelector<HTMLAnchorElement>('a[href*="/id/"]');
      const time = node.querySelector<HTMLElement>('time[datetime]');
      return {
        href: anchor?.href ?? '',
        subject: text(
          node,
          '[data-testid="message-subject"], [data-conversation-subject], [class*="subject" i]',
        ),
        sender: text(
          node,
          '[data-testid="message-sender"], [class*="sender" i]',
        ),
        senderAddress: attr(
          node,
          'a[href^="mailto:"], [data-email-address]',
          'href',
        ),
        snippet: text(
          node,
          '[data-testid="message-preview"], [data-testid="message-snippet"], [class*="preview" i]',
        ),
        receivedAt: time?.getAttribute('datetime') ?? null,
        conversationId:
          node.getAttribute('data-conversation-id') ??
          node.getAttribute('data-conversationid') ??
          null,
      };
    });
  });
}

async function readingPane(page: Page): Promise<MessageDetail | null> {
  const pane = page.locator(
    '[data-testid="message-body"], [role="document"], [aria-label*="Message body" i]',
  );
  try {
    await pane.first().waitFor({ state: 'attached', timeout: 15000 });
  } catch {
    return null;
  }
  return page.evaluate(() => {
    const text = (selector: string) =>
      document.querySelector(selector)?.textContent?.trim() ?? null;
    const attr = (selector: string, name: string) =>
      document.querySelector(selector)?.getAttribute(name) ?? null;
    const body = document.querySelector<HTMLElement>(
      '[data-testid="message-body"], [role="document"], [aria-label*="Message body" i]',
    );
    const link = document.querySelector<HTMLAnchorElement>(
      '[data-testid="message-sender"] a[href^="mailto:"], [data-testid="sender"] a[href^="mailto:"], a[href^="mailto:"]',
    );
    return {
      subject: text(
        '[data-testid="message-subject"], [role="main"] h1, h1[role="heading"], [role="heading"][aria-level="1"]',
      ),
      sender: text(
        '[data-testid="message-sender"], [data-testid="sender"], [class*="sender" i]',
      ),
      senderAddress: link?.getAttribute('href') ?? null,
      receivedAt: attr('time[datetime]', 'datetime'),
      bodyText: body ? body.innerText : null,
      conversationId:
        attr('[data-conversation-id]', 'data-conversation-id') ??
        attr('[data-conversationid]', 'data-conversationid'),
    };
  });
}

async function detailFor(
  page: Page,
  config: OutlookBrowserConnectorConfig,
  href: string,
): Promise<MessageDetail | null> {
  let url: URL;
  try {
    url = new URL(href, `${config.outlookOrigin}/`);
  } catch {
    return null;
  }
  if (url.origin !== config.outlookOrigin) return null;
  const response = await openPage(page, config, `${url.origin}${url.pathname}`);
  if (!requireOutlookPath(page, config, url.pathname)) return null;
  if (statusKind(response) !== 'ok') return null;
  return readingPane(page);
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
  return {
    discover: async () => {
      const response = await openPage(page, config, `${origin}/mail/`);
      if (!requireOutlookPath(page, config, null))
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
        return { status: 'partial', folders: [] };
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
          .locator(messageRowSelector)
          .first()
          .waitFor({ state: 'attached', timeout: 15000 });
      } catch {
        return { status: 'partial', messages: [] };
      }
      await settle(page, messageRowSelector);
      const rows = (await messageRows(page)).filter((row) => row.href);
      if (rows.length > maxRows) throw new CollectionError('traversal-limit');
      const links = canonicalMessageLinks(
        origin,
        folder.providerId,
        await page
          .locator(messageLinkSelector)
          .evaluateAll((anchors) =>
            anchors.map((anchor) => (anchor as HTMLAnchorElement).href),
          ),
      );
      const uncertain = await listUncertain(page);
      const entries: { row: MessageRow; detail: MessageDetail | undefined }[] =
        [];
      for (const row of rows) {
        let detail: MessageDetail | null = null;
        try {
          detail = await detailFor(page, config, row.href);
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
          row: { ...row, senderAddress: row.senderAddress },
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
      return {
        status:
          rows.length === 0 ||
          rows.length >= maxRows ||
          normalized.skipped > 0 ||
          !exactCoverage ||
          uncertain
            ? 'partial'
            : 'complete',
        messages: normalized.messages,
      };
    },
    close: () => context.close(),
  };
}
