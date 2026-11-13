/**
 * Self-contained DOM projections. These functions may be serialized into the
 * browser through Playwright evaluation or the bounded sweep helpers, so they
 * must not close over module constants. Selectors and expected identities are
 * passed in explicitly.
 */

export const domSelectors = {
  folderLinks:
    '[data-app-section="folder-list"] a[href*="/mail/"], [role="treeitem"] a[href*="/mail/"], nav[aria-label*="folder" i] a[href*="/mail/"], [role="navigation"] a[href*="/mail/"]',
  messageRows:
    '[data-testid="message-list"] [role="option"], [data-app-section="message-list"] [role="option"], [role="listbox"] [role="option"]',
  messageLink: 'a[href*="/id/"]',
  list: '[data-testid="message-list"], [data-app-section="message-list"], [role="listbox"]',
  subject:
    '[data-testid="message-subject"], [data-conversation-subject], [class*="subject" i]',
  sender:
    '[data-testid="message-sender"], [data-testid="sender"], [class*="sender" i]',
  snippet:
    '[data-testid="message-preview"], [data-testid="message-snippet"], [class*="preview" i]',
  count:
    '[data-testid="message-list-count"], [data-testid="total-count"], [data-testid*="count" i][aria-label], [aria-label*="total messages" i]',
  loadMore:
    'a[rel="next"], [data-testid="pagination-next"], [data-testid*="load-more" i], button[aria-label*="load more" i], a[aria-label*="load more" i], button[aria-label*="show more" i], a[aria-label*="show more" i]',
  readingPanes:
    '[data-app-section="reading-pane"], [data-testid="reading-pane"], [aria-label*="Reading pane" i], [role="main"][aria-label*="message" i]',
  body: '[data-testid="message-body"], [role="document"], [aria-label*="Message body" i]',
  emptyBody:
    '[data-testid="message-body-empty"], [data-testid="empty-message"], [data-empty="true"]',
  loading:
    '[aria-busy="true"], [role="progressbar"], .loading, .spinner, [data-testid*="loading" i]',
} as const;

export type MessageRowSnapshot = {
  href: string;
  subject: string | null;
  sender: string | null;
  senderAddress: string | null;
  snippet: string | null;
  receivedAt: string | null;
  conversationId: string | null;
  ariaPosition: string | null;
  ariaSetSize: string | null;
  rowIndex: string | null;
};

export type MessageListSnapshot = {
  rows: MessageRowSnapshot[];
  options: number;
  unresolved: number;
  loadMore: boolean;
  next: boolean;
  collapsed: boolean;
  totalCount: number | null;
  setSize: number | null;
  rowIndexes: string[];
  loading: boolean;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  scrollable: boolean;
};

export type ReadingPaneDetail = {
  subject: string | null;
  sender: string | null;
  senderAddress: string | null;
  receivedAt: string | null;
  bodyText: string;
  bodyProvenEmpty: boolean;
  conversationId: string | null;
};

export type ReadingPaneResult = {
  status: 'ok' | 'loading' | 'missing' | 'ambiguous' | 'mismatch' | 'empty';
  detail: ReadingPaneDetail | null;
  fingerprint: string;
};

export type AuthState = 'sign-in' | 'mfa' | null;

