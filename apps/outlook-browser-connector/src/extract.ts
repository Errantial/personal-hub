import { outlookOrigins } from './config.js';

const originSet = new Set<string>(outlookOrigins);
const exactInstant =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const messageProviderId = /^[A-Za-z0-9_-]{8,2000}$/;
const reservedFolderSegments = new Set([
  'id',
  'deeplink',
  'options',
  'settings',
]);
const signInHosts = new Set([
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
  'account.live.com',
  'mysignins.microsoft.com',
]);
const maxFolders = 200;
const maxMessagesPerFolder = 200;
const maxSubject = 500;
const maxSender = 200;
const maxAddress = 320;
const maxSnippet = 2000;
const maxBody = 20000;

export class CollectionError extends Error {
  constructor(
    public readonly code:
      | 'sign-in-required'
      | 'mfa-required'
      | 'browser-unavailable'
      | 'outlook-unavailable'
      | 'foreign-origin'
      | 'traversal-failed'
      | 'traversal-limit',
  ) {
    super(code);
  }
}

export type OutlookOrigin = (typeof outlookOrigins)[number];

export type Folder = {
  providerId: string;
  name: string;
  canonicalUrl: string;
};

export type Message = {
  providerId: string;
  conversationId: string | null;
  canonicalUrl: string;
  subject: string;
  senderDisplay: string;
  senderAddress: string | null;
  receivedAt: string | null;
  snippet: string;
  bodyText: string;
};

export type MessageRow = {
  href: string;
  subject: string | null;
  sender: string | null;
  senderAddress: string | null;
  snippet: string | null;
  receivedAt: string | null;
  conversationId: string | null;
};

export type MessageDetail = {
  subject: string | null;
  sender: string | null;
  senderAddress: string | null;
  receivedAt: string | null;
  bodyText: string | null;
  conversationId: string | null;
};

export type PageKind =
  | { kind: 'outlook'; pathname: string }
  | { kind: 'sign-in' }
  | { kind: 'blank' }
  | { kind: 'foreign' };

function clean(value: string | null | undefined) {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
}

function display(value: string | null | undefined) {
  const text = clean(value);
  if (!text) return null;
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(text);
  return (named?.[1] || named?.[2] || text).slice(0, maxSender);
}

function addressOf(value: string | null | undefined) {
  const text = clean(value);
  if (!text) return null;
  const named = /<([^<>]+)>$/.exec(text);
  const candidate = (named?.[1] ?? text).replace(/^mailto:/i, '');
  if (
    candidate.length < 3 ||
    candidate.length > maxAddress ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate)
  )
    return null;
  return candidate;
}

function instant(value: string | null | undefined) {
  if (!value) return null;
  if (!exactInstant.test(value) || Number.isNaN(Date.parse(value)))
    throw new CollectionError('traversal-failed');
  return new Date(value).toISOString();
}

/** Parses an Outlook Web URL for the configured origin only. */
export function outlookIdentity(origin: OutlookOrigin, value: string) {
  if (!originSet.has(origin)) return null;
  let url: URL;
  try {
    url = new URL(value, `${origin}/`);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password) return null;
  if (url.search || url.hash) {
    if (/^\/mail(?:\/|$)/.test(url.pathname))
      throw new CollectionError('traversal-failed');
    return null;
  }
  return url;
}

export function normalizeFolders(
  origin: OutlookOrigin,
  rows: { href: string; name: string }[],
): Folder[] {
  const folders = new Map<string, Folder>();
  for (const row of rows) {
    let url: URL | null;
    try {
      url = outlookIdentity(origin, row.href);
    } catch {
      throw new CollectionError('traversal-failed');
    }
    if (!url) continue;
    const match = /^\/mail\/([A-Za-z0-9_-]{1,200})\/?$/.exec(url.pathname);
    if (!match || reservedFolderSegments.has(match[1]!)) continue;
    const name = clean(row.name).slice(0, 200);
    if (!name) throw new CollectionError('traversal-failed');
    const providerId = match[1]!;
    const folder = {
      providerId,
      name,
      canonicalUrl: `${origin}/mail/${providerId}`,
    };
    const previous = folders.get(providerId);
    if (previous && previous.name !== folder.name)
      throw new CollectionError('traversal-failed');
    folders.set(providerId, folder);
  }
  const sorted = [...folders.values()].sort((a, b) =>
    a.providerId.localeCompare(b.providerId),
  );
  if (sorted.length > maxFolders) throw new CollectionError('traversal-limit');
  return sorted;
}

