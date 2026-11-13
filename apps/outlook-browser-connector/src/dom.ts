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
    'a[rel="next"], [data-testid="pagination-next"], [data-testid*="load-more" i], button, a, [role="button"]',
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
  const explicitList = document.querySelector(
    '[data-testid="message-list"], [data-app-section="message-list"]',
  );
  const listbox = [...document.querySelectorAll('[role="listbox"]')].find(
    (node) => node.querySelector('a[href*="/id/"]'),
  );
  const root = explicitList ?? listbox ?? document;
  const rowNodes = [
    ...(root === document
      ? document.querySelectorAll(selectors.messageRows)
      : root.querySelectorAll('[role="option"]')),
  ];
  const rows: MessageRowSnapshot[] = rowNodes.map((node) => {
    const link = node.querySelector(selectors.messageLink);
    const senderNode = node.querySelector(selectors.sender);
    const emailNode =
      senderNode?.getAttribute('data-email-address') !== null &&
      senderNode?.getAttribute('data-email-address') !== undefined
        ? senderNode
        : (senderNode?.querySelector('[data-email-address]') ??
          node.querySelector('[data-email-address]'));
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
      if (node.closest('[role="option"]')) return false;
      if (
        node.tagName === 'A' &&
        (node.getAttribute('href') ?? '').includes('/id/')
      )
        return false;
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
    ...root.querySelectorAll(
      'details:not([open]), [data-collapsed="true"], [data-testid*="collapsed" i], [aria-expanded="false"]',
    ),
  ].some((node) => {
    if (node.tagName === 'DETAILS') return true;
    if (node.getAttribute('data-collapsed') === 'true') return true;
    if ((node.getAttribute('data-testid') ?? '').includes('collapsed'))
      return true;
    const label = `${node.getAttribute('aria-label') ?? ''} ${elementText(node)}`;
    return /expand|collapsed|conversation/i.test(label);
  });
  const scrollable = (node: Element) => {
    const element = node as HTMLElement;
    return (element.scrollHeight ?? 0) > (element.clientHeight ?? 0) + 4;
  };
  let candidates: Element[] = [];
  if (root === document) {
    if (document.scrollingElement) candidates.push(document.scrollingElement);
  } else {
    const rootElement = root as Element;
    const local: Element[] = [];
    if (scrollable(rootElement)) local.push(rootElement);
    for (const node of rootElement.querySelectorAll(
      '[data-testid*="scroll" i], [class*="scroll" i], [role="listbox"], [style*="overflow"]',
    ))
      if (scrollable(node)) local.push(node);
    if (local.length) candidates = local;
    else {
      let ancestor = rootElement.parentElement;
      for (let depth = 0; depth < 5 && ancestor; depth++) {
        if (scrollable(ancestor)) candidates.push(ancestor);
        ancestor = ancestor.parentElement;
      }
    }
  }
  const scroller = candidates.reduce<Element | null>((best, node) => {
    if (!best) return node;
    const delta = (element: Element) => {
      const value = element as HTMLElement;
      return (value.scrollHeight ?? 0) - (value.clientHeight ?? 0);
    };
    return delta(node) > delta(best) ? node : best;
  }, null);
  const scrollerElement =
    scroller ??
    (root === document
      ? (document.scrollingElement as Element | null)
      : (root as Element));
  const scrollHeight =
    (scrollerElement as HTMLElement | null)?.scrollHeight ?? 0;
  const clientHeight =
    (scrollerElement as HTMLElement | null)?.clientHeight ?? 0;
  const scrollTop = (scrollerElement as HTMLElement | null)?.scrollTop ?? 0;
  return {
    rows,
    options: rows.length,
    unresolved,
    loadMore,
    next,
    collapsed,
    totalCount: counts.length ? Math.max(...counts) : null,
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
  _selectors: typeof domSelectors,
  position: 'top' | 'next' | 'end',
) {
  const root =
    document.querySelector(
      '[data-testid="message-list"], [data-app-section="message-list"]',
    ) ??
    [...document.querySelectorAll('[role="listbox"]')].find((node) =>
      node.querySelector('a[href*="/id/"]'),
    ) ??
    document;
  const scrollable = (node: Element) => {
    const element = node as HTMLElement;
    return (element.scrollHeight ?? 0) > (element.clientHeight ?? 0) + 4;
  };
  let candidates: Element[] = [];
  if (root === document) {
    if (document.scrollingElement) candidates.push(document.scrollingElement);
  } else {
    const rootElement = root as Element;
    const local: Element[] = [];
    if (scrollable(rootElement)) local.push(rootElement);
    for (const node of rootElement.querySelectorAll(
      '[data-testid*="scroll" i], [class*="scroll" i], [role="listbox"], [style*="overflow"]',
    ))
      if (scrollable(node)) local.push(node);
    if (local.length) candidates = local;
    else {
      let ancestor = rootElement.parentElement;
      for (let depth = 0; depth < 5 && ancestor; depth++) {
        if (scrollable(ancestor)) candidates.push(ancestor);
        ancestor = ancestor.parentElement;
      }
    }
  }
  const scroller = candidates.reduce<Element | null>((best, node) => {
    if (!best) return node;
    const delta = (element: Element) => {
      const value = element as HTMLElement;
      return (value.scrollHeight ?? 0) - (value.clientHeight ?? 0);
    };
    return delta(node) > delta(best) ? node : best;
  }, null) as HTMLElement | null;
  if (!scroller || !scrollable(scroller))
    return { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
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

export function readReadingPane(
  pane: Element,
  arg: {
    expected: {
      providerId: string;
      folderProviderId: string;
      subject?: string | null;
      sender?: string | null;
      conversationId?: string | null;
      receivedAt?: string | null;
    };
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
  const rawBodyText = `${bodyElement.innerText ?? body.textContent ?? ''}`
    .replace(/\r\n?/g, '\n')
    .trim();
  const directMarker = [...body.children].find((child) =>
    child.matches(selectors.emptyBody),
  );
  const markerPresent =
    body.getAttribute('data-empty') === 'true' ||
    Boolean(directMarker && !elementText(directMarker));
  const emptyMarker = markerPresent && !rawBodyText;
  const bodyText = rawBodyText;
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
  const expectedSubject = first(expected.subject);
  const expectedSender = first(expected.sender);
  const expectedConversation = first(expected.conversationId);
  const expectedReceivedAt = first(expected.receivedAt);
  const normalizedSubject = subject.toLowerCase();
  const normalizedExpectedSubject = expectedSubject.toLowerCase();
  const subjectMatches =
    Boolean(normalizedSubject && normalizedExpectedSubject) &&
    (normalizedSubject === normalizedExpectedSubject ||
      (normalizedSubject.length >= 8 &&
        normalizedExpectedSubject.length >= 8 &&
        (normalizedSubject.startsWith(normalizedExpectedSubject) ||
          normalizedExpectedSubject.startsWith(normalizedSubject))));
  const conversationMatches =
    Boolean(expectedConversation) &&
    expectedConversation.toLowerCase() === conversationId.toLowerCase();
  const senderMatches =
    Boolean(expectedSender) &&
    expectedSender.toLowerCase() === sender.toLowerCase();
  const sameInstant = (left: string, right: string) => {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    return Number.isFinite(leftTime) && Number.isFinite(rightTime)
      ? leftTime === rightTime
      : left === right;
  };
  const receivedMatches =
    Boolean(expectedReceivedAt && receivedAt) &&
    sameInstant(expectedReceivedAt, receivedAt);
  let identityMatches = Boolean(declaredId);
  if (!declaredId) {
    if (expectedReceivedAt && receivedAt) {
      identityMatches =
        receivedMatches &&
        (conversationMatches || senderMatches || subjectMatches);
    } else {
      identityMatches =
        [conversationMatches, senderMatches, subjectMatches].filter(Boolean)
          .length >= 2;
    }
  }
  if (!identityMatches) {
    return { status: 'mismatch', detail: null, fingerprint: '' };
  }
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