export function readMessageList(
  document: Document,
  selectors: typeof domSelectors,
): MessageListSnapshot {
  const clean = (value: string | null | undefined) =>
    (value ?? '').replace(/\s+/g, ' ').trim();
  const elementText = (element: Element | null | undefined) =>
    clean(element?.textContent);
  const first = (...values: (string | null | undefined)[]) => {
    for (const value of values) {
      const text = clean(value);
      if (text) return text;
    }
    return '';
  };
  const senderText = (node: Element | null | undefined) => {
    if (!node) return '';
    const clone = node.cloneNode(true) as Element;
    clone.querySelectorAll('a').forEach((anchor) => anchor.remove());
    return elementText(clone);
  };
  const rowNodes = [...document.querySelectorAll(selectors.messageRows)];
  const root = document.querySelector(selectors.list) ?? document;
  const rows: MessageRowSnapshot[] = rowNodes.map((node) => {
    const link = node.querySelector(selectors.messageLink);
    const emailNode = node.querySelector('[data-email-address]');
    const senderLink = node.querySelector(
      '[data-testid="message-sender"] a[href^="mailto:"], [data-testid="sender"] a[href^="mailto:"], [class*="sender" i] a[href^="mailto:"]',
    );
    const time = node.querySelector('time[datetime]');
    const senderAddress = first(
      emailNode?.getAttribute('data-email-address'),
      senderLink?.getAttribute('href'),
    );
    return {
      href: link?.getAttribute('href') ?? '',
      subject:
        first(
          elementText(
            node.querySelector(
              '[data-testid="message-subject"], [data-conversation-subject], [class*="subject" i]',
            ),
          ),
        ) || null,
      sender: first(senderText(node.querySelector(selectors.sender))) || null,
      senderAddress: senderAddress || null,
      snippet:
        first(elementText(node.querySelector(selectors.snippet))) || null,
      receivedAt: time?.getAttribute('datetime') ?? null,
      conversationId:
        first(
          node.getAttribute('data-conversation-id'),
          node.getAttribute('data-conversationid'),
          node
            .querySelector('[data-conversation-id]')
            ?.getAttribute('data-conversation-id'),
          node
            .querySelector('[data-conversationid]')
            ?.getAttribute('data-conversationid'),
        ) || null,
      ariaPosition: node.getAttribute('aria-posinset'),
      ariaSetSize: node.getAttribute('aria-setsize'),
      rowIndex:
        node.getAttribute('data-index') ??
        node.getAttribute('data-item-index') ??
        node.getAttribute('aria-posinset'),
    };
  });
  const unresolved = rows.filter((row) => !row.href).length;
  const countText = [...root.querySelectorAll(selectors.count)]
    .map(
      (node) => `${node.getAttribute('aria-label') ?? ''} ${elementText(node)}`,
    )
    .join(' ');
  const counts = [
    ...new Set(
      [...countText.matchAll(/\d[\d,]*/g)].map((match) =>
        Number(match[0].replaceAll(',', '')),
      ),
    ),
  ].filter((value) => Number.isFinite(value) && value >= 0);
  const setSizes = rows
    .map((row) => Number(row.ariaSetSize))
    .filter((value) => Number.isFinite(value) && value > 0);
  const loadMore = [...root.querySelectorAll(selectors.loadMore)].some(
    (node) => {
      const label = `${node.getAttribute('aria-label') ?? ''} ${elementText(node)}`;
      return /(?:load|show)\s+more|next|more messages/i.test(label);
    },
  );
  const next = Boolean(
    root.querySelector('a[rel="next"], [data-testid="pagination-next"]'),
  );
  const loading = Boolean(
    root.querySelector(selectors.loading) ||
    document.querySelector('[aria-busy="true"]'),
  );
  const collapsed = [
    ...root.querySelectorAll('details:not([open]), [aria-expanded="false"]'),
  ].some((node) => {
    if (!node.closest('[role="option"]')) return true;
    return !['BUTTON', 'A', 'INPUT', 'SELECT'].includes(node.tagName);
  });
  const ancestors: Element[] = [];
  let ancestor = (root as Element).parentElement ?? null;
  for (let depth = 0; depth < 5 && ancestor; depth++) {
    ancestors.push(ancestor);
    ancestor = ancestor.parentElement;
  }
  const candidates = (
    [
      root,
      ...ancestors,
      ...document.querySelectorAll(
        '[data-testid*="scroll" i], [class*="scroll" i], [role="listbox"]',
      ),
      ...(document.scrollingElement ? [document.scrollingElement] : []),
    ] as (Document | Element)[]
  ).filter((node) => node !== document) as Element[];
  const scroller = candidates.reduce<Element>((best, node) => {
    const element = node as HTMLElement;
    const bestElement = best as HTMLElement;
    return (element.scrollHeight ?? 0) - (element.clientHeight ?? 0) >
      (bestElement.scrollHeight ?? 0) - (bestElement.clientHeight ?? 0)
      ? node
      : best;
  }, root as Element);
  const scrollerElement = scroller as HTMLElement;
  const scrollHeight = scrollerElement.scrollHeight ?? 0;
  const clientHeight = scrollerElement.clientHeight ?? 0;
  const scrollTop = scrollerElement.scrollTop ?? 0;
  return {
    rows,
    options: rows.length,
    unresolved,
    loadMore,
    next,
    collapsed,
    totalCount: counts.length === 1 ? counts[0]! : null,
    setSize: setSizes.length ? Math.max(...setSizes) : null,
    rowIndexes: rows
      .map((row) => row.rowIndex)
      .filter((value): value is string => Boolean(value)),
    loading,
    scrollHeight,
    clientHeight,
    scrollTop,
    scrollable: scrollHeight > clientHeight + 4,
  };
}

