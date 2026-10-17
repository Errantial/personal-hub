import type { Course, Item } from './hub.js';

const origin = 'https://canvas.colorado.edu';
const coursePath = /^\/courses\/([1-9]\d*)$/;
const itemPath = /^\/courses\/([1-9]\d*)\/(assignments|quizzes)\/([1-9]\d*)$/;
const exactInstant =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export class CollectionError extends Error {
  constructor(
    public readonly code:
      | 'sign-in-required'
      | 'browser-unavailable'
      | 'canvas-unavailable'
      | 'traversal-failed'
      | 'traversal-limit',
  ) {
    super(code);
  }
}

export function canvasUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  return url;
}

export function normalizeCourses(
  rows: { href: string; title: string }[],
): Course[] {
  const courses = new Map<string, Course>();
  for (const row of rows) {
    let raw: URL | null = null;
    try {
      raw = new URL(row.href, origin);
    } catch {
      // Invalid unrelated anchors cannot contribute course identity.
    }
    if (
      raw?.origin === origin &&
      coursePath.test(raw.pathname) &&
      (raw.search || raw.hash || raw.username || raw.password)
    )
      throw new CollectionError('traversal-failed');
    const url = canvasUrl(row.href);
    const match = url && coursePath.exec(url.pathname);
    const name = row.title.trim();
    if (!match || !name || name.length > 200) continue;
    const providerId = match[1]!;
    const course = {
      providerId,
      name,
      canonicalUrl: `${origin}/courses/${providerId}`,
    };
    const previous = courses.get(providerId);
    if (previous && previous.name !== course.name)
      throw new CollectionError('traversal-failed');
    courses.set(providerId, course);
  }
  return [...courses.values()].sort((a, b) =>
    a.providerId.localeCompare(b.providerId, undefined, { numeric: true }),
  );
}

export function normalizeItems(
  courseProviderId: string,
  rows: {
    href: string;
    title: string;
    dueAt: string | null;
    hasDueLabel: boolean;
  }[],
): Item[] {
  const items = new Map<string, Item>();
  for (const row of rows) {
    const url = canvasUrl(row.href);
    const match = url && itemPath.exec(url.pathname);
    if (!match || match[1] !== courseProviderId)
      throw new CollectionError('traversal-failed');
    const title = row.title.trim();
    if (!title || title.length > 200)
      throw new CollectionError('traversal-failed');
    if (row.hasDueLabel && !row.dueAt)
      throw new CollectionError('traversal-failed');
    if (
      row.dueAt &&
      (!exactInstant.test(row.dueAt) || Number.isNaN(Date.parse(row.dueAt)))
    )
      throw new CollectionError('traversal-failed');
    const resourceKind = match[2] === 'assignments' ? 'assignment' : 'quiz';
    const providerId = match[3]!;
    const key = `${resourceKind}:${providerId}`;
    const item: Item = {
      resourceKind,
      providerId,
      canonicalUrl: `${origin}${url.pathname}`,
      title,
      dueAt: row.dueAt ? new Date(row.dueAt).toISOString() : null,
    };
    if (items.has(key)) throw new CollectionError('traversal-failed');
    items.set(key, item);
  }
  return [...items.values()].sort((a, b) =>
    `${a.resourceKind}:${a.providerId}`.localeCompare(
      `${b.resourceKind}:${b.providerId}`,
      undefined,
      { numeric: true },
    ),
  );
}

export function canonicalItemLinks(
  courseProviderId: string,
  hrefs: string[],
): string[] {
  const links = new Set<string>();
  for (const href of hrefs) {
    let raw: URL;
    try {
      raw = new URL(href, origin);
    } catch {
      continue;
    }
    if (raw.origin !== origin) continue;
    const match = itemPath.exec(raw.pathname);
    if (!match || match[1] !== courseProviderId) continue;
    if (raw.search || raw.hash || raw.username || raw.password)
      throw new CollectionError('traversal-failed');
    links.add(`${origin}${raw.pathname}`);
  }
  return [...links].sort();
}