export function canonicalMessageLinks(
  origin: OutlookOrigin,
  folderProviderIdValue: string,
  hrefs: string[],
): string[] {
  const links = new Set<string>();
  for (const href of hrefs) {
    let url: URL | null;
    try {
      url = outlookIdentity(origin, href);
    } catch {
      throw new CollectionError('traversal-failed');
    }
    if (!url) continue;
    const match =
      /^\/mail\/(?:([A-Za-z0-9_-]{1,200})\/)?id\/([A-Za-z0-9_-]{8,2000})$/.exec(
        url.pathname,
      );
    if (!match) continue;
    if (
      match[1] &&
      (reservedFolderSegments.has(match[1]) ||
        match[1] !== folderProviderIdValue)
    )
      throw new CollectionError('traversal-failed');
    links.add(`${origin}${url.pathname}`);
  }
  return [...links].sort();
}

export function projectMessage(
  origin: OutlookOrigin,
  folderProviderIdValue: string,
  row: MessageRow,
  detail: MessageDetail | undefined,
): Message | null {
  const url = outlookIdentity(origin, row.href);
  if (!url) return null;
  const match =
    /^\/mail\/(?:([A-Za-z0-9_-]{1,200})\/)?id\/([A-Za-z0-9_-]{8,2000})$/.exec(
      url.pathname,
    );
  if (!match) return null;
  if (
    match[1] &&
    (reservedFolderSegments.has(match[1]) || match[1] !== folderProviderIdValue)
  )
    throw new CollectionError('traversal-failed');
  if (!detail) return null;

  const providerId = match[2]!;
  const subject = clean(detail.subject ?? row.subject).slice(0, maxSubject);
  const senderDisplay = display(detail.sender ?? row.sender);
  const senderAddress = addressOf(detail.senderAddress ?? row.senderAddress);
  const receivedAt = instant(detail.receivedAt ?? row.receivedAt);
  const bodyText = (detail.bodyText ?? '').replace(/\r\n?/g, '\n').trim();
  if (!subject || !senderDisplay || bodyText.length > maxBody) return null;
  const conversation = clean(detail.conversationId ?? row.conversationId);
  const snippet =
    clean(row.snippet).slice(0, maxSnippet) ||
    clean(bodyText).slice(0, maxSnippet);
  return {
    providerId,
    conversationId:
      conversation && messageProviderId.test(conversation)
        ? conversation
        : null,
    canonicalUrl: `${origin}${url.pathname}`,
    subject,
    senderDisplay,
    senderAddress,
    receivedAt,
    snippet,
    bodyText,
  };
}

export function normalizeMessages(
  origin: OutlookOrigin,
  folderProviderIdValue: string,
  entries: { row: MessageRow; detail: MessageDetail | undefined }[],
): { messages: Message[]; skipped: number; duplicates: number } {
  if (entries.length > maxMessagesPerFolder)
    throw new CollectionError('traversal-limit');
  const messages = new Map<string, Message>();
  let skipped = 0;
  let duplicates = 0;
  for (const entry of entries) {
    let message: Message | null;
    try {
      message = projectMessage(
        origin,
        folderProviderIdValue,
        entry.row,
        entry.detail,
      );
    } catch (error) {
      if (
        error instanceof CollectionError &&
        error.code === 'traversal-failed'
      ) {
        skipped++;
        continue;
      }
      throw error;
    }
    if (!message) {
      skipped++;
      continue;
    }
    if (messages.has(message.providerId)) {
      duplicates++;
      continue;
    }
    messages.set(message.providerId, message);
  }
  return {
    messages: [...messages.values()].sort((a, b) =>
      a.providerId.localeCompare(b.providerId),
    ),
    skipped,
    duplicates,
  };
}

/** Classifies the committed page without reading or retaining page text. */
export function classifyOutlookPage(
  origin: OutlookOrigin,
  value: string,
): PageKind {
  if (value === 'about:blank' || value === '') return { kind: 'blank' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'foreign' };
  }
  if (url.origin === origin) return { kind: 'outlook', pathname: url.pathname };
  if (signInHosts.has(url.hostname)) return { kind: 'sign-in' };
  return { kind: 'foreign' };
}

export function nextSettleState(input: {
  count: number;
  loading: boolean;
  previous: number;
  stablePasses: number;
}) {
  const stablePasses =
    !input.loading && input.count === input.previous
      ? input.stablePasses + 1
      : 0;
  return { stablePasses, done: stablePasses >= 20 };
}

export function uncertainFolderList(input: {
  activeSearch: boolean;
  activeFilter: boolean;
  loading: boolean;
  pagination: boolean;
}) {
  return (
    input.activeSearch ||
    input.activeFilter ||
    input.loading ||
    input.pagination
  );
}