export function scrollMessageList(
  document: Document,
  selectors: typeof domSelectors,
  position: 'top' | 'next' | 'end',
) {
  const root = document.querySelector(selectors.list) ?? document;
  const ancestors: Element[] = [];
  let ancestor = (root as Element).parentElement ?? null;
  for (let depth = 0; depth < 5 && ancestor; depth++) {
    ancestors.push(ancestor);
    ancestor = ancestor.parentElement;
  }
  const candidates = (
    [
      root,
      ...ancestors,
      ...document.querySelectorAll(
        '[data-testid*="scroll" i], [class*="scroll" i], [role="listbox"]',
      ),
      ...(document.scrollingElement ? [document.scrollingElement] : []),
    ] as (Document | Element)[]
  ).filter((node) => node !== document) as Element[];
  const scroller = candidates.reduce<Element>((best, node) => {
    const element = node as HTMLElement;
    const bestElement = best as HTMLElement;
    return (element.scrollHeight ?? 0) - (element.clientHeight ?? 0) >
      (bestElement.scrollHeight ?? 0) - (bestElement.clientHeight ?? 0)
      ? node
      : best;
  }, root as Element) as HTMLElement;
  if ((scroller.scrollHeight ?? 0) > (scroller.clientHeight ?? 0) + 4) {
    if (position === 'top') scroller.scrollTop = 0;
    else if (position === 'end') scroller.scrollTop = scroller.scrollHeight;
    else
      scroller.scrollTop = Math.min(
        scroller.scrollHeight,
        (scroller.scrollTop ?? 0) +
          Math.max(1, (scroller.clientHeight ?? 1) * 0.8),
      );
    return {
      scrollHeight: scroller.scrollHeight ?? 0,
      clientHeight: scroller.clientHeight ?? 0,
      scrollTop: scroller.scrollTop ?? 0,
    };
  }
  const documentScroller = document.scrollingElement as HTMLElement | null;
  if (documentScroller) {
    if (position === 'top') documentScroller.scrollTop = 0;
    else if (position === 'end')
      documentScroller.scrollTop = documentScroller.scrollHeight;
    else
      documentScroller.scrollTop = Math.min(
        documentScroller.scrollHeight,
        (documentScroller.scrollTop ?? 0) +
          Math.max(1, (documentScroller.clientHeight ?? 1) * 0.8),
      );
    return {
      scrollHeight: documentScroller.scrollHeight ?? 0,
      clientHeight: documentScroller.clientHeight ?? 0,
      scrollTop: documentScroller.scrollTop ?? 0,
    };
  }
  return { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
}

export function readReadingPane(
  pane: Element,
  arg: {
    expected: { providerId: string; folderProviderId: string };
    selectors: typeof domSelectors;
  },
): ReadingPaneResult {
  const { expected, selectors } = arg;
  const clean = (value: string | null | undefined) =>
    (value ?? '').replace(/\s+/g, ' ').trim();
  const elementText = (element: Element | null | undefined) =>
    clean(element?.textContent);
  const first = (...values: (string | null | undefined)[]) => {
    for (const value of values) {
      const text = clean(value);
      if (text) return text;
    }
    return '';
  };
  const senderText = (node: Element | null | undefined) => {
    if (!node) return '';
    const clone = node.cloneNode(true) as Element;
    clone.querySelectorAll('a').forEach((anchor) => anchor.remove());
    return elementText(clone);
  };
  if (
    pane.getAttribute('aria-busy') === 'true' ||
    pane.querySelector(selectors.loading)
  ) {
    return { status: 'loading', detail: null, fingerprint: '' };
  }
  const declaredId = first(
    pane.getAttribute('data-message-id'),
    pane.querySelector('[data-message-id]')?.getAttribute('data-message-id'),
  );
  if (declaredId && declaredId !== expected.providerId) {
    return { status: 'mismatch', detail: null, fingerprint: '' };
  }
  const bodyNodes = [...pane.querySelectorAll(selectors.body)];
  if (bodyNodes.length === 0)
    return { status: 'missing', detail: null, fingerprint: '' };
  if (bodyNodes.length > 1)
    return { status: 'ambiguous', detail: null, fingerprint: '' };
  const body = bodyNodes[0]!;
  const bodyElement = body as HTMLElement;
  const bodyText = `${bodyElement.innerText ?? body.textContent ?? ''}`
    .replace(/\r\n?/g, '\n')
    .trim();
  const emptyMarker = pane.querySelector(selectors.emptyBody);
  if (!bodyText && !emptyMarker)
    return { status: 'empty', detail: null, fingerprint: '' };
  const subject = first(
    elementText(
      pane.querySelector(
        '[data-testid="message-subject"], [role="main"] h1, h1[role="heading"], [role="heading"][aria-level="1"]',
      ),
    ),
  );
  const senderNode = pane.querySelector(
    '[data-testid="message-sender"], [data-testid="sender"], [class*="sender" i]',
  );
  const sender = first(senderText(senderNode));
  const senderAddress = first(
    senderNode?.getAttribute('data-email-address'),
    senderNode
      ?.querySelector('[data-email-address]')
      ?.getAttribute('data-email-address'),
    senderNode?.querySelector('a[href^="mailto:"]')?.getAttribute('href'),
  );
  const receivedAt = first(
    pane.querySelector('time[datetime]')?.getAttribute('datetime'),
  );
  const conversationId = first(
    pane.getAttribute('data-conversation-id'),
    pane
      .querySelector('[data-conversation-id]')
      ?.getAttribute('data-conversation-id'),
    pane
      .querySelector('[data-conversationid]')
      ?.getAttribute('data-conversationid'),
  );
  return {
    status: 'ok',
    detail: {
      subject: subject || null,
      sender: sender || null,
      senderAddress: senderAddress || null,
      receivedAt: receivedAt || null,
      bodyText,
      bodyProvenEmpty: !bodyText && Boolean(emptyMarker),
      conversationId: conversationId || null,
    },
    fingerprint: `${subject}|${sender}|${receivedAt}|${bodyText.length}|${bodyText.slice(0, 80)}`,
  };
}

export function detectAuthState(document: Document): AuthState {
  if (
    document.querySelector(
      '#idDiv_SAOTCC_Description, #idTxtBx_SAOTCC_OTC, [data-testid="proofList"], [data-testid="mfa"], [data-testid="codeVerification"]',
    )
  )
    return 'mfa';
  if (
    document.querySelector(
      'input[type="password"], #i0116, #idSIButton9, [data-testid="login"], form[action*="login" i]',
    )
  )
    return 'sign-in';
  return null;
}
